# Architecture

Architectural decisions, boundaries, and implementation patterns for `mors`.

**What belongs here:** data model boundaries, command contracts, invariants, rationale for key patterns.

---

## MVP architecture constraints

- Local-first CLI (no web/API server in MVP)
- Encrypted local persistence via SQLCipher-backed SQLite
- Message envelope model includes IDs, threading (`thread_id`, `in_reply_to`), dedupe key, `trace_id`, and read/ack state separation
- Explicit ACK model: read and ack are distinct user actions and state transitions
- Phase 2 adapters (transport/integrations) are contracts only in MVP

## Concurrency testing with better-sqlite3

`better-sqlite3` (and `better-sqlite3-multiple-ciphers`) uses synchronous, single-connection operations. This means:

- **Single-handle in-process tests cannot produce true INSERT-level race contention.** A pre-INSERT SELECT will always find the canonical row before the INSERT executes, so UNIQUE-constraint conflict recovery branches are structurally unreachable in single-handle sequential tests.
- **True overlapping contention** requires either multi-process tests (separate Node processes each opening their own DB handle) or targeted fault injection / mocking to force the INSERT path to execute without the preceding SELECT finding a match.
- When claiming "concurrent" or "overlapping" coverage, workers must verify the specific code branch is actually exercised, not just that multiple calls succeed sequentially.
