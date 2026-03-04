# User Testing Surface

Manual validation guidance for global CLI + relay + SSE + E2EE mission.

**What belongs here:** runnable user-facing validation flows, setup, and known environment constraints.

---

## Surfaces to test

1. **CLI**: `login`, `status`, `logout`, `send`, `inbox`, `read`, `reply`, `ack`, `watch`.
2. **Relay HTTP API**: health/auth/authorization/message endpoints via `curl`.
3. **SSE stream**: authenticated connection, reconnect/cursor resume, dedupe behavior.
4. **Install/deploy UX**: npm GitHub install, setup-shell prompt behavior, Fly deploy command error paths.

## Setup and isolation

- Run `.factory/init.sh` first.
- Use isolated directories for each identity/device (`MORS_CONFIG_DIR=<tempdir>`).
- Use separate identities for sender/recipient and separate device dirs for multi-device assertions.
- Capture both stdout/stderr and exit codes for every manual step.

## Evidence requirements

- CLI/API transcripts with explicit command lines and exit codes.
- JSON outputs whenever available.
- SSE event logs showing event IDs/cursors and reconnect behavior.
- Canary checks proving no plaintext message-body leakage in relay payloads/logs.

## Accepted limitations

- Real OAuth/Fly credentials may be absent during placeholder-first phase; validate safe-failure guidance where credentials are missing.
- `flyctl` may be unavailable locally; missing-tool remediation output is valid evidence for deploy failure-path assertions.
- `tuistory` is unavailable; CLI/API/SSE transcript evidence is the primary validation mode.

## Known infrastructure issue

- `user-testing-flow-validator` subagent sessions can fail with environment permission errors. If this recurs, run flow checks inline and record that deviation.

---

## Flow Validator Guidance: CLI

**Testing tool:** Direct CLI invocation via `node dist/index.js` or `npx tsx src/index.ts` with `MORS_CONFIG_DIR` isolation.

**Isolation rules:**
- Each subagent MUST use a unique `MORS_CONFIG_DIR` (e.g., `/tmp/mors-test-<group-id>-<n>`).
- Each subagent tests with its own device directory — do NOT share config dirs across subagents.
- For multi-device assertions, create two separate `MORS_CONFIG_DIR` paths within the same subagent.
- Do not modify or read another subagent's config directories.

**Auth testing:**
- OAuth credentials are placeholder-first. `mors login` will fail with actionable missing-config guidance when `GITHUB_DEVICE_CLIENT_ID` is unset — this is expected behavior for VAL-AUTH-007.
- To test session persistence (VAL-AUTH-002), manually create a session.json file in the config dir simulating a successful login, then verify loadSession reads it back.
- To test logout (VAL-AUTH-005), save a session, then use clearSession or invoke the logout path and verify session is gone.
- For multi-device (VAL-AUTH-009), save two sessions in two different MORS_CONFIG_DIR directories with the same githubUserId but different deviceIds.

**E2EE testing:**
- Device key bootstrap (VAL-E2EE-001): Use `generateDeviceKeys()` + `persistDeviceKeys()` directly, or `mors init --json` if the CLI command wires bootstrap.
- Key exchange (VAL-E2EE-002): Generate two device key bundles, perform key exchange using `performKeyExchange()`, verify session is persisted.
- Group E2EE rejection (VAL-E2EE-008): Call `validateConversationType('group')` and verify it throws `GroupE2EEUnsupportedError`.

---

## Flow Validator Guidance: Developer Launch & Deploy

**Testing tool:** Direct CLI invocation via `node dist/index.js` with `MORS_CONFIG_DIR` isolation, plus filesystem checks.

**Isolation rules:**
- Each subagent MUST use unique temp dirs for `MORS_CONFIG_DIR` (e.g., `/tmp/mors-launch-test-<group-id>`)
- Do NOT share config dirs across subagents
- For multi-device assertions within one subagent, use separate `MORS_CONFIG_DIR` paths

**Install testing (VAL-LAUNCH-001):**
- Verify `dist/index.js` exists after build, `npm pack` includes all required files
- Run `node dist/index.js --version` to confirm binary works
- The install test suite (`test/install.test.ts`, `test/install-matrix.test.ts`) covers npm GitHub install simulation
- Test that build succeeds even without global `tsc` (uses local `npx tsc`)

