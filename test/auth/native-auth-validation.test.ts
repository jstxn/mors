/**
 * Validation contract tests for mors-native auth assertions.
 *
 * Tests each assertion as a self-contained scenario exercising the full
 * CLI login/status flow with mors-native auth (invite-token + device-key bootstrap).
 *
 * Covers:
 * - VAL-AUTH-001: mors login starts native auth flow only (no GitHub dependency)
 * - VAL-AUTH-002: Successful native login persists session across restart
 * - VAL-AUTH-007: Missing native prerequisites fail with actionable guidance
 * - VAL-AUTH-011: Invite-token + device-key bootstrap are required before activation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import {
  validateInviteToken,
  generateInviteToken,
  generateSessionToken,
  verifySessionToken,
  generateSigningKey,
  NativeAuthPrerequisiteError,
} from '../../src/auth/native.js';

import { saveSession, loadSession, type AuthSession } from '../../src/auth/session.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = join(ROOT, 'dist', 'index.js');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mors-native-auth-val-'));
}

/**
 * Simulate a fully initialized mors config directory.
 * Creates identity files, init sentinel, and device keys.
 */
function simulateFullInit(configDir: string): void {
  mkdirSync(configDir, { recursive: true });
  // Identity files
  writeFileSync(
    join(configDir, 'identity.json'),
    JSON.stringify({
      publicKey: 'a'.repeat(64),
      fingerprint: 'b'.repeat(64),
      createdAt: new Date().toISOString(),
    })
  );
  writeFileSync(join(configDir, 'identity.key'), Buffer.alloc(32, 0xaa), { mode: 0o600 });
  // Init sentinel
  writeFileSync(join(configDir, '.initialized'), '');
  // Device E2EE keys
  const keysDir = join(configDir, 'e2ee');
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(join(keysDir, 'device.pub'), 'test-pub-key-data');
  writeFileSync(join(keysDir, 'device.key'), 'test-priv-key-data', { mode: 0o600 });
}

/**
 * Simulate init WITHOUT device keys (for testing prerequisite failure).
 */
function simulateInitNoDeviceKeys(configDir: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'identity.json'),
    JSON.stringify({
      publicKey: 'a'.repeat(64),
      fingerprint: 'b'.repeat(64),
      createdAt: new Date().toISOString(),
    })
  );
  writeFileSync(join(configDir, 'identity.key'), Buffer.alloc(32, 0xaa), { mode: 0o600 });
  writeFileSync(join(configDir, '.initialized'), '');
}

/**
 * Run CLI command against a custom config dir.
 */
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
    const e = err as { stdout?: string; stderr?: string; status?: number };
    if (options?.expectFailure) {
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        exitCode: e.status ?? 1,
      };
    }
    // If not expecting failure, throw to make test fail
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

// ── VAL-AUTH-001: CLI login starts mors-native auth flow (no GitHub dependency) ──

