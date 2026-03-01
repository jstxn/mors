/**
 * Quickstart CLI command tests.
 *
 * Validates:
 * - VAL-LAUNCH-007: Quickstart command achieves first-success local lifecycle
 *
 * Tests cover:
 * - Quickstart runs deterministic local lifecycle sequence (init → send → inbox → read → ack)
 * - Quickstart reports explicit success when all lifecycle steps pass
 * - Failure output includes actionable next command(s) for recovery
 * - JSON output is machine-readable with per-step results and summary
 * - Fresh config context isolation
 * - Simulated failure paths with remediation guidance
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
// VAL-LAUNCH-007: Quickstart command achieves first-success local lifecycle
// ═══════════════════════════════════════════════════════════════════════

describe('VAL-LAUNCH-007: quickstart command first-success lifecycle', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'mors-quickstart-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  // ── Core happy path ────────────────────────────────────────────────

  it('quickstart --json succeeds with exit code 0 in a fresh config dir', () => {
    const result = runCli('quickstart --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.status).toBe('success');
  });

  it('quickstart runs all five lifecycle steps: init, send, inbox, read, ack', () => {
    const result = runCli('quickstart --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.steps).toBeDefined();
    expect(Array.isArray(parsed.steps)).toBe(true);

    const stepNames = parsed.steps.map((s: { name: string }) => s.name);
    expect(stepNames).toContain('init');
    expect(stepNames).toContain('send');
    expect(stepNames).toContain('inbox');
    expect(stepNames).toContain('read');
    expect(stepNames).toContain('ack');
  });

  it('each lifecycle step reports individual success status', () => {
    const result = runCli('quickstart --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());

    for (const step of parsed.steps) {
      expect(step.status).toBe('pass');
      expect(step.name).toBeDefined();
    }
  });

  it('quickstart returns message ID used across read and ack steps', () => {
    const result = runCli('quickstart --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());

    // The send step should produce a message ID
    const sendStep = parsed.steps.find((s: { name: string }) => s.name === 'send');
    expect(sendStep).toBeDefined();
    expect(sendStep.messageId).toBeDefined();

    // inbox step should find the message
    const inboxStep = parsed.steps.find((s: { name: string }) => s.name === 'inbox');
    expect(inboxStep).toBeDefined();
    expect(inboxStep.messageId).toBe(sendStep.messageId);

    // read/ack steps should reference the same message
    const readStep = parsed.steps.find((s: { name: string }) => s.name === 'read');
    expect(readStep).toBeDefined();
    expect(readStep.messageId).toBe(sendStep.messageId);

    const ackStep = parsed.steps.find((s: { name: string }) => s.name === 'ack');
    expect(ackStep).toBeDefined();
    expect(ackStep.messageId).toBe(sendStep.messageId);
  });

  it('quickstart summary includes total step count and pass count', () => {
    const result = runCli('quickstart --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());

    expect(parsed.totalSteps).toBe(5);
    expect(parsed.passedSteps).toBe(5);
  });

  // ── Fresh config context isolation ─────────────────────────────────

  it('quickstart uses MORS_CONFIG_DIR for isolation', () => {
    const result = runCli('quickstart --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.configDir).toBe(configDir);
  });

  it('quickstart in two different config dirs produces independent results', () => {
    const configDir2 = mkdtempSync(join(tmpdir(), 'mors-quickstart2-'));
    try {
      const result1 = runCli('quickstart --json', { configDir });
      const result2 = runCli('quickstart --json', { configDir: configDir2 });

      expect(result1.exitCode).toBe(0);
      expect(result2.exitCode).toBe(0);

      const parsed1 = JSON.parse(result1.stdout.trim());
      const parsed2 = JSON.parse(result2.stdout.trim());

      // Each should have its own message IDs
      const send1 = parsed1.steps.find((s: { name: string }) => s.name === 'send');
      const send2 = parsed2.steps.find((s: { name: string }) => s.name === 'send');
      expect(send1.messageId).not.toBe(send2.messageId);
    } finally {
      rmSync(configDir2, { recursive: true, force: true });
    }
  });

  // ── Already-initialized config dir ─────────────────────────────────

  it('quickstart succeeds even if config dir is already initialized', () => {
    // Init first
    runCli('init --json', { configDir });

    // Quickstart should still work (init step handles idempotency)
    const result = runCli('quickstart --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.status).toBe('success');
  });

  // ── Human-readable output mode ────────────────────────────────────

  it('quickstart without --json produces human-readable output with success marker', () => {
    const result = runCli('quickstart', { configDir });
    expect(result.exitCode).toBe(0);
    const output = result.stdout + result.stderr;
    // Should contain the lifecycle steps mentioned
    expect(output).toContain('init');
    expect(output).toContain('send');
    expect(output).toContain('inbox');
    expect(output).toContain('read');
    expect(output).toContain('ack');
    // Should have a success indicator
    expect(output.toLowerCase()).toMatch(/success|pass|✓|ok/);
  });

  // ── Deterministic structure ────────────────────────────────────────

  it('quickstart --json output is valid JSON with required top-level fields', () => {
    const result = runCli('quickstart --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());

    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('steps');
    expect(parsed).toHaveProperty('totalSteps');
    expect(parsed).toHaveProperty('passedSteps');
    expect(parsed).toHaveProperty('configDir');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Quickstart failure paths with actionable remediation
// ═══════════════════════════════════════════════════════════════════════

describe('quickstart: failure paths and remediation', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'mors-quickstart-fail-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('quickstart --json with simulated init failure returns failure status', () => {
    const result = runCli('quickstart --json --simulate-init-failure', {
      configDir,
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.status).toBe('failure');
  });

  it('failure output includes actionable next commands for recovery', () => {
    const result = runCli('quickstart --json --simulate-init-failure', {
      configDir,
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.status).toBe('failure');
    // Must include remediation
    expect(parsed.remediation).toBeDefined();
    expect(Array.isArray(parsed.remediation)).toBe(true);
    expect(parsed.remediation.length).toBeGreaterThan(0);
    // Each remediation should be a string (command or instruction)
    for (const r of parsed.remediation) {
      expect(typeof r).toBe('string');
      expect(r.length).toBeGreaterThan(0);
    }
  });

  it('failure output identifies which step failed', () => {
    const result = runCli('quickstart --json --simulate-init-failure', {
      configDir,
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim());

    // Should have at least one step with fail status
    const failedSteps = parsed.steps.filter((s: { status: string }) => s.status === 'fail');
    expect(failedSteps.length).toBeGreaterThan(0);

    // Failed step should include error message
    for (const s of failedSteps) {
      expect(s.error).toBeDefined();
      expect(typeof s.error).toBe('string');
    }
  });

  it('steps after a failure are reported as skipped', () => {
    const result = runCli('quickstart --json --simulate-init-failure', {
      configDir,
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim());

    // Init should fail, so subsequent steps should be skipped
    const initStep = parsed.steps.find((s: { name: string }) => s.name === 'init');
    expect(initStep.status).toBe('fail');

    // Steps after init should be skipped
    const skippedSteps = parsed.steps.filter((s: { status: string }) => s.status === 'skipped');
    expect(skippedSteps.length).toBeGreaterThan(0);
  });

  it('passedSteps count reflects actual passes (not total)', () => {
    const result = runCli('quickstart --json --simulate-init-failure', {
      configDir,
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim());

    expect(parsed.passedSteps).toBeLessThan(parsed.totalSteps);
  });

  it('human-readable failure output mentions the failed step and next action', () => {
    const result = runCli('quickstart --simulate-init-failure', {
      configDir,
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    // Should mention the failure
    expect(output.toLowerCase()).toMatch(/fail|error|✗|✘/);
    // Should suggest what to do
    expect(output.toLowerCase()).toMatch(/init|sqlcipher|brew/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Quickstart: help integration
// ═══════════════════════════════════════════════════════════════════════

describe('quickstart: help and discovery', () => {
  it('quickstart appears in mors --help output', () => {
    const result = runCli('--help');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('quickstart');
  });

  it('quickstart --help shows usage information', () => {
    const result = runCli('quickstart --help');
    expect(result.exitCode).toBe(0);
    const output = result.stdout;
    expect(output).toContain('quickstart');
    expect(output.toLowerCase()).toContain('lifecycle');
  });
});
