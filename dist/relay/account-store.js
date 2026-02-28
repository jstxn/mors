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
    handle;
    constructor(handle) {
        super(`Handle "${handle}" is already taken. Choose a different handle. ` +
            'Handles are globally unique and case-insensitive.');
        this.name = 'DuplicateHandleError';
        this.handle = handle;
    }
}
/** Thrown when attempting to change an account's handle after creation. */
export class ImmutableHandleError extends MorsError {
    existingHandle;
    constructor(existingHandle) {
        super(`Your handle "${existingHandle}" cannot be changed. ` +
            'Handles are immutable after creation.');
        this.name = 'ImmutableHandleError';
        this.existingHandle = existingHandle;
    }
}
/** Thrown when a handle does not meet format requirements. */
export class InvalidHandleError extends MorsError {
    handle;
    constructor(handle, detail) {
        super(`Invalid handle "${handle}": ${detail}. ` +
            'Handles must be 3-32 characters, using only letters, numbers, hyphens, and underscores.');
        this.name = 'InvalidHandleError';
        this.handle = handle;
    }
}
// ── Handle normalization and validation ──────────────────────────────
/**
 * Handle format: 3-32 characters, alphanumeric + hyphens + underscores.
 * Must start and end with alphanumeric.
 */
const HANDLE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,30}[a-zA-Z0-9]$/;
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
export function normalizeHandle(handle) {
    return handle.trim().toLowerCase();
}
/**
 * Validate a handle string against format rules.
 *
 * The handle is normalized (trimmed + lowercased) before validation.
 *
 * @param handle - The handle to validate.
 * @returns The normalized handle string.
 * @throws InvalidHandleError if the handle is invalid.
 */
export function validateHandle(handle) {
    if (!handle || typeof handle !== 'string') {
        throw new InvalidHandleError(handle ?? '', 'handle is required');
    }
    const normalized = normalizeHandle(handle);
    if (normalized.length === 0) {
        throw new InvalidHandleError(handle, 'handle cannot be empty');
    }
    if (normalized.length < 3) {
        throw new InvalidHandleError(handle, 'handle must be at least 3 characters');
    }
    if (normalized.length > 32) {
        throw new InvalidHandleError(handle, 'handle must be at most 32 characters');
    }
    if (!HANDLE_PATTERN.test(normalized)) {
        throw new InvalidHandleError(handle, 'handle must start and end with a letter or number, and contain only letters, numbers, hyphens, and underscores');
    }
    return normalized;
}
// ── Account Store ────────────────────────────────────────────────────
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
export class AccountStore {
    /** Map from account ID to profile. */
    byAccountId = new Map();
    /** Map from lowercase handle to account ID (for uniqueness checks). */
    handleToAccountId = new Map();
    /** Map from account ID to its registered device identities (VAL-AUTH-009). */
    devicesByAccountId = new Map();
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
    register(options) {
        const { accountId, handle, displayName } = options;
        // Validate and normalize handle (trim + lowercase)
        const normalizedHandle = validateHandle(handle);
        // Check if this account already has a profile
        const existing = this.byAccountId.get(accountId);
        if (existing) {
            // Idempotent re-registration with same handle
            if (existing.handle === normalizedHandle) {
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
        // Create new profile — store the normalized handle
        const profile = {
            accountId,
            handle: normalizedHandle,
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
    isHandleAvailable(handle) {
        return !this.handleToAccountId.has(normalizeHandle(handle));
    }
    /**
     * Get a profile by account ID.
     *
     * @param accountId - The account ID to look up.
     * @returns The account profile, or null if not found.
     */
    getByAccountId(accountId) {
        return this.byAccountId.get(accountId) ?? null;
    }
    /**
     * Get a profile by handle.
     *
     * @param handle - The handle to look up (case-insensitive).
     * @returns The account profile, or null if not found.
     */
    getByHandle(handle) {
        const accountId = this.handleToAccountId.get(normalizeHandle(handle));
        if (!accountId)
            return null;
        return this.byAccountId.get(accountId) ?? null;
    }
    // ── Multi-device identity tracking (VAL-AUTH-009) ──────────────
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
    registerDevice(accountId, deviceId) {
        let deviceMap = this.devicesByAccountId.get(accountId);
        if (!deviceMap) {
            deviceMap = new Map();
            this.devicesByAccountId.set(accountId, deviceMap);
        }
        // Idempotent: skip if already registered
        if (deviceMap.has(deviceId))
            return;
        deviceMap.set(deviceId, {
            deviceId,
            registeredAt: new Date().toISOString(),
        });
    }
    /**
     * List all registered device identities for an account.
     *
     * Returns an empty array if no devices have been registered.
     * Ordered by registration time (insertion order).
     *
     * @param accountId - The account ID to look up.
     * @returns Array of device registrations.
     */
    listDevices(accountId) {
        const deviceMap = this.devicesByAccountId.get(accountId);
        if (!deviceMap)
            return [];
        return Array.from(deviceMap.values());
    }
}
//# sourceMappingURL=account-store.js.map