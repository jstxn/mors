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
