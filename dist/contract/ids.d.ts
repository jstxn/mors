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
/**
 * Generate a unique message ID.
 * Format: msg_{uuid}
 */
export declare function generateMessageId(): string;
/**
 * Generate a unique thread ID.
 * Format: thr_{uuid}
 */
export declare function generateThreadId(): string;
/**
 * Generate a unique trace ID for distributed tracing.
 * Format: trc_{uuid}
 */
export declare function generateTraceId(): string;
/**
 * Generate a unique dedupe key for idempotent sends.
 * Format: dup_{uuid}
 */
export declare function generateDedupeKey(): string;
/**
 * Validate that a value is a non-empty string suitable as an ID.
 * @param value - The value to check.
 * @returns true if the value is a non-empty, non-whitespace-only string.
 */
export declare function isValidId(value: unknown): value is string;
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
export declare function isValidOptionalId(value: unknown): value is string | null;
/** Typed ID prefix map keyed by semantic role. */
export declare const ID_PREFIXES: {
    readonly message: "msg_";
    readonly thread: "thr_";
    readonly trace: "trc_";
    readonly dedupe: "dup_";
};
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
export declare function isValidPrefixedId(value: unknown, idType: IdType): boolean;
//# sourceMappingURL=ids.d.ts.map