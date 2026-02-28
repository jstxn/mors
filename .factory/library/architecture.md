# Architecture

Architectural boundaries and invariants for `mors` global messaging evolution.

**What belongs here:** relay/auth/realtime/E2EE design constraints and reliability/security invariants.

---

## Mission architecture direction

- CLI-first user surface remains primary.
- Hosted relay (same repo) provides remote async messaging + SSE realtime.
- Identity/auth via GitHub OAuth Device Flow.
- E2EE scope is 1:1 only with per-device keypairs and key exchange.

## Invariants to preserve

- `read` and `ack` remain distinct state transitions.
- Causal threading remains `thread_id` + `in_reply_to`.
- Dedupe/retry/replay paths converge to one logical message outcome.
- Relay derives actor from validated auth context; client sender spoofing is not trusted.
- No plaintext message-body leakage in relay wire payloads, persistence, or logs.

## Realtime model

- SSE is default realtime transport for `watch --remote` style flows.
- Reconnect must use cursor/Last-Event-ID semantics.
- Startup should avoid replaying historical create events by default.
- At-least-once transport duplicates must collapse to exactly-once user-visible transitions.

## Concurrency/testing note

For SQLite-backed portions, single-handle tests may not naturally exercise conflict-recovery branches. Use multi-handle/multi-process tests or explicit fault injection when validating race/retry logic.
