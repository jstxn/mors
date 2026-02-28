/**
 * Auth session persistence for mors CLI.
 *
 * Manages the local authenticated session file with:
 * - Owner-only file permissions (0o600) for security
 * - Graceful handling of corrupt/missing session files
 * - Schema validation on load to reject partial data
 *
 * Session identity is bound to the stable mors-native account ID
 * (derived from invite-token bootstrap) per VAL-AUTH-008.
 *
 * Each device gets its own config directory and session file,
 * enabling multi-device support (VAL-AUTH-009).
 */
/**
 * Persisted auth session data.
 *
 * The accountId is the stable identity key — derived from invite-token
 * bootstrap and immutable after creation (VAL-AUTH-008).
 */
export interface AuthSession {
    /** Mors-native session token (HMAC-signed). */
    accessToken: string;
    /** Token type (always "bearer"). */
    tokenType: string;
    /** Stable mors account ID (identity key, derived from invite token). */
    accountId: string;
    /** Unique device identifier for this installation. */
    deviceId: string;
    /** ISO-8601 timestamp of session creation. */
    createdAt: string;
}
/**
 * Save an auth session to disk with owner-only permissions.
 *
 * @param configDir - The config directory to write to.
 * @param session - The session data to persist.
 */
export declare function saveSession(configDir: string, session: AuthSession): void;
/**
 * Load an auth session from disk.
 *
 * Returns null if:
 * - No session file exists
 * - Session file is corrupt (invalid JSON)
 * - Session file is missing required fields
 *
 * @param configDir - The config directory to read from.
 * @returns The loaded session, or null if unavailable/invalid.
 */
export declare function loadSession(configDir: string): AuthSession | null;
/**
 * Clear the persisted auth session.
 *
 * Idempotent — safe to call even when no session exists.
 * Preserves the auth-enabled marker so auth gating remains active
 * after logout (VAL-AUTH-005).
 *
 * @param configDir - The config directory containing the session.
 */
export declare function clearSession(configDir: string): void;
/**
 * Mark that auth has been enabled in this config directory.
 *
 * Called during login to record that the user has engaged with auth.
 * This marker persists across logout so that auth gating can distinguish
 * "never logged in" (local-only) from "logged in then logged out"
 * (requires re-login).
 *
 * @param configDir - The config directory to mark.
 */
export declare function markAuthEnabled(configDir: string): void;
/**
 * Check whether auth has been enabled in this config directory.
 *
 * Returns true if the user has previously logged in (even if currently logged out),
 * meaning protected commands should require re-authentication.
 *
 * @param configDir - The config directory to check.
 * @returns true if the auth-enabled marker exists.
 */
export declare function isAuthEnabled(configDir: string): boolean;
/**
 * Save the signing key for session token generation/verification.
 *
 * @param configDir - The config directory.
 * @param signingKey - Hex-encoded signing key.
 */
export declare function saveSigningKey(configDir: string, signingKey: string): void;
/**
 * Load the signing key from disk.
 *
 * @param configDir - The config directory.
 * @returns The signing key string, or null if not found.
 */
export declare function loadSigningKey(configDir: string): string | null;
/**
 * Persisted account profile data.
 *
 * Stores the handle and display name from the onboarding wizard.
 * The handle is immutable after creation (VAL-AUTH-008).
 */
export interface AccountProfileLocal {
    /** Globally unique, immutable handle. */
    handle: string;
    /** Display name. */
    displayName: string;
    /** Stable account ID. */
    accountId: string;
    /** ISO-8601 timestamp of profile creation. */
    createdAt: string;
}
/**
 * Save an account profile to disk.
 *
 * @param configDir - The config directory to write to.
 * @param profile - The profile data to persist.
 */
export declare function saveProfile(configDir: string, profile: AccountProfileLocal): void;
/**
 * Load an account profile from disk.
 *
 * Returns null if no profile file exists or if it is corrupt.
 *
 * @param configDir - The config directory to read from.
 * @returns The loaded profile, or null if unavailable/invalid.
 */
export declare function loadProfile(configDir: string): AccountProfileLocal | null;
//# sourceMappingURL=session.d.ts.map