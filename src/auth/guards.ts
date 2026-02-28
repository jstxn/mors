/**
 * Auth guards for CLI command gating and token liveness validation.
 *
 * Provides:
 * - requireAuth: Gate that checks for a valid local session (re-gates after logout)
 * - verifyTokenLiveness: Validates a session token is still valid via HMAC verification
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
import { loadSession, loadSigningKey, isAuthEnabled, type AuthSession } from './session.js';

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
 * Thrown when a token is expired, revoked, or otherwise invalid.
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
  /** Signing key for HMAC verification. If not provided, loaded from configDir. */
  signingKey?: string;
  /** Config directory for loading signing key. */
  configDir?: string;
}

/** Result of a successful token liveness check. */
export interface TokenLivenessResult {
  /** Stable mors account ID. */
  accountId: string;
  /** Device ID from the session token. */
  deviceId: string;
}

/**
 * Verify that a session token is still valid.
 *
 * This verifies the HMAC signature of the session token and extracts
 * the principal identity. Detects tampered, revoked, or otherwise
 * invalid tokens rather than silently treating a locally-persisted
 * session as valid.
 *
 * @param accessToken - The mors session token to verify.
 * @param options - Optional configuration.
 * @returns Principal identity from the valid token.
 * @throws TokenLivenessError if the token is invalid or cannot be verified.
 */
export async function verifyTokenLiveness(
  accessToken: string,
  options?: TokenLivenessOptions
): Promise<TokenLivenessResult> {
  const { verifySessionToken } = await import('./native.js');

  // Resolve signing key.
  // Priority: explicit option > MORS_RELAY_SIGNING_KEY env var > local signing key file.
  // This ensures token liveness checks use the same key the relay uses for verification,
  // enabling deterministic key coordination between CLI and relay.
  let signingKey = options?.signingKey;
  if (!signingKey) {
    const envKey = (process.env['MORS_RELAY_SIGNING_KEY'] ?? '').trim();
    if (envKey) {
      signingKey = envKey;
    } else if (options?.configDir) {
      signingKey = loadSigningKey(options.configDir) ?? undefined;
    }
  }

  if (!signingKey) {
    throw new TokenLivenessError('Unable to verify token — signing key not available');
  }

  const payload = verifySessionToken(accessToken, signingKey);
  if (!payload) {
    throw new TokenLivenessError(
      'Session token signature is invalid — token may be expired or revoked'
    );
  }

  return {
    accountId: payload.accountId,
    deviceId: payload.deviceId,
  };
}
