/**
 * GitHub OAuth Device Flow primitives for mors CLI authentication.
 *
 * Implements the device authorization grant flow (RFC 8628):
 * 1. Request device code from GitHub
 * 2. Display verification URL and user code to the user
 * 3. Poll for token exchange until user completes browser authorization
 * 4. Fetch GitHub user profile for stable identity binding
 *
 * Identity binding uses the stable numeric GitHub user ID (not mutable login)
 * per VAL-AUTH-008.
 *
 * Missing OAuth config is detected early with actionable guidance (VAL-AUTH-007).
 * Token expiry/revocation produces explicit re-auth guidance (VAL-AUTH-006).
 */
import { MorsError } from '../errors.js';
/** Thrown when the device flow encounters a terminal error. */
export declare class DeviceFlowError extends MorsError {
    constructor(message: string);
}
/** Thrown when OAuth config is missing or invalid. */
export declare class AuthConfigError extends MorsError {
    readonly missing: string[];
    constructor(missing: string[]);
}
/** Thrown when a token is expired or revoked. */
export declare class TokenExpiredError extends MorsError {
    constructor(detail?: string);
}
/** OAuth config needed for the device flow. */
export interface AuthConfig {
    /** GitHub OAuth App client ID. */
    clientId: string;
    /** OAuth scope to request. */
    scope: string;
    /** GitHub device code endpoint URL. */
    deviceEndpoint: string;
    /** GitHub token exchange endpoint URL. */
    tokenEndpoint: string;
}
/** Response from the device code request. */
export interface DeviceCodeResponse {
    /** Device verification code (internal, not shown to user). */
    device_code: string;
    /** User-visible code to enter on the verification page. */
    user_code: string;
    /** URL the user must visit to authorize. */
    verification_uri: string;
    /** Seconds until the device code expires. */
    expires_in: number;
    /** Minimum polling interval in seconds. */
    interval: number;
}
/** Response from a successful token exchange. */
export interface TokenResponse {
    /** OAuth access token. */
    access_token: string;
    /** Token type (typically "bearer"). */
    token_type: string;
    /** Granted scope. */
    scope: string;
}
/** GitHub user profile (subset of /user response). */
export interface GitHubUser {
    /** Stable numeric GitHub user ID (identity key). */
    id: number;
    /** Current login name (mutable, informational). */
    login: string;
}
/** Config validation result. */
export interface AuthConfigValidation {
    /** Whether the config is complete and valid. */
    valid: boolean;
    /** List of missing variables with guidance. */
    missing: string[];
}
/**
 * Validate that all required OAuth config fields are present.
 *
 * @param config - The auth config to validate.
 * @returns Validation result with list of missing fields.
 */
export declare function validateAuthConfig(config: AuthConfig): AuthConfigValidation;
/**
 * Build AuthConfig from relay config environment variables.
 */
export declare function authConfigFromEnv(env?: Record<string, string | undefined>): AuthConfig;
/**
 * Request a device code from GitHub's OAuth device authorization endpoint.
 *
 * @param config - OAuth configuration.
 * @returns Device code response with user_code and verification_uri.
 * @throws DeviceFlowError on non-200 response.
 */
export declare function requestDeviceCode(config: AuthConfig): Promise<DeviceCodeResponse>;
/** Polling options. */
export interface PollOptions {
    /** Polling interval in milliseconds. */
    intervalMs: number;
    /** Total timeout in milliseconds. */
    expiresInMs: number;
    /** Optional abort signal. */
    signal?: AbortSignal;
    /** Optional callback for polling state updates. */
    onPoll?: (state: 'pending' | 'slow_down') => void;
}
/**
 * Poll the token endpoint until authorization completes, expires, or is denied.
 *
 * Handles GitHub's device flow polling protocol:
 * - `authorization_pending`: Keep polling
 * - `slow_down`: Increase interval by 5 seconds
 * - `expired_token`: Device code expired
 * - `access_denied`: User denied authorization
 * - Success: Returns token
 *
 * @param config - OAuth configuration.
 * @param deviceCode - The device_code from requestDeviceCode.
 * @param options - Polling options.
 * @returns Token response on success.
 * @throws DeviceFlowError on terminal errors.
 */
export declare function pollForToken(config: AuthConfig, deviceCode: string, options: PollOptions): Promise<TokenResponse>;
/** Options for fetchGitHubUser. */
export interface FetchUserOptions {
    /** Base URL for the GitHub API. Defaults to https://api.github.com */
    apiBaseUrl?: string;
}
/**
 * Fetch the authenticated GitHub user profile.
 *
 * Uses the access token to call /user and extract the stable numeric ID.
 *
 * @param accessToken - GitHub OAuth access token.
 * @param options - Optional configuration.
 * @returns GitHub user profile.
 * @throws TokenExpiredError on 401 (expired/revoked token).
 * @throws DeviceFlowError on other errors.
 */
export declare function fetchGitHubUser(accessToken: string, options?: FetchUserOptions): Promise<GitHubUser>;
//# sourceMappingURL=device-flow.d.ts.map