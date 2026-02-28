# mors

`mors` is a markdown-first, CLI-first local messaging system for agents with SQLCipher-backed encrypted-at-rest storage.

## Features

- CLI commands: `init`, `send`, `inbox`, `read`, `reply`, `ack`, `watch`, `thread`
- Explicit processing semantics (`read` does not imply `ack`)
- Causal threading via `thread_id` + `in_reply_to`
- Dedupe + trace ID support with validation
- SQLCipher fail-closed behavior (no plaintext fallback)

## Requirements

- Node.js + npm
- Python 3 (native module build support)
- SQLCipher installed (`brew install sqlcipher` on macOS)

## Setup

```bash
npm install
npm run build
```

## Run

Use an isolated config directory for local testing:

```bash
MORS_CONFIG_DIR=/tmp/mors-demo node dist/index.js init --json
MORS_CONFIG_DIR=/tmp/mors-demo node dist/index.js send --to agent-b --body "hello" --json
MORS_CONFIG_DIR=/tmp/mors-demo node dist/index.js inbox --json
```

## Validate

```bash
npm run lint
npm run typecheck
npm run test -- --maxConcurrency=7
```
