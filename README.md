# mors

`mors` is a CLI-first, agent-first messaging system with a hosted relay, mors-native auth, SSE realtime watch, and 1:1 E2EE.

## Core Capabilities

- Local + relay-backed messaging (`send`, `inbox`, `read`, `ack`, `reply`, `thread`, `watch`)
- Mors-native auth session lifecycle (`login`, `status`, `logout`)
- Realtime remote watch with reconnect/cursor resume and fallback signaling
- 1:1 encryption model with per-device keys, key exchange, rotation, and revocation enforcement
- Install and launch UX: GitHub npm install, Homebrew formula, `setup-shell` prompt-first behavior
- Deploy preflight + Fly deploy command path with placeholder-safe validation and redaction

## Requirements

- Node.js + npm
- Python 3 (native module build support)
- SQLCipher (`brew install sqlcipher` on macOS)

## Setup

```bash
npm install
npm run build
cp .env.example .env
```

Fill placeholder variables in `.env` for relay/auth/deploy workflows as needed.

## Local Usage

```bash
# initialize local identity + encrypted store + device keys
MORS_CONFIG_DIR=/tmp/mors-a mors init --json

# auth lifecycle (placeholder-safe failures until OAuth vars are configured)
MORS_CONFIG_DIR=/tmp/mors-a mors login --json
MORS_CONFIG_DIR=/tmp/mors-a mors status --json

# local or remote messaging
MORS_CONFIG_DIR=/tmp/mors-a mors send --to agent-b --body "hello" --json
MORS_CONFIG_DIR=/tmp/mors-a mors watch --remote --json

# direct node entrypoint (scripted/testing usage)
MORS_CONFIG_DIR=/tmp/mors-a node dist/index.js inbox --json
```

## Deploy

```bash
mors deploy --dry-run --json
```

## Validation

```bash
npm run lint
npm run typecheck
npm run test -- --maxConcurrency=7
```
