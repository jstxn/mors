/**
 * Custom error types for mors security and store operations.
 * All errors are designed for fail-closed behavior with actionable messages.
 */
/** Base error for all mors-specific errors. */
export class MorsError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MorsError';
    }
}
/** Thrown when SQLCipher is unavailable or the database cannot be opened due to encryption issues. */
export class StoreEncryptionError extends MorsError {
    constructor(message) {
        super(message);
        this.name = 'StoreEncryptionError';
    }
}
/** Thrown when the encryption key is wrong, missing, or cannot be read. */
export class KeyError extends MorsError {
    constructor(message) {
        super(message);
        this.name = 'KeyError';
    }
}
/** Thrown when a store operation is attempted before initialization. */
export class NotInitializedError extends MorsError {
    constructor(message) {
        super(message);
        this.name = 'NotInitializedError';
    }
}
/** Thrown when SQLCipher prerequisites are not met. */
export class SqlCipherUnavailableError extends MorsError {
    constructor(message) {
        super(message);
        this.name = 'SqlCipherUnavailableError';
    }
}
/** Thrown when a dedupe key collides with an existing record whose causal context (thread_id / in_reply_to) does not match. */
export class DedupeConflictError extends MorsError {
    dedupeKey;
    existingMessageId;
    constructor(dedupeKey, existingMessageId, detail) {
        super(`Dedupe conflict for key "${dedupeKey}": existing message ${existingMessageId} has incompatible causal context. ${detail}`);
        this.name = 'DedupeConflictError';
        this.dedupeKey = dedupeKey;
        this.existingMessageId = existingMessageId;
    }
}
//# sourceMappingURL=errors.js.map