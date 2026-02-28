/**
 * Custom error types for mors security and store operations.
 * All errors are designed for fail-closed behavior with actionable messages.
 */

/** Base error for all mors-specific errors. */
export class MorsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MorsError';
  }
}

/** Thrown when SQLCipher is unavailable or the database cannot be opened due to encryption issues. */
export class StoreEncryptionError extends MorsError {
  constructor(message: string) {
    super(message);
    this.name = 'StoreEncryptionError';
  }
}

/** Thrown when the encryption key is wrong, missing, or cannot be read. */
export class KeyError extends MorsError {
  constructor(message: string) {
    super(message);
    this.name = 'KeyError';
  }
}

/** Thrown when a store operation is attempted before initialization. */
export class NotInitializedError extends MorsError {
  constructor(message: string) {
    super(message);
    this.name = 'NotInitializedError';
  }
}

/** Thrown when SQLCipher prerequisites are not met. */
export class SqlCipherUnavailableError extends MorsError {
  constructor(message: string) {
    super(message);
    this.name = 'SqlCipherUnavailableError';
  }
}

/** Thrown when E2EE device key operations fail (generation, persistence, loading, validation). */
export class DeviceKeyError extends MorsError {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceKeyError';
  }
}

/** Thrown when a secure messaging operation is attempted before device key bootstrap is complete. */
export class DeviceNotBootstrappedError extends MorsError {
  constructor(message?: string) {
    super(
      message ??
        'Device E2EE keys have not been bootstrapped. ' +
          'Run "mors init" to generate device encryption keys before using secure messaging.'
    );
    this.name = 'DeviceNotBootstrappedError';
  }
}

/** Thrown when a dedupe key collides with an existing record whose causal context (thread_id / in_reply_to) does not match. */
export class DedupeConflictError extends MorsError {
  readonly dedupeKey: string;
  readonly existingMessageId: string;

  constructor(dedupeKey: string, existingMessageId: string, detail: string) {
    super(
      `Dedupe conflict for key "${dedupeKey}": existing message ${existingMessageId} has incompatible causal context. ${detail}`
    );
    this.name = 'DedupeConflictError';
    this.dedupeKey = dedupeKey;
    this.existingMessageId = existingMessageId;
  }
}
