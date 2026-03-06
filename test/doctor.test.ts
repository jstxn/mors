/**
 * Doctor CLI command tests.
 *
 * Validates:
 * - VAL-LAUNCH-008: Doctor command emits actionable remediation for prerequisites and config
 *
 * Tests cover:
 * - `mors doctor` returns healthy status when environment is valid
 * - `mors doctor` reports targeted failures with explicit remediation commands
 * - Doctor output is deterministic and automation-friendly (including --json mode)
 * - Each check produces a pass/fail/warn status with remediation on failure
 * - Checks cover: node version, sqlcipher, init status, auth session, relay config, device keys
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'index.js');

/** Run the CLI and capture output with full control. */
function runCli(
  args: string,
  options?: {
    configDir?: string;
    env?: Record<string, string>;
    expectFailure?: boolean;
  }
): { stdout: string; stderr: string; exitCode: number } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...options?.env,
  };
  if (options?.configDir) {
    env['MORS_CONFIG_DIR'] = options.configDir;
  }

  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd: ROOT,
      encoding: 'utf8',
      env,
      timeout: 30_000,
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

// ═══════════════════════════════════════════════════════════════════════
// VAL-LAUNCH-008: Doctor command emits actionable remediation
// ═══════════════════════════════════════════════════════════════════════

