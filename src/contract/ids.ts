/**
 * ID generation and validation for the mors envelope contract.
 *
 * All IDs are typed-prefixed for debuggability:
 * - msg_  — message IDs
 * - thr_  — thread IDs
 * - trc_  — trace IDs
 * - dup_  — dedupe keys
 *
 * IDs use crypto.randomUUID() for uniqueness guarantees.
 */

import { randomUUID } from 'node:crypto';

/**
 * Generate a unique message ID.
 * Format: msg_{uuid}
 */
export function generateMessageId(): string {
  return `msg_${randomUUID()}`;
}

/**
 * Generate a unique thread ID.
 * Format: thr_{uuid}
 */
export function generateThreadId(): string {
  return `thr_${randomUUID()}`;
}

/**
 * Generate a unique trace ID for distributed tracing.
 * Format: trc_{uuid}
 */
export function generateTraceId(): string {
  return `trc_${randomUUID()}`;
}

/**
 * Generate a unique dedupe key for idempotent sends.
 * Format: dup_{uuid}
 */
export function generateDedupeKey(): string {
  return `dup_${randomUUID()}`;
}

/**
 * Validate that a value is a non-empty string suitable as an ID.
 * @param value - The value to check.
 * @returns true if the value is a non-empty, non-whitespace-only string.
 */
export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate that a value is either null/undefined or a valid ID.
 * Used for optional reference fields like in_reply_to.
 * @param value - The value to check.
 * @returns true if the value is null, undefined, or a valid non-empty string.
 */
export function isValidOptionalId(value: unknown): value is string | null | undefined {
  if (value === null || value === undefined) return true;
  return isValidId(value);
}
