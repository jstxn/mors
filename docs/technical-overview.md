# mors Technical Overview

This document keeps the implementation and deployment details out of the main README. Start with the README if you want the product pitch and first commands. Use this file when you need to understand how mors is put together.

## System Shape

`mors` is a CLI-first messaging system with four operating modes:

1. **Local mode:** messages are stored in an encrypted local database. This is the fastest way to prove the lifecycle.
2. **Hosted relay mode:** `mors setup relay` connects to the hosted relay, creates or reuses a profile, and publishes the device bundle needed for remote encrypted messaging. Use `send --remote`, `inbox --remote`, and `watch --remote` after setup.
3. **Low-level relay mode:** scripts can call `login`, `onboard`, `send --remote`, `watch --remote`, and related commands directly.
4. **Sandbox spool mode:** a VM or container writes files to a mounted spool folder while the host runs `mors spool bridge` with real relay credentials.

## Main Components

- **CLI:** exposes human and automation commands from `dist/index.js`.
- **Local encrypted store:** keeps identity, sessions, messages, and state in SQLCipher-backed storage.
- **Identity and device keys:** `mors init` creates local identity material and device keys. Hosted mode reuses those keys.
- **Relay service:** accepts authenticated messages, stores relay-side state, and streams events.
- **E2EE layer:** remote message bodies can be encrypted after device bundle exchange.
- **Watch streams:** local and relay-backed watchers expose realtime create, reply, and ack events.
- **Spool bridge:** maps file-based sandbox commands into relay or local actions controlled by host policy.
- **Host tool runners:** optional policy-named runners execute host-owned commands for sandbox tool requests.

## Trust Boundaries

Local CLI usage is trusted to the local user account. The encrypted database protects at-rest data, but the running process can read decrypted content.

Relay usage separates local identity from remote delivery. Authenticated relay actions depend on session tokens, which now carry an expiry (default 30 days) and are refused once lapsed, so a captured token cannot be replayed indefinitely. E2EE protects message bodies across relay delivery once device keys are exchanged.

The relay is treated as untrusted for key distribution. Published peer device bundles are verified client-side: a bundle's fingerprint must be an honest hash of its own public keys, and once a peer's key is pinned (trust on first use) a later key change is refused rather than silently re-keyed — a relay cannot swap in its own key mid-conversation. Verify a peer's fingerprint out of band before trusting first contact. Remote send never silently downgrades to plaintext: sends to a contact with no published keys are labeled as unencrypted.

The relay also bounds abuse: request bodies are capped, unauthenticated public routes (signup, health) are rate-limited per client, and the relay container runs as a non-root user.

Sandbox spool usage is a local host trust boundary. The spool is plaintext on disk. Use VM disk encryption or an encrypted host volume for sensitive payloads. The sandbox should not receive relay credentials unless it is intentionally trusted.

Tool requests are denied by default. If enabled, the host names each allowed runner in policy. Runner commands execute without a shell. Sandbox-provided arguments are passed through environment JSON such as `MORS_TOOL_ARGS_JSON`, not interpolated into the command line.

## Agent-Oriented Contracts

Agent-safe command usage depends on three rules:

- Set `MORS_CONFIG_DIR` per agent or per run.
- Use `--json` for machine parsing.
- Treat exit code `0` as success and any non-zero exit as failure.

Common checks:

```bash
node dist/index.js setup local --json
node dist/index.js setup relay --json
node dist/index.js quickstart --json
node dist/index.js doctor --json
```

Common local lifecycle:

```bash
node dist/index.js setup local --json
node dist/index.js send --to peer-agent --body "hello" --json
node dist/index.js inbox --json
node dist/index.js read <message-id> --json
node dist/index.js ack <message-id> --json
```

### Message Correlation For Orchestration

Messages carry a `thread_id` and optional `in_reply_to` for causal linkage, plus an optional `trace_id` (`trc_`-prefixed) that is now carried end-to-end across the relay — local and remote. An orchestrator can tag a suggestion with a `trace_id` and match it on the worker's reply without scraping bodies:

```bash
# orchestrator sends a course-correction suggestion, tagged for correlation
node dist/index.js send --remote --to acct_worker \
  --body '{"kind":"course_correction","hint":"prefer the cheaper route"}' \
  --trace-id trc_route_decision_1 --json

# worker replies on the same thread, echoing the trace id
node dist/index.js reply <parent-id> --remote --to acct_orchestrator \
  --body '{"kind":"ack","applied":true}' --trace-id trc_route_decision_1 --json
```

Typed course-correction payloads follow the spool convention of a structured JSON body (a `kind` discriminator plus fields), correlated by `trace_id` and grouped by `thread_id`. Subject and `trace_id` are metadata (not encrypted); the body is E2EE when a session exists.

`setup local` is a thin orchestrator over initialization and local health checks. It does not enable auth or relay state.

`setup relay` initializes local state, saves relay settings, verifies `/health` unless skipped, and can complete identity setup when given `--handle` and `--display-name` for hosted signup. It also supports native invite-token auth with `--invite-token`.

Both setup modes return `blocked` with a non-zero exit code when required local checks fail. Relay setup also blocks when an authenticated profile exists but the device bundle cannot be published, because external messaging is not ready until the relay can discover the local device keys.

## Sandbox Spool Contract

The sandbox agent writes commands into:

```text
<root>/agents/<agent-id>/outbox/{tmp,new,cur}
<root>/agents/<agent-id>/inbox/{tmp,new,cur}
<root>/agents/<agent-id>/control/{tmp,new,cur}
<root>/agents/<agent-id>/failed/{tmp,new,cur}
```

The host bridge owns relay identity and policy:

```bash
node dist/index.js spool bridge \
  --root /var/lib/mors-spool \
  --agent worker-a \
  --policy /etc/mors/worker-a.policy.json \
  --json
```

Use [sandbox-agents.md](./sandbox-agents.md) for the full file shapes, quotas, transcript export, bridge state, scoped tokens, Docker image notes, and security checklist.

## Reference Sandbox Image

The repository includes `Dockerfile.sandbox` for containerized agents. Build after `npm run build` so the copied `dist/` output matches source:

```bash
docker build -f Dockerfile.sandbox -t mors-sandbox-agent:local .
docker run --rm mors-sandbox-agent:local --version
docker run --rm mors-sandbox-agent:local sandbox init --root /tmp/mors-spool --agent worker-a --json
```

The image includes the CLI and local prerequisites, runs as a non-root user, and does not bake relay credentials or host policy into the image.

## Deployment Notes

- Keep relay signing keys and OAuth configuration out of images.
- Prefer host-owned spool bridges for untrusted containers.
- Mount only the intended spool root into sandbox images.
- Preserve committed `dist/` output for GitHub shortcut installs.
- Run `doctor` inside each target environment before trusting it.

## Verification

Release-oriented checks:

```bash
npm run build
npm run lint
npm run typecheck
npm run test -- --maxConcurrency=7
docker build -f Dockerfile.sandbox -t mors-sandbox-agent:local .
```
