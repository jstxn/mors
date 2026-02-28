/**
 * Message operations for the mors messaging system.
 *
 * Provides core message lifecycle functions:
 * - sendMessage  — Create and deliver a message (with dedupe support)
 * - listInbox    — List messages for a recipient (with unread filtering)
 * - readMessage  — Mark a message as read (sets read_at, idempotent)
 * - ackMessage   — Acknowledge a message (transitions to acked, idempotent)
 *
 * Invariants:
 * - Read and ack are separate operations (read ≠ ack).
 * - State transitions follow: queued → delivered → acked (no skipping).
 * - Dedupe key prevents duplicate message creation.
 * - Read/ack are idempotent (no side effects on repeat).
 * - Invalid targets fail with clear errors.
 *
 * Fulfills: VAL-MSG-001 through VAL-MSG-009
 */

import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import { generateMessageId, generateThreadId, validateMessageId } from './contract/index.js';
import { validateStateTransition } from './contract/states.js';
import { ContractValidationError } from './contract/errors.js';
import { MorsError, DedupeConflictError } from './errors.js';
import { isValidId, isValidPrefixedId } from './contract/ids.js';

// ── Types ──────────────────────────────────────────────────────────────

/** Options for sending a message. */
export interface SendOptions {
  /** Sender identity string. */
  sender: string;
  /** Recipient identity string. */
  recipient: string;
  /** Message body (markdown content). */
  body: string;
  /** Optional message subject. */
  subject?: string;
  /** Optional dedupe key for idempotent sends. Must have dup_ prefix. */
  dedupeKey?: string;
  /** Optional trace ID for distributed tracing. Must have trc_ prefix. */
  traceId?: string;
}

/** Result of sending a message. */
export interface SendResult {
  /** Message ID (msg_ prefixed). */
  id: string;
  /** Thread ID (thr_ prefixed). */
  thread_id: string;
  /** Sender identity. */
  sender: string;
  /** Recipient identity. */
  recipient: string;
  /** Current delivery state. */
  state: string;
  /** ISO-8601 creation timestamp. */
  created_at: string;
  /** Dedupe key if provided. */
  dedupe_key: string | null;
  /** Trace ID if provided. */
  trace_id: string | null;
  /** Whether this was a dedupe replay (existing message returned). */
  dedupe_replay: boolean;
}

/** Options for listing inbox messages. */
export interface InboxOptions {
  /** Filter by recipient identity. */
  recipient?: string;
  /** If true, only return unread messages (read_at IS NULL). */
  unreadOnly?: boolean;
}

