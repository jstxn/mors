/**
 * In-memory account store for the relay service.
 *
 * Manages account registration with globally unique, immutable handles
 * and basic profile metadata. Handles are case-insensitive for uniqueness
 * checks but stored in their original case.
 *
 * Invariants:
 * - Handles are globally unique (case-insensitive)
 * - Handles are immutable after creation (cannot be changed)
 * - Re-registration with the same handle by the same account is idempotent
 * - Handle format is validated: 3-32 chars, alphanumeric + hyphens + underscores
 *
 * Covers:
 * - VAL-AUTH-008: Account identity uses global unique immutable handle
 * - VAL-AUTH-012: Onboarding wizard captures handle and basic profile
 */

import { MorsError } from '../errors.js';

// ── Error types ──────────────────────────────────────────────────────

/** Thrown when a handle is already taken by another account. */
export class DuplicateHandleError extends MorsError {
  readonly handle: string;

  constructor(handle: string) {
    super(
      `Handle "${handle}" is already taken. Choose a different handle. ` +
        'Handles are globally unique and case-insensitive.'
    );
    this.name = 'DuplicateHandleError';
    this.handle = handle;
  }
}

/** Thrown when attempting to change an account's handle after creation. */
export class ImmutableHandleError extends MorsError {
  readonly existingHandle: string;

  constructor(existingHandle: string) {
    super(
      `Your handle "${existingHandle}" cannot be changed. ` +
        'Handles are immutable after creation.'
    );
    this.name = 'ImmutableHandleError';
    this.existingHandle = existingHandle;
  }
}

/** Thrown when a handle does not meet format requirements. */
export class InvalidHandleError extends MorsError {
  readonly handle: string;

  constructor(handle: string, detail: string) {
    super(
      `Invalid handle "${handle}": ${detail}. ` +
        'Handles must be 3-32 characters, using only letters, numbers, hyphens, and underscores.'
    );
    this.name = 'InvalidHandleError';
    this.handle = handle;
  }
}

// ── Types ────────────────────────────────────────────────────────────

/** Account profile stored on the relay. */
export interface AccountProfile {
  /** Stable account ID (from auth). */
  accountId: string;
  /** Globally unique, immutable handle. */
  handle: string;
  /** Display name (mutable profile metadata). */
  displayName: string;
  /** ISO-8601 timestamp of account creation. */
  createdAt: string;
}

/** Options for registering an account. */
export interface RegisterOptions {
  /** Stable account ID (from auth principal). */
  accountId: string;
  /** Desired handle (globally unique, immutable). */
  handle: string;
  /** Display name for profile. */
  displayName: string;
}

// ── Handle validation ────────────────────────────────────────────────

/**
 * Handle format: 3-32 characters, alphanumeric + hyphens + underscores.
 * Must start and end with alphanumeric.
 */
const HANDLE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,30}[a-zA-Z0-9]$/;

/**
 * Validate a handle string against format rules.
 *
 * @param handle - The handle to validate.
 * @throws InvalidHandleError if the handle is invalid.
 */
export function validateHandle(handle: string): void {
  if (!handle || typeof handle !== 'string') {
    throw new InvalidHandleError(handle ?? '', 'handle is required');
  }

  const trimmed = handle.trim();

  if (trimmed.length === 0) {
    throw new InvalidHandleError(handle, 'handle cannot be empty');
  }

  if (trimmed.length < 3) {
    throw new InvalidHandleError(handle, 'handle must be at least 3 characters');
  }

  if (trimmed.length > 32) {
    throw new InvalidHandleError(handle, 'handle must be at most 32 characters');
  }

  if (!HANDLE_PATTERN.test(trimmed)) {
    throw new InvalidHandleError(
      handle,
      'handle must start and end with a letter or number, and contain only letters, numbers, hyphens, and underscores'
    );
  }
}

// ── Account Store ────────────────────────────────────────────────────

/**
 * In-memory account store with handle uniqueness and immutability.
 *
 * Thread-safe for single-process use (JavaScript event loop).
 * Future milestones may back this with a persistent store.
 */
export class AccountStore {
  /** Map from account ID to profile. */
  private readonly byAccountId = new Map<string, AccountProfile>();
  /** Map from lowercase handle to account ID (for uniqueness checks). */
  private readonly handleToAccountId = new Map<string, string>();

  /**
   * Register an account with a handle and profile.
   *
   * - Validates handle format
   * - Enforces global handle uniqueness (case-insensitive)
   * - Enforces handle immutability (same account cannot change handle)
   * - Idempotent: re-registering with the same handle from the same account returns existing profile
   *
   * @param options - Registration options.
   * @returns The registered account profile.
   * @throws InvalidHandleError if handle format is invalid.
   * @throws DuplicateHandleError if handle is taken by another account.
   * @throws ImmutableHandleError if account already has a different handle.
   */
  register(options: RegisterOptions): AccountProfile {
    const { accountId, handle, displayName } = options;

    // Validate handle format
    validateHandle(handle);

    const normalizedHandle = handle.toLowerCase();

    // Check if this account already has a profile
    const existing = this.byAccountId.get(accountId);
    if (existing) {
      // Idempotent re-registration with same handle
      if (existing.handle.toLowerCase() === normalizedHandle) {
        return existing;
      }
      // Attempt to change handle — immutability violation
      throw new ImmutableHandleError(existing.handle);
    }

    // Check if handle is taken by another account
    const ownerAccountId = this.handleToAccountId.get(normalizedHandle);
    if (ownerAccountId !== undefined && ownerAccountId !== accountId) {
      throw new DuplicateHandleError(handle);
    }

    // Create new profile
    const profile: AccountProfile = {
      accountId,
      handle,
      displayName,
      createdAt: new Date().toISOString(),
    };

    this.byAccountId.set(accountId, profile);
    this.handleToAccountId.set(normalizedHandle, accountId);

    return profile;
  }

  /**
   * Check whether a handle is available (not taken).
   *
   * @param handle - The handle to check (case-insensitive).
   * @returns true if the handle is available, false if taken.
   */
  isHandleAvailable(handle: string): boolean {
    return !this.handleToAccountId.has(handle.toLowerCase());
  }

  /**
   * Get a profile by account ID.
   *
   * @param accountId - The account ID to look up.
   * @returns The account profile, or null if not found.
   */
  getByAccountId(accountId: string): AccountProfile | null {
    return this.byAccountId.get(accountId) ?? null;
  }

  /**
   * Get a profile by handle.
   *
   * @param handle - The handle to look up (case-insensitive).
   * @returns The account profile, or null if not found.
   */
  getByHandle(handle: string): AccountProfile | null {
    const accountId = this.handleToAccountId.get(handle.toLowerCase());
    if (!accountId) return null;
    return this.byAccountId.get(accountId) ?? null;
  }
}
