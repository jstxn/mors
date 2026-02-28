/**
 * Shared config loading for the mors relay service.
 *
 * Loads configuration from environment variables with safe defaults.
 * Reports explicit diagnostics for missing config placeholders so operators
 * know exactly what is unset before features that depend on them fail.
 *
 * Credentials are intentionally placeholder-first in this phase.
 */
/** A diagnostic entry for a missing or unset config variable. */
export interface ConfigDiagnostic {
    /** The environment variable name. */
    variable: string;
    /** Human-readable description of what this variable configures. */
    description: string;
}
/** Relay service configuration. */
export interface RelayConfig {
    /** Port the relay HTTP server listens on. */
    port: number;
    /** Base URL for the relay service (used in responses/redirects). */
    baseUrl: string | undefined;
    /** GitHub OAuth device-flow client ID. */
    githubClientId: string | undefined;
    /** GitHub OAuth scope. */
    githubScope: string | undefined;
    /** GitHub device code endpoint. */
    githubDeviceEndpoint: string | undefined;
    /** GitHub token exchange endpoint. */
    githubTokenEndpoint: string | undefined;
    /** Auth token issuer identifier. */
    authTokenIssuer: string | undefined;
    /** Auth token audience identifier. */
    authAudience: string | undefined;
    /** Diagnostics for missing config variables. */
    diagnostics: ConfigDiagnostic[];
}
/**
 * Load relay configuration from the given environment map.
 *
 * @param env - Map of environment variables (defaults to process.env).
 * @returns Parsed config with diagnostics for any missing placeholder variables.
 * @throws Error if port is non-numeric or out of range.
 */
export declare function loadRelayConfig(env?: Record<string, string | undefined>): RelayConfig;
//# sourceMappingURL=config.d.ts.map