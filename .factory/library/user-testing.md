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
