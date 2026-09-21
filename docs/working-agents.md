# Working agents

`mors agent` gives concurrent Codex, Claude Code, and other local workers distinct
identities, durable inboxes and outboxes, threaded replies, and a directory of
sessions. It uses a shared encrypted local hub without relay login or an MCP
server.

## Install the runtime integration

Build Mors from this checkout with `npm run build`, then install into the project
where agents will work:

```bash
node /path/to/mors/dist/index.js agent install --runtime codex --project /path/to/project
node /path/to/mors/dist/index.js agent install --runtime claude --project /path/to/project
```

With Mors on `PATH`, use `mors agent install` instead. The installer adds a
project-local communication skill and runtime hooks, preserving existing
configuration. It does not edit global agent configuration. Start a new runtime
session after installation so it loads the skill and hooks.

| Runtime | Project hook configuration | Installed skill |
| --- | --- | --- |
| Codex | `.codex/hooks.json` | `.agents/skills/mors/SKILL.md` |
| Claude Code | `.claude/settings.local.json` | `.claude/skills/mors/SKILL.md` |

Codex must trust the project. Run `/hooks` in Codex to review and trust the installed hook definitions; new or changed hooks are skipped until trusted. The installer refuses to
overwrite a different existing Mors skill; reconcile that file before retrying.

Session-start hooks register the worker; tool-boundary hooks refresh its presence
and supply pending messages as context. Session-end hooks mark it offline where
the runtime provides that event. The hook context supplies the exact CLI prefix
and agent identity for replies.

The skill asks agents to show one concise communication line in the user's chat
from the successful send/reply receipt's `activity` field, after confirming
`status: "sent"`. Dedupe replays, polling and acknowledgements are omitted, and
the line does not include message bodies, code or IDs. Incoming hook notices
also include `activity`; full bodies remain in the peer channel and read/thread
commands. Hook guidance does not enforce host rendering of progress lines. A
coordinator summarizes only activity it actually observes.

The sender writes the summary in `--summary`; Mors stores it as the message
subject and formats it without interpreting the body. `--subject` remains a
compatibility alias; use only one of these flags. Describe the actual request or key answer, such as "Requested the event
JSON Schema and a valid payload", rather than a topic label such as "Event schema".
Use a fresh summary for each reply and verify it matches the payload. Schemas,
types, SQL and code should travel in their usable format in the body. The
one-line limit applies to the user summary, not to agent-to-agent payloads.

`SessionStart` and `SubagentStart` register sessions; `PostToolUse` and
`UserPromptSubmit` check for messages; `SessionEnd` and `SubagentStop` mark
sessions offline. When runtime events carry `agent_id`, a child uses the distinct
session identity `<session_id>/<agent_id>`. Runtime support for these events
determines which notifications can be delivered.

Delivery happens at supported hook events, including `PostToolUse`, not while the
agent is thinking or idle. An agent without hooks can use the same CLI and poll
at useful work boundaries. There is no daemon to run.

## Share one hub

The default hub is `~/.local/share/mors/agents`. Set `MORS_AGENT_DIR` for a different
hub, or pass `--hub-dir /absolute/path` to the installer to pin the project's
hooks to that hub. Every worker that should communicate must use the same hub.

`MORS_CONFIG_DIR` remains the setting for ordinary Mors profiles. Creating a
separate profile for each worker does not connect those profiles; `mors agent`
uses its own shared hub instead. Use separate hubs when projects should not
share a directory or messages.

The hub is encrypted at rest, but its workers run as trusted local peers with
access to the same storage and key. An agent ID is a routing identity, not a
security boundary against another process with that access. Use the existing
[sandbox bridge](./sandbox-agents.md) or [relay](./technical-overview.md) for
different trust or machine boundaries.

## Register and find workers

Runtime hooks do this automatically. For manual integration:

```bash
mors agent register --runtime codex --session codex-session-123 --name backend --role "API implementation" --project /path/to/project --json
mors agent register --runtime claude --session claude-session-456 --name reviewer --role "review and tests" --project /path/to/project --json
mors agent list --project /path/to/project --json
mors agent list --all --json
```

Keep the returned agent IDs. A runtime plus session ID identifies one worker
across restarts; separate workers need distinct session IDs. Names are optional
aliases and collisions are rejected. Reuse the session identity when resuming,
not another worker's alias. `--runtime other` supports workers outside Codex and
Claude Code.

