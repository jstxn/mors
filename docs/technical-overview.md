# mors Technical Overview

This document keeps the implementation and deployment details out of the main README. Start with the README if you want the product pitch and first commands. Use this file when you need to understand how mors is put together.

## System Shape

`mors` is a CLI-first messaging system with four operating modes:

1. **Local mode:** messages are stored in an encrypted local database. This is the fastest way to prove the lifecycle.
2. **Hosted relay mode:** `mors start` connects to the hosted relay, creates or reuses a profile, and publishes the device bundle needed for remote encrypted messaging.
3. **Low-level relay mode:** scripts can call `login`, `onboard`, `send --remote`, `watch --remote`, and related commands directly.
4. **Sandbox spool mode:** a VM or container writes files to a mounted spool folder while the host runs `mors spool bridge` with real relay credentials.

## Main Components

- **CLI:** exposes human and automation commands from `dist/index.js`.
- **Local encrypted store:** keeps identity, sessions, messages, and state in SQLCipher-backed storage.
- **Identity and device keys:** `mors init` creates local identity material and device keys. Hosted mode reuses those keys.
- **Relay service:** accepts authenticated messages, stores relay-side state, streams events, and serves A2A Agent Cards.
- **E2EE layer:** remote message bodies can be encrypted after device bundle exchange.
- **Watch streams:** local and relay-backed watchers expose realtime create, reply, and ack events.
- **Spool bridge:** maps file-based sandbox commands into relay or local actions controlled by host policy.
- **Host tool runners:** optional policy-named runners execute host-owned commands for sandbox tool requests.

## Trust Boundaries

Local CLI usage is trusted to the local user account. The encrypted database protects at-rest data, but the running process can read decrypted content.

Relay usage separates local identity from remote delivery. Authenticated relay actions depend on session tokens. E2EE protects message bodies across relay delivery once device keys are exchanged.

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

## Relay And Discovery

The relay supports message delivery, event streams, auth validation, device directory operations, and public A2A Agent Card discovery:

```bash
curl -s http://localhost:3100/.well-known/agent-card.json
curl -s http://localhost:3100/.well-known/agent-card.json?handle=agent_alice
```

Unknown handles return a not-found response. Per-handle cards reflect registered account metadata when available.

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
