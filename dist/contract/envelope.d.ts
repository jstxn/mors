/**
 * Message envelope type definition and validation for the mors contract.
 *
 * The MessageEnvelope is the canonical shape for all message data flowing
 * through the system. Every CLI command (send, read, reply, ack, inbox, watch)
 * uses this contract to ensure consistent message handling.
 *
 * Fields:
 * - id           — Unique message identifier (msg_ prefixed)
 * - thread_id    — Thread grouping identifier (thr_ prefixed)
 * - in_reply_to  — Parent message ID for replies (null for root messages)
 * - sender       — Sender identity (fingerprint or alias)
 * - recipient    — Recipient identity (fingerprint or alias)
 * - subject      — Optional message subject
 * - body         — Message body (markdown content)
 * - dedupe_key   — Optional idempotency key for replay-safe sends
 * - trace_id     — Optional distributed tracing identifier
 * - state        — Current delivery state (queued|delivered|acked|failed)
 * - read_at      — ISO-8601 timestamp when message was read (null = unread)
 * - created_at   — ISO-8601 timestamp of creation
 * - updated_at   — ISO-8601 timestamp of last update
 */
import { type DeliveryState } from './states.js';
/**
 * Canonical message envelope shape used by all mors commands.
 */
export interface MessageEnvelope {
    /** Unique message identifier (msg_ prefixed). */
    id: string;
    /** Thread grouping identifier (thr_ prefixed). */
    thread_id: string;
    /** Parent message ID for replies; null for root messages. */
    in_reply_to: string | null;
    /** Sender identity string. */
    sender: string;
    /** Recipient identity string. */
    recipient: string;
    /** Optional message subject line. */
    subject: string | null;
    /** Message body content (markdown). */
    body: string;
    /** Optional idempotency key for dedupe. */
    dedupe_key: string | null;
    /** Optional distributed tracing identifier. */
    trace_id: string | null;
    /** Current delivery state. */
    state: DeliveryState;
    /** ISO-8601 timestamp when message was read; null = unread. */
    read_at: string | null;
    /** ISO-8601 timestamp of creation. */
    created_at: string;
    /** ISO-8601 timestamp of last state update. */
    updated_at: string;
}
/**
 * Validate the structural integrity of a message envelope.
 * Checks all required fields, type constraints, and optional field rules.
 *
 * @param envelope - The envelope to validate.
 * @throws ContractValidationError with a deterministic message identifying the invalid field.
 */
export declare function validateEnvelope(envelope: MessageEnvelope): void;
/**
 * Validate an envelope for the `send` command context.
 * In addition to structural validation, enforces:
 * - State must be 'queued' (initial state for new messages).
 * - read_at must be null (unread on send).
 *
 * @param envelope - The envelope to validate.
 * @throws ContractValidationError if send-specific constraints are violated.
 */
export declare function validateEnvelopeForSend(envelope: MessageEnvelope): void;
/**
 * Validate an envelope for the `reply` command context.
 * In addition to send validation, enforces:
 * - in_reply_to must be present (non-null) — replies must reference a parent message.
 *
 * @param envelope - The envelope to validate.
 * @throws ContractValidationError if reply-specific constraints are violated.
 */
export declare function validateEnvelopeForReply(envelope: MessageEnvelope): void;
/**
 * Validate a message ID string (used for read, ack, reply target lookups).
 * Ensures the value is a non-empty, non-whitespace string with `msg_` prefix.
 *
 * @param id - The message ID to validate.
 * @throws ContractValidationError if the ID is invalid or missing the `msg_` prefix.
 */
export declare function validateMessageId(id: unknown): asserts id is string;
//# sourceMappingURL=envelope.d.ts.map