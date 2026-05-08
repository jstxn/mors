# Maildir and Perkeep Investigation for Agent Communication

## Objective

Investigate whether `mors` should use Maildir-like filesystem semantics and possibly Perkeep to support agent-to-agent communication between sandboxed or VM-isolated agents during engineering sessions.

The target is not generic human email. The target is a reliable local and remote control plane where agents can exchange messages, tool requests, tool results, read state, ack state, and hook events in near real time.

## Current mors Shape

The repo already has most of the network messaging spine:

- `src/relay/server.ts` exposes authenticated `/messages`, `/inbox`, `/messages/:id/read`, `/messages/:id/ack`, `/events`, contact routes, device-bundle routes, and A2A agent card discovery.
- `src/relay/message-store.ts` models messages with `thread_id`, `in_reply_to`, `read_at`, `acked_at`, dedupe keys, sender and recipient indexes, participant checks, and an SSE event log.
- `src/relay/client.ts` already has durable offline send queueing with retry and dedupe convergence.
- `src/remote-watch.ts` implements an SSE client with `Last-Event-ID` resume and fallback mode.
- `src/store.ts` keeps the local single-agent store in SQLCipher, not plain files.
- `.factory/library/architecture.md` names SSE as the default remote realtime model and requires read/ack separation, causal threading, dedupe convergence, auth-derived actor identity, and no plaintext relay leakage.

That means Maildir should not replace the relay. It is a better fit as a local isolation and tool boundary around the relay.

## Maildir Fit

Maildir's useful properties for `mors` are simple:

- Each message is a separate file.
- Delivery is atomic: write in `tmp`, then rename into `new`.
- Readers never need to inspect `tmp`.
- Multiple readers can observe a mailbox without sharing process memory.
- It works well as a plain filesystem contract that simple tools can read and write.

Those properties map directly to sandboxed agents. A VM can write a file into its own outbox without receiving relay credentials, opening inbound ports, or sharing a process with the host. A host bridge can then validate, send, and materialize inbound messages.

Maildir does not solve these by itself:

- Network delivery between machines.
- Identity, authorization, or sender spoofing.
- Read and ack semantics richer than email's `Seen` flag.
- Low-latency notification without a watcher, poller, or relay stream.
- Tool execution policy.

So the right design is Maildir-inspired, not a strict email store.

## Recommended Architecture

Use a host-owned spool bridge:

```text
agent VM tool
  -> writable outbox Maildir
  -> mors spool bridge
  -> mors relay /messages and /events
  -> mors spool bridge
  -> read-only inbox Maildir
  -> hook runner or agent inbox reader
```

The bridge owns relay credentials and maps each outbox path to one authenticated agent identity. Message payload `sender_id` should be ignored, just like the relay currently derives sender identity from auth context.

Per-agent filesystem shape:

```text
.mors-spool/
  agents/
    <agent-id>/
      outbox/
        tmp/
        new/
        cur/
      inbox/
        tmp/
        new/
        cur/
      control/
        tmp/
        new/
        cur/
      failed/
        tmp/
        new/
        cur/
      state.json
```

Use `outbox` for new messages, replies, tool requests, and tool results. Use `control` for state transitions like read and ack. Do not rely on Maildir filename flags for `ack`, because `mors` intentionally separates read from ack and Maildir flags do not model that cleanly.

## Spool Message Contract

Use one JSON file per command or event. Keep it machine-first and let humans inspect it with normal tools.

```json
{
  "schema": "mors.spool.v1",
  "kind": "message",
  "recipient_id": "acct_1002",
  "body": {
    "format": "text/markdown",
    "content": "please inspect the failing test"
  },
  "subject": "optional",
  "in_reply_to": null,
  "dedupe_key": "dup_...",
  "trace_id": "trc_...",
  "tool": null
}
```

Control event example:

```json
{
  "schema": "mors.spool.v1",
  "kind": "ack",
  "message_id": "msg_...",
  "dedupe_key": "dup_..."
}
```

Tool request example:

```json
{
  "schema": "mors.spool.v1",
  "kind": "tool_request",
  "recipient_id": "acct_tool_runner",
  "tool": {
    "name": "run_tests",
    "args": {
      "command": "npm run test -- --maxConcurrency=7"
    }
  },
  "body": {
    "format": "text/markdown",
    "content": "Run the project test gate and return the result."
  },
  "dedupe_key": "dup_..."
}
```

Incoming files should include the relay-assigned fields from `RelayMessageResponse`: `id`, `thread_id`, `in_reply_to`, `sender_id`, `sender_device_id`, `recipient_id`, `state`, `read_at`, `acked_at`, `created_at`, and `updated_at`.

## Delivery Rules

Writer side:

1. Create a unique filename with cryptographic randomness.
2. Write the complete JSON body to `tmp/<name>`.
3. Flush and close the file.
4. Rename to `new/<name>`.

Bridge side:

1. Scan `outbox/new` and `control/new`.
2. Validate schema and reject unknown fields that affect authority.
3. Derive sender identity from the configured spool path, not from file content.
4. Submit to the relay using existing `RelayClient`.
5. Move accepted files to `cur`.
6. Move malformed or permanently rejected files to `failed/new` with an error sidecar.
7. Keep transient failures in `new` or use a retry schedule in `state.json`.

