# Environment

Environment variables, dependencies, and setup notes for global relay/auth messaging mission.

**What belongs here:** required env vars, credential placeholders, toolchain/dependency caveats.
**What does NOT belong here:** service ports/commands (use `.factory/services.yaml`).

---

## Runtime baseline

- Node.js + npm
- `python3` and native toolchain for native Node module builds
- SQLCipher dependency remains required for local encrypted persistence

## Placeholder configuration

Use `.env.example` as the source of required placeholders:

- `MORS_RELAY_PORT`, `MORS_RELAY_BASE_URL`
- `MORS_RELAY_SIGNING_KEY` — signing key used by relay to verify native auth tokens. Must match the key used during token issuance. Relay startup enforces non-empty key (fail-closed); empty/unset key causes startup error with remediation guidance.
- `MORS_AUTH_TOKEN_ISSUER`, `MORS_AUTH_AUDIENCE`
- `FLY_APP_NAME`, `FLY_PRIMARY_REGION`, `FLY_ORG`

Note: GitHub OAuth device flow placeholders (`GITHUB_DEVICE_CLIENT_ID`, etc.) are legacy from the pre-native-auth era and may still appear in `.env.example` but are no longer used for account authentication.

Real credentials are intentionally deferred in this phase; workers must fail with actionable guidance when placeholders are unset.

## Security constraints

- Never commit real OAuth or Fly secrets.
- Keep `.env` local-only (`.gitignore` includes `.env`).
- Do not print auth tokens or private key material in normal CLI/server logs.

## dist/ rebuild after source changes

Some test suites (e.g., `test/auth/cli-auth-gating.test.ts`, `test/install.test.ts`) execute from `dist/` rather than TS source. After modifying TypeScript source files, run `npm run build` before the full test suite to avoid stale-`dist/` failures (missing exports, outdated behavior). This is especially relevant when editing relay or CLI entrypoint files.

## flyctl PATH co-location caveat

On macOS with Homebrew, `flyctl` and `node` may share the same bin directory (e.g., `/opt/homebrew/bin`). Test helpers that prune PATH to simulate missing `flyctl` must avoid naively removing directories that also contain `node`, or the test process itself will break.

## SQLCipher caveat (still applies)

- `better-sqlite3-multiple-ciphers` keying does not behave correctly with `:memory:` paths. Encryption verification and fail-closed tests must use temporary on-disk DB files.