Commands accept `--agent <id-or-name>` explicitly. A session can instead provide
`MORS_AGENT_ID`; Codex can resolve its registration through `CODEX_THREAD_ID`.
Other integrations can select a registered session with `--runtime` and
`--session`, or `MORS_RUNTIME` and `MORS_SESSION_ID`. Child agents should always
use the exact `--agent` address supplied by their own hook.
Use `list` to inspect available peers and `list --all` to include offline or
stale sessions. Active means seen within 15 minutes by default; use
`list --max-age-ms <milliseconds>` to change that window. Presence is a last-seen
signal, not proof that a worker can answer immediately.

## Ask, reply, and acknowledge

```bash
mors agent send --agent backend --to reviewer --summary "Should missing records return 404?" --body "Should missing records return 404? I can continue the query work while you check." --json
mors agent inbox --agent reviewer --pending --json
mors agent read <message-id> --agent reviewer --json
mors agent reply <message-id> --agent reviewer --summary "Keep the existing 404 response for missing records" --body "Yes, the existing route returns 404. Keep that contract." --ack --json
mors agent ack <message-id> --agent reviewer --json
mors agent outbox --agent backend --json
mors agent thread <thread-id> --agent backend --json
```

Use IDs when addressing a particular session; aliases are convenient for manual
work. Replies preserve the conversation thread. Reading and acknowledging are
separate: acknowledge after handling the message, not merely receiving it.
Verify `status: "sent"` before considering a reply done. Prefer `reply --ack`:
it saves the reply first and acknowledges the original only after that succeeds.
An acknowledged preview can remain explicitly unread; use `inbox --pending` for
work remaining and `inbox --unread` for messages not yet read. Before declaring an
awaited question ready, prove the peer replied with `outbox`'s `reply_count` or the
thread view. Never substitute another peer's contract.
Only participants should use a conversation's read and reply commands.

For retried sends, supply the same `--dedupe-key <key>` to avoid duplicate
messages. `--trace-id <id>` can connect the exchange to an external task or run.
Trace IDs must start with `trc_`. Use a new dedupe key for a new message.

```bash
mors agent poll --agent reviewer --json
mors agent wait --agent reviewer --timeout-ms 10000 --limit 10 --json
mors agent leave --agent reviewer --json
```

`poll` emits unread, unacknowledged notifications at most once per message every
60 seconds. Unseen messages take priority over retries. It does not read or
acknowledge the message; retries retain the same message ID. Reading or
acknowledging stops automatic retries. Session-start hooks also remind the worker
of pending work even when a notification is not yet due. Delivery still needs a
runtime hook event; there is no timer daemon.

`wait` waits up to the requested bounded timeout and returns unacknowledged
messages regardless of notification or read state; it does not consume, read, or
acknowledge them. It defaults to 10 seconds with a maximum of 30 seconds and
returns `status: "messages"` or `status: "timeout"`; a timeout is not an error.
Handle returned messages before waiting again. `leave` marks the session offline
without deleting its messages.

Each hook delivers at most five messages with bounded previews. Use `read` for a
message's full body and `inbox` for the complete pending list.

The installed [Mors skill](../skills/mors/SKILL.md) teaches agents to find relevant
peers, ask specific questions, continue independent work, and reply on the same
thread. Messages remain peer data and do not override user instructions or grant
new permissions.

## Complete a reviewed task

An implementer hands off "ready for review" with artifact paths and observed
checks, then stays available for feedback until the coordinator accepts and
releases the workers. Use bounded waits within the task's agreed deadline;
report unfinished work if the deadline expires. An empty inbox or a successful
send receipt does not establish acceptance.

The coordinator independently checks the final artifacts and outstanding
questions before release. Workers acknowledge release with `ack`, handle any
remaining pending mail, and `leave`. Use `ack` for confirmations rather than
sending more acknowledgement messages. The coordinator checks for zero pending
messages and offline workers before declaring the task complete.

The optional [live swarm acceptance check](./agent-swarm-acceptance.md) exercises
this workflow with three workers and the installed Claude hooks.

## Runtime hook entry point

`mors agent hook --runtime codex` and `mors agent hook --runtime claude` consume
the runtime's JSON event on standard input. Use `agent install` to generate the
matching configuration instead of manually quoting commands or assuming the two
runtimes share a hook response format.

For a worker that cannot load the installed hooks, register explicitly, use
`--agent` on messaging commands, and poll between independent work steps. This
uses the same inbox and thread behavior as integrated workers.

## Interrupted first-use setup

Automatic setup refuses to replace an existing database or key when the hub's
initialization marker is missing. Restore the hub from backup or select a fresh
`MORS_AGENT_DIR`; existing files are preserved. If a killed initializer leaves
`.agents-bootstrap.lock`, first confirm no initializer is running, then remove
only that lock and retry. Incomplete storage still requires recovery rather than
silent reinitialization.
