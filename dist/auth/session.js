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
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
/** Owner-only file permissions for session file. */
const SESSION_FILE_MODE = 0o600;
/** Owner-only directory permissions. */
const DIR_MODE = 0o700;
/** Session file name. */
const SESSION_FILE = 'session.json';
/**
 * Marker file created on first login.
 * Indicates that auth has been used in this config dir,
 * enabling auth gating after logout.
 */
const AUTH_MARKER_FILE = '.auth-enabled';
/**
 * Required fields for session validation.
 */
const REQUIRED_SESSION_FIELDS = [
    'accessToken',
    'tokenType',
    'scope',
    'githubUserId',
    'githubLogin',
    'deviceId',
    'createdAt',
];
/**
 * Save an auth session to disk with owner-only permissions.
 *
 * @param configDir - The config directory to write to.
 * @param session - The session data to persist.
 */
export function saveSession(configDir, session) {
    mkdirSync(configDir, { recursive: true, mode: DIR_MODE });
    chmodSync(configDir, DIR_MODE);
    const sessionPath = join(configDir, SESSION_FILE);
    const data = JSON.stringify(session, null, 2) + '\n';
    writeFileSync(sessionPath, data, { mode: SESSION_FILE_MODE });
    // Explicitly chmod in case umask altered the effective permissions.
    chmodSync(sessionPath, SESSION_FILE_MODE);
}
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
export function loadSession(configDir) {
    const sessionPath = join(configDir, SESSION_FILE);
    if (!existsSync(sessionPath)) {
        return null;
    }
    let raw;
    try {
        raw = readFileSync(sessionPath, 'utf-8');
    }
    catch {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }
    const obj = parsed;
    // Validate all required fields are present
    for (const field of REQUIRED_SESSION_FIELDS) {
        if (obj[field] === undefined || obj[field] === null) {
            return null;
        }
    }
    // Type-check critical fields
    if (typeof obj['accessToken'] !== 'string' || typeof obj['githubUserId'] !== 'number') {
        return null;
    }
    return {
        accessToken: obj['accessToken'],
        tokenType: obj['tokenType'],
        scope: obj['scope'],
        githubUserId: obj['githubUserId'],
        githubLogin: obj['githubLogin'],
        deviceId: obj['deviceId'],
        createdAt: obj['createdAt'],
    };
}
/**
 * Clear the persisted auth session.
 *
 * Idempotent — safe to call even when no session exists.
 * Preserves the auth-enabled marker so auth gating remains active
 * after logout (VAL-AUTH-005).
 *
 * @param configDir - The config directory containing the session.
 */
export function clearSession(configDir) {
    const sessionPath = join(configDir, SESSION_FILE);
    if (existsSync(sessionPath)) {
        try {
            unlinkSync(sessionPath);
        }
        catch {
            // Best-effort removal
        }
    }
}
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
export function markAuthEnabled(configDir) {
    mkdirSync(configDir, { recursive: true, mode: DIR_MODE });
    const markerPath = join(configDir, AUTH_MARKER_FILE);
    if (!existsSync(markerPath)) {
        writeFileSync(markerPath, new Date().toISOString() + '\n', { mode: 0o644 });
    }
}
/**
 * Check whether auth has been enabled in this config directory.
 *
 * Returns true if the user has previously logged in (even if currently logged out),
 * meaning protected commands should require re-authentication.
 *
 * @param configDir - The config directory to check.
 * @returns true if the auth-enabled marker exists.
 */
export function isAuthEnabled(configDir) {
    return existsSync(join(configDir, AUTH_MARKER_FILE));
}
//# sourceMappingURL=session.js.map