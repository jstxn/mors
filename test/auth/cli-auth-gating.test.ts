/**
 * CLI-level integration tests for auth gating and token liveness.
 *
 * Verifies that the full CLI command dispatch properly gates protected
 * commands after logout and validates token liveness for status.
 *
 * Covers:
 * - VAL-AUTH-005: Protected commands fail with login-required guidance after logout
 * - VAL-AUTH-006: Expired/revoked tokens are detected in status output
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';

import {
  saveSession,
  clearSession,
  markAuthEnabled,
  type AuthSession,
} from '../../src/auth/session.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = join(ROOT, 'dist', 'index.js');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mors-cli-auth-test-'));
}

function makeSession(overrides?: Partial<AuthSession>): AuthSession {
  return {
    accessToken: 'gho_test_cli_token_abc',
    tokenType: 'bearer',
    scope: 'read:user',
    githubUserId: 12345,
    githubLogin: 'testuser',
    deviceId: 'device-cli-001',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Initialize a mors config directory with sentinel files so init gate passes.
 * This simulates a previously-initialized instance without running full init.
 */
function simulateInit(configDir: string): void {
  mkdirSync(configDir, { recursive: true });
  // Create identity files
  writeFileSync(
    join(configDir, 'identity.json'),
    JSON.stringify({
      publicKey: 'a'.repeat(64),
      fingerprint: 'b'.repeat(64),
      createdAt: new Date().toISOString(),
    })
  );
  writeFileSync(join(configDir, 'identity.key'), Buffer.alloc(32, 0xaa), { mode: 0o600 });
  // Create init sentinel
  writeFileSync(join(configDir, '.initialized'), '');
}

/**
 * Run CLI command synchronously. Used for commands that don't make network calls.
 */
function runCli(
  args: string,
  options?: {
    configDir?: string;
    env?: Record<string, string>;
    expectFailure?: boolean;
  }
): { stdout: string; exitCode: number } {
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
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    if (options?.expectFailure) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return {
        stdout: (e.stdout ?? '') + (e.stderr ?? ''),
        exitCode: e.status ?? 1,
      };
    }
    throw err;
  }
}

/**
 * Run CLI command asynchronously. Required for tests that run a mock HTTP server
 * in the same process — spawnSync/execSync blocks the event loop and prevents
 * the server from handling requests.
 */