describe('VAL-AUTH-001: CLI login starts mors-native auth flow (no GitHub dependency)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('login with valid invite-token succeeds with native auth identity', () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    const result = runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('authenticated');
    expect(parsed.account_id).toBeTruthy();
    expect(parsed.device_id).toBeTruthy();
  });

  it('login output contains no GitHub URLs, device codes, or OAuth references', () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    const result = runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
    });

    const fullOutput = result.stdout + result.stderr;
    // No GitHub device flow artifacts
    expect(fullOutput).not.toContain('github.com/login/device');
    expect(fullOutput).not.toContain('verification_uri');
    expect(fullOutput).not.toContain('user_code');
    expect(fullOutput).not.toContain('device_code');
    expect(fullOutput).not.toContain('github.com/login/oauth');
    expect(fullOutput).not.toContain('GITHUB_DEVICE_CLIENT_ID');
  });

  it('login uses invite-token-derived account identity (not GitHub user ID)', () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    const result = runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
    });

    const parsed = JSON.parse(result.stdout);
    // Account ID should be a hex string derived from invite token, not a numeric GitHub ID
    expect(parsed.account_id).toMatch(/^[0-9a-f]{32}$/);
    // Device ID should be a UUID-based device identifier
    expect(parsed.device_id).toMatch(/^device-/);
  });

  it('native auth primitives: validateInviteToken accepts well-formed token', () => {
    const token = generateInviteToken();
    const result = validateInviteToken(token);
    expect(result.valid).toBe(true);
    expect(result.accountId).toBeTruthy();
    expect(result.accountId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('native auth primitives: session token round-trip with HMAC verification', () => {
    const signingKey = generateSigningKey();
    const token = generateSessionToken({
      accountId: 'acct_test_native_001',
      deviceId: 'device-native-001',
      signingKey,
    });

    expect(token).toMatch(/^mors-session\./);
    const payload = verifySessionToken(token, signingKey);
    expect(payload).not.toBeNull();
    if (payload) {
      expect(payload.accountId).toBe('acct_test_native_001');
      expect(payload.deviceId).toBe('device-native-001');
    }
  });

  it('native session token is NOT a GitHub OAuth token format', () => {
    const signingKey = generateSigningKey();
    const token = generateSessionToken({
      accountId: 'acct_native',
      deviceId: 'device-native',
      signingKey,
    });
    // Not a GitHub token format (gho_*, ghp_*, etc.)
    expect(token).not.toMatch(/^gh[ops]_/);
    expect(token).toMatch(/^mors-session\./);
  });
});

// ── VAL-AUTH-002: Successful native login establishes persisted authenticated session ──

describe('VAL-AUTH-002: Successful native login persists session across restart', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('after login, mors status shows native account identity', () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    // Login
    const loginResult = runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
    });
    expect(loginResult.exitCode).toBe(0);
    const loginParsed = JSON.parse(loginResult.stdout);
    const accountId = loginParsed.account_id;

    // Status in same config dir (simulates restart — different process)
    const statusResult = runCli('status --json --offline', {
      configDir: tempDir,
    });
    expect(statusResult.exitCode).toBe(0);
    const statusParsed = JSON.parse(statusResult.stdout);
    expect(statusParsed.status).toBe('authenticated');
    expect(statusParsed.account_id).toBe(accountId);
  });

  it('session file survives across two separate CLI process invocations', () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    // First process: login
    runCli(`login --invite-token ${inviteToken} --json`, { configDir: tempDir });

    // Verify session file exists on disk
    const session = loadSession(tempDir);
    expect(session).not.toBeNull();
    const sessionData = session as AuthSession;
    expect(sessionData.accessToken).toMatch(/^mors-session\./);
    expect(sessionData.accountId).toMatch(/^[0-9a-f]{32}$/);

    // Second process: status (completely new execSync = new process)
    const statusResult = runCli('status --json --offline', { configDir: tempDir });
    const parsed = JSON.parse(statusResult.stdout);
    expect(parsed.status).toBe('authenticated');
    expect(parsed.account_id).toBe(sessionData.accountId);
  });

  it('status with token liveness check verifies HMAC-signed session', () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    // Login (which generates and saves signing key)
    runCli(`login --invite-token ${inviteToken} --json`, { configDir: tempDir });

    // Status WITH liveness check (no --offline) — verifies HMAC locally
    const statusResult = runCli('status --json', { configDir: tempDir });
    expect(statusResult.exitCode).toBe(0);
    const parsed = JSON.parse(statusResult.stdout);
    expect(parsed.status).toBe('authenticated');
    expect(parsed.token_valid).toBe(true);
  });

  it('session persistence primitives: save + load round-trip preserves all fields', () => {
    const session: AuthSession = {
      accessToken: 'mors-session.payload.sig',
      tokenType: 'bearer',
      accountId: 'acct_persist_test_001',
      deviceId: 'device-persist-001',
      createdAt: new Date().toISOString(),
    };

    saveSession(tempDir, session);
    const loaded = loadSession(tempDir);
    expect(loaded).toEqual(session);
  });
});

// ── VAL-AUTH-007: Missing native onboarding prerequisites fail safely ──

