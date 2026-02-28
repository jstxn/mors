/**
 * Fly.io deployment module for the mors relay service.
 *
 * Provides pre-flight validation for deploy prerequisites:
 * - flyctl CLI availability
 * - Deploy authentication (FLY_ACCESS_TOKEN or flyctl auth)
 * - Required environment variables with placeholder detection
 * - Secret redaction in all output paths
 *
 * Validates VAL-DEPLOY-001, VAL-DEPLOY-002, VAL-DEPLOY-003.
 */
/** Result of a deploy pre-flight check. */
export interface DeployPreflightResult {
    /** Whether all pre-flight checks passed. */
    ready: boolean;
    /** List of issues found. Empty if ready is true. */
    issues: DeployIssue[];
    /** Resolved deploy configuration (only populated if ready is true). */
    config?: DeployConfig;
}
/** A single pre-flight issue. */
export interface DeployIssue {
    /** Category of the issue. */
    category: 'flyctl' | 'auth' | 'config' | 'placeholder';
    /** Human-readable description. */
    message: string;
    /** Actionable remediation steps. */
    remediation: string;
}
/** Resolved deploy configuration after validation. */
export interface DeployConfig {
    appName: string;
    primaryRegion: string;
    org: string;
    flyctlPath: string;
}
/**
 * Run deploy pre-flight checks.
 *
 * Validates all prerequisites before attempting a fly deploy.
 * Issues are collected (not thrown) so the caller can present all
 * problems at once rather than failing on the first one.
 *
 * @param env - Environment variables to check (defaults to process.env).
 * @returns Pre-flight result with issues and optional config.
 */
export declare function runDeployPreflight(env?: Record<string, string | undefined>): DeployPreflightResult;
/**
 * Redact known secret values from a string.
 *
 * Scans output for any values matching known secret environment variables
 * and replaces them with [REDACTED]. This is a defense-in-depth measure
 * to prevent accidental secret leakage in deploy output.
 *
 * @param text - Text to redact.
 * @param env - Environment variables to check for secret values.
 * @returns Text with secret values replaced.
 */
export declare function redactSecrets(text: string, env?: Record<string, string | undefined>): string;
/**
 * Format deploy pre-flight issues for human-readable output.
 *
 * @param issues - List of pre-flight issues.
 * @returns Formatted error string.
 */
export declare function formatDeployIssues(issues: DeployIssue[]): string;
/**
 * Format deploy pre-flight result as JSON.
 *
 * Ensures no secret values are embedded in the JSON output.
 *
 * @param result - Pre-flight result.
 * @param env - Environment for secret redaction.
 * @returns Safe JSON string.
 */
export declare function formatDeployResultJson(result: DeployPreflightResult, env?: Record<string, string | undefined>): string;
//# sourceMappingURL=deploy.d.ts.map