**Setup-shell testing (VAL-LAUNCH-002, 003, 004):**
- `test/setup-shell.test.ts` covers preview/prompt, decline path, confirm path, idempotency
- Verify: preview shows exact RC changes before mutation, decline leaves files unchanged, confirm applies minimal edit, repeated runs are no-op

**First-run flow (VAL-LAUNCH-005):**
- `test/install-matrix.test.ts` covers version → init → send → inbox → read lifecycle
- Verify exit codes for each step

**Deploy testing (VAL-DEPLOY-001, 002, 003):**
- `test/deploy/fly.test.ts` covers fly.toml presence, placeholder-safe handling, missing flyctl, missing auth
- `test/deploy/shell-injection-safety.test.ts` covers safe subprocess execution
- Verify no secrets in output/logs

**Cross-area golden path (VAL-CROSS-001, 005, 006, 007, 008):**
- `test/cross/golden-path.test.ts` covers all five assertions through programmatic relay server + E2EE tests
- These tests use ephemeral ports and in-memory stores with stub auth
- Multi-device tests create separate key material directories
- Restart integrity tests use snapshot/rehydrate pattern

---

## Flow Validator Guidance: Relay API

**Testing tool:** `curl` against `http://localhost:3100` (relay must be running on port 3100).

**Isolation rules:**
- Subagents testing relay API may share the relay server but MUST NOT create data that interferes with other subagents.
- Use unique conversation IDs per subagent (e.g., `conv-<group-id>-<n>`).
- The relay is configured with stub token verifiers in tests — for user testing, the production relay is running but without real GitHub OAuth configured, so auth-related curl tests should verify 401 behavior for missing/invalid auth headers.

**Auth guard testing:**
- Health endpoint (`GET /health`) is public — always returns 200.
- All other endpoints require Bearer token — verify 401 for missing/invalid tokens.
- Conversation endpoints additionally check participant authorization — verify 403 for non-participants.
- Without real GitHub OAuth configured, the production relay token verifier will call GitHub API — tokens will fail validation. This is correct behavior for testing 401 paths.

**Evidence format:**
- Include full curl command with `-v` flag for header inspection.
- Capture HTTP status code and JSON response body.
- Verify error field matches expected value (`unauthorized` or `forbidden`).

---

## Flow Validator Guidance: Relay Async Messaging (global-async-messaging)

**Testing tool:** Programmatic Node.js scripts using the relay server library + RelayClient, or vitest tests with stub auth. The existing test suite provides comprehensive coverage for all relay messaging assertions.

**Testing approach for this milestone:**
Since the relay uses in-memory storage and GitHub OAuth is placeholder-first (no real tokens), the most reliable validation method is:
1. Run the existing vitest test suite which exercises all assertions through real HTTP servers with stub auth
2. Verify via curl against the running relay (port 3100) for auth guard behavior (401 for all protected routes since production token verifier calls GitHub API)
3. Use programmatic scripts importing library code directly for E2EE operations

**Test files covering assertions:**
- `test/relay/async-core.test.ts` → VAL-RELAY-001, VAL-RELAY-002, VAL-RELAY-003
- `test/relay/thread-dedupe.test.ts` → VAL-RELAY-004, VAL-RELAY-005, VAL-RELAY-009, VAL-RELAY-010
- `test/relay/offline-retry.test.ts` → VAL-RELAY-006, VAL-RELAY-007
- `test/relay/spoof-prevention.test.ts` → VAL-RELAY-008
- `test/e2ee/cipher-runtime.test.ts` → VAL-E2EE-003, VAL-E2EE-004, VAL-E2EE-009
- `test/e2ee/rekey-rotation.test.ts` → VAL-E2EE-005, VAL-E2EE-006, VAL-E2EE-007

**Isolation rules:**
- Each subagent MUST use a unique random port range for relay servers (30000-39999)
- Each subagent MUST use unique temp directories for E2EE key material
- Relay tests use stub token verifiers with well-known test tokens (token-alice, token-bob, token-eve)
- Test identities: alice (userId=1001), bob (userId=1002), eve (userId=1003)

**Evidence requirements:**
- vitest output showing test names and pass/fail status
- curl transcripts for relay API auth guard checks
- For E2EE: canary plaintext absence verification in relay store/log artifacts

---

## Flow Validator Guidance: SSE Realtime Streaming (realtime-watch)

