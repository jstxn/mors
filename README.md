# mors

`mors` is a CLI-first messaging system with local encrypted storage, relay-backed delivery, mors-native auth, and realtime watch.

## Current behavior

- **Native auth only**: `mors login` uses invite-token bootstrap (no OAuth flow).
- **Bootstrap prerequisites**: `mors init` sets up local identity + device keys; `mors login` requires an invite token (`--invite-token` or `MORS_INVITE_TOKEN`).
- **Onboarding**: `mors onboard --handle --display-name` registers a globally unique handle and profile. Handles are immutable once set.
- **First-contact autonomy model**: message delivery is always allowed (email-like inbox delivery), while autonomous actions remain gated until contact approval.

## Requirements

- Node.js >= 20 + npm
- Python 3 (native module build support)
- SQLCipher (`brew install sqlcipher` on macOS)

## Install

### npm global (GitHub)

```bash
npm install -g github:jstxn/mors
mors --version
mors setup-shell
```

### Homebrew formula path (tap-ready formula)

```bash
brew install --formula ./Formula/mors.rb
mors --version
```

## Local setup (from source)

```bash
npm install
npm run build
cp .env.example .env
node dist/index.js --help
```

## How to use

Use `MORS_CONFIG_DIR` if you want to keep data in a custom folder (for example: `MORS_CONFIG_DIR=/tmp/mors-demo mors inbox`).

```bash
# 1) Initialize your local mors profile
mors init

# 2) Log in with an invite token
mors login --invite-token mors-invite-0123456789abcdef0123456789abcdef

# 3) Complete onboarding (one-time)
mors onboard --handle agent_alice --display-name "Alice Agent"

# 4) Send a message
mors send --to agent-b --body "hello"

# 5) Check your inbox
mors inbox

# 6) Read and acknowledge a message
mors read <message-id>
mors ack <message-id>

# 7) Watch for new events
mors watch
```

## Validation

```bash
npm run lint
npm run typecheck
npm run test -- --maxConcurrency=7
```
