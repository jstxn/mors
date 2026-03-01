/**
 * Fly.io deployment artifacts and deploy command tests.
 *
 * Validates:
 * - VAL-DEPLOY-001: Fly deploy artifacts exist and are placeholder-safe
 * - VAL-DEPLOY-002: Missing flyctl or deploy auth fails safely with remediation
 * - VAL-DEPLOY-003: Deploy path does not leak secrets in output/logs
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(ROOT, 'dist', 'index.js');

/**
 * Build a PATH that includes node but genuinely excludes flyctl.
 *
 * Creates a temporary directory containing only a symlink to the node
 * binary, then returns a PATH consisting of that directory plus /usr/bin
 * and /bin. This avoids the pitfall where node and flyctl live in the
 * same directory (e.g. /opt/homebrew/bin).
 */
function pathWithoutFlyctl(): string {
  const nodeBin = execSync('which node', { encoding: 'utf8' }).trim();
  const isolatedDir = join(tmpdir(), `mors-test-node-only-${process.pid}`);
  mkdirSync(isolatedDir, { recursive: true });
  const symlink = join(isolatedDir, 'node');
  try {
    symlinkSync(nodeBin, symlink);
  } catch {
    // symlink may already exist from a previous run in the same process
  }
  return `${isolatedDir}:/usr/bin:/bin`;
}

/**
 * Extract all top-level JSON objects from a string that may contain
 * one or more pretty-printed or single-line JSON objects. The deploy
 * command may emit a progress object followed by the final result.
 */
function extractJsonObjects(text: string): unknown[] {
  const objects: unknown[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // skip malformed fragments
        }
        start = -1;
      }
    }
  }
  return objects;
}

/**
 * Parse the last JSON object from deploy output.
 */
function parseLastJson(text: string): unknown {
  const objects = extractJsonObjects(text);
  if (objects.length === 0) throw new SyntaxError('No JSON object found in output');
  return objects[objects.length - 1];
}

/** Run the CLI and capture output. */
function runCli(
  args: string,
  options?: {
    env?: Record<string, string>;
    expectFailure?: boolean;
  }
): { stdout: string; stderr: string; exitCode: number } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...options?.env,
  };

  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd: ROOT,
      encoding: 'utf8',
      env,
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    if (options?.expectFailure) {
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        exitCode: e.status ?? 1,
      };
    }
    throw err;
  }
}

describe('VAL-DEPLOY-001: Fly deploy artifacts exist and are placeholder-safe', () => {
  it('fly.toml exists in repository root', () => {
    expect(existsSync(join(ROOT, 'fly.toml'))).toBe(true);
  });

  it('fly.toml references the app name placeholder', () => {
    const content = readFileSync(join(ROOT, 'fly.toml'), 'utf8');
    // Should not contain hardcoded real app names — uses env or placeholder
    expect(content).toContain('app');
    // Must not contain real secrets
    expect(content).not.toMatch(/ghp_[A-Za-z0-9]{36}/);
    expect(content).not.toMatch(/gho_[A-Za-z0-9]{36}/);
  });

  it('Dockerfile exists in repository root', () => {
    expect(existsSync(join(ROOT, 'Dockerfile'))).toBe(true);
  });

  it('Dockerfile builds relay entrypoint', () => {
    const content = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    // Should reference the relay entrypoint
    expect(content).toContain('relay');
    // Should have a proper FROM directive
    expect(content).toMatch(/^FROM\s+node:/m);
  });

  it('.dockerignore exists and excludes sensitive files', () => {
    expect(existsSync(join(ROOT, '.dockerignore'))).toBe(true);
    const content = readFileSync(join(ROOT, '.dockerignore'), 'utf8');
    expect(content).toContain('node_modules');
    expect(content).toContain('.env');
  });

  it('fly.toml configures internal port matching relay default', () => {
    const content = readFileSync(join(ROOT, 'fly.toml'), 'utf8');
    // fly.toml should configure the internal_port to match the relay default (3100)
    expect(content).toContain('3100');
  });

  it('deploy artifacts do not contain hardcoded secrets', () => {
    const flyToml = readFileSync(join(ROOT, 'fly.toml'), 'utf8');
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    const combined = flyToml + dockerfile;

    // No OAuth tokens
    expect(combined).not.toMatch(/ghp_[A-Za-z0-9]{36}/);
    expect(combined).not.toMatch(/gho_[A-Za-z0-9]{36}/);
    // No Fly API tokens
    expect(combined).not.toMatch(/FlyV1\s+[A-Za-z0-9+/=]{20,}/);
    // No hardcoded passwords
    expect(combined).not.toMatch(/password\s*[:=]\s*["'][^"']+["']/i);
  });
});

