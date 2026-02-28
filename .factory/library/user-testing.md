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

### Evidence collection
- Capture terminal output (stdout and stderr separately when possible)
- Record exit codes for every command
- Use `--json` flag for machine-readable output where available
- For encryption assertions, use `strings` or hex dump on `.db`, `-wal`, `-shm` files
- For permission checks, use `stat -f '%Lp' <file>` (macOS) to get octal permissions

### Shared state boundaries
- There is NO shared state between flow validators — each uses an independent config dir.
- The project source and `dist/` directory are read-only shared resources.
- Do not run `npm run build` or modify `dist/` — the CLI is already built.
