/**
 * Auth guards for CLI command gating and token liveness validation.
 *
 * Provides:
 * - requireAuth: Gate that checks for a valid local session (re-gates after logout)
 * - verifyTokenLiveness: Validates an access token is still active with GitHub API
 * - NotAuthenticatedError: Thrown when no session exists with login guidance
 * - TokenLivenessError: Thrown when a token is expired/revoked with re-auth guidance
 *
 * These guards ensure:
 * - Protected commands fail with actionable guidance after logout (VAL-AUTH-005)
 * - Expired/revoked tokens are detected, not silently reported as authenticated (VAL-AUTH-006)
 * - Recovery guidance always points to "mors login" (VAL-AUTH-006)
 * - Token values are never leaked in error messages (VAL-AUTH-010)
 */

import { MorsError } from '../errors.js';
import { loadSession, isAuthEnabled, type AuthSession } from './session.js';

// ── Error types ──────────────────────────────────────────────────────

/**
 * Thrown when a protected command is invoked without an authenticated session.
 *
 * Provides actionable guidance to run `mors login`.
 */
export class NotAuthenticatedError extends MorsError {
  constructor(message?: string) {
    super(
      message ?? 'Not authenticated. Run "mors login" to authenticate before using this command.'
    );
    this.name = 'NotAuthenticatedError';
  }
}

/**
 * Thrown when a token is expired, revoked, or otherwise invalid when validated
 * against the GitHub API.
 *
 * Provides actionable re-auth guidance to run `mors login`.
 * Never includes the token value in the error message.
 */
export class TokenLivenessError extends MorsError {
  constructor(detail?: string) {
    super(
      'Your access token has expired or been revoked. ' +
        'Run "mors login" to re-authenticate and restore access.' +
        (detail ? ` (${detail})` : '')
    );
    this.name = 'TokenLivenessError';
  }
}

// ── Guards ───────────────────────────────────────────────────────────

/**
 * Require an authenticated session to proceed.
 *
 * Only enforces auth if the user has previously logged in (auth-enabled marker
 * exists). This allows local-only operation without auth for users who have
 * never engaged with the auth system.
 *
 * When auth is enabled (user has logged in before):
 * - Returns the loaded session if valid
 * - Throws NotAuthenticatedError if no session (after logout, corrupt, missing)
 *
 * When auth is not enabled (user has never logged in):
 * - Returns null, allowing the command to proceed without auth
 *
 * @param configDir - The config directory containing the session file.
 * @returns The loaded auth session, or null if auth is not enabled.
 * @throws NotAuthenticatedError if auth is enabled but no valid session exists.
 */
export function requireAuth(configDir: string): AuthSession | null {
  // If user has never logged in, don't enforce auth (local-only mode)
  if (!isAuthEnabled(configDir)) {
    return null;
  }

  const session = loadSession(configDir);

  if (!session) {
    throw new NotAuthenticatedError();
  }

  return session;
}

// ── Token liveness verification ─────────────────────────────────────

/** Options for verifyTokenLiveness. */
export interface TokenLivenessOptions {
  /** Base URL for the GitHub API. Defaults to https://api.github.com */
  apiBaseUrl?: string;
}

/** Result of a successful token liveness check. */
export interface TokenLivenessResult {
  /** Stable GitHub numeric user ID. */
  githubUserId: number;
  /** Current GitHub login (informational). */
  githubLogin: string;
}

/**
 * Verify that an access token is still active by calling the GitHub API.
 *
 * This detects expired, revoked, or otherwise invalid tokens rather than
 * silently treating a locally-persisted session as valid.
 *
 * @param accessToken - The GitHub OAuth access token to verify.
 * @param options - Optional configuration.
 * @returns Principal identity from the valid token.
 * @throws TokenLivenessError if the token is expired, revoked, or invalid.
 */
export async function verifyTokenLiveness(
  accessToken: string,
  options?: TokenLivenessOptions
): Promise<TokenLivenessResult> {
  const baseUrl = options?.apiBaseUrl ?? 'https://api.github.com';

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'mors-cli/0.1.0',
      },
    });
  } catch {
    throw new TokenLivenessError('Unable to reach GitHub API to verify token');
  }

  if (response.status === 401) {
    throw new TokenLivenessError('GitHub API returned 401 — token is expired or revoked');
  }

  if (!response.ok) {
    throw new TokenLivenessError(`GitHub API returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  if (typeof data['id'] !== 'number' || typeof data['login'] !== 'string') {
    throw new TokenLivenessError('GitHub API returned invalid user data');
  }

  return {
    githubUserId: data['id'] as number,
    githubLogin: data['login'] as string,
  };
}