describe('VAL-LAUNCH-008: doctor command healthy environment', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'mors-doctor-'));
    // Initialize the config dir so init check passes
    execSync(`node ${CLI} init --json`, {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...(process.env as Record<string, string>),
        MORS_CONFIG_DIR: configDir,
      },
      timeout: 15_000,
    });
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('doctor --json returns exit code 0 when core prerequisites pass', () => {
    const result = runCli('doctor --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.status).toBe('healthy');
  });

  it('doctor --json includes checks array with per-check results', () => {
    const result = runCli('doctor --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBeGreaterThan(0);
  });

  it('each check has name, status, and optional message fields', () => {
    const result = runCli('doctor --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());

    for (const check of parsed.checks) {
      expect(check).toHaveProperty('name');
      expect(typeof check.name).toBe('string');
      expect(check).toHaveProperty('status');
      expect(['pass', 'fail', 'warn']).toContain(check.status);
    }
  });

  it('doctor checks node version, sqlcipher, and init status', () => {
    const result = runCli('doctor --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());

    const names = parsed.checks.map((c: { name: string }) => c.name);
    expect(names).toContain('node_version');
    expect(names).toContain('sqlcipher');
    expect(names).toContain('init');
  });

  it('node_version check passes for current Node.js', () => {
    const result = runCli('doctor --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());

    const nodeCheck = parsed.checks.find((c: { name: string }) => c.name === 'node_version');
    expect(nodeCheck.status).toBe('pass');
  });

  it('sqlcipher check passes when SQLCipher is available', () => {
    const result = runCli('doctor --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());

    const sqlCheck = parsed.checks.find((c: { name: string }) => c.name === 'sqlcipher');
    expect(sqlCheck.status).toBe('pass');
  });

  it('init check passes when config dir is initialized', () => {
    const result = runCli('doctor --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());

    const initCheck = parsed.checks.find((c: { name: string }) => c.name === 'init');
    expect(initCheck.status).toBe('pass');
  });

  it('device_keys check passes when device keys are bootstrapped', () => {
    const result = runCli('doctor --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());

    const keysCheck = parsed.checks.find((c: { name: string }) => c.name === 'device_keys');
    expect(keysCheck.status).toBe('pass');
  });

  it('doctor --json output has deterministic structure', () => {
    const result = runCli('doctor --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());

    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('checks');
    expect(parsed).toHaveProperty('configDir');
    expect(parsed.configDir).toBe(configDir);
  });
});

describe('VAL-LAUNCH-008: doctor command failure detection', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'mors-doctor-fail-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  // ── Not initialized ──────────────────────────────────────────────

  it('init check fails with remediation when config dir is not initialized', () => {
    const result = runCli('doctor --json', {
      configDir,
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim());

    expect(parsed.status).toBe('unhealthy');

    const initCheck = parsed.checks.find((c: { name: string }) => c.name === 'init');
    expect(initCheck.status).toBe('fail');
    expect(initCheck.remediation).toBeDefined();
    expect(Array.isArray(initCheck.remediation)).toBe(true);
    expect(initCheck.remediation.length).toBeGreaterThan(0);
    // Remediation should include `mors init`
    const hasInitCmd = initCheck.remediation.some((r: string) => r.includes('mors init'));
    expect(hasInitCmd).toBe(true);
  });

  it('device_keys check fails with remediation when keys are missing', () => {
    // Initialize but then remove the e2ee keys
    execSync(`node ${CLI} init --json`, {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...(process.env as Record<string, string>),
        MORS_CONFIG_DIR: configDir,
      },
      timeout: 15_000,
    });

    // Remove device keys directory
    const keysDir = join(configDir, 'e2ee');
    rmSync(keysDir, { recursive: true, force: true });

    const result = runCli('doctor --json', {
      configDir,
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim());

    const keysCheck = parsed.checks.find((c: { name: string }) => c.name === 'device_keys');
    expect(keysCheck.status).toBe('fail');
    expect(keysCheck.remediation).toBeDefined();
    // Should suggest re-running init
    const hasRemediation = keysCheck.remediation.some((r: string) => r.includes('mors init'));
    expect(hasRemediation).toBe(true);
  });

  // ── SQLCipher unavailable (simulated) ────────────────────────────

  it('sqlcipher check fails with remediation when simulated unavailable', () => {
    const result = runCli('doctor --json --simulate-sqlcipher-failure', {
      configDir,
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim());

    const sqlCheck = parsed.checks.find((c: { name: string }) => c.name === 'sqlcipher');
    expect(sqlCheck.status).toBe('fail');
    expect(sqlCheck.remediation).toBeDefined();
    // Should suggest brew install sqlcipher
    const hasBrewCmd = sqlCheck.remediation.some((r: string) =>
      r.includes('brew install sqlcipher')
    );
    expect(hasBrewCmd).toBe(true);
  });

  // ── Auth session ─────────────────────────────────────────────────

  it('auth check warns when no session exists (not blocking)', () => {
    // Initialize first so init passes
    execSync(`node ${CLI} init --json`, {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...(process.env as Record<string, string>),
        MORS_CONFIG_DIR: configDir,
      },
      timeout: 15_000,
    });

    const result = runCli('doctor --json', { configDir });
    // Auth is a warn, not a hard fail — exit code 0
    const parsed = JSON.parse(result.stdout.trim());

    const authCheck = parsed.checks.find((c: { name: string }) => c.name === 'auth_session');
    expect(authCheck).toBeDefined();
    expect(authCheck.status).toBe('warn');
    expect(authCheck.remediation).toBeDefined();
    // Should suggest mors login
    const hasLoginCmd = authCheck.remediation.some((r: string) => r.includes('mors login'));
    expect(hasLoginCmd).toBe(true);
  });

  // ── Relay configuration ──────────────────────────────────────────

  it('relay_config check passes with the hosted relay default when MORS_RELAY_BASE_URL is not set', () => {
    // Initialize first
    execSync(`node ${CLI} init --json`, {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...(process.env as Record<string, string>),
        MORS_CONFIG_DIR: configDir,
      },
      timeout: 15_000,
    });

    // Ensure MORS_RELAY_BASE_URL is not set
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
    };
    delete env['MORS_RELAY_BASE_URL'];

    const result = runCli('doctor --json', {
      configDir,
      env,
    });
    const parsed = JSON.parse(result.stdout.trim());

    const relayCheck = parsed.checks.find((c: { name: string }) => c.name === 'relay_config');
    expect(relayCheck).toBeDefined();
    expect(relayCheck.status).toBe('pass');
    expect(relayCheck.message).toContain('https://relay.mors.app');
  });

  // ── Multiple failures ────────────────────────────────────────────

  it('doctor reports multiple failing checks at once', () => {
    // fresh configDir, not initialized, simulated sqlcipher failure
    const result = runCli('doctor --json --simulate-sqlcipher-failure', {
      configDir,
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim());

    expect(parsed.status).toBe('unhealthy');

    const failChecks = parsed.checks.filter((c: { status: string }) => c.status === 'fail');
    expect(failChecks.length).toBeGreaterThanOrEqual(2);
  });

  it('each failing check includes non-empty remediation array', () => {
    const result = runCli('doctor --json --simulate-sqlcipher-failure', {
      configDir,
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim());

    const failChecks = parsed.checks.filter((c: { status: string }) => c.status === 'fail');
    for (const check of failChecks) {
      expect(check.remediation).toBeDefined();
      expect(Array.isArray(check.remediation)).toBe(true);
      expect(check.remediation.length).toBeGreaterThan(0);
      for (const r of check.remediation) {
        expect(typeof r).toBe('string');
        expect(r.length).toBeGreaterThan(0);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Doctor: human-readable output
// ═══════════════════════════════════════════════════════════════════════

describe('doctor: human-readable output', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'mors-doctor-human-'));
    execSync(`node ${CLI} init --json`, {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...(process.env as Record<string, string>),
        MORS_CONFIG_DIR: configDir,
      },
      timeout: 15_000,
    });
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('doctor without --json produces human-readable output', () => {
    const result = runCli('doctor', { configDir });
    expect(result.exitCode).toBe(0);
    const output = result.stdout + result.stderr;
    // Should contain check results
    expect(output).toContain('node_version');
    expect(output).toContain('sqlcipher');
    expect(output).toContain('init');
  });

  it('human-readable output includes pass/fail indicators', () => {
    const result = runCli('doctor', { configDir });
    expect(result.exitCode).toBe(0);
    const output = result.stdout;
    // Should have success indicators
    expect(output).toMatch(/✓|pass|ok/i);
  });

  it('human-readable failure output includes remediation commands', () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'mors-doctor-fail-human-'));
    try {
      const result = runCli('doctor', {
        configDir: freshDir,
        expectFailure: true,
      });
      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      // Should mention the failed check and remediation
      expect(output.toLowerCase()).toMatch(/fail|✗|✘/);
      expect(output).toContain('mors init');
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Doctor: help integration
// ═══════════════════════════════════════════════════════════════════════

describe('doctor: help and discovery', () => {
  it('doctor appears in mors --help output', () => {
    const result = runCli('--help');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('doctor');
  });

  it('doctor --help shows usage information', () => {
    const result = runCli('doctor --help');
    expect(result.exitCode).toBe(0);
    const output = result.stdout;
    expect(output).toContain('doctor');
    expect(output.toLowerCase()).toMatch(/prerequisite|health|check/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Doctor: determinism and automation-friendly output
// ═══════════════════════════════════════════════════════════════════════

describe('doctor: determinism and automation', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'mors-doctor-determ-'));
    execSync(`node ${CLI} init --json`, {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...(process.env as Record<string, string>),
        MORS_CONFIG_DIR: configDir,
      },
      timeout: 15_000,
    });
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('doctor --json output is valid JSON', () => {
    const result = runCli('doctor --json', { configDir });
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout.trim())).not.toThrow();
  });

  it('consecutive doctor runs produce same check names and statuses', () => {
    const r1 = runCli('doctor --json', { configDir });
    const r2 = runCli('doctor --json', { configDir });

    const p1 = JSON.parse(r1.stdout.trim());
    const p2 = JSON.parse(r2.stdout.trim());

    expect(p1.status).toBe(p2.status);
    expect(p1.checks.length).toBe(p2.checks.length);

    for (let i = 0; i < p1.checks.length; i++) {
      expect(p1.checks[i].name).toBe(p2.checks[i].name);
      expect(p1.checks[i].status).toBe(p2.checks[i].status);
    }
  });

  it('exit code is deterministic: 0 for healthy, 1 for unhealthy', () => {
    // Healthy
    const healthy = runCli('doctor --json', { configDir });
    expect(healthy.exitCode).toBe(0);

    // Unhealthy (fresh dir)
    const freshDir = mkdtempSync(join(tmpdir(), 'mors-doctor-exit-'));
    try {
      const unhealthy = runCli('doctor --json', {
        configDir: freshDir,
        expectFailure: true,
      });
      expect(unhealthy.exitCode).toBe(1);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});
