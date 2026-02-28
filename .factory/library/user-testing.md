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
