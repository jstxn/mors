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
