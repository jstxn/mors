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
/** Thrown when a handle is already taken by another account. */
export declare class DuplicateHandleError extends MorsError {
    readonly handle: string;
    constructor(handle: string);
}
/** Thrown when attempting to change an account's handle after creation. */
export declare class ImmutableHandleError extends MorsError {
    readonly existingHandle: string;
    constructor(existingHandle: string);
}
/** Thrown when a handle does not meet format requirements. */
export declare class InvalidHandleError extends MorsError {
    readonly handle: string;
    constructor(handle: string, detail: string);
}
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
/**
 * Validate a handle string against format rules.
 *
 * @param handle - The handle to validate.
 * @throws InvalidHandleError if the handle is invalid.
 */
export declare function validateHandle(handle: string): void;
/**
 * In-memory account store with handle uniqueness and immutability.
 *
 * Thread-safe for single-process use (JavaScript event loop).
 * Future milestones may back this with a persistent store.
 */
export declare class AccountStore {
    /** Map from account ID to profile. */
    private readonly byAccountId;
    /** Map from lowercase handle to account ID (for uniqueness checks). */
    private readonly handleToAccountId;
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
    register(options: RegisterOptions): AccountProfile;
    /**
     * Check whether a handle is available (not taken).
     *
     * @param handle - The handle to check (case-insensitive).
     * @returns true if the handle is available, false if taken.
     */
    isHandleAvailable(handle: string): boolean;
    /**
     * Get a profile by account ID.
     *
     * @param accountId - The account ID to look up.
     * @returns The account profile, or null if not found.
     */
    getByAccountId(accountId: string): AccountProfile | null;
    /**
     * Get a profile by handle.
     *
     * @param handle - The handle to look up (case-insensitive).
     * @returns The account profile, or null if not found.
     */
    getByHandle(handle: string): AccountProfile | null;
}
//# sourceMappingURL=account-store.d.ts.map