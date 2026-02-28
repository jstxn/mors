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
 * Required fields for session validation.
 */
const REQUIRED_SESSION_FIELDS: (keyof AuthSession)[] = [
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
  if (typeof obj['accessToken'] !== 'string' || typeof obj['githubUserId'] !== 'number') {
    return null;
  }

  return {
    accessToken: obj['accessToken'] as string,
    tokenType: obj['tokenType'] as string,
    scope: obj['scope'] as string,
    githubUserId: obj['githubUserId'] as number,
    githubLogin: obj['githubLogin'] as string,
    deviceId: obj['deviceId'] as string,
    createdAt: obj['createdAt'] as string,
  };
}

/**
 * Clear the persisted auth session.
 *
 * Idempotent — safe to call even when no session exists.
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
