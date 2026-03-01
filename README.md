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
```

## Local usage

```bash
# 1) Initialize identity + encrypted store + device keys
MORS_CONFIG_DIR=/tmp/mors-a mors init --json

# 2) Login with invite-token bootstrap
MORS_CONFIG_DIR=/tmp/mors-a mors login \
  --invite-token mors-invite-0123456789abcdef0123456789abcdef \
  --json

# 3) Complete onboarding (global immutable handle + profile)
MORS_CONFIG_DIR=/tmp/mors-a mors onboard \
  --handle agent_alice \
  --display-name "Alice Agent" \
  --json

# 4) Send and watch
MORS_CONFIG_DIR=/tmp/mors-a mors send --to agent-b --body "hello" --json
MORS_CONFIG_DIR=/tmp/mors-a mors watch --remote --json
```

## Validation

```bash
npm run lint
npm run typecheck
npm run test -- --maxConcurrency=7
```
