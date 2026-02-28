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
- `GITHUB_DEVICE_CLIENT_ID`, `GITHUB_DEVICE_SCOPE`, `GITHUB_DEVICE_ENDPOINT`, `GITHUB_TOKEN_ENDPOINT`
- `MORS_AUTH_TOKEN_ISSUER`, `MORS_AUTH_AUDIENCE`
- `FLY_APP_NAME`, `FLY_PRIMARY_REGION`, `FLY_ORG`

Real credentials are intentionally deferred in this phase; workers must fail with actionable guidance when placeholders are unset.

## Security constraints

- Never commit real OAuth or Fly secrets.
- Keep `.env` local-only (`.gitignore` includes `.env`).
- Do not print auth tokens or private key material in normal CLI/server logs.

## SQLCipher caveat (still applies)

- `better-sqlite3-multiple-ciphers` keying does not behave correctly with `:memory:` paths. Encryption verification and fail-closed tests must use temporary on-disk DB files.
