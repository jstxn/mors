/**
 * Shared config loading for the mors relay service.
 *
 * Loads configuration from environment variables with safe defaults.
 * Reports explicit diagnostics for missing config placeholders so operators
 * know exactly what is unset before features that depend on them fail.
 *
 * Credentials are intentionally placeholder-first in this phase.
 */
/**
 * Config variable definitions with their env keys and descriptions.
 * Used both for loading and for generating diagnostics.
 */
const CONFIG_VARS = [
    {
        key: 'MORS_RELAY_BASE_URL',
        field: 'baseUrl',
        description: 'Base URL for the relay service (e.g. https://relay.mors.dev). Used in API responses and redirects.',
    },
    {
        key: 'GITHUB_DEVICE_CLIENT_ID',
        field: 'githubClientId',
        description: 'GitHub OAuth App client ID for device-flow authentication. Create one at https://github.com/settings/applications/new.',
    },
    {
        key: 'GITHUB_DEVICE_SCOPE',
        field: 'githubScope',
        description: 'OAuth scope for GitHub device flow (e.g. "read:user"). Controls what permissions the CLI requests.',
    },
    {
        key: 'GITHUB_DEVICE_ENDPOINT',
        field: 'githubDeviceEndpoint',
        description: 'GitHub device code request endpoint (typically https://github.com/login/device/code).',
    },
    {
        key: 'GITHUB_TOKEN_ENDPOINT',
        field: 'githubTokenEndpoint',
        description: 'GitHub token exchange endpoint (typically https://github.com/login/oauth/access_token).',
    },
    {
        key: 'MORS_AUTH_TOKEN_ISSUER',
        field: 'authTokenIssuer',
        description: 'Issuer identifier for relay-issued auth tokens. Used in token validation.',
    },
    {
        key: 'MORS_AUTH_AUDIENCE',
        field: 'authAudience',
        description: 'Audience identifier for relay-issued auth tokens. Used in token validation.',
    },
];
/**
 * Load relay configuration from the given environment map.
 *
 * @param env - Map of environment variables (defaults to process.env).
 * @returns Parsed config with diagnostics for any missing placeholder variables.
 * @throws Error if port is non-numeric or out of range.
 */
export function loadRelayConfig(env = process.env) {
    // Port resolution: MORS_RELAY_PORT > PORT > 3100
    const portStr = env['MORS_RELAY_PORT'] ?? env['PORT'] ?? '3100';
    const port = Number(portStr);
    if (!Number.isFinite(port) || !Number.isInteger(port)) {
        throw new Error(`Invalid port value: "${portStr}". MORS_RELAY_PORT must be a valid integer.`);
    }
    if (port < 1 || port > 65535) {
        throw new Error(`Port ${port} is out of range. Must be between 1 and 65535.`);
    }
    // Host resolution: MORS_RELAY_HOST > '0.0.0.0' (container/hosted default)
    const host = env['MORS_RELAY_HOST'] ?? '0.0.0.0';
    // Load optional config variables and collect diagnostics for missing ones
    const diagnostics = [];
    const values = {};
    for (const varDef of CONFIG_VARS) {
        const value = env[varDef.key];
        values[varDef.field] = value;
        if (!value) {
            diagnostics.push({
                variable: varDef.key,
                description: varDef.description,
            });
        }
    }
    return {
        port,
        host,
        baseUrl: values['baseUrl'],
        githubClientId: values['githubClientId'],
        githubScope: values['githubScope'],
        githubDeviceEndpoint: values['githubDeviceEndpoint'],
        githubTokenEndpoint: values['githubTokenEndpoint'],
        authTokenIssuer: values['authTokenIssuer'],
        authAudience: values['authAudience'],
        diagnostics,
    };
}
//# sourceMappingURL=config.js.map