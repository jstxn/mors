# User Testing Surface

How validators/workers should test user-visible `mors` behavior.

**What belongs here:** manual testing surfaces, entry commands, setup notes, known constraints.

---

## Test surface

- Surface type: CLI-only
- Primary commands: `mors init`, `mors send`, `mors inbox`, `mors read`, `mors reply`, `mors ack`, `mors watch`
- Preferred evidence format: terminal transcripts + exit codes + JSON command output when available

## Setup notes

- Run `.factory/init.sh` before manual testing sessions
- Use isolated temp directories for fresh-init and failure-path checks
- Use deterministic canary message bodies for encryption-at-rest checks

## Known constraints

- `tuistory` binary is unavailable in this environment; this is accepted for the current CLI-only mission
- Browser tooling is not required for MVP validation

---

## Flow Validator Guidance: CLI

### Testing surface
All validation is performed via direct CLI execution using `node dist/index.js <command>` from the project root `/Users/justen/Development/mors`. The CLI binary is pre-built.

### Isolation rules
- Each flow validator MUST use its own unique temp directory as config dir via the `MORS_CONFIG_DIR` environment variable.
- Create a fresh temp dir at the start: `TESTDIR=$(mktemp -d)/mors-test-<group-id>` then use `MORS_CONFIG_DIR="$TESTDIR" node dist/index.js <command>`.
- Do NOT use the default `.mors` directory in the project root.
- Do NOT modify any source files, test files, or project configuration.
- Clean up your temp directories when done.

### CLI invocation pattern
```bash
cd /Users/justen/Development/mors
MORS_CONFIG_DIR="$TESTDIR" node dist/index.js <command> [args]
```

### Distribution-channel executable checks
For install/distribution assertions, collect channel-specific runnable binary evidence:

```bash
# npm GitHub path
npm install -g github:jstxn/mors
mors --version

# Homebrew formula path (tap-ready repository formula)
brew install --build-from-source ./Formula/mors.rb
mors --version
```

If PATH is missing npm global bin location, use explicit shell setup flow and capture prompt/confirm evidence:

```bash
mors setup-shell
```

For JSON output, append `--json`:
```bash
MORS_CONFIG_DIR="$TESTDIR" node dist/index.js init --json
```

### Testing hooks (hidden flags)
These flags are available for fault-injection testing:
- `--simulate-sqlcipher-unavailable` — Simulates SQLCipher being unavailable (for VAL-INIT-003)
- `--simulate-failure-after-identity` — Simulates failure mid-init after identity creation (for VAL-INIT-006)

### Key file layout after init
After successful `mors init`, the config dir contains:
- `.initialized` — sentinel file marking successful init
- `identity.json` — public identity metadata (public key hex, fingerprint)
- `identity.key` — private key seed (32 bytes, owner-only 0o600 permissions)
- `db.key` — database encryption key (32 bytes, owner-only 0o600 permissions)
- `mors.db` — SQLCipher encrypted database

### Dedupe key format
Dedupe keys passed via `--dedupe-key` must be prefixed with `dup_` (e.g., `--dedupe-key dup_my-idempotent-key`). The CLI validates this prefix and rejects keys without it.

### Evidence collection
- Capture terminal output (stdout and stderr separately when possible)
- Record exit codes for every command
- Use `--json` flag for machine-readable output where available
- For encryption assertions, use `strings` or hex dump on `.db`, `-wal`, `-shm` files
- For permission checks, use `stat -f '%Lp' <file>` (macOS) to get octal permissions

### Known issue: npm GitHub shortcut install PATH in nested context (npm 11.9.0)
When running `npm i -g github:jstxn/mors`, npm 11.9.0 clones the repo to a temp dir, runs `npm install --force --include=dev`, then fires the `prepare` script. The prepare script's condition `test -x node_modules/.bin/tsc` evaluates TRUE (devDeps installed), so `npm run build` fires. However, `tsc` is NOT found in PATH within this nested npm execution context — the `npm run` inside the prepare context during git dep resolution does NOT properly add `node_modules/.bin` to PATH. The build exits 127 (`sh: tsc: command not found`), causing the entire global install to fail.

**Root cause:** The `build` script uses bare `tsc` instead of `node_modules/.bin/tsc` or `npx tsc`, and the nested npm context during git dep preparation doesn't add `node_modules/.bin` to PATH for the `npm run build` invocation.

**Suggested fix approaches:**
1. Change `build` script to use `npx tsc -p tsconfig.build.json` instead of `tsc -p tsconfig.build.json`
2. Or change `build` script to use `node_modules/.bin/tsc -p tsconfig.build.json`
3. Or change `prepare` script to always skip build (since dist/ is committed to git)

### Shared state boundaries
- There is NO shared state between flow validators — each uses an independent config dir.
- The project source and `dist/` directory are read-only shared resources.
- Do not run `npm run build` or modify `dist/` — the CLI is already built.
