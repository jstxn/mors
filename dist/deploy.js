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
import { execFileSync } from 'node:child_process';
/** Secrets and token patterns that must never appear in deploy output. */
const SECRET_ENV_KEYS = [
    'FLY_ACCESS_TOKEN',
    'GITHUB_DEVICE_CLIENT_ID',
    'GITHUB_TOKEN_ENDPOINT',
    'MORS_AUTH_TOKEN_ISSUER',
    'MORS_AUTH_AUDIENCE',
];
/** Pattern that matches placeholder values from .env.example. */
const PLACEHOLDER_PATTERN = /^replace-with-/;
/** Required deploy configuration variables. */
const REQUIRED_DEPLOY_VARS = [
    {
        key: 'FLY_APP_NAME',
        description: 'Fly.io application name (create with `flyctl apps create <name>`)',
    },
    {
        key: 'FLY_ORG',
        description: 'Fly.io organization slug (find with `flyctl orgs list`)',
    },
];
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
export function runDeployPreflight(env = process.env) {
    const issues = [];
    // 1. Check required config variables (and placeholder detection)
    for (const varDef of REQUIRED_DEPLOY_VARS) {
        const value = env[varDef.key];
        if (!value) {
            issues.push({
                category: 'config',
                message: `Required variable ${varDef.key} is not set.`,
                remediation: `Set ${varDef.key} in your environment or .env file. ${varDef.description}.`,
            });
        }
        else if (PLACEHOLDER_PATTERN.test(value)) {
            issues.push({
                category: 'placeholder',
                message: `${varDef.key} contains a placeholder value ("${value}").`,
                remediation: `Replace the placeholder in ${varDef.key} with a real value. ${varDef.description}.`,
            });
        }
    }
    // If config is invalid, return early — no point checking flyctl/auth
    if (issues.length > 0) {
        return { ready: false, issues };
    }
    // 2. Check flyctl availability
    const flyctlPath = resolveFlyctl(env);
    if (!flyctlPath) {
        issues.push({
            category: 'flyctl',
            message: 'flyctl CLI is not installed or not found in PATH.',
            remediation: 'Install flyctl: brew install flyctl (macOS) or curl -L https://fly.io/install.sh | sh. ' +
                'See https://fly.io/docs/flyctl/install/ for details.',
        });
        return { ready: false, issues };
    }
    // 3. Check deploy authentication
    const hasToken = Boolean(env['FLY_ACCESS_TOKEN']);
    if (!hasToken) {
        // Check if flyctl auth is configured
        const authOk = checkFlyctlAuth(flyctlPath);
        if (!authOk) {
            issues.push({
                category: 'auth',
                message: 'Fly.io deploy authentication is not configured.',
                remediation: 'Authenticate with Fly.io: run `flyctl auth login` interactively, ' +
                    'or set the FLY_ACCESS_TOKEN environment variable with a deploy token. ' +
                    'Create a deploy token at https://fly.io/dashboard/<app>/tokens.',
            });
        }
    }
    if (issues.length > 0) {
        return { ready: false, issues };
    }
    // At this point, required vars are validated and flyctl is resolved
    const appName = env['FLY_APP_NAME'];
    const org = env['FLY_ORG'];
    const resolvedPath = flyctlPath;
    return {
        ready: true,
        issues: [],
        config: {
            appName,
            primaryRegion: env['FLY_PRIMARY_REGION'] ?? 'iad',
            org,
            flyctlPath: resolvedPath,
        },
    };
}
/**
 * Resolve the flyctl binary path.
 *
 * Checks MORS_DEPLOY_FLYCTL_PATH override first, then searches PATH.
 * Returns the path if found, undefined otherwise.
 */
function resolveFlyctl(env) {
    // Allow override for testing
    const override = env['MORS_DEPLOY_FLYCTL_PATH'];
    if (override) {
        return override;
    }
    try {
        // Use argv-based execFileSync to avoid shell injection.
        // flyctl --version is used to verify the binary exists and is executable;
        // the PATH lookup is performed by execFileSync itself (no shell needed).
        execFileSync('flyctl', ['--version'], {
            encoding: 'utf8',
            timeout: 5_000,
            env: env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        return 'flyctl';
    }
    catch {
        return undefined;
    }
}
/**
 * Check if flyctl is authenticated by running `flyctl auth whoami`.
 *
 * @returns true if authenticated, false otherwise.
 */
function checkFlyctlAuth(flyctlPath) {
    try {
        execFileSync(flyctlPath, ['auth', 'whoami'], {
            encoding: 'utf8',
            timeout: 10_000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        return true;
    }
    catch {
        return false;
    }
}
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
export function redactSecrets(text, env = process.env) {
    let result = text;
    for (const key of SECRET_ENV_KEYS) {
        const value = env[key];
        if (value && value.length > 0) {
            // Use split/join for safe replacement (no regex escaping needed)
            result = result.split(value).join('[REDACTED]');
        }
    }
    return result;
}
/**
 * Format deploy pre-flight issues for human-readable output.
 *
 * @param issues - List of pre-flight issues.
 * @returns Formatted error string.
 */
export function formatDeployIssues(issues) {
    const lines = ['Deploy pre-flight check failed:', ''];
    for (const issue of issues) {
        lines.push(`  ✗ ${issue.message}`);
        lines.push(`    → ${issue.remediation}`);
        lines.push('');
    }
    return lines.join('\n');
}
/**
 * Format deploy pre-flight result as JSON.
 *
 * Ensures no secret values are embedded in the JSON output.
 *
 * @param result - Pre-flight result.
 * @param env - Environment for secret redaction.
 * @returns Safe JSON string.
 */
export function formatDeployResultJson(result, env = process.env) {
    const config = result.config;
    const payload = result.ready && config
        ? {
            status: 'ready',
            config: {
                appName: config.appName,
                primaryRegion: config.primaryRegion,
                org: config.org,
            },
        }
        : {
            status: 'error',
            error: result.issues.map((i) => i.category).join(', '),
            issues: result.issues.map((i) => ({
                category: i.category,
                message: i.message,
                remediation: i.remediation,
            })),
        };
    // Defense-in-depth: redact any secret values that might have leaked into messages
    return redactSecrets(JSON.stringify(payload, null, 2), env);
}
//# sourceMappingURL=deploy.js.map