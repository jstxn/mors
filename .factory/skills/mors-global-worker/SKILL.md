---
name: mors-global-worker
description: Implements mors global relay/auth/realtime/E2EE and launch-path features with strict TDD and CLI/API evidence.
---

# mors Global Worker

NOTE: Startup/cleanup are handled by `worker-base`. This skill defines feature implementation procedure.

## When to Use This Skill

Use for features in milestones `relay-foundation`, `global-async-messaging`, `realtime-watch`, and `developer-launch-path`.

## Work Procedure

1. Read `mission.md`, mission `AGENTS.md`, `validation-contract.md`, and assigned feature requirements.
2. Follow strict red/green TDD:
   - Add failing tests first.
   - Run targeted tests and confirm failure.
   - Implement minimal changes to pass.
   - Refactor safely.
3. Preserve core invariants:
   - read/ack separation,
   - causal threading (`thread_id`, `in_reply_to`),
   - idempotent dedupe/retry semantics,
   - no secret/token/plaintext leakage.
4. For auth/relay features, verify actor identity is derived from validated auth context (never trusted from client payload).
5. For SSE features, verify reconnect/cursor behavior and startup determinism with explicit event traces.
6. For E2EE features, verify key-exchange preconditions, decrypt success path, stale/revoked failure paths, and tamper detection.
7. Run targeted checks first, then full validators from `.factory/services.yaml` (`lint`, `typecheck`, `test`).
8. Perform manual CLI/API/SSE sanity checks for touched behavior and capture concrete observations.
9. Ensure no long-running orphan processes remain (especially relay dev server and watch streams).
10. Report handoff with concrete commands, observations, tests added, and discovered issues.

## Example Handoff

```json
{
  "salientSummary": "Implemented authenticated relay SSE watch with cursor resume and duplicate replay collapsing. Added reconnect tests and validated auth-expiry behavior with explicit re-auth guidance.",
  "whatWasImplemented": "Added relay SSE endpoint with auth guard, event-id cursor support, and client watch reconnect logic using Last-Event-ID. Implemented startup filtering to avoid historical create spam and added duplicate replay suppression in CLI watch state reducer.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "npx vitest run test/stream/resume-dedupe.test.ts --maxConcurrency=7",
        "exitCode": 0,
        "observation": "Reconnect, dedupe, and deterministic startup cases pass."
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
      },
      {
        "command": "npm run test -- --maxConcurrency=7",
        "exitCode": 0,
        "observation": "Full suite passes including stream/auth regressions."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Run two terminals: one `mors watch --remote --json`, one send/reply/ack sequence; then restart watch and resend with Last-Event-ID.",
        "observed": "Watch reconnects cleanly, no historical create flood, no duplicate user-visible transitions, and missing-auth reconnect prompts re-login."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "test/stream/resume-dedupe.test.ts",
        "cases": [
          {
            "name": "resumes from last-event-id without gaps",
            "verifies": "disconnect/reconnect catches up exactly once"
          },
          {
            "name": "startup suppresses historical create events",
            "verifies": "pre-existing messages are not replayed as fresh create events"
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- Feature depends on unavailable external credentials/account setup beyond placeholder scope.
- Requirements conflict with mission invariants (e.g., group E2EE requested in this mission).
- Validation requires infrastructure outside allowed mission boundaries.
- Environment/tooling blockers prevent reliable verification after reasonable attempts.