function runCliAsync(
  args: string[],
  options: {
    configDir?: string;
    env?: Record<string, string>;
    timeout?: number;
  }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...options.env,
    };
    if (options.configDir) {
      env['MORS_CONFIG_DIR'] = options.configDir;
    }

    const child = spawn('node', [CLI, ...args], {
      cwd: ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, options.timeout ?? 10_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

/**
 * Start a mock HTTP server and return the server + port.
 */
async function startMockServer(
  handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse
  ) => void
): Promise<{ server: Server; port: number }> {
  const { createServer } = await import('node:http');
  const server = createServer(handler);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return { server, port };
}

describe('CLI auth gating (VAL-AUTH-005)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    simulateInit(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Protected commands require auth ───────────────────────────────

  const protectedCommands = [
    'inbox --json',
    'send --to test --body hello --json',
    'read fake-id --json',
    'ack fake-id --json',
    'reply fake-id --body hello --json',
    'thread fake-id --json',
  ];

  for (const cmd of protectedCommands) {
    const commandName = cmd.split(' ')[0];

    it(`"${commandName}" fails with not_authenticated when no session exists`, () => {
      // Mark auth as enabled (user logged in before) but no session → should fail
      markAuthEnabled(tempDir);
      const result = runCli(cmd, { configDir: tempDir, expectFailure: true });

      expect(result.exitCode).not.toBe(0);
      const output = result.stdout;
      expect(output).toContain('not_authenticated');
      expect(output).toContain('mors login');
    });

    it(`"${commandName}" fails with not_authenticated after logout`, () => {
      // Setup: mark auth enabled, save session, then clear it (simulate login → logout)
      markAuthEnabled(tempDir);
      saveSession(tempDir, makeSession());
      clearSession(tempDir);

      const result = runCli(cmd, { configDir: tempDir, expectFailure: true });

      expect(result.exitCode).not.toBe(0);
      const output = result.stdout;
      expect(output).toContain('not_authenticated');
      expect(output).toContain('mors login');
    });
  }

  // ── Non-JSON mode also shows guidance ─────────────────────────────

  it('inbox without --json shows login guidance on stderr', () => {
    markAuthEnabled(tempDir);
    const result = runCli('inbox', { configDir: tempDir, expectFailure: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('mors login');
  });

  // ── Local-only mode bypasses auth ─────────────────────────────────

  it('commands work without auth when user has never logged in (local-only mode)', () => {
    // No auth marker → local mode, auth not required
    // inbox will fail because no DB exists, but it should NOT fail with auth error
    const result = runCli('inbox --json', { configDir: tempDir, expectFailure: true });

    // Should NOT be an auth error — it should be a store/key error instead
    expect(result.stdout).not.toContain('not_authenticated');
  });

  // ── Auth + init gating coexistence ────────────────────────────────

  it('init-only commands still work without auth (init is not auth-gated)', () => {
    // `mors status` should work without auth (it reports "not authenticated")
    const result = runCli('status --json --offline', { configDir: tempDir });

    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('not_authenticated');
  });

  // ── Logout → protected command → re-login cycle ───────────────────

  it('logout JSON output confirms session cleared and re-gates commands', () => {
    // Simulate a login (auth marker + session)
    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());

    const logoutResult = runCli('logout --json', { configDir: tempDir });
    const logoutParsed = JSON.parse(logoutResult.stdout);
    expect(logoutParsed.status).toBe('logged_out');
    expect(logoutParsed.had_session).toBe(true);

    // After logout, protected commands should fail because auth marker persists
    const inboxResult = runCli('inbox --json', { configDir: tempDir, expectFailure: true });
    expect(inboxResult.exitCode).not.toBe(0);

    const inboxParsed = JSON.parse(inboxResult.stdout);
    expect(inboxParsed.error).toBe('not_authenticated');
  });
});

describe('CLI status token liveness (VAL-AUTH-006)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    simulateInit(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('status --json reports token_expired for expired token', async () => {
    const { server, port } = await startMockServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Bad credentials' }));
    });

    try {
      saveSession(tempDir, makeSession({ accessToken: 'gho_expired_token_test' }));

      const result = await runCliAsync(['status', '--json'], {
        configDir: tempDir,
        env: { MORS_GITHUB_API_URL: `http://127.0.0.1:${port}` },
      });

      expect(result.exitCode).not.toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.status).toBe('token_expired');
      expect(parsed.token_valid).toBe(false);
      expect(parsed.message).toContain('mors login');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('status --json reports authenticated with valid token', async () => {
    const { server, port } = await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 12345, login: 'testuser' }));
    });

    try {
      saveSession(tempDir, makeSession());

      const result = await runCliAsync(['status', '--json'], {
        configDir: tempDir,
        env: { MORS_GITHUB_API_URL: `http://127.0.0.1:${port}` },
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.status).toBe('authenticated');
      expect(parsed.token_valid).toBe(true);
      expect(parsed.github_user_id).toBe(12345);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('status --offline --json skips liveness check and reports local session', () => {
    saveSession(tempDir, makeSession());

    const result = runCli('status --json --offline', { configDir: tempDir });

    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('authenticated');
    expect(parsed.github_user_id).toBe(12345);
    // Offline mode should not include token_valid field
    expect(parsed.token_valid).toBeUndefined();
  });

  it('expired token error does not leak token value', async () => {
    const tokenCanary = 'gho_canary_secret_no_leak_xyz';

    const { server, port } = await startMockServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Bad credentials' }));
    });

    try {
      saveSession(tempDir, makeSession({ accessToken: tokenCanary }));

      const result = await runCliAsync(['status', '--json'], {
        configDir: tempDir,
        env: { MORS_GITHUB_API_URL: `http://127.0.0.1:${port}` },
      });

      // Token value should not appear anywhere in output
      expect(result.stdout).not.toContain(tokenCanary);
      expect(result.stderr).not.toContain(tokenCanary);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
