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
/** A registered device identity under an account. */
export interface DeviceRegistration {
    /** Unique device identifier. */
    deviceId: string;
    /** ISO-8601 timestamp of device registration. */
    registeredAt: string;
}
/** Public device bundle metadata published to the relay for peer discovery. */
export interface PublishedDeviceBundle {
    /** Owning account ID. */
    accountId: string;
    /** Device identifier. */
    deviceId: string;
    /** Device fingerprint for display/verification. */
    fingerprint: string;
    /** Hex-encoded X25519 public key. */
    x25519PublicKey: string;
    /** Hex-encoded Ed25519 public key. */
    ed25519PublicKey: string;
    /** Original device key creation timestamp. */
    createdAt: string;
    /** ISO-8601 timestamp of relay publication. */
    publishedAt: string;
}
/** JSON-serializable snapshot of the account store state. */
export interface AccountStoreSnapshot {
    profiles: Array<[string, AccountProfile]>;
    handleToAccountId: Array<[string, string]>;
    devicesByAccountId: Array<[string, DeviceRegistration[]]>;
    deviceBundlesByAccountId: Array<[string, PublishedDeviceBundle[]]>;
}
/**
 * Normalize a handle string by trimming whitespace and lowercasing.
 *
 * This is the canonical normalization applied before all handle operations
 * (validation, uniqueness checks, storage, and lookups) to close whitespace
 * and case edge-case bypasses.
 *
 * @param handle - The raw handle input.
 * @returns The normalized handle (trimmed + lowercased).
 */
export declare function normalizeHandle(handle: string): string;
/**
 * Validate a handle string against format rules.
 *
 * The handle is normalized (trimmed + lowercased) before validation.
 *
 * @param handle - The handle to validate.
 * @returns The normalized handle string.
 * @throws InvalidHandleError if the handle is invalid.
 */
export declare function validateHandle(handle: string): string;
/**
 * In-memory account store with handle uniqueness, immutability,
 * and multi-device identity tracking.
 *
 * Thread-safe for single-process use (JavaScript event loop).
 * Future milestones may back this with a persistent store.
 *
 * Multi-device model (VAL-AUTH-009):
 * - One account (stable accountId) can have multiple devices
 * - Each device has a distinct deviceId
 * - Device registration is idempotent
 * - Device lists are account-scoped (no cross-account leakage)
 */
export declare class AccountStore {
    private readonly onMutation?;
    constructor(onMutation?: (() => void) | undefined);
    /** Map from account ID to profile. */
    private readonly byAccountId;
    /** Map from lowercase handle to account ID (for uniqueness checks). */
    private readonly handleToAccountId;
    /** Map from account ID to its registered device identities (VAL-AUTH-009). */
    private readonly devicesByAccountId;
    /** Map from account ID to published public device bundles by device ID. */
    private readonly deviceBundlesByAccountId;
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
    /**
     * Register a device identity under an account.
     *
     * Idempotent — re-registering the same device for the same account
     * is a no-op and preserves the original registration timestamp.
     *
     * Does not require the account to have a profile yet — device registration
     * can happen before or after onboarding.
     *
     * @param accountId - The account ID.
     * @param deviceId - The device ID to register.
     */
    registerDevice(accountId: string, deviceId: string): void;
    /**
     * List all registered device identities for an account.
     *
     * Returns an empty array if no devices have been registered.
     * Ordered by registration time (insertion order).
     *
     * @param accountId - The account ID to look up.
     * @returns Array of device registrations.
     */
    listDevices(accountId: string): DeviceRegistration[];
    /**
     * Publish or update a public device bundle for an account.
     *
     * Publication is idempotent per (accountId, deviceId). Re-publishing the same
     * device updates its public metadata and refreshes the publishedAt timestamp.
     *
     * @param accountId - Owning account ID.
     * @param bundle - Public device metadata to publish.
     * @returns The canonical published bundle stored by the relay.
     */
    publishDeviceBundle(accountId: string, bundle: Omit<PublishedDeviceBundle, 'accountId' | 'publishedAt'>): PublishedDeviceBundle;
    /**
     * Look up a published device bundle for a specific account/device pair.
     *
     * @param accountId - Owning account ID.
     * @param deviceId - Device identifier.
     * @returns The published bundle, or null when none exists.
     */
    getPublishedDeviceBundle(accountId: string, deviceId: string): PublishedDeviceBundle | null;
    /**
     * List all published device bundles for an account.
     *
     * Results preserve publication insertion order.
     *
     * @param accountId - Owning account ID.
     * @returns Published bundles for the account.
     */
    listPublishedDeviceBundles(accountId: string): PublishedDeviceBundle[];
    snapshot(): AccountStoreSnapshot;
    static fromSnapshot(data: AccountStoreSnapshot, onMutation?: () => void): AccountStore;
}
//# sourceMappingURL=account-store.d.ts.map