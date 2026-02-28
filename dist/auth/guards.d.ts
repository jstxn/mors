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
import { type AuthSession } from './session.js';
/**
 * Thrown when a protected command is invoked without an authenticated session.
 *
 * Provides actionable guidance to run `mors login`.
 */
export declare class NotAuthenticatedError extends MorsError {
    constructor(message?: string);
}
/**
 * Thrown when a token is expired, revoked, or otherwise invalid when validated
 * against the GitHub API.
 *
 * Provides actionable re-auth guidance to run `mors login`.
 * Never includes the token value in the error message.
 */
export declare class TokenLivenessError extends MorsError {
    constructor(detail?: string);
}
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
export declare function requireAuth(configDir: string): AuthSession | null;
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
export declare function verifyTokenLiveness(accessToken: string, options?: TokenLivenessOptions): Promise<TokenLivenessResult>;
//# sourceMappingURL=guards.d.ts.map