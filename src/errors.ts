/**
 * Custom error types for mors security and store operations.
 * All errors are designed for fail-closed behavior with actionable messages.
 */

/** Base error for all mors-specific errors. */
export class MorsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MorsError";
  }
}

/** Thrown when SQLCipher is unavailable or the database cannot be opened due to encryption issues. */
export class StoreEncryptionError extends MorsError {
  constructor(message: string) {
    super(message);
    this.name = "StoreEncryptionError";
  }
}

/** Thrown when the encryption key is wrong, missing, or cannot be read. */
export class KeyError extends MorsError {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

/** Thrown when a store operation is attempted before initialization. */
export class NotInitializedError extends MorsError {
  constructor(message: string) {
    super(message);
    this.name = "NotInitializedError";
  }
}

/** Thrown when SQLCipher prerequisites are not met. */
export class SqlCipherUnavailableError extends MorsError {
  constructor(message: string) {
    super(message);
    this.name = "SqlCipherUnavailableError";
  }
}
