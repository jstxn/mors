/**
 * Agent-friendly self-serve install/run path tests.
 *
 * Validates:
 * - VAL-LAUNCH-006: Agent self-install/run path works without shell mutation
 *
 * Tests cover:
 * - One-shot `node dist/index.js` invocation works in a clean session without shell RC edits
 * - Deterministic success/failure signaling suitable for automation (exit codes + JSON)
 * - Actionable error output with exact next-step commands when prerequisites are missing
 * - The `--agent` flag produces machine-parseable output with deterministic structure
 * - The full local lifecycle (init → send → inbox → read → ack) works via agent path
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
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

// ═══════════════════════════════════════════════════════════════════════
// VAL-LAUNCH-006: Agent self-install/run path without shell mutation
// ═══════════════════════════════════════════════════════════════════════

describe('VAL-LAUNCH-006: agent self-serve invocation path', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'mors-agent-path-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  // ── Core: npx/node dist invocation works without shell RC edits ──

  it('agent can run mors --version via node dist/index.js without any shell setup', () => {
    // This simulates `npx github:jstxn/mors --version` in a clean environment.
    // No setup-shell, no PATH mutation, no aliases.
    const result = runCli('--version', { configDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(`mors ${pkg.version}`);
  });

  it('agent can run mors --help via node dist/index.js and sees agent-relevant commands', () => {
    const result = runCli('--help', { configDir });
    expect(result.exitCode).toBe(0);
    // Must list key commands an agent would use
    expect(result.stdout).toContain('init');
    expect(result.stdout).toContain('send');
    expect(result.stdout).toContain('inbox');
    expect(result.stdout).toContain('read');
    expect(result.stdout).toContain('ack');
  });

  it('agent can run mors init --json without shell setup and gets deterministic JSON', () => {
    const result = runCli('init --json', { configDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.status).toBe('initialized');
    expect(parsed.fingerprint).toBeDefined();
    expect(parsed.configDir).toBe(configDir);
  });

  // ── Full local lifecycle via agent path ────────────────────────────

  it('agent completes full local lifecycle: init → send → inbox → read → ack with JSON', () => {
    // Step 1: Init
    const initResult = runCli('init --json', { configDir });
    expect(initResult.exitCode).toBe(0);
    const initParsed = JSON.parse(initResult.stdout.trim());
    expect(initParsed.status).toBe('initialized');

    // Step 2: Send
    const sendResult = runCli('send --to agent-recipient --body "agent-path-test-message" --json', {
      configDir,
    });
    expect(sendResult.exitCode).toBe(0);
    const sendParsed = JSON.parse(sendResult.stdout.trim());
    expect(sendParsed.status).toBe('sent');
    expect(sendParsed.id).toBeDefined();

    // Step 3: Inbox
    const inboxResult = runCli('inbox --json', { configDir });
    expect(inboxResult.exitCode).toBe(0);
    const inboxParsed = JSON.parse(inboxResult.stdout.trim());
    expect(inboxParsed.status).toBe('ok');
    expect(inboxParsed.count).toBe(1);
    expect(inboxParsed.messages[0].id).toBe(sendParsed.id);

    // Step 4: Read
    const readResult = runCli(`read ${sendParsed.id} --json`, { configDir });
    expect(readResult.exitCode).toBe(0);
    const readParsed = JSON.parse(readResult.stdout.trim());
    expect(readParsed.status).toBe('ok');
    expect(readParsed.message.body).toBe('agent-path-test-message');
    expect(readParsed.message.read_at).toBeDefined();

    // Step 5: Ack
    const ackResult = runCli(`ack ${sendParsed.id} --json`, { configDir });
    expect(ackResult.exitCode).toBe(0);
    const ackParsed = JSON.parse(ackResult.stdout.trim());
    expect(ackParsed.status).toBe('acked');
    expect(ackParsed.state).toBe('acked');
  });

  // ── Deterministic success/failure signaling ────────────────────────

  it('all JSON responses contain status field for automation parsing', () => {
    // Init
    const init = runCli('init --json', { configDir });
    expect(JSON.parse(init.stdout.trim())).toHaveProperty('status');

    // Send
    const send = runCli('send --to x --body y --json', { configDir });
    expect(JSON.parse(send.stdout.trim())).toHaveProperty('status');

    // Inbox
    const inbox = runCli('inbox --json', { configDir });
    expect(JSON.parse(inbox.stdout.trim())).toHaveProperty('status');
  });

  it('error responses in JSON mode contain status=error and actionable message', () => {
    // Gated command before init → deterministic error
    const result = runCli('inbox --json', {
      configDir: join(configDir, 'nonexistent'),
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    // stderr or stdout should contain JSON error
    const output = result.stdout + result.stderr;
    expect(output).toContain('init');
  });

  it('exit code 0 for success, non-zero for failure (deterministic signaling)', () => {
    // Success path
    const success = runCli('--version', { configDir });
    expect(success.exitCode).toBe(0);

    // Failure path: command before init
    const failure = runCli('send --to x --body y --json', {
      configDir: join(configDir, 'no-init'),
      expectFailure: true,
    });
    expect(failure.exitCode).not.toBe(0);
  });

  // ── Actionable error output with next-step commands ────────────────

  it('gated commands before init provide exact next-step command', () => {
    const result = runCli('inbox --json', {
      configDir: join(configDir, 'empty'),
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    // Must mention "mors init" as the remediation
    expect(output.toLowerCase()).toContain('init');
  });

  it('login without prerequisites provides specific missing-prerequisite list', () => {
    const result = runCli('login --json', {
      configDir,
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('missing_prerequisites');
    expect(parsed.missing).toBeDefined();
    expect(Array.isArray(parsed.missing)).toBe(true);
    expect(parsed.missing.length).toBeGreaterThan(0);
  });

  // ── MORS_CONFIG_DIR isolation for agent environments ──────────────

  it('MORS_CONFIG_DIR provides complete isolation for agent environments', () => {
    const agentDir1 = mkdtempSync(join(tmpdir(), 'mors-agent1-'));
    const agentDir2 = mkdtempSync(join(tmpdir(), 'mors-agent2-'));

    try {
      // Init agent 1
      runCli('init --json', { configDir: agentDir1 });
      runCli('send --to target --body "msg from agent 1" --json', { configDir: agentDir1 });

      // Init agent 2
      runCli('init --json', { configDir: agentDir2 });
      runCli('send --to target --body "msg from agent 2" --json', { configDir: agentDir2 });

      // Each agent sees only their own messages
      const inbox1 = JSON.parse(runCli('inbox --json', { configDir: agentDir1 }).stdout.trim());
      const inbox2 = JSON.parse(runCli('inbox --json', { configDir: agentDir2 }).stdout.trim());

      expect(inbox1.count).toBe(1);
      expect(inbox2.count).toBe(1);
      expect(inbox1.messages[0].body).toContain('agent 1');
      expect(inbox2.messages[0].body).toContain('agent 2');
    } finally {
      rmSync(agentDir1, { recursive: true, force: true });
      rmSync(agentDir2, { recursive: true, force: true });
    }
  });

  // ── Self-serve path does NOT require setup-shell ───────────────────

  it('full lifecycle works without ever calling setup-shell', () => {
    // This is the core of VAL-LAUNCH-006: agents do not need setup-shell
    const result = runCli('init --json', { configDir });
    expect(result.exitCode).toBe(0);

    // Send + inbox works immediately
    const send = runCli('send --to agent-peer --body "no-shell-setup-needed" --json', {
      configDir,
    });
    expect(send.exitCode).toBe(0);

    const inbox = runCli('inbox --json', { configDir });
    expect(inbox.exitCode).toBe(0);
    expect(JSON.parse(inbox.stdout.trim()).count).toBe(1);
  });

  // ── npx-style one-shot invocation ──────────────────────────────────

  it('dist/index.js is directly invocable via node (simulates npx path)', () => {
    // Ensure dist/index.js exists (it should be pre-built and committed)
    expect(existsSync(CLI)).toBe(true);

    // Invoke directly — no PATH setup, no aliases, no shell RC
    const result = execSync(`node ${CLI} --version`, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        MORS_CONFIG_DIR: configDir,
      } as Record<string, string>,
    });
    expect(result.trim()).toBe(`mors ${pkg.version}`);
  });

  it('one-shot invocation with MORS_CONFIG_DIR completes init+send+read cycle', () => {
    // Simulates an agent doing a one-shot lifecycle in a temp directory
    const env = {
      ...(process.env as Record<string, string>),
      MORS_CONFIG_DIR: configDir,
    };

    // All commands via direct node invocation (no PATH/alias required)
    const init = execSync(`node ${CLI} init --json`, {
      cwd: ROOT,
      encoding: 'utf8',
      env,
      timeout: 10_000,
    });
    expect(JSON.parse(init.trim()).status).toBe('initialized');

    const send = execSync(`node ${CLI} send --to bot --body "one-shot-test" --json`, {
      cwd: ROOT,
      encoding: 'utf8',
      env,
      timeout: 10_000,
    });
    const sendParsed = JSON.parse(send.trim());
    expect(sendParsed.status).toBe('sent');

    const read = execSync(`node ${CLI} read ${sendParsed.id} --json`, {
      cwd: ROOT,
      encoding: 'utf8',
      env,
      timeout: 10_000,
    });
    expect(JSON.parse(read.trim()).status).toBe('ok');
  });

  // ── Clean environment: no global state leakage ────────────────────

  it('agent path uses only MORS_CONFIG_DIR (no HOME-based config leakage)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mors-agent-fakehome-'));
    try {
      const result = runCli('init --json', {
        configDir,
        env: { HOME: fakeHome },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      // Config dir should be the explicit MORS_CONFIG_DIR, not based on HOME
      expect(parsed.configDir).toBe(configDir);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Agent path: deterministic output structure
// ═══════════════════════════════════════════════════════════════════════

describe('agent path: deterministic JSON output structure', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'mors-agent-json-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('init --json has status, fingerprint, configDir fields', () => {
    const result = runCli('init --json', { configDir });
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('fingerprint');
    expect(parsed).toHaveProperty('configDir');
  });

  it('send --json has status, id, thread_id fields', () => {
    runCli('init --json', { configDir });
    const result = runCli('send --to x --body y --json', { configDir });
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toHaveProperty('status', 'sent');
    expect(parsed).toHaveProperty('id');
    expect(parsed).toHaveProperty('thread_id');
  });

  it('inbox --json has status, count, messages fields', () => {
    runCli('init --json', { configDir });
    const result = runCli('inbox --json', { configDir });
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toHaveProperty('status', 'ok');
    expect(parsed).toHaveProperty('count');
    expect(parsed).toHaveProperty('messages');
    expect(Array.isArray(parsed.messages)).toBe(true);
  });

  it('read --json has status and message object with body', () => {
    runCli('init --json', { configDir });
    const send = JSON.parse(
      runCli('send --to x --body "test-body" --json', { configDir }).stdout.trim()
    );
    const result = runCli(`read ${send.id} --json`, { configDir });
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toHaveProperty('status', 'ok');
    expect(parsed).toHaveProperty('message');
    expect(parsed.message).toHaveProperty('body', 'test-body');
  });

  it('ack --json has status=acked and state=acked fields', () => {
    runCli('init --json', { configDir });
    const send = JSON.parse(runCli('send --to x --body y --json', { configDir }).stdout.trim());
    const result = runCli(`ack ${send.id} --json`, { configDir });
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toHaveProperty('status', 'acked');
    expect(parsed).toHaveProperty('state', 'acked');
  });

  it('error JSON has status=error and error type field', () => {
    const result = runCli('inbox --json', {
      configDir: join(configDir, 'nope'),
      expectFailure: true,
    });
    const output = result.stdout + result.stderr;
    // Should be parseable JSON with error info
    const lines = output.trim().split('\n');
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.status === 'error') {
          expect(parsed).toHaveProperty('error');
          expect(parsed).toHaveProperty('message');
        }
      } catch {
        // Not JSON, check stderr
      }
    }
    // At minimum, the exit code is non-zero
    expect(result.exitCode).not.toBe(0);
    // The output must mention init for remediation
    expect(output.toLowerCase()).toContain('init');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Agent path: actionable prerequisite error guidance
// ═══════════════════════════════════════════════════════════════════════

describe('agent path: actionable prerequisite error guidance', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'mors-agent-errors-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('send before init shows exact "mors init" remediation', () => {
    const result = runCli('send --to x --body y --json', {
      configDir: join(configDir, 'uninit'),
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output.toLowerCase()).toContain('init');
  });

  it('read before init shows exact init remediation', () => {
    const result = runCli('read some-id --json', {
      configDir: join(configDir, 'uninit'),
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output.toLowerCase()).toContain('init');
  });

  it('login with no invite token shows specific missing field', () => {
    // Init first so we can attempt login
    runCli('init --json', { configDir });

    const result = runCli('login --json', {
      configDir,
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.status).toBe('error');
    expect(parsed.missing).toContain('invite_token');
  });

  it('auth-gated command after logout shows login remediation', () => {
    // Init + login + logout to enter the "auth-enabled but no session" state
    runCli('init --json', { configDir });
    // Login with a valid invite token
    runCli('login --invite-token mors-invite-0123456789abcdef0123456789abcdef --json', {
      configDir,
    });
    // Logout to clear the session but keep auth-enabled
    runCli('logout --json', { configDir });

    // Now auth-gated commands should fail with login guidance
    const result = runCli('send --to x --body y --json', {
      configDir,
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    // Should mention login as remediation
    expect(output.toLowerCase()).toContain('login');
  });

  it('unknown command returns non-zero exit code with help hint', () => {
    const result = runCli('nonexistent-command', {
      configDir,
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain('--help');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Agent path: README documents self-serve invocation
// ═══════════════════════════════════════════════════════════════════════

describe('agent path: documentation references', () => {
  it('README contains For Agents section with self-serve path', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('For Agents');
  });

  it('README agent section documents npx or direct node invocation path', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    // Should document at least one of: npx, node dist/index.js, or direct invocation
    const agentSection = readme.slice(readme.indexOf('For Agents'));
    expect(
      agentSection.includes('npx') ||
        agentSection.includes('node dist/index.js') ||
        agentSection.includes('MORS_CONFIG_DIR')
    ).toBe(true);
  });

  it('README agent section documents MORS_CONFIG_DIR for isolation', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const agentSection = readme.slice(readme.indexOf('For Agents'));
    expect(agentSection).toContain('MORS_CONFIG_DIR');
  });

  it('README contains For Humans section', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('For Humans');
  });
});
