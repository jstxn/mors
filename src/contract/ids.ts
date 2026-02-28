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
 * Validate that a value is either null or a valid ID.
 * Used for optional reference fields like in_reply_to.
 *
 * Per the envelope contract, nullable fields are `string | null`.
 * `undefined` is rejected as structurally invalid — callers must
 * explicitly set nullable fields to `null` rather than omitting them.
 *
 * @param value - The value to check.
 * @returns true if the value is null or a valid non-empty string.
 */
export function isValidOptionalId(value: unknown): value is string | null {
  if (value === null) return true;
  return isValidId(value);
}

/** Typed ID prefix map keyed by semantic role. */
export const ID_PREFIXES = {
  message: 'msg_',
  thread: 'thr_',
  trace: 'trc_',
  dedupe: 'dup_',
} as const;

/** Semantic ID type corresponding to a prefix in {@link ID_PREFIXES}. */
export type IdType = keyof typeof ID_PREFIXES;

/**
 * Validate that a value is a non-empty string with the expected typed prefix
 * and has content after the prefix.
 *
 * @param value  - The value to check.
 * @param idType - The expected semantic type (message, thread, trace, dedupe).
 * @returns true if value is a non-empty string starting with the correct prefix
 *          and has at least one character after the prefix.
 */
export function isValidPrefixedId(value: unknown, idType: IdType): boolean {
  if (!isValidId(value)) return false;
  const prefix = ID_PREFIXES[idType];
  return value.startsWith(prefix) && value.length > prefix.length;
}
