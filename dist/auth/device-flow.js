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
// ── Error types ──────────────────────────────────────────────────────
/** Thrown when the device flow encounters a terminal error. */
export class DeviceFlowError extends MorsError {
    constructor(message) {
        super(message);
        this.name = 'DeviceFlowError';
    }
}
/** Thrown when OAuth config is missing or invalid. */
export class AuthConfigError extends MorsError {
    missing;
    constructor(missing) {
        const list = missing.join(', ');
        super(`Missing required OAuth configuration: ${list}. ` +
            'Set these environment variables or configure them in your relay deployment. ' +
            'See https://github.com/settings/applications/new to create a GitHub OAuth App.');
        this.name = 'AuthConfigError';
        this.missing = missing;
    }
}
/** Thrown when a token is expired or revoked. */
export class TokenExpiredError extends MorsError {
    constructor(detail) {
        super('Your access token has expired or been revoked. ' +
            'Run "mors login" to re-authenticate and restore access.' +
            (detail ? ` (${detail})` : ''));
        this.name = 'TokenExpiredError';
    }
}
// ── Config validation ────────────────────────────────────────────────
const CONFIG_FIELD_MAP = [
    {
        field: 'clientId',
        envVar: 'GITHUB_DEVICE_CLIENT_ID',
        description: 'GitHub OAuth App client ID',
    },
    {
        field: 'scope',
        envVar: 'GITHUB_DEVICE_SCOPE',
        description: 'OAuth scope (e.g. "read:user")',
    },
    {
        field: 'deviceEndpoint',
        envVar: 'GITHUB_DEVICE_ENDPOINT',
        description: 'Device code endpoint URL',
    },
    {
        field: 'tokenEndpoint',
        envVar: 'GITHUB_TOKEN_ENDPOINT',
        description: 'Token exchange endpoint URL',
    },
];
/**
 * Validate that all required OAuth config fields are present.
 *
 * @param config - The auth config to validate.
 * @returns Validation result with list of missing fields.
 */
export function validateAuthConfig(config) {
    const missing = [];
    for (const { field, envVar, description } of CONFIG_FIELD_MAP) {
        const value = config[field];
        if (!value || (typeof value === 'string' && value.trim() === '')) {
            missing.push(`${envVar} (${description})`);
        }
    }
    return {
        valid: missing.length === 0,
        missing,
    };
}
/**
 * Build AuthConfig from relay config environment variables.
 */
export function authConfigFromEnv(env = process.env) {
    return {
        clientId: env['GITHUB_DEVICE_CLIENT_ID'] ?? '',
        scope: env['GITHUB_DEVICE_SCOPE'] ?? 'read:user',
        deviceEndpoint: env['GITHUB_DEVICE_ENDPOINT'] ?? 'https://github.com/login/device/code',
        tokenEndpoint: env['GITHUB_TOKEN_ENDPOINT'] ?? 'https://github.com/login/oauth/access_token',
    };
}
// ── Device code request ──────────────────────────────────────────────
/**
 * Request a device code from GitHub's OAuth device authorization endpoint.
 *
 * @param config - OAuth configuration.
 * @returns Device code response with user_code and verification_uri.
 * @throws DeviceFlowError on non-200 response.
 */
export async function requestDeviceCode(config) {
    const body = new URLSearchParams({
        client_id: config.clientId,
        scope: config.scope,
    });
    const response = await fetch(config.deviceEndpoint, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
    });
    if (!response.ok) {
        let errorDetail = `HTTP ${response.status}`;
        try {
            const errorBody = await response.json();
            if (errorBody['error']) {
                errorDetail = `${errorBody['error']}: ${errorBody['error_description'] ?? 'unknown error'}`;
            }
        }
        catch {
            // Use HTTP status as detail
        }
        throw new DeviceFlowError(`Failed to request device code: ${errorDetail}`);
    }
    const data = await response.json();
    return data;
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
export async function pollForToken(config, deviceCode, options) {
    let currentInterval = options.intervalMs;
    const deadline = Date.now() + options.expiresInMs;
    while (Date.now() < deadline) {
        if (options.signal?.aborted) {
            throw new DeviceFlowError('Device flow polling was cancelled.');
        }
        // Wait before polling
        await sleep(currentInterval);
        const body = new URLSearchParams({
            client_id: config.clientId,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        const response = await fetch(config.tokenEndpoint, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
        });
        const data = await response.json();
        // Check for error responses
        if (data['error']) {
            const error = data['error'];
            switch (error) {
                case 'authorization_pending':
                    options.onPoll?.('pending');
                    continue;
                case 'slow_down':
                    // GitHub spec: increase interval by 5 seconds
                    currentInterval += 5000;
                    options.onPoll?.('slow_down');
                    continue;
                case 'expired_token':
                    throw new DeviceFlowError('Device code has expired. Please run "mors login" again to start a new authorization.');
                case 'access_denied':
                    throw new DeviceFlowError('Authorization was denied. The user declined the permission request.');
                default:
                    throw new DeviceFlowError(`Device flow error: ${error}${data['error_description'] ? ` - ${data['error_description']}` : ''}`);
            }
        }
        // Success — we have a token
        if (data['access_token'] && data['token_type']) {
            return {
                access_token: data['access_token'],
                token_type: data['token_type'],
                scope: data['scope'] ?? '',
            };
        }
        // Unexpected response
        throw new DeviceFlowError('Unexpected response from token endpoint.');
    }
    throw new DeviceFlowError('Device code expired (polling timeout). Please run "mors login" again.');
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
export async function fetchGitHubUser(accessToken, options) {
    const baseUrl = options?.apiBaseUrl ?? 'https://api.github.com';
    const response = await fetch(`${baseUrl}/user`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            'User-Agent': 'mors-cli/0.1.0',
        },
    });
    if (response.status === 401) {
        throw new TokenExpiredError('GitHub API returned 401 - Bad credentials');
    }
    if (!response.ok) {
        throw new DeviceFlowError(`Failed to fetch GitHub user: HTTP ${response.status}`);
    }
    const data = await response.json();
    if (typeof data['id'] !== 'number' || typeof data['login'] !== 'string') {
        throw new DeviceFlowError('Invalid GitHub user response: missing id or login.');
    }
    return {
        id: data['id'],
        login: data['login'],
    };
}
// ── Helpers ──────────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=device-flow.js.map