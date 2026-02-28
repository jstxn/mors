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
/** Thrown when E2EE device key operations fail (generation, persistence, loading, validation). */
export class DeviceKeyError extends MorsError {
    constructor(message) {
        super(message);
        this.name = 'DeviceKeyError';
    }
}
/** Thrown when a secure messaging operation is attempted before device key bootstrap is complete. */
export class DeviceNotBootstrappedError extends MorsError {
    constructor(message) {
        super(message ??
            'Device E2EE keys have not been bootstrapped. ' +
                'Run "mors init" to generate device encryption keys before using secure messaging.');
        this.name = 'DeviceNotBootstrappedError';
    }
}
/** Thrown when a key exchange operation fails (invalid peer key, DH computation error, persistence failure). */
export class KeyExchangeError extends MorsError {
    constructor(message) {
        super(message);
        this.name = 'KeyExchangeError';
    }
}
/** Thrown when an encrypted operation is attempted before key exchange is complete with the target peer. */
export class KeyExchangeNotCompleteError extends MorsError {
    constructor(peerDeviceId, message) {
        super(message ??
            `Key exchange has not been completed with peer device "${peerDeviceId}". ` +
                'Run "mors key-exchange" with the peer\'s public key before sending encrypted messages.');
        this.name = 'KeyExchangeNotCompleteError';
    }
}
/** Thrown when E2EE is attempted on a group or channel conversation (only 1:1/direct is supported). */
export class GroupE2EEUnsupportedError extends MorsError {
    constructor(conversationType) {
        super(`End-to-end encryption is not supported for "${conversationType}" conversations. ` +
            'E2EE is currently only supported for 1:1 direct conversations. ' +
            'Group and channel E2EE support is deferred to a future release.');
        this.name = 'GroupE2EEUnsupportedError';
    }
}
/** Thrown when E2EE encryption or decryption fails (tampered ciphertext, wrong key, malformed payload). */
export class CipherError extends MorsError {
    constructor(message) {
        super(message);
        this.name = 'CipherError';
    }
}
/**
 * Thrown when decryption fails due to a stale or mismatched shared secret.
 * Extends CipherError for backward compatibility.
 * Includes actionable rekey guidance directing the user to re-exchange keys.
 */
export class StaleKeyError extends CipherError {
    constructor(message) {
        super(message ??
            'Decryption failed: the shared secret appears stale or mismatched. ' +
                'This typically occurs after a device rotation or when keys are out of sync. ' +
                'Run "mors key-exchange" to re-establish a fresh shared secret with the peer device.');
        this.name = 'StaleKeyError';
    }
}
/**
 * Thrown when an operation involves a revoked device.
 * Extends CipherError for error-handling consistency in decrypt paths.
 */
export class DeviceRevokedError extends CipherError {
    revokedDeviceId;
    constructor(deviceId, message) {
        super(message ??
            `Device "${deviceId}" has been revoked and can no longer decrypt new messages. ` +
                'Run "mors key-exchange" from an active device to establish new encryption keys.');
        this.name = 'DeviceRevokedError';
        this.revokedDeviceId = deviceId;
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