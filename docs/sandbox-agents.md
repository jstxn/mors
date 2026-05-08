# Sandbox and VM Agents

This guide defines the supported way to connect an isolated agent, container, or VM to mors. The default production posture is file-spool bridging: the host owns relay credentials and the sandbox only sees a shared folder.

## Recommended Contract

- Host creates one spool per sandbox identity with `mors sandbox init`.
- Host runs `mors spool bridge` outside the sandbox.
- Agent writes outbound commands with `mors spool write` or atomic Maildir writes.
- Agent reads inbound work with `mors spool wait`, `mors spool tail`, or direct reads from `inbox/new`.
- Host policy controls quotas and tool-request permission.
- Host exports transcripts with `mors spool export` for review, audit, or replay.

```bash
mors sandbox init --root /var/lib/mors-spool --agent worker-a --json
mors sandbox doctor --root /var/lib/mors-spool --agent worker-a --json
mors spool bridge --root /var/lib/mors-spool --agent worker-a --policy /etc/mors/worker-a.policy.json --json
```

Inside the sandbox:

```bash
mors spool write --root /mnt/mors-spool --agent worker-a --to acct_host --body "ready" --json
mors spool wait --root /mnt/mors-spool --agent worker-a --timeout-ms 30000 --json
mors spool tail --root /mnt/mors-spool --agent worker-a --mailbox inbox --json
```

## Shared Folder Layout

```text
<root>/agents/<agent-id>/
  outbox/{tmp,new,cur}
  inbox/{tmp,new,cur}
  control/{tmp,new,cur}
  failed/{tmp,new,cur}
  bridge-state.json
```

Writers must write a complete JSON file into `tmp` and then rename it into `new`. The bridge only processes complete files in `new`. Failed entries move to `failed/new` with metadata. Processed outbound entries move to `cur`.

## Policy File

Policies are host-owned JSON files. Omitted quota fields keep secure defaults.

```json
{
  "schema": "mors.spool.policy.v1",
  "quotas": {
    "max_entry_bytes": 1048576,
    "max_pending_entries": 1000,
    "max_pending_bytes": 67108864,
    "max_inbox_entries": 10000,
    "max_failed_entries": 1000
  },
  "tools": {
    "allow_requests": true,
    "allowed_names": ["run-tests"],
    "max_args_bytes": 65536,
    "runners": {
      "run-tests": {
        "command": "npm",
        "args": ["run", "test", "--", "--maxConcurrency=7"],
        "cwd": "/workspace",
        "timeout_ms": 120000,
        "max_output_bytes": 65536
      }
    }
  }
}
```

Default tool posture is deny. Tool requests are only accepted when the host explicitly sets `tools.allow_requests` and, for production, names the allowed tools. Tool execution should stay host-side so the sandbox never gains more authority than the host policy grants.

Runner commands are host-owned and executed without a shell. The sandbox-provided tool arguments are not interpolated into the command line; they are passed as JSON in `MORS_TOOL_ARGS_JSON`, along with `MORS_TOOL_NAME`, `MORS_TOOL_BODY`, and `MORS_TOOL_TRACE_ID`. The bridge writes a local `tool_result` entry back to `inbox/new` and moves the request to `outbox/cur`.

## Command Shapes

Message:

```bash
mors spool write \
  --root /mnt/mors-spool \
  --agent worker-a \
  --kind message \
  --to acct_host \
  --body "build finished" \
  --json
```

Tool request:

```bash
mors spool write \
  --root /mnt/mors-spool \
  --agent worker-a \
  --kind tool_request \
  --to acct_host \
  --body "run regression suite" \
  --tool run-tests \
  --args-json '{"target":"regression"}' \
  --policy /mnt/mors-spool/worker-a.policy.json \
  --json
```

Read or ack:

```bash
mors spool write --root /mnt/mors-spool --agent worker-a --kind read --message-id msg_123 --json
mors spool write --root /mnt/mors-spool --agent worker-a --kind ack --message-id msg_123 --json
```

## Observability

Use status and doctor as the first triage commands.

```bash
mors sandbox status --root /var/lib/mors-spool --agent worker-a --json
mors sandbox doctor --root /var/lib/mors-spool --agent worker-a --policy /etc/mors/worker-a.policy.json --json
```

`bridge-state.json` records the last bridge result, last error, consecutive failures, next retry time, and the last relay event cursor. This gives supervising agents a stable recovery signal without scraping process logs.

## Transcript Export

Export a local transcript before deleting a sandbox or escalating a failure.

```bash
mors spool export --root /var/lib/mors-spool --agent worker-a --output worker-a-transcript.json
```

The export includes new and cur entries from outbox, inbox, control, and failed mailboxes. It is local plaintext JSON and should be treated as sensitive.

## Direct Relay Tokens

Use direct relay tokens only for trusted VM agents that need relay access without a file bridge. The safer default is still the spool bridge.

```bash
mors sandbox token --agent worker-a --scopes messages:read,messages:write,messages:state,events:read --json
```

Scoped tokens are HMAC-signed native session tokens with explicit relay scopes. A token with `messages:read` cannot write messages. Existing full session tokens without scopes remain unrestricted for compatibility.

Available scopes:

- `messages:read`
- `messages:write`
- `messages:state`
- `events:read`
- `accounts:read`
- `accounts:write`
- `contacts:read`
- `contacts:write`

## Reference Image Guidance

A production sandbox image should include:

- Node.js 20 or newer.
- npm.
- SQLCipher and native module build support when the local CLI database is used.
- A built mors checkout or installed package.
- A writable `MORS_CONFIG_DIR` owned by the agent user.
- A mounted spool path, for example `/mnt/mors-spool`.
- No relay access token by default.

For containerized agents, mount only the intended spool root and keep host relay config outside the container. For VM agents, mount the spool folder with owner-only permissions when the hypervisor supports it.

This repository includes `Dockerfile.sandbox` as the reference container build. Build it after `npm run build` so the committed `dist/` matches source:

```bash
docker build -f Dockerfile.sandbox -t mors-sandbox-agent:local .
docker run --rm -v /var/lib/mors-spool:/mnt/mors-spool mors-sandbox-agent:local sandbox doctor --root /mnt/mors-spool --agent worker-a --json
```

## Security Notes

- The spool is plaintext on local disk. Use VM disk encryption or an encrypted host volume when messages are sensitive.
- End-to-end encryption still applies to relay delivery, but the spool boundary is a local host trust boundary.
- Sender authority is derived from the host bridge session, not from spool JSON fields.
- Quotas protect the host from unbounded file growth and oversized commands.
- Tool requests execute only when a host-owned runner is named in policy; no arbitrary shell text is accepted from the sandbox.

## Verification Checklist

Before shipping a sandbox image or VM template:

```bash
npm run build
npm run typecheck
npm run lint
npm run test -- --maxConcurrency=7
mors sandbox init --root /tmp/mors-spool --agent smoke --json
mors sandbox doctor --root /tmp/mors-spool --agent smoke --json
mors spool write --root /tmp/mors-spool --agent smoke --to acct_host --body smoke --json
mors spool tail --root /tmp/mors-spool --agent smoke --mailbox outbox --json
```