Incoming side:

1. Hold an authenticated `/events` SSE connection for each relay identity or for a host bridge identity.
2. For each relevant relay event, fetch or use the message payload and materialize it into the recipient `inbox/tmp`.
3. Rename into `inbox/new`.
4. On reconnect, use `Last-Event-ID` if available. Also periodically reconcile with `/inbox` and local dedupe because SSE history is not a durable queue forever.

## Hooks

Hooks should be host configured, not message supplied. The safe default is:

- A bridge emits a local hook event when a file appears in `inbox/new`.
- The hook runner receives the message file path and parsed JSON.
- Tool execution is allowlisted by hook config and contact/autonomy policy.
- Tool results are sent back as normal `tool_result` messages.

Do not let a message directly name an arbitrary executable. For engineering sessions, a tool request should be data. The host decides whether that data maps to a runnable command.

## Security Model

Recommended V1 security stance:

- Each agent gets write access only to its own `outbox` and `control`.
- Each agent gets read-only access to its own `inbox`, if the mount system allows it.
- The bridge is the only writer to `inbox`.
- The bridge ignores payload sender identity and derives identity from the directory or mount capability.
- The bridge rejects symlinks, path traversal, non-regular files, oversized files, and invalid JSON.
- Spool directories use owner-only permissions on the host.
- Plaintext message bodies in Maildir are sensitive. Prefer encrypted relay payloads for cross-agent secrets and keep plaintext spool use local to the engineering session.
- Quotas are required. Maildir makes it easy for one agent to create many files.

This aligns with the existing relay invariant that actor identity comes from validated auth context and not from the client payload.

## Perkeep Fit

Perkeep is a better fit for archive and replication than for the realtime path.

Useful Perkeep properties:

- Content-addressed immutable blobs.
- Signed claims and permanodes for mutable views over immutable history.
- Search and indexing over long-lived objects.
- Replication between stores.
- Current 0.12 release added modernized build, Tailscale support, and refreshed storage/encryption work.

Weak fit for V1 realtime agent communication:

- It introduces a Go server and Perkeep operational model into a Node CLI project.
- The main protocol is blob storage, stat, upload, signing, indexing, and search, not a simple low-latency message queue.
- It has its own identity and signing model, which would overlap with `mors` native auth and E2EE.
- It is larger than the immediate isolation problem requires.

Recommended Perkeep role:

- Optional transcript archive after the spool and relay contract is stable.
- Store immutable message bodies or encrypted payloads as blobs.
- Model sessions, threads, and agents as permanodes.
- Store state changes such as read, ack, tool_request, and tool_result as signed claims or immutable event blobs.
- Use Perkeep replication for long-term portability, not for hot delivery.

Do not put Perkeep on the critical path for V1 agent-to-agent communication.

## Implementation Plan

1. Add a `MaildirSpool` adapter behind the existing adapter boundary.
   - No new dependencies.
   - Use Node `fs`, `crypto.randomUUID`, `rename`, and a scan loop.
   - Keep all files under a small module, not in `src/cli.ts`.

2. Add a bridge process.
   - Suggested CLI: `mors spool bridge --root <path> --agent <agent-id>`.
   - The bridge reads outbox/control, sends via `RelayClient`, listens to `/events`, and materializes inbox files.

3. Add deterministic spool tests.
   - Atomic tmp-to-new delivery.
   - Restart scan picks up existing `new` files.
   - Dedupe prevents duplicate relay sends.
   - Malformed files move to `failed`.
   - Sender spoof payload is ignored.
   - Symlink and path traversal attempts are rejected.

4. Add an end-to-end tempdir test.
   - Create two agent spools.
   - Send agent A to agent B.
   - Verify B receives `inbox/new`.
   - Send reply.
   - Ack through `control/new`.
   - Verify relay state and local materialized state converge.

5. Add an optional hook-runner spike.
   - Host-configured allowlist only.
   - Tool request and tool result are regular messages.
   - No executable path from the message is honored directly.

6. Defer Perkeep to a separate spike.
   - Export a completed session transcript from `mors` into Perkeep.
   - Rehydrate a transcript back into a read-only `mors` view.
   - Decide only after measuring operational cost and schema friction.

## Rejected Approaches

- Replace `mors` relay with Maildir: rejected because Maildir is not a network protocol and does not provide auth, routing, or remote realtime.
- Use strict Maildir flags for all state: rejected because `mors` read and ack semantics are richer than email `Seen`.
- Put Perkeep in the realtime send path: rejected because it solves long-term content storage better than low-latency message delivery.
- Let agent messages execute hooks directly: rejected because hook execution must remain a host policy decision.

## Sources

- Maildir overview: https://en.wikipedia.org/wiki/Maildir
- Original Maildir format notes: https://cr.yp.to/proto/maildir.html
- Dovecot Maildir operational notes: https://doc.dovecot.org/2.3/admin_manual/mailbox_formats/maildir/
- Perkeep docs index: https://perkeep.org/doc/
- Perkeep overview: https://perkeep.org/doc/overview
- Perkeep protocol docs: https://perkeep.org/doc/protocol/
- Perkeep permanodes: https://perkeep.org/doc/schema/permanode
- Perkeep 0.12 release: https://perkeep.org/doc/release/0.12
