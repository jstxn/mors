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

/** Signing key file name. */
const SIGNING_KEY_FILE = '.signing-key';

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
 * Required fields for session validation.
 */
const REQUIRED_SESSION_FIELDS: (keyof AuthSession)[] = [
  'accessToken',
  'tokenType',
  'accountId',
  'deviceId',
  'createdAt',
];

/**
 * Save an auth session to disk with owner-only permissions.
 *
 * @param configDir - The config directory to write to.
 * @param session - The session data to persist.
 */
export function saveSession(configDir: string, session: AuthSession): void {
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
export function loadSession(configDir: string): AuthSession | null {
  const sessionPath = join(configDir, SESSION_FILE);

  if (!existsSync(sessionPath)) {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(sessionPath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // Validate all required fields are present
  for (const field of REQUIRED_SESSION_FIELDS) {
    if (obj[field] === undefined || obj[field] === null) {
      return null;
    }
  }

  // Type-check critical fields
  if (typeof obj['accessToken'] !== 'string' || typeof obj['accountId'] !== 'string') {
    return null;
  }

  return {
    accessToken: obj['accessToken'] as string,
    tokenType: obj['tokenType'] as string,
    accountId: obj['accountId'] as string,
    deviceId: obj['deviceId'] as string,
    createdAt: obj['createdAt'] as string,
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
export function clearSession(configDir: string): void {
  const sessionPath = join(configDir, SESSION_FILE);

  if (existsSync(sessionPath)) {
    try {
      unlinkSync(sessionPath);
    } catch {
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
export function markAuthEnabled(configDir: string): void {
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
export function isAuthEnabled(configDir: string): boolean {
  return existsSync(join(configDir, AUTH_MARKER_FILE));
}

/**
 * Save the signing key for session token generation/verification.
 *
 * @param configDir - The config directory.
 * @param signingKey - Hex-encoded signing key.
 */
export function saveSigningKey(configDir: string, signingKey: string): void {
  mkdirSync(configDir, { recursive: true, mode: DIR_MODE });
  chmodSync(configDir, DIR_MODE);

  const keyPath = join(configDir, SIGNING_KEY_FILE);
  writeFileSync(keyPath, signingKey + '\n', { mode: SESSION_FILE_MODE });
  chmodSync(keyPath, SESSION_FILE_MODE);
}

/**
 * Load the signing key from disk.
 *
 * @param configDir - The config directory.
 * @returns The signing key string, or null if not found.
 */
export function loadSigningKey(configDir: string): string | null {
  const keyPath = join(configDir, SIGNING_KEY_FILE);

  if (!existsSync(keyPath)) return null;

  try {
    return readFileSync(keyPath, 'utf-8').trim();
  } catch {
    return null;
  }
}

// ── Profile persistence ──────────────────────────────────────────────

/** Profile file name. */
const PROFILE_FILE = 'profile.json';

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
export function saveProfile(configDir: string, profile: AccountProfileLocal): void {
  mkdirSync(configDir, { recursive: true, mode: DIR_MODE });

  const profilePath = join(configDir, PROFILE_FILE);
  const data = JSON.stringify(profile, null, 2) + '\n';

  writeFileSync(profilePath, data, { mode: 0o644 });
}

/**
 * Load an account profile from disk.
 *
 * Returns null if no profile file exists or if it is corrupt.
 *
 * @param configDir - The config directory to read from.
 * @returns The loaded profile, or null if unavailable/invalid.
 */
export function loadProfile(configDir: string): AccountProfileLocal | null {
  const profilePath = join(configDir, PROFILE_FILE);

  if (!existsSync(profilePath)) {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(profilePath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['handle'] !== 'string' || typeof obj['displayName'] !== 'string') {
    return null;
  }

  return {
    handle: obj['handle'] as string,
    displayName: obj['displayName'] as string,
    accountId: (obj['accountId'] as string) ?? '',
    createdAt: (obj['createdAt'] as string) ?? '',
  };
}