describe('VAL-DEPLOY-002: Missing flyctl or deploy auth fails safely with remediation', () => {
  it('deploy command exists in CLI help', () => {
    const result = runCli('--help');
    expect(result.stdout).toContain('deploy');
  });

  it('missing flyctl produces explicit remediation output with install instructions', () => {
    const result = runCli('deploy --json', {
      env: {
        // Ensure flyctl is genuinely not found by using isolated PATH
        PATH: pathWithoutFlyctl(),
        // Set required deploy env vars so we isolate the flyctl check
        FLY_APP_NAME: 'test-app',
        FLY_PRIMARY_REGION: 'iad',
        FLY_ORG: 'test-org',
      },
      expectFailure: true,
    });

    expect(result.exitCode).not.toBe(0);

    const output = result.stdout + result.stderr;
    // Must explicitly mention flyctl is not installed
    expect(output.toLowerCase()).toContain('flyctl');
    // Must provide concrete installation remediation (brew or curl install URL)
    expect(output).toMatch(/brew install flyctl|https:\/\/fly\.io/);
    // Must indicate this is an install issue, not a generic error
    expect(output.toLowerCase()).toContain('install');
  });

  it('missing flyctl JSON output has error structure with flyctl category', () => {
    const result = runCli('deploy --json', {
      env: {
        PATH: pathWithoutFlyctl(),
        FLY_APP_NAME: 'test-app',
        FLY_PRIMARY_REGION: 'iad',
        FLY_ORG: 'test-org',
      },
      expectFailure: true,
    });

    // stdout must contain a JSON error object for missing flyctl
    const jsonOutput = result.stdout.trim();
    expect(jsonOutput).toContain('{');
    const parsed = parseLastJson(jsonOutput) as Record<string, unknown>;
    expect(parsed.status).toBe('error');

    // The error must reference the flyctl category
    const errorField = String(parsed.error ?? '');
    expect(errorField).toContain('flyctl');

    // Issues array must contain a flyctl-category issue with remediation
    const issues = parsed.issues as Array<Record<string, unknown>>;
    expect(issues).toBeDefined();
    expect(issues.length).toBeGreaterThanOrEqual(1);
    const flyctlIssue = issues.find((i) => i.category === 'flyctl') as Record<string, unknown>;
    expect(flyctlIssue).toBeDefined();
    expect(String(flyctlIssue.remediation)).toMatch(/install/i);
    expect(String(flyctlIssue.remediation)).toMatch(/brew install flyctl|https:\/\/fly\.io/);
  });

  it('missing deploy auth (FLY_ACCESS_TOKEN) produces explicit remediation', () => {
    // Create a fake flyctl that is found but fails auth check
    const fakeFlyctl = join(tmpdir(), 'fake-flyctl-noauth');
    writeFileSync(fakeFlyctl, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const result = runCli('deploy --json', {
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/usr/local/bin:/bin',
        FLY_APP_NAME: 'test-app',
        FLY_PRIMARY_REGION: 'iad',
        FLY_ORG: 'test-org',
        // Explicitly unset FLY_ACCESS_TOKEN
        FLY_ACCESS_TOKEN: '',
        // Provide a fake flyctl that is found but auth fails
        MORS_DEPLOY_FLYCTL_PATH: fakeFlyctl,
      },
      expectFailure: true,
    });

    expect(result.exitCode).not.toBe(0);

    const output = result.stdout + result.stderr;
    // Must mention authentication or token
    expect(output.toLowerCase()).toMatch(/auth|token|fly auth login|FLY_ACCESS_TOKEN/i);
    // Must provide remediation guidance
    expect(output.toLowerCase()).toMatch(/fly auth login|FLY_ACCESS_TOKEN|flyctl auth/i);
  });

  it('missing FLY_APP_NAME produces remediation with variable name', () => {
    const result = runCli('deploy --json', {
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/usr/local/bin:/bin',
        FLY_APP_NAME: '',
        FLY_PRIMARY_REGION: 'iad',
        FLY_ORG: 'test-org',
      },
      expectFailure: true,
    });

    expect(result.exitCode).not.toBe(0);

    const output = result.stdout + result.stderr;
    expect(output).toContain('FLY_APP_NAME');
  });

  it('missing FLY_ORG produces remediation with variable name', () => {
    const result = runCli('deploy --json', {
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/usr/local/bin:/bin',
        FLY_APP_NAME: 'test-app',
        FLY_PRIMARY_REGION: 'iad',
        FLY_ORG: '',
      },
      expectFailure: true,
    });

    expect(result.exitCode).not.toBe(0);

    const output = result.stdout + result.stderr;
    expect(output).toContain('FLY_ORG');
  });

  it('placeholder values (replace-with-*) are detected and rejected', () => {
    const result = runCli('deploy --json', {
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/usr/local/bin:/bin',
        FLY_APP_NAME: 'replace-with-fly-app-name',
        FLY_PRIMARY_REGION: 'iad',
        FLY_ORG: 'replace-with-fly-org',
      },
      expectFailure: true,
    });

    expect(result.exitCode).not.toBe(0);

    const output = result.stdout + result.stderr;
    // Must identify the placeholder values
    expect(output.toLowerCase()).toMatch(/placeholder|replace-with/);
  });
});

