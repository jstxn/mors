/**
 * Custom error types for mors security and store operations.
 * All errors are designed for fail-closed behavior with actionable messages.
 */
/** Base error for all mors-specific errors. */
export declare class MorsError extends Error {
    constructor(message: string);
}
/** Thrown when SQLCipher is unavailable or the database cannot be opened due to encryption issues. */
export declare class StoreEncryptionError extends MorsError {
    constructor(message: string);
}
/** Thrown when the encryption key is wrong, missing, or cannot be read. */
export declare class KeyError extends MorsError {
    constructor(message: string);
}
/** Thrown when a store operation is attempted before initialization. */
export declare class NotInitializedError extends MorsError {
    constructor(message: string);
}
/** Thrown when SQLCipher prerequisites are not met. */
export declare class SqlCipherUnavailableError extends MorsError {
    constructor(message: string);
}
/** Thrown when E2EE device key operations fail (generation, persistence, loading, validation). */
export declare class DeviceKeyError extends MorsError {
    constructor(message: string);
}
/** Thrown when a secure messaging operation is attempted before device key bootstrap is complete. */
export declare class DeviceNotBootstrappedError extends MorsError {
    constructor(message?: string);
}
/** Thrown when a key exchange operation fails (invalid peer key, DH computation error, persistence failure). */
export declare class KeyExchangeError extends MorsError {
    constructor(message: string);
}
/** Thrown when an encrypted operation is attempted before key exchange is complete with the target peer. */
export declare class KeyExchangeNotCompleteError extends MorsError {
    constructor(peerDeviceId: string, message?: string);
}
/** Thrown when E2EE is attempted on a group or channel conversation (only 1:1/direct is supported). */
export declare class GroupE2EEUnsupportedError extends MorsError {
    constructor(conversationType: string);
}
/** Thrown when E2EE encryption or decryption fails (tampered ciphertext, wrong key, malformed payload). */
export declare class CipherError extends MorsError {
    constructor(message: string);
}
/**
 * Thrown when decryption fails due to a stale or mismatched shared secret.
 * Extends CipherError for backward compatibility.
 * Includes actionable rekey guidance directing the user to re-exchange keys.
 */
export declare class StaleKeyError extends CipherError {
    constructor(message?: string);
}
/**
 * Thrown when an operation involves a revoked device.
 * Extends CipherError for error-handling consistency in decrypt paths.
 */
export declare class DeviceRevokedError extends CipherError {
    readonly revokedDeviceId: string;
    constructor(deviceId: string, message?: string);
}
/** Thrown when a dedupe key collides with an existing record whose causal context (thread_id / in_reply_to) does not match. */
export declare class DedupeConflictError extends MorsError {
    readonly dedupeKey: string;
    readonly existingMessageId: string;
    constructor(dedupeKey: string, existingMessageId: string, detail: string);
}
//# sourceMappingURL=errors.d.ts.map