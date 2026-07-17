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
  /** Host/address the relay HTTP server binds to. Defaults to '0.0.0.0'. */
  host: string;
  /** Base URL for the relay service (used in responses/redirects). */
  baseUrl: string | undefined;
  /** Auth token issuer identifier. */
  authTokenIssuer: string | undefined;
  /** Auth token audience identifier. */
  authAudience: string | undefined;
  /** Diagnostics for missing config variables. */
  diagnostics: ConfigDiagnostic[];
}

/**
 * Config variable definitions with their env keys and descriptions.
 * Used both for loading and for generating diagnostics.
 */
const CONFIG_VARS = [
  {
    key: 'MORS_RELAY_BASE_URL',
    field: 'baseUrl' as const,
    description:
      'Base URL for the relay service (e.g. https://relay.mors.dev). Used in API responses and redirects.',
  },
  {
    key: 'MORS_AUTH_TOKEN_ISSUER',
    field: 'authTokenIssuer' as const,
    description: 'Issuer identifier for relay-issued auth tokens. Used in token validation.',
  },
  {
    key: 'MORS_AUTH_AUDIENCE',
    field: 'authAudience' as const,
    description: 'Audience identifier for relay-issued auth tokens. Used in token validation.',
  },
] as const;

/**
 * Load relay configuration from the given environment map.
 *
 * @param env - Map of environment variables (defaults to process.env).
 * @returns Parsed config with diagnostics for any missing placeholder variables.
 * @throws Error if port is non-numeric or out of range.
 */
export function loadRelayConfig(
  env: Record<string, string | undefined> = process.env
): RelayConfig {
  // Port resolution: MORS_RELAY_PORT > PORT > 3100
  const portStr = env['MORS_RELAY_PORT'] ?? env['PORT'] ?? '3100';
  const port = Number(portStr);

  if (!Number.isFinite(port) || !Number.isInteger(port)) {
    throw new Error(`Invalid port value: "${portStr}". MORS_RELAY_PORT must be a valid integer.`);
  }

  if (port < 0 || port > 65535) {
    throw new Error(`Port ${port} is out of range. Must be between 0 and 65535.`);
  }

  // Host resolution: MORS_RELAY_HOST > '0.0.0.0' (container/hosted default)
  const host = env['MORS_RELAY_HOST'] ?? '0.0.0.0';

  // Load optional config variables and collect diagnostics for missing ones
  const diagnostics: ConfigDiagnostic[] = [];
  const values: Record<string, string | undefined> = {};

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
    authTokenIssuer: values['authTokenIssuer'],
    authAudience: values['authAudience'],
    diagnostics,
  };
}
