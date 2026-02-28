---
name: mors-worker
description: Implements mors CLI and storage features with SQLCipher-first reliability, TDD, and CLI evidence capture.
---

# mors Worker

NOTE: Startup/cleanup are handled by `worker-base`. This skill defines implementation procedure for `mors` features.

## When to Use This Skill

Use for `mors` CLI, schema, storage, security, and integration-test features in milestones `core-foundation` and `local-cli-flows`.

## Work Procedure

1. Read `mission.md`, mission `AGENTS.md`, `validation-contract.md`, and assigned feature details.
2. Implement via strict TDD:
   - Add/extend failing tests first (red).
   - Run targeted tests and confirm failure.
   - Implement minimal code to pass (green).
   - Refactor safely.
   - Exception for scaffold/bootstrap features: if the test harness does not exist yet, first establish the minimal runnable harness, then immediately return to red/green cycles for all subsequent behavior.
3. Preserve mandatory product invariants:
   - SQLCipher required; no plaintext fallback.
   - `read` and `ack` remain separate.
   - Thread linkage uses `thread_id` + `in_reply_to`.
4. For CLI behavior, provide deterministic outputs and non-zero exits for failures; include `--json` where required for validation evidence.
5. Run feature-level verification first (targeted tests/commands), then full validators from services manifest.
6. Perform manual CLI sanity checks for touched command paths and capture observed behavior (use patterns in `.factory/library/user-testing.md`, including `MORS_CONFIG_DIR`-scoped runs).
7. Ensure no long-running orphan processes remain (especially `mors watch` test runs).
8. Set handoff `skillFeedback.followedProcedure` accurately: if strict red/green order was not followed (outside scaffold exception), set it to false and list deviations.
9. If adding catch/recovery/error-handling branches, add tests that explicitly exercise those branches (fault injection/mocking/multi-handle overlap as needed), not only nearby happy paths.
10. Commit only feature-related project files; return thorough handoff with concrete evidence.

## Example Handoff

```json
{
  "salientSummary": "Implemented `mors init` with SQLCipher preflight, keypair generation, fail-closed behavior, and idempotent re-run handling. Added CLI JSON status output for validation and covered init atomicity/error paths with tests.",
  "whatWasImplemented": "Added initialization command flow that provisions identity and encrypted DB, validates SQLCipher availability, persists key metadata safely, blocks plaintext fallback, and guards against concurrent/duplicate init behavior with deterministic errors.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "npx vitest run test/init.test.ts --maxConcurrency=7",
        "exitCode": 0,
        "observation": "Init suite passed including atomic failure and rerun/idempotency checks."
      },
      {
        "command": "npm run typecheck",
        "exitCode": 0,
        "observation": "No TypeScript errors."
      },
      {
        "command": "npm run lint",
        "exitCode": 0,
        "observation": "No lint violations."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Run `mors init` in fresh temp workspace, then run `mors inbox --json`.",
        "observed": "Init succeeds once, rerun reports already initialized, and inbox command works without mutating state."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "test/init.test.ts",
        "cases": [
          {
            "name": "fails closed when SQLCipher preflight fails",
            "verifies": "No plaintext fallback and non-zero exit with remediation guidance"
          },
          {
            "name": "second init is non-destructive",
            "verifies": "identity/db artifacts are not silently overwritten"
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- SQLCipher cannot be installed or linked in this environment after reasonable setup attempts.
- Feature requirements conflict with mission invariants (for example, request to imply ack on read).
- Required command surface/flags needed by validation contract are missing from feature scope and would materially change scope.
- External/environment blockers prevent verification (toolchain failure, permissions, unavailable dependency).
