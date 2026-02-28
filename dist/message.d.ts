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
import { MorsError } from './errors.js';
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
/** Thrown when a message is not found. */
export declare class MessageNotFoundError extends MorsError {
    constructor(id: string);
}
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
export declare function sendMessage(db: BetterSqlite3.Database, options: SendOptions): SendResult;
/**
 * List inbox messages.
 *
 * @param db - Open encrypted database handle.
 * @param options - Inbox filter options.
 * @returns Array of inbox entries ordered by created_at descending.
 */
export declare function listInbox(db: BetterSqlite3.Database, options: InboxOptions): InboxEntry[];
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
export declare function readMessage(db: BetterSqlite3.Database, messageId: string): ReadResult;
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
export declare function ackMessage(db: BetterSqlite3.Database, messageId: string): AckResult;
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
export declare function replyMessage(db: BetterSqlite3.Database, options: ReplyOptions): ReplyResult;
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
export declare function listThread(db: BetterSqlite3.Database, threadId: string): ThreadEntry[];
//# sourceMappingURL=message.d.ts.map