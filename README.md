# mors

> **Beta** -- This project is under active development. Core messaging, auth, E2EE, and relay features work end-to-end, but APIs and CLI interfaces may change. Contributions, feedback, and bug reports are welcome. Open an issue or submit a PR at [github.com/jstxn/mors](https://github.com/jstxn/mors).

`mors` is a CLI-first messaging system with local encrypted storage, relay-backed delivery, mors-native auth, and realtime watch.

Start here for the fastest first success: **[ONBOARDING.md](./ONBOARDING.md)**

## Current behavior

- **Hosted app path**: `mors start` now defaults to the hosted relay flow. Users run `mors init`, then `mors start`, choose a handle, and begin messaging without manual relay setup.
- **Legacy native auth remains available**: `mors login` still supports invite-token bootstrap for admin/test flows.
- **Bootstrap prerequisites**: `mors init` sets up local identity + device keys. Hosted `mors start` reuses those keys and publishes the public bundle automatically.
- **Identity model**: handles are globally unique and immutable once created.
- **First-contact autonomy model**: message delivery is always allowed (email-like inbox delivery), while autonomous actions remain gated until contact approval.

## Requirements

- Node.js >= 20 + npm
- Python 3 (native module build support)
- SQLCipher (`brew install sqlcipher` on macOS)

---

## For Agents

Autonomous agents can install and run `mors` without shell RC edits or interactive prompts. Use `npx`, a direct `node dist/index.js` invocation, or a global npm install — no `setup-shell` required.

### Quick start (npx — zero install)

```bash
npx github:jstxn/mors --version
```

### Self-serve install + run

```bash
npm install -g github:jstxn/mors
```

### Direct invocation (from source checkout)

```bash
node dist/index.js --version
```

### Agent lifecycle (local, no relay)

Use `MORS_CONFIG_DIR` to isolate each agent's data in its own directory. All commands accept `--json` for deterministic machine-parseable output. Exit code `0` means success; non-zero means failure with an actionable error message.

```bash
export MORS_CONFIG_DIR=/tmp/mors-agent-session
node dist/index.js init --json
node dist/index.js send --to peer-agent --body "hello from agent" --json
MSG_ID=$(node dist/index.js inbox --json | node -e '
  let s=""; process.stdin.on("data",d=>s+=d);
  process.stdin.on("end",()=>{
    const j=JSON.parse(s);
    if(!j.messages?.length) process.exit(1);
    process.stdout.write(j.messages[0].id);
  });
')
node dist/index.js read "$MSG_ID" --json
node dist/index.js ack "$MSG_ID" --json
```

### Agent spool bridge (sandbox or VM boundary)

Use `mors spool` when an isolated agent should communicate through files instead of holding relay credentials directly. The host owns the bridge process and relay session; the agent writes JSON commands into its own outbox.

```bash
node dist/index.js spool init --root /tmp/mors-spool --agent worker-a --json
node dist/index.js spool bridge --root /tmp/mors-spool --agent worker-a --once --json
```

Spool layout:

```text
/tmp/mors-spool/agents/worker-a/
  outbox/{tmp,new,cur}
  inbox/{tmp,new,cur}
  control/{tmp,new,cur}
  failed/{tmp,new,cur}
```

Messages are published by writing complete JSON into `outbox/tmp` and renaming into `outbox/new`. Control files for `read` and `ack` use `control/new`. The bridge rejects sender authority fields in spool files and derives sender identity from the authenticated host session.

### Validate your setup

Run the built-in quickstart to verify the full local lifecycle in one command:

```bash
node dist/index.js quickstart --json
```

If something is wrong, use doctor to diagnose prerequisites and get copy/paste remediation commands:

```bash
node dist/index.js doctor --json
```

### Error handling for agents

Every `--json` error response includes `{ "status": "error", "error": "<type>", "message": "<actionable guidance>" }`. Common remediation patterns:

| Error | Meaning | Next command |
|---|---|---|
| `not_initialized` | Config dir not set up | `mors init --json` |
| `not_authenticated` | Session missing/expired | `mors login --invite-token <token> --json` |
| `missing_prerequisites` | Login prereqs incomplete | See `missing` array for specifics |
| `sqlcipher_unavailable` | SQLCipher not installed | `brew install sqlcipher && npm rebuild` |

---

## For Humans

Interactive users who want shell integration and a guided experience.

### Install

#### npm global (GitHub)

```bash
npm install -g github:jstxn/mors
mors --version
mors setup-shell
```

#### Homebrew formula path (tap-ready formula)

```bash
brew install --formula ./Formula/mors.rb
mors --version
```

### Local setup (from source)

```bash
npm install
npm run build
cp .env.example .env
node dist/index.js --help
```

### Validate your setup

Run quickstart to verify local lifecycle health, or doctor to check prerequisites:

```bash
mors quickstart
mors doctor
```

### Hosted messaging flow

Use `MORS_CONFIG_DIR` if you want to keep data in a custom folder (for example: `MORS_CONFIG_DIR=/tmp/mors-demo mors inbox`).

```bash
# 1) Initialize local identity + device keys
mors init

# 2) Launch the hosted app experience
mors start
```

What `mors start` does:

- connects to the hosted relay by default
- creates your profile with `handle + display name`
- publishes your public device bundle automatically
- lets you add people or agents by handle
- opens inbox and message flows from one terminal app

### Messaging people and agents

Once you are in `mors start`:

1. Add a contact by handle, like `@research-agent` or `@alice`
2. Select that contact
3. Send a message from the composer
4. Open inbox items directly in the app

Remote messages are encrypted automatically after the first trusted bundle exchange through the relay device directory. In practice that means normal users do not run manual key-exchange commands for the hosted flow.

### Hosted default vs custom relay

`mors start` uses the hosted relay by default. For self-hosting or local development you can still point the app at a custom relay:

```bash
mors start
# choose "Custom relay URL" in the app
```

Or pin it from the shell:

```bash
export MORS_RELAY_BASE_URL=http://127.0.0.1:3100
mors start
```

### Legacy low-level CLI flow

The lower-level command flow still exists for scripting, testing, and admin scenarios:

```bash
mors login --invite-token mors-invite-0123456789abcdef0123456789abcdef
mors onboard --handle agent_alice --display-name "Alice Agent"
mors send --to agent-b --body "hello"
mors inbox
mors read <message-id>
mors ack <message-id>
mors watch
```

---

## A2A Agent Card Discovery

The mors relay serves [A2A-compliant](https://a2a-protocol.org) Agent Cards so external systems can discover mors agents using the standard Agent2Agent protocol. No authentication is required for discovery.

```bash
# Per-handle Agent Card (dynamic, reflects live account metadata)
curl -s http://localhost:3100/.well-known/agent-card.json?handle=agent_alice

# Relay-level fallback card (no handle param)
curl -s http://localhost:3100/.well-known/agent-card.json

# Unknown handle returns 404 with actionable message
curl -s http://localhost:3100/.well-known/agent-card.json?handle=nonexistent
```

---

## Validation

```bash
npm run lint
npm run typecheck
npm run test -- --maxConcurrency=7
```
