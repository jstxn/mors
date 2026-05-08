# TODO

- [x] Diagnose hosted-session status failure and identify relay profile loss.
- [x] Patch `mors status` to verify hosted sessions against the relay.
- [x] Patch `mors start` to repair missing hosted profiles.
- [x] Add relay persistence snapshots for message/account/contact stores.
- [x] Load persisted relay state during bootstrap/entrypoint wiring.
- [x] Prefer durable Fly storage path and document/configure it in deploy files.
- [x] Add regression tests for persistence across restart.
- [x] Run build, typecheck, lint, and targeted/full tests.
- [x] Commit hosted repair + persistence changes cleanly without touching unrelated local work.

## Review

- Fixed chmod safety issues for relay persistence and spool roots.
- Ignored local `.mors/` state to keep keys, sessions, and databases out of commits.