**Testing tool:** vitest test suite + `curl` against relay on port 3100.

**Test approach:**
SSE streaming assertions are best validated through the existing integration test suite which uses real relay servers with in-memory stores, stub auth, and raw HTTP SSE connections. The tests exercise:
- Authenticated SSE connection setup with proper headers (text/event-stream, Cache-Control: no-cache)
- Event shape validation (event type, event ID, message ID, thread ID, in_reply_to)
- Last-Event-ID cursor resume with gap detection
- Startup determinism (no historical create spam)
- Duplicate replay deduplication to exactly-once transitions
- Mid-stream auth expiry with auth_expired event and clean disconnect
- Fallback mode when SSE is unavailable (explicit degraded indication)

**Test files covering stream assertions:**
- `test/stream/connect-shape.test.ts` → VAL-STREAM-001, VAL-STREAM-002
- `test/stream/resume-dedupe.test.ts` → VAL-STREAM-003, VAL-STREAM-004, VAL-STREAM-005
- `test/stream/auth-fallback.test.ts` → VAL-STREAM-006, VAL-STREAM-007
- `test/stream/cli-watch-remote.test.ts` → VAL-STREAM-001, VAL-STREAM-003, VAL-STREAM-007 (CLI integration)
- `test/cross/async-stream-consistency.test.ts` → VAL-CROSS-002, VAL-CROSS-003, VAL-CROSS-004

**curl validation against running relay:**
- `GET /health` (public, expect 200) validates relay is up
- `GET /events` without auth header → 401 with `{"error":"unauthorized"}` confirms auth guard on SSE
- `GET /events` with invalid Bearer token → 401 confirms token validation
- `GET /messages` without/with invalid auth → 401 confirms consistent auth across async and realtime surfaces (VAL-CROSS-002)

**Isolation rules:**
- Tests use ephemeral OS-assigned ports (port 0) for relay servers
- Each test creates its own RelayMessageStore and token verifier
- Stub tokens: token-alice (userId=1001), token-bob (userId=1002)
- No shared state between test files

---

## Flow Validator Guidance: Native Identity (native-identity-core)

**Testing tool:** Direct CLI invocation via `node dist/index.js` with `MORS_CONFIG_DIR` isolation.

**Assertions covered:** VAL-AUTH-001, VAL-AUTH-002, VAL-AUTH-007, VAL-AUTH-011

**Setup:**
- Build first: `npm run build`
- Use `mors init --json` to create a fully initialized config directory (creates identity, device keys, init sentinel)
- Generate invite tokens: `mors-invite-$(openssl rand -hex 32)`
- Each test uses a unique `MORS_CONFIG_DIR` temp directory

**Known issue (fixed):**
- The CLI login command originally checked for `device.pub` and `device.key` files, but `mors init` creates `device-keys.json`, `x25519.key`, and `ed25519.key`. This was fixed by using the canonical `isDeviceBootstrapped()` function. Test `simulateFullInit` helpers were updated to match the real file layout.

**Test flow:**
1. `mors init --json` → creates identity + device keys
2. `mors login --invite-token <token> --json` → native auth, no GitHub dependency
3. `mors status --json --offline` → persisted session with same account_id
4. `mors login --json` (no token) → exit code 1, missing_prerequisites with remediation
5. `mors login --invite-token "invalid" --json` → exit code 1, invalid_invite_token

---

## Flow Validator Guidance: Onboarding Handle Profile

**Testing tool:** Direct CLI invocation via `node dist/index.js` with `MORS_CONFIG_DIR` isolation, plus relay API via `curl`/`fetch`.

**Assertions covered:** VAL-AUTH-008, VAL-AUTH-009, VAL-AUTH-012

**Setup:**
- Build first: `npm run build`
- Start relay with signing key: `MORS_RELAY_SIGNING_KEY=<key> PORT=3100 npm run relay:dev`
- Use `MORS_CONFIG_DIR` temp dirs for each test identity
- Generate invite tokens with `generateInviteToken()` from `src/auth/native.ts`

**Isolation rules:**
- Each subagent MUST use unique `MORS_CONFIG_DIR` temp directories
- Use separate relay server instances (ephemeral port 0) for relay API tests to avoid cross-subagent interference
- For multi-device tests, use two separate `MORS_CONFIG_DIR` paths with the same invite token