describe('VAL-AUTH-007: Missing native prerequisites fail with actionable guidance', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('login without invite-token fails with missing_prerequisites and non-zero exit', () => {
    simulateFullInit(tempDir);

    const result = runCli('login --json', {
      configDir: tempDir,
      expectFailure: true,
    });

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('missing_prerequisites');
    expect(parsed.missing).toContain('invite_token');
  });

  it('login without device keys fails with missing_prerequisites and guidance', () => {
    simulateInitNoDeviceKeys(tempDir);
    const inviteToken = generateInviteToken();

    const result = runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
      expectFailure: true,
    });

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('missing_prerequisites');
    expect(parsed.missing).toContain('device_keys');
  });

  it('login without init fails with missing_prerequisites including "initialized"', () => {
    // Empty temp dir — nothing initialized
    const result = runCli('login --json', {
      configDir: tempDir,
      expectFailure: true,
    });

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('missing_prerequisites');
    expect(parsed.missing).toContain('initialized');
  });

  it('missing prerequisite error message includes remediation steps', () => {
    // No init, no device keys, no invite token
    const result = runCli('login --json', {
      configDir: tempDir,
      expectFailure: true,
    });

    const parsed = JSON.parse(result.stdout);
    const message = parsed.message as string;

    // Must include specific remediation for each missing item
    expect(message).toContain('mors init');
    expect(message).toContain('invite token');
  });

  it('non-JSON login without prerequisites prints error to stderr with non-zero exit', () => {
    const result = runCli('login', {
      configDir: tempDir,
      expectFailure: true,
    });

    expect(result.exitCode).not.toBe(0);
    const errOutput = result.stderr;
    expect(errOutput).toContain('Missing required authentication prerequisites');
    // Should mention remediation
    expect(errOutput).toMatch(/mors init|invite token/i);
  });

  it('NativeAuthPrerequisiteError lists all missing items', () => {
    const err = new NativeAuthPrerequisiteError(['invite_token', 'device_keys', 'initialized']);
    expect(err.missing).toEqual(['invite_token', 'device_keys', 'initialized']);
    expect(err.message).toContain('invite_token');
    expect(err.message).toContain('device_keys');
    expect(err.message).toContain('initialized');
    expect(err.message).toContain('--invite-token');
    expect(err.message).toContain('mors init');
  });
});

// ── VAL-AUTH-011: Invite-token and device-key bootstrap are required during onboarding ──

describe('VAL-AUTH-011: Invite-token and device-key bootstrap are required', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('login with invalid invite-token format is rejected', () => {
    simulateFullInit(tempDir);

    const result = runCli('login --invite-token not-a-valid-token --json', {
      configDir: tempDir,
      expectFailure: true,
    });

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('invalid_invite_token');
    expect(parsed.message).toContain('format');
  });

  it('login with empty invite-token is rejected as missing prerequisite', () => {
    simulateFullInit(tempDir);

    const result = runCli('login --invite-token "" --json', {
      configDir: tempDir,
      expectFailure: true,
    });

    expect(result.exitCode).not.toBe(0);
  });

  it('login with absent device key files is rejected', () => {
    simulateInitNoDeviceKeys(tempDir);
    const inviteToken = generateInviteToken();

    const result = runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
      expectFailure: true,
    });

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error).toBe('missing_prerequisites');
    expect(parsed.missing).toContain('device_keys');
  });

  it('successful invite-token + device-key bootstrap activates account', () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    // Login with valid invite token + device keys present
    const loginResult = runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
    });

    expect(loginResult.exitCode).toBe(0);
    const parsed = JSON.parse(loginResult.stdout);
    expect(parsed.status).toBe('authenticated');
    expect(parsed.account_id).toBeTruthy();

    // Verify session was persisted (account is now activated)
    const session = loadSession(tempDir);
    expect(session).not.toBeNull();
    const sessionData = session as AuthSession;
    expect(sessionData.accountId).toBe(parsed.account_id);
    expect(sessionData.accessToken).toMatch(/^mors-session\./);
  });

  it('invite-token can be passed via MORS_INVITE_TOKEN env var', () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    const result = runCli('login --json', {
      configDir: tempDir,
      env: { MORS_INVITE_TOKEN: inviteToken },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('authenticated');
  });

  it('validateInviteToken rejects null/undefined/empty', () => {
    expect(validateInviteToken(null).valid).toBe(false);
    expect(validateInviteToken(undefined).valid).toBe(false);
    expect(validateInviteToken('').valid).toBe(false);
    expect(validateInviteToken('   ').valid).toBe(false);
  });

  it('validateInviteToken rejects short/malformed tokens', () => {
    expect(validateInviteToken('mors-invite-abc').valid).toBe(false);
    expect(validateInviteToken('not-mors-prefix').valid).toBe(false);
    expect(validateInviteToken('mors-invite-').valid).toBe(false);
  });

  it('validateInviteToken rejects non-hex characters', () => {
    expect(validateInviteToken('mors-invite-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz').valid).toBe(false);
    expect(validateInviteToken('mors-invite-GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG').valid).toBe(false);
  });

  it('same invite-token produces same account ID (deterministic derivation)', () => {
    const token = generateInviteToken();
    const r1 = validateInviteToken(token);
    const r2 = validateInviteToken(token);
    expect(r1.accountId).toBe(r2.accountId);
    expect(r1.accountId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('different invite-tokens produce different account IDs', () => {
    const t1 = generateInviteToken();
    const t2 = generateInviteToken();
    const r1 = validateInviteToken(t1);
    const r2 = validateInviteToken(t2);
    expect(r1.accountId).not.toBe(r2.accountId);
  });
});
