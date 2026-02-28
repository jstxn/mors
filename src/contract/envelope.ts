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

import { isValidId, isValidOptionalId, isValidPrefixedId } from './ids.js';
import { isValidDeliveryState, type DeliveryState } from './states.js';
import { ContractValidationError } from './errors.js';

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
export function validateEnvelope(envelope: MessageEnvelope): void {
  if (!envelope || typeof envelope !== 'object') {
    throw new ContractValidationError('Envelope must be a non-null object.');
  }

  // Required non-empty string fields with typed prefix enforcement.
  if (!isValidPrefixedId(envelope.id, 'message')) {
    throw new ContractValidationError(
      'Envelope field "id" must be a non-empty string with "msg_" prefix.'
    );
  }
  if (!isValidPrefixedId(envelope.thread_id, 'thread')) {
    throw new ContractValidationError(
      'Envelope field "thread_id" must be a non-empty string with "thr_" prefix.'
    );
  }
  if (!isValidId(envelope.sender)) {
    throw new ContractValidationError('Envelope field "sender" must be a non-empty string.');
  }
  if (!isValidId(envelope.recipient)) {
    throw new ContractValidationError('Envelope field "recipient" must be a non-empty string.');
  }
  if (!isValidId(envelope.body)) {
    throw new ContractValidationError('Envelope field "body" must be a non-empty string.');
  }
  if (!isValidId(envelope.created_at)) {
    throw new ContractValidationError('Envelope field "created_at" must be a non-empty string.');
  }
  if (!isValidId(envelope.updated_at)) {
    throw new ContractValidationError('Envelope field "updated_at" must be a non-empty string.');
  }

  // Optional nullable ID fields: must be null or valid non-empty string (undefined rejected).
  // When present (non-null), enforce typed prefix validation.
  if (!isValidOptionalId(envelope.in_reply_to)) {
    throw new ContractValidationError(
      'Envelope field "in_reply_to" must be null or a non-empty string.'
    );
  }
  if (envelope.in_reply_to !== null && !isValidPrefixedId(envelope.in_reply_to, 'message')) {
    throw new ContractValidationError(
      'Envelope field "in_reply_to" must have "msg_" prefix when set.'
    );
  }
  if (!isValidOptionalId(envelope.dedupe_key)) {
    throw new ContractValidationError(
      'Envelope field "dedupe_key" must be null or a non-empty string.'
    );
  }
  if (envelope.dedupe_key !== null && !isValidPrefixedId(envelope.dedupe_key, 'dedupe')) {
    throw new ContractValidationError(
      'Envelope field "dedupe_key" must have "dup_" prefix when set.'
    );
  }
  if (!isValidOptionalId(envelope.trace_id)) {
    throw new ContractValidationError(
      'Envelope field "trace_id" must be null or a non-empty string.'
    );
  }
  if (envelope.trace_id !== null && !isValidPrefixedId(envelope.trace_id, 'trace')) {
    throw new ContractValidationError(
      'Envelope field "trace_id" must have "trc_" prefix when set.'
    );
  }

  // State must be a valid delivery state.
  if (!isValidDeliveryState(envelope.state)) {
    throw new ContractValidationError(
      `Envelope field "state" must be one of: queued, delivered, acked, failed. Got: "${String(envelope.state)}".`
    );
  }

  // subject and read_at are nullable (null allowed, undefined rejected).
  // When present must be non-empty strings.
  if (!isValidOptionalId(envelope.subject)) {
    throw new ContractValidationError(
      'Envelope field "subject" must be null or a non-empty string.'
    );
  }
  if (!isValidOptionalId(envelope.read_at)) {
    throw new ContractValidationError(
      'Envelope field "read_at" must be null or a non-empty string.'
    );
  }
}

/**
 * Validate an envelope for the `send` command context.
 * In addition to structural validation, enforces:
 * - State must be 'queued' (initial state for new messages).
 * - read_at must be null (unread on send).
 *
 * @param envelope - The envelope to validate.
 * @throws ContractValidationError if send-specific constraints are violated.
 */
export function validateEnvelopeForSend(envelope: MessageEnvelope): void {
  validateEnvelope(envelope);

  if (envelope.state !== 'queued') {
    throw new ContractValidationError(
      `Send envelope must have state "queued". Got: "${envelope.state}".`
    );
  }

  if (envelope.read_at !== null) {
    throw new ContractValidationError(
      'Send envelope must not have read_at set (messages are unread on send).'
    );
  }
}

/**
 * Validate an envelope for the `reply` command context.
 * In addition to send validation, enforces:
 * - in_reply_to must be present (non-null) — replies must reference a parent message.
 *
 * @param envelope - The envelope to validate.
 * @throws ContractValidationError if reply-specific constraints are violated.
 */
export function validateEnvelopeForReply(envelope: MessageEnvelope): void {
  validateEnvelopeForSend(envelope);

  if (envelope.in_reply_to === null) {
    throw new ContractValidationError(
      'Reply envelope must have "in_reply_to" set to the parent message ID.'
    );
  }
}

/**
 * Validate a message ID string (used for read, ack, reply target lookups).
 * Ensures the value is a non-empty, non-whitespace string with `msg_` prefix.
 *
 * @param id - The message ID to validate.
 * @throws ContractValidationError if the ID is invalid or missing the `msg_` prefix.
 */
export function validateMessageId(id: unknown): asserts id is string {
  if (!isValidPrefixedId(id, 'message')) {
    throw new ContractValidationError(
      `Invalid message ID: expected a non-empty "msg_"-prefixed string, got ${id === null ? 'null' : typeof id === 'string' ? `"${id}"` : typeof id}.`
    );
  }
}
