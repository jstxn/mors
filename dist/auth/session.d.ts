/**
 * Auth session persistence for mors CLI.
 *
 * Manages the local authenticated session file with:
 * - Owner-only file permissions (0o600) for security
 * - Graceful handling of corrupt/missing session files
 * - Schema validation on load to reject partial data
 *
 * Session identity is bound to the stable GitHub numeric user ID
 * (not the mutable login/username string) per VAL-AUTH-008.
 *
 * Each device gets its own config directory and session file,
 * enabling multi-device support (VAL-AUTH-009).
 */
/**
 * Persisted auth session data.
 *
 * The githubUserId is the stable identity key — it does not change
 * when a user renames their GitHub account (VAL-AUTH-008).
 */
export interface AuthSession {
    /** GitHub OAuth access token. */
    accessToken: string;
    /** Token type (typically "bearer"). */
    tokenType: string;
    /** OAuth scope granted. */
    scope: string;
    /** Stable GitHub numeric user ID (identity key). */
    githubUserId: number;
    /** Current GitHub login (informational, may change). */
    githubLogin: string;
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
 *
 * @param configDir - The config directory containing the session.
 */
export declare function clearSession(configDir: string): void;
//# sourceMappingURL=session.d.ts.map