**VAL-AUTH-008 (handle uniqueness + immutability):**
1. Start a relay server with AccountStore
2. Register handle "alice" for account A → 201
3. Attempt same handle "alice" for account B → 409 (duplicate_handle)
4. Attempt "ALICE" / " alice " for account C → 409 (normalization catches duplicates)
5. Attempt different handle for account A → 409 (immutable_handle)
6. CLI `mors onboard --handle <handle> --display-name <name> --json` with relay → persists handle + profile

**VAL-AUTH-009 (multi-device):**
1. Generate one invite token
2. `mors init --json` + `mors login --invite-token <token> --json` in two separate config dirs
3. Both produce same account_id but different device_id
4. `mors status --json` on each shows correct device identity
5. Relay device listing shows both devices under one account

**VAL-AUTH-012 (onboarding wizard):**
1. CLI `mors onboard --handle <handle> --display-name <name> --json` requires both fields
2. Missing fields → error with missing_required_fields
3. Successful onboard → persists profile.json locally + registers with relay
4. `onboard` appears in `--help` output

---

## Flow Validator Guidance: Autonomy Permissions

**Testing tool:** Relay HTTP API via programmatic fetch or curl. Also vitest tests in `test/relay/first-contact-policy.test.ts`.

**Assertions covered:** VAL-RELAY-011, VAL-RELAY-012, VAL-RELAY-013

**Setup:**
- Build first: `npm run build`
- Start relay with signing key: `MORS_RELAY_SIGNING_KEY=<key> PORT=3100 MORS_RELAY_HOST=127.0.0.1 npm run relay:dev`
- Generate native session tokens using `generateSessionToken()` from `src/auth/native.ts` with matching signing key
- Token format: `mors-session.<base64url-payload>.<hmac-hex-signature>`

**Token generation (inline):**
Tokens can be generated inline using crypto primitives:
```typescript
import { createHmac, randomUUID } from 'node:crypto';
function generateSessionToken(opts: { accountId: string; deviceId: string; signingKey: string }): string {
  const payload = { accountId: opts.accountId, deviceId: opts.deviceId, issuedAt: new Date().toISOString(), tokenId: randomUUID() };
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', opts.signingKey).update(payloadStr).digest('hex');
  return `mors-session.${payloadStr}.${signature}`;
}
```

**Isolation rules:**
- Each subagent MUST use unique account IDs (e.g., `acct_<group>_<n>`)
- Contact state is per-account scoped; different account IDs won't collide
- The relay uses in-memory storage; restart clears all state

**API endpoints for autonomy-permissions:**
- `POST /messages` — send message (includes `first_contact` and `autonomy_allowed` annotations in response)
- `GET /inbox` — list inbox (each message annotated with `first_contact` and `autonomy_allowed`)
- `POST /contacts/status` — check contact status (`{ contact_account_id: "..." }` → `{ status, autonomy_allowed }`)
- `POST /contacts/approve` — approve a contact (`{ contact_account_id: "..." }` → enables autonomy)
- `GET /contacts/pending` — list pending (unapproved) contacts

**Test files covering assertions:**
- `test/relay/first-contact-policy.test.ts` → VAL-RELAY-011, VAL-RELAY-012, VAL-RELAY-013 (26 tests)
- `test/relay/entrypoint-wiring.test.ts` → confirms contactStore wiring in production entrypoint

---

## Flow Validator Guidance: Agent-Friendly Install UX (agent-friendly-install-ux)

**Testing tool:** Direct CLI invocation via `node dist/index.js` with `MORS_CONFIG_DIR` isolation. No relay needed.

**Build requirement:** Run `npm run build` before testing to ensure `dist/index.js` is fresh.

**Assertions covered:** VAL-LAUNCH-006, VAL-LAUNCH-007, VAL-LAUNCH-008, VAL-LAUNCH-009

**Isolation rules:**
- Each subagent MUST use a unique `MORS_CONFIG_DIR` temp directory (e.g., `/tmp/mors-agent-ux-<group>`)
- No relay service is needed for these assertions
- Do NOT share config dirs across subagents

**VAL-LAUNCH-006 (Agent self-install/run without shell mutation):**
1. Create a temp config dir, run `node dist/index.js --version` with `MORS_CONFIG_DIR` set → exit 0 + version output
2. Run `node dist/index.js init --json` with `MORS_CONFIG_DIR` set → exit 0, valid JSON with initialized status
3. Confirm no shell RC files were created or modified
4. The key validation: an agent can invoke mors, do init, and run lifecycle commands without setup-shell

**VAL-LAUNCH-007 (Quickstart first-success lifecycle):**
1. Create fresh temp config dir
2. Run `node dist/index.js quickstart --json` with `MORS_CONFIG_DIR` → exit 0
3. Validate JSON output has `steps` array with init/send/inbox/read/ack entries, all passed
4. Validate `summary.total` and `summary.passed` counts match
5. Run without --json → check human-readable output with success marker
6. Test failure path: corrupt the config dir to simulate failure and verify remediation guidance

**VAL-LAUNCH-008 (Doctor actionable remediation):**
1. Create initialized config dir with `node dist/index.js init --json`
2. Run `node dist/index.js doctor --json` → exit 0, JSON with checks array
3. Each check has name, status (pass/warn/fail), and message
4. Verify node_version and sqlcipher checks pass
5. Test unhealthy path: use empty config dir (no init) → doctor reports init check fail with remediation
6. Verify remediation commands are present and copy/paste-ready (e.g., "mors init")
7. Run without --json → human-readable output with pass/fail indicators

**VAL-LAUNCH-009 (README audience-split):**
1. Read README.md, verify "## For Agents" and "## For Humans" sections exist
2. Agent section includes: npx path, npm global install, direct node invocation, MORS_CONFIG_DIR usage, --json flags
3. Human section includes: npm global install + setup-shell, Homebrew path, interactive usage
4. Validate one command from agent section: `node dist/index.js --version` → exit 0
5. Validate one command from agent lifecycle: init → send → inbox → read → ack with --json

---

## Flow Validator Guidance: A2A Agent Card Discovery (agent-card-discovery)

**Testing tool:** `curl` against relay on port 3100. No CLI or browser automation needed — pure JSON API.

**Assertions covered:** VAL-A2A-001, VAL-A2A-002, VAL-A2A-003, VAL-A2A-004, VAL-A2A-005

**Setup:**
- Build first: `npm run build`
- Start relay with signing key: `MORS_RELAY_SIGNING_KEY=<key> PORT=3100 MORS_RELAY_HOST=127.0.0.1 npm run relay:dev`
- The relay is already running at http://localhost:3100 for this validation session
- Signing key for this session: `validation-signing-key-a2a-test-2024`

**Token generation for account registration:**
To test VAL-A2A-004 (live account metadata), you need to register an account via `POST /accounts/register`. This requires a valid mors-session token. Generate one using:
```bash
# Generate a valid mors-session token for account registration
node -e "
const crypto = require('crypto');
const signingKey = 'validation-signing-key-a2a-test-2024';
const payload = { accountId: 'acct_a2a_test_1', deviceId: 'dev_a2a_test_1', issuedAt: new Date().toISOString(), tokenId: crypto.randomUUID() };
const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
const signature = crypto.createHmac('sha256', signingKey).update(payloadStr).digest('hex');
console.log('mors-session.' + payloadStr + '.' + signature);
"
```

**Endpoint reference:**
- `GET /.well-known/agent-card.json` — Relay-level fallback Agent Card (no handle param)
- `GET /.well-known/agent-card.json?handle={handle}` — Per-handle Agent Card
- `POST /accounts/register` — Register handle + profile (requires Bearer token, body: `{"handle":"...", "display_name":"..."}`)

**Isolation rules:**
- All assertions can be tested by a single subagent (no isolation conflict — read-only except for account registration)
- Use unique account IDs and handles per test run
- The relay uses in-memory storage; data is ephemeral

**Expected A2A Agent Card structure:**
- `name`: handle or relay name
- `description`: relay/agent description
- `version`: version string
- `supportedInterfaces`: array with URL, protocolBinding, protocolVersion
- `capabilities`: object with streaming, pushNotifications
- `skills`: array of skill objects
- `securitySchemes`: object with mors_bearer auth scheme
- `securityRequirements`: array referencing security scheme
- `defaultInputModes` / `defaultOutputModes`: content type arrays

**Sensitive fields that MUST NOT appear:**
- No signing keys, session tokens, internal account IDs, device IDs
- No internal relay state, store references, or config values
- Only public discovery information (handle, display name, endpoint, capabilities, auth scheme)
