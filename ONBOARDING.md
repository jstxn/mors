# ONBOARDING.md

This doc defines the **fastest successful path** for new `mors` users.

Goal: a new user should reach first success in under 5 minutes and understand exactly what to do next.

---

## Onboarding principles (non-negotiable)

1. **First success must be local and secret-free**
   - No OAuth setup, no relay infra, no cloud accounts required for first win.
2. **Copy/paste over explanation**
   - New users should run commands, see success, then read details.
3. **Error messages must be actionable**
   - Every failure should tell them the *next command to run*.
4. **Progressive disclosure**
   - Local baseline first, then auth, then relay/remote, then E2EE hardening.
5. **No hidden assumptions**
   - If Node/sqlcipher/env vars are required, state it up front.

---

## 5-minute happy path (local, no relay)

> This path proves lifecycle correctness: `init -> send -> inbox -> read -> ack`.

### Prerequisites

- Node.js 20+
- npm
- SQLCipher (`brew install sqlcipher` on macOS)

### Install from source

```bash
git clone git@github.com:jstxn/mors.git
cd mors
npm ci
npm run build
alias mors='node dist/index.js'
```

### Run the lifecycle

Use a fresh config dir so onboarding is deterministic:

```bash
export MORS_CONFIG_DIR=/tmp/mors-quickstart
rm -rf "$MORS_CONFIG_DIR"

mors init --json
mors send --to demo-recipient --body "hello from quickstart" --json

# Get the newest message id from inbox JSON
MSG_ID=$(mors inbox --to demo-recipient --json | node -e '
let s="";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  const j = JSON.parse(s);
  if (!j.messages?.length) process.exit(1);
  process.stdout.write(j.messages[0].id);
});
')

echo "MSG_ID=$MSG_ID"

mors read "$MSG_ID" --json
mors ack "$MSG_ID" --json
```

### Success criteria

- `init` returns `status: initialized`
- `send` returns `status: sent`
- `inbox` returns at least 1 message
- `read` returns the message body and `read_at`
- `ack` returns `status: acked`

If all five happen, onboarding succeeded.

---

## Optional: 2-minute remote/auth extension

Only after local success.

```bash
# Requires auth env vars configured for your relay setup
mors login --json
mors status --json

# Requires MORS_RELAY_BASE_URL and valid session
mors watch --remote --json
```

Success:
- `status` reports authenticated session
- remote watch connects and streams events

---

## Common failure modes (and exact fixes)

### `Not authenticated. Run "mors login"...`
- You previously enabled auth in this config dir.
- Fix: either run `mors login`, or use a fresh local-only config dir:

```bash
export MORS_CONFIG_DIR=/tmp/mors-quickstart-2
mors init --json
```

### `sqlcipher` / DB open errors
- SQLCipher is missing or misconfigured.
- Fix:

```bash
brew install sqlcipher
npm rebuild
```

### `mors: command not found`
- You installed from source but no global binary.
- Fix:

```bash
alias mors='node dist/index.js'
# or
npm i -g mors
```

### Remote mode fails (`MORS_RELAY_BASE_URL` / auth issues)
- Local mode is still valid; remote is a second phase.
- Fix: complete local 5-minute path first, then configure relay env vars.

---

## What “painless” means (quality bar)

A first-time user should be able to:

- copy commands from this file,
- get a successful message lifecycle,
- understand whether they are in local mode or remote mode,
- recover from one failure without reading source code.

If they cannot do this in under 5 minutes, onboarding is broken and should be fixed before feature work.

---

## Maintainer checklist for every release

- [ ] Commands in this file still match current CLI flags
- [ ] Fresh-machine run of local 5-minute path passes
- [ ] Error messages still include actionable next step
- [ ] README links to this file near the top
- [ ] CI includes a smoke check for quickstart command sequence