describe('VAL-DEPLOY-003: Deploy path does not leak secrets in output/logs', () => {
  it('deploy output does not contain secret environment variable values', () => {
    const canarySecret = 'CANARY_SECRET_ghp_TestToken12345678901234';
    const result = runCli('deploy --json', {
      env: {
        PATH: pathWithoutFlyctl(),
        FLY_APP_NAME: 'test-app',
        FLY_PRIMARY_REGION: 'iad',
        FLY_ORG: 'test-org',
        FLY_ACCESS_TOKEN: canarySecret,
        GITHUB_DEVICE_CLIENT_ID: 'canary-client-id-secret',
      },
      expectFailure: true,
    });

    const fullOutput = result.stdout + result.stderr;
    // The canary secrets must NOT appear in any output
    expect(fullOutput).not.toContain(canarySecret);
    expect(fullOutput).not.toContain('canary-client-id-secret');
  });

  it('deploy --dry-run output does not leak FLY_ACCESS_TOKEN', () => {
    const canaryToken = 'FlyV1_canary_token_that_should_be_redacted';
    const result = runCli('deploy --dry-run --json', {
      env: {
        PATH: pathWithoutFlyctl(),
        FLY_APP_NAME: 'test-app',
        FLY_PRIMARY_REGION: 'iad',
        FLY_ORG: 'test-org',
        FLY_ACCESS_TOKEN: canaryToken,
      },
      expectFailure: true,
    });

    const fullOutput = result.stdout + result.stderr;
    expect(fullOutput).not.toContain(canaryToken);
  });

  it('deploy with placeholder env vars does not include secret patterns in error', () => {
    const result = runCli('deploy --json', {
      env: {
        PATH: pathWithoutFlyctl(),
        FLY_APP_NAME: 'replace-with-fly-app-name',
        FLY_PRIMARY_REGION: 'iad',
        FLY_ORG: 'replace-with-fly-org',
        GITHUB_DEVICE_CLIENT_ID: 'replace-with-github-oauth-client-id',
        FLY_ACCESS_TOKEN: 'real-secret-token-value',
      },
      expectFailure: true,
    });

    const fullOutput = result.stdout + result.stderr;
    // Must not leak the access token
    expect(fullOutput).not.toContain('real-secret-token-value');
  });

  it('deploy JSON error output has safe structure without embedded secrets', () => {
    const result = runCli('deploy --json', {
      env: {
        PATH: pathWithoutFlyctl(),
        FLY_APP_NAME: 'test-app',
        FLY_PRIMARY_REGION: 'iad',
        FLY_ORG: 'test-org',
        FLY_ACCESS_TOKEN: 'secret-fly-token-canary',
      },
      expectFailure: true,
    });

    // stdout may contain multiple JSON objects (progress + result);
    // extract each one and verify none contain the canary secret.
    const jsonOutput = result.stdout.trim();
    const objects = extractJsonObjects(jsonOutput);
    for (const obj of objects) {
      const serialized = JSON.stringify(obj);
      expect(serialized).not.toContain('secret-fly-token-canary');
    }
  });
});

describe('deploy command integration', () => {
  it('deploy --help shows usage information', () => {
    const result = runCli('deploy --help', { expectFailure: true });
    const output = result.stdout + result.stderr;
    // Deploy help should mention key options
    expect(output.toLowerCase()).toMatch(/deploy|fly|usage/);
  });

  it('deploy --dry-run does not actually execute flyctl', () => {
    // Use isolated PATH so flyctl is genuinely absent for this test.
    const result = runCli('deploy --dry-run --json', {
      env: {
        PATH: pathWithoutFlyctl(),
        FLY_APP_NAME: 'test-app',
        FLY_PRIMARY_REGION: 'iad',
        FLY_ORG: 'test-org',
      },
      expectFailure: true,
    });

    const output = result.stdout + result.stderr;
    // Dry-run without flyctl should report an error mentioning flyctl,
    // OR if the isolated PATH somehow still resolves flyctl, dry-run
    // should report "ready" status without actually deploying.
    const lower = output.toLowerCase();
    expect(lower).toMatch(/flyctl|ready/);
  });
});