/** An inbox entry representing a message. */
export interface InboxEntry {
  id: string;
  thread_id: string;
  in_reply_to: string | null;
  sender: string;
  recipient: string;
  subject: string | null;
  body: string;
  dedupe_key: string | null;
  trace_id: string | null;
  state: string;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Result of reading a message. */
export interface ReadResult {
  id: string;
  thread_id: string;
  in_reply_to: string | null;
  sender: string;
  recipient: string;
  subject: string | null;
  body: string;
  dedupe_key: string | null;
  trace_id: string | null;
  state: string;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Result of acknowledging a message. */
export interface AckResult {
  id: string;
  thread_id: string;
  state: string;
  updated_at: string;
}

// ── Error types ────────────────────────────────────────────────────────

/** Thrown when a message is not found. */
export class MessageNotFoundError extends MorsError {
  constructor(id: string) {
    super(`Message not found: ${id}`);
    this.name = 'MessageNotFoundError';
  }
}

// ── Core operations ────────────────────────────────────────────────────

/**
 * Send a message.
 *
 * For local delivery, messages transition directly to 'delivered' state.
 * If a dedupe_key is provided and a message with that key already exists,
 * the existing message is returned (idempotent replay).
 *
 * @param db - Open encrypted database handle.
 * @param options - Send options.
 * @returns SendResult with the message metadata.
 * @throws ContractValidationError if inputs are invalid.
 */
export function sendMessage(db: BetterSqlite3.Database, options: SendOptions): SendResult {
  const { sender, recipient, body, subject, dedupeKey, traceId } = options;

  // ── Input validation ──────────────────────────────────────────────
  if (!isValidId(sender)) {
    throw new ContractValidationError('Send requires a non-empty sender.');
  }
  if (!isValidId(recipient)) {
    throw new ContractValidationError('Send requires a non-empty recipient.');
  }
  if (!isValidId(body)) {
    throw new ContractValidationError('Send requires a non-empty body.');
  }
  if (dedupeKey !== undefined && !isValidPrefixedId(dedupeKey, 'dedupe')) {
    throw new ContractValidationError('dedupe_key must have "dup_" prefix.');
  }
  if (traceId !== undefined && !isValidPrefixedId(traceId, 'trace')) {
    throw new ContractValidationError('trace_id must have "trc_" prefix.');
  }

  // ── Dedupe check ──────────────────────────────────────────────────
  if (dedupeKey) {
    const existing = db
      .prepare(
        'SELECT id, thread_id, in_reply_to, sender, recipient, state, created_at, dedupe_key, trace_id FROM messages WHERE dedupe_key = ?'
      )
      .get(dedupeKey) as
      | {
          id: string;
          thread_id: string;
          in_reply_to: string | null;
          sender: string;
          recipient: string;
          state: string;
          created_at: string;
          dedupe_key: string | null;
          trace_id: string | null;
        }
      | undefined;

    if (existing) {
      // Causal linkage check: a top-level send must match a top-level record (in_reply_to is null).
      // If the existing record is a reply, the dedupe key is incompatible with a send.
      if (existing.in_reply_to !== null) {
        throw new DedupeConflictError(
          dedupeKey,
          existing.id,
          `Expected a top-level message (in_reply_to: null) but found a reply (in_reply_to: "${existing.in_reply_to}").`
        );
      }

      return {
        id: existing.id,
        thread_id: existing.thread_id,
        sender: existing.sender,
        recipient: existing.recipient,
        state: existing.state,
        created_at: existing.created_at,
        dedupe_key: existing.dedupe_key,
        trace_id: existing.trace_id,
        dedupe_replay: true,
      };
    }
  }

  // ── Create message ────────────────────────────────────────────────
  const id = generateMessageId();
  const threadId = generateThreadId();
  const now = new Date().toISOString();

  // Local delivery: messages are immediately delivered.
  const state = 'delivered';

  db.prepare(
    `INSERT INTO messages (id, thread_id, in_reply_to, sender, recipient, subject, body, dedupe_key, trace_id, state, read_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    threadId,
    null, // in_reply_to: null for new messages
    sender,
    recipient,
    subject ?? null,
    body,
    dedupeKey ?? null,
    traceId ?? null,
    state,
    null, // read_at: null on send
    now,
    now
  );

  return {
    id,
    thread_id: threadId,
    sender,
    recipient,
    state,
    created_at: now,
    dedupe_key: dedupeKey ?? null,
    trace_id: traceId ?? null,
    dedupe_replay: false,
  };
}

/**
 * List inbox messages.
 *
 * @param db - Open encrypted database handle.
 * @param options - Inbox filter options.
 * @returns Array of inbox entries ordered by created_at descending.
 */
export function listInbox(db: BetterSqlite3.Database, options: InboxOptions): InboxEntry[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.recipient) {
    conditions.push('recipient = ?');
    params.push(options.recipient);
  }

  if (options.unreadOnly) {
    conditions.push('read_at IS NULL');
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT id, thread_id, in_reply_to, sender, recipient, subject, body, dedupe_key, trace_id, state, read_at, created_at, updated_at
     FROM messages ${where}
     ORDER BY created_at DESC`
    )
    .all(...params) as InboxEntry[];

  return rows;
}

/**
 * Read a message by ID.
 *
 * Sets read_at timestamp if not already set. Idempotent — re-reading
 * does not update read_at or change state. Does not imply ack.
 *
 * @param db - Open encrypted database handle.
 * @param messageId - The message ID to read (must have msg_ prefix).
 * @returns The full message as a ReadResult.
 * @throws ContractValidationError if the ID format is invalid.
 * @throws MessageNotFoundError if the message doesn't exist.
 */
export function readMessage(db: BetterSqlite3.Database, messageId: string): ReadResult {
  // ── Validate message ID format ────────────────────────────────────
  validateMessageId(messageId);

  // ── Fetch message ─────────────────────────────────────────────────
  const row = db
    .prepare(
      `SELECT id, thread_id, in_reply_to, sender, recipient, subject, body, dedupe_key, trace_id, state, read_at, created_at, updated_at
     FROM messages WHERE id = ?`
    )
    .get(messageId) as InboxEntry | undefined;

  if (!row) {
    throw new MessageNotFoundError(messageId);
  }

  // ── Set read_at if not already set (idempotent) ───────────────────
  if (row.read_at === null) {
    const now = new Date().toISOString();
    db.prepare(
      'UPDATE messages SET read_at = ?, updated_at = ? WHERE id = ? AND read_at IS NULL'
    ).run(now, now, messageId);

    row.read_at = now;
    row.updated_at = now;
  }

  return row;
}

/**
 * Acknowledge a message by ID.
 *
 * Transitions the message state to 'acked'. Requires the message to be in
 * 'delivered' state (must have been read/delivered first). Idempotent —
 * re-acking an already-acked message returns it unchanged.
 *
 * @param db - Open encrypted database handle.
 * @param messageId - The message ID to acknowledge (must have msg_ prefix).
 * @returns The ack result with updated state.
 * @throws ContractValidationError if the ID format is invalid.
 * @throws MessageNotFoundError if the message doesn't exist.
 * @throws InvalidStateTransitionError if the state transition is not allowed.
 */
export function ackMessage(db: BetterSqlite3.Database, messageId: string): AckResult {
  // ── Validate message ID format ────────────────────────────────────
  validateMessageId(messageId);

  // ── Fetch current state ───────────────────────────────────────────
  const row = db
    .prepare('SELECT id, thread_id, state, updated_at FROM messages WHERE id = ?')
    .get(messageId) as
    | { id: string; thread_id: string; state: string; updated_at: string }
    | undefined;

  if (!row) {
    throw new MessageNotFoundError(messageId);
  }

  // ── Idempotent: if already acked, return as-is ────────────────────
  if (row.state === 'acked') {
    return {
      id: row.id,
      thread_id: row.thread_id,
      state: row.state,
      updated_at: row.updated_at,
    };
  }

  // ── Validate state transition ─────────────────────────────────────
  // This enforces: only delivered → acked is allowed.
  // queued → acked is rejected (must go through delivered).
  validateStateTransition(row.state as 'queued' | 'delivered' | 'acked' | 'failed', 'acked');

  // ── Transition to acked ───────────────────────────────────────────
  const now = new Date().toISOString();
  db.prepare('UPDATE messages SET state = ?, updated_at = ? WHERE id = ?').run(
    'acked',
    now,
    messageId
  );

  return {
    id: row.id,
    thread_id: row.thread_id,
    state: 'acked',
    updated_at: now,
  };
}

// ── Reply types ────────────────────────────────────────────────────────

/** Options for replying to a message. */
export interface ReplyOptions {
  /** The ID of the message being replied to (must have msg_ prefix). */
  parentMessageId: string;
  /** Sender identity string. */
  sender: string;
  /** Recipient identity string. */
  recipient: string;
  /** Reply body (markdown content). */
  body: string;
  /** Optional reply subject. */
  subject?: string;
  /** Optional dedupe key for idempotent replies. Must have dup_ prefix. */
  dedupeKey?: string;
  /** Optional trace ID for distributed tracing. Must have trc_ prefix. */
  traceId?: string;
}

/** Result of replying to a message. */
export interface ReplyResult {
  /** Reply message ID (msg_ prefixed). */
  id: string;
  /** Thread ID (thr_ prefixed) — inherited from root of thread. */
  thread_id: string;
  /** Parent message ID this reply is in response to. */
  in_reply_to: string;
  /** Sender identity. */
  sender: string;
  /** Recipient identity. */
  recipient: string;
  /** Current delivery state. */
  state: string;
  /** ISO-8601 creation timestamp. */
  created_at: string;
  /** Dedupe key if provided. */
  dedupe_key: string | null;
  /** Trace ID if provided. */
  trace_id: string | null;
  /** Whether this was a dedupe replay (existing reply returned). */
  dedupe_replay: boolean;
}

/** An entry in a thread listing. */
export interface ThreadEntry {
  id: string;
  thread_id: string;
  in_reply_to: string | null;
  sender: string;
  recipient: string;
  subject: string | null;
  body: string;
  dedupe_key: string | null;
  trace_id: string | null;
  state: string;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Reply operation ────────────────────────────────────────────────────

/**
 * Reply to an existing message.
 *
 * Creates a new message linked to the parent via `in_reply_to` and sharing
 * the parent's `thread_id`. For nested replies (replying to a reply), the
 * thread_id is inherited from the root of the thread (the parent's thread_id),
 * while `in_reply_to` always points to the immediate parent.
 *
 * Supports dedupe_key for idempotent reply creation.
 * Local delivery: replies are immediately set to 'delivered' state.
 *
 * @param db - Open encrypted database handle.
 * @param options - Reply options.
 * @returns ReplyResult with the reply metadata.
 * @throws ContractValidationError if inputs are invalid.
 * @throws MessageNotFoundError if the parent message doesn't exist.
 *
 * Fulfills: VAL-THREAD-001, VAL-THREAD-002, VAL-THREAD-003, VAL-THREAD-004
 */
export function replyMessage(db: BetterSqlite3.Database, options: ReplyOptions): ReplyResult {
  const { parentMessageId, sender, recipient, body, subject, dedupeKey, traceId } = options;

  // ── Input validation ──────────────────────────────────────────────
  validateMessageId(parentMessageId);

  if (!isValidId(sender)) {
    throw new ContractValidationError('Reply requires a non-empty sender.');
  }
  if (!isValidId(recipient)) {
    throw new ContractValidationError('Reply requires a non-empty recipient.');
  }
  if (!isValidId(body)) {
    throw new ContractValidationError('Reply requires a non-empty body.');
  }
  if (dedupeKey !== undefined && !isValidPrefixedId(dedupeKey, 'dedupe')) {
    throw new ContractValidationError('dedupe_key must have "dup_" prefix.');
  }
  if (traceId !== undefined && !isValidPrefixedId(traceId, 'trace')) {
    throw new ContractValidationError('trace_id must have "trc_" prefix.');
  }

  // ── Dedupe check ──────────────────────────────────────────────────
  if (dedupeKey) {
    const existing = db
      .prepare(
        'SELECT id, thread_id, in_reply_to, sender, recipient, state, created_at, dedupe_key, trace_id FROM messages WHERE dedupe_key = ?'
      )
      .get(dedupeKey) as
      | {
          id: string;
          thread_id: string;
          in_reply_to: string | null;
          sender: string;
          recipient: string;
          state: string;
          created_at: string;
          dedupe_key: string | null;
          trace_id: string | null;
        }
      | undefined;

    if (existing) {
      // Causal linkage check: the existing record must be a reply to the same parent.
      // If in_reply_to is null, the existing record is a top-level send — incompatible with a reply.
      if (existing.in_reply_to !== parentMessageId) {
        const existingReplyTo = existing.in_reply_to ?? 'null (top-level message)';
        throw new DedupeConflictError(
          dedupeKey,
          existing.id,
          `Expected in_reply_to="${parentMessageId}" but found in_reply_to="${existingReplyTo}".`
        );
      }

      // Also verify thread_id matches — look up the parent to get its thread_id.
      const parent = db
        .prepare('SELECT thread_id FROM messages WHERE id = ?')
        .get(parentMessageId) as { thread_id: string } | undefined;

      if (parent && existing.thread_id !== parent.thread_id) {
        throw new DedupeConflictError(
          dedupeKey,
          existing.id,
          `Expected thread_id="${parent.thread_id}" but found thread_id="${existing.thread_id}".`
        );
      }

      return {
        id: existing.id,
        thread_id: existing.thread_id,
        in_reply_to: existing.in_reply_to,
        sender: existing.sender,
        recipient: existing.recipient,
        state: existing.state,
        created_at: existing.created_at,
        dedupe_key: existing.dedupe_key,
        trace_id: existing.trace_id,
        dedupe_replay: true,
      };
    }
  }

  // ── Look up parent message to get thread_id ───────────────────────
  const parent = db
    .prepare('SELECT id, thread_id FROM messages WHERE id = ?')
    .get(parentMessageId) as { id: string; thread_id: string } | undefined;

  if (!parent) {
    throw new MessageNotFoundError(parentMessageId);
  }

  // ── Create reply ──────────────────────────────────────────────────
  const id = generateMessageId();
  const threadId = parent.thread_id; // Inherit thread from parent (preserves root thread)
  const now = new Date().toISOString();
  const state = 'delivered'; // Local delivery: immediately delivered

  db.prepare(
    `INSERT INTO messages (id, thread_id, in_reply_to, sender, recipient, subject, body, dedupe_key, trace_id, state, read_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    threadId,
    parentMessageId, // in_reply_to: always the immediate parent
    sender,
    recipient,
    subject ?? null,
    body,
    dedupeKey ?? null,
    traceId ?? null,
    state,
    null, // read_at: null on creation
    now,
    now
  );

  return {
    id,
    thread_id: threadId,
    in_reply_to: parentMessageId,
    sender,
    recipient,
    state,
    created_at: now,
    dedupe_key: dedupeKey ?? null,
    trace_id: traceId ?? null,
    dedupe_replay: false,
  };
}

// ── Thread navigation ──────────────────────────────────────────────────

/**
 * List all messages in a thread in deterministic causal order.
 *
 * Messages are ordered so that:
 * 1. Parent messages always appear before their descendants.
 * 2. Sibling messages (concurrent replies to same parent) are ordered by
 *    created_at timestamp for stable deterministic ordering.
 *
 * This is achieved by fetching all messages in the thread and performing
 * a topological sort based on the `in_reply_to` graph, with `created_at`
 * as the tiebreaker for siblings.
 *
 * @param db - Open encrypted database handle.
 * @param threadId - The thread ID to list (must have thr_ prefix).
 * @returns Array of thread entries in causal order.
 * @throws ContractValidationError if the thread ID format is invalid.
 *
 * Fulfills: VAL-THREAD-005
 */
export function listThread(db: BetterSqlite3.Database, threadId: string): ThreadEntry[] {
  // ── Validate thread ID format ─────────────────────────────────────
  if (!isValidPrefixedId(threadId, 'thread')) {
    throw new ContractValidationError(
      `Invalid thread ID: expected a non-empty "thr_"-prefixed string, got "${String(threadId)}".`
    );
  }

  // ── Fetch all messages in the thread ──────────────────────────────
  const rows = db
    .prepare(
      `SELECT id, thread_id, in_reply_to, sender, recipient, subject, body, dedupe_key, trace_id, state, read_at, created_at, updated_at
       FROM messages WHERE thread_id = ?
       ORDER BY created_at ASC`
    )
    .all(threadId) as ThreadEntry[];

  if (rows.length === 0) {
    return [];
  }

  // ── Topological sort for causal ordering ──────────────────────────
  // Build adjacency: parent_id -> children (sorted by created_at)
  const byId = new Map<string, ThreadEntry>();
  const children = new Map<string, ThreadEntry[]>();

  for (const row of rows) {
    byId.set(row.id, row);
    const parentKey = row.in_reply_to ?? '__root__';
    let siblings = children.get(parentKey);
    if (!siblings) {
      siblings = [];
      children.set(parentKey, siblings);
    }
    siblings.push(row);
  }

  // Sort each sibling group by created_at for deterministic ordering
  for (const siblings of children.values()) {
    siblings.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  // BFS/DFS traversal: root messages first, then their children
  const result: ThreadEntry[] = [];
  const visited = new Set<string>();

  // Start with root messages (no in_reply_to or parent not in this thread)
  const roots = children.get('__root__') ?? [];
  // Also include messages whose in_reply_to is not in this thread (orphan safety)
  for (const row of rows) {
    if (row.in_reply_to !== null && !byId.has(row.in_reply_to)) {
      roots.push(row);
    }
  }
  roots.sort((a, b) => a.created_at.localeCompare(b.created_at));

  // DFS traversal preserving causal order (parent before children)
  const stack = [...roots].reverse(); // Reverse so first item is processed first
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    result.push(current);

    // Push children in reverse order so they come out in correct order
    const childList = children.get(current.id) ?? [];
    for (let i = childList.length - 1; i >= 0; i--) {
      if (!visited.has(childList[i].id)) {
        stack.push(childList[i]);
      }
    }
  }

  return result;
}
