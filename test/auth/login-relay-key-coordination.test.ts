/**
 * Tests for deterministic key coordination between CLI native login token
 * issuance and relay verification.
 *
 * Ensures login-issued sessions are reliably accepted by the relay under
 * configured signing-key policy.
 *
 * Feature: native-identity-core-fix-login-relay-key-coordination
 *
 * Covers:
 * - Login-issued tokens validate against relay verifier in normal configured flow
 * - Mismatched signing-key paths fail with explicit remediation
 * - Native auth session reliability holds across process restart
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import {
  generateInviteToken,
  generateSigningKey,
  verifySessionToken,
} from '../../src/auth/native.js';
import { loadSession, loadSigningKey, type AuthSession } from '../../src/auth/session.js';
import { createNativeTokenVerifier } from '../../src/relay/auth-middleware.js';
import { createRelayServer } from '../../src/relay/server.js';
import { loadRelayConfig } from '../../src/relay/config.js';
import { getTestPort } from '../helpers/test-port.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = join(ROOT, 'dist', 'index.js');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mors-key-coord-'));
}

/**
 * Simulate a fully initialized mors config directory with device keys.
 */
function simulateFullInit(configDir: string): void {
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
  const keysDir = join(configDir, 'e2ee');
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(join(keysDir, 'device.pub'), 'test-pub-key-data');
  writeFileSync(join(keysDir, 'device.key'), 'test-priv-key-data', { mode: 0o600 });
}

/**
 * Run CLI command with configDir and optional env overrides.
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
  // Remove relay env vars that might leak from the test runner environment
  // unless explicitly set in options?.env
  if (!options?.env?.['MORS_RELAY_BASE_URL']) {
    delete env['MORS_RELAY_BASE_URL'];
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
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

// ── Login-issued tokens validate against relay verifier (normal configured flow) ──

describe('login-issued tokens validate against relay verifier in configured flow', () => {
  let tempDir: string;
  let relaySigningKey: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    relaySigningKey = generateSigningKey();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('login with MORS_RELAY_SIGNING_KEY uses the shared signing key', () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    const result = runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
      env: { MORS_RELAY_SIGNING_KEY: relaySigningKey },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('authenticated');

    // The session token should be verifiable with the relay signing key
    const session = loadSession(tempDir) as AuthSession;
    expect(session).not.toBeNull();
    const payload = verifySessionToken(session.accessToken, relaySigningKey);
    expect(payload).not.toBeNull();
    expect(payload?.accountId).toBe(parsed.account_id);
  });

  it('login-issued token is accepted by createNativeTokenVerifier with same key', async () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    const result = runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
      env: { MORS_RELAY_SIGNING_KEY: relaySigningKey },
    });

    expect(result.exitCode).toBe(0);
    const session = loadSession(tempDir) as AuthSession;
    expect(session).not.toBeNull();

    // Simulate the relay's token verifier using the same signing key
    const verifier = createNativeTokenVerifier(relaySigningKey);
    const principal = await verifier(session.accessToken);
    expect(principal).not.toBeNull();
    expect(principal?.accountId).toBeTruthy();
  });

  it('login-issued token works against a real relay server with the same signing key', async () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    // Login with shared signing key
    const loginResult = runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
      env: { MORS_RELAY_SIGNING_KEY: relaySigningKey },
    });

    expect(loginResult.exitCode).toBe(0);
    const session = loadSession(tempDir) as AuthSession;
    expect(session).not.toBeNull();

    // Start a relay server with the same signing key
    const port = getTestPort();
    const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
    const verifier = createNativeTokenVerifier(relaySigningKey);
    const server = createRelayServer(config, { tokenVerifier: verifier });
    await server.start();

    try {
      // Use the login-issued token to access a protected endpoint
      const res = await fetch(`http://127.0.0.1:${server.port}/events`, {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          Accept: 'text/event-stream',
        },
      });
      // Should be 200 (SSE connection accepted), not 401
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
    } finally {
      await server.close();
    }
  });

  it('token persisted after login round-trips through relay verifier across process restart', async () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    // Login (process 1)
    runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
      env: { MORS_RELAY_SIGNING_KEY: relaySigningKey },
    });

    // Reload session from disk (simulates new process)
    const session = loadSession(tempDir) as AuthSession;
    expect(session).not.toBeNull();

    // Verify against relay verifier (the relay also uses this key)
    const verifier = createNativeTokenVerifier(relaySigningKey);
    const principal = await verifier(session.accessToken);
    expect(principal).not.toBeNull();
    expect(principal?.accountId).toBeTruthy();

    // Status check in a separate process also verifies OK
    const statusResult = runCli('status --json', {
      configDir: tempDir,
      env: { MORS_RELAY_SIGNING_KEY: relaySigningKey },
    });
    expect(statusResult.exitCode).toBe(0);
    const parsed = JSON.parse(statusResult.stdout);
    expect(parsed.status).toBe('authenticated');
    expect(parsed.token_valid).toBe(true);
  });
});

// ── Mismatched signing-key paths fail with explicit remediation ──

describe('mismatched signing-key paths fail with explicit remediation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('token signed with local key is rejected by relay with different MORS_RELAY_SIGNING_KEY', async () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    // Login WITHOUT relay signing key (falls back to local key)
    const loginResult = runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
    });
    expect(loginResult.exitCode).toBe(0);

    const session = loadSession(tempDir) as AuthSession;
    expect(session).not.toBeNull();

    // Relay uses a different signing key
    const differentRelayKey = generateSigningKey();
    const verifier = createNativeTokenVerifier(differentRelayKey);
    const principal = await verifier(session.accessToken);

    // Token must be rejected — key mismatch
    expect(principal).toBeNull();
  });

  it('status with MORS_RELAY_SIGNING_KEY detects token signed with different local key', () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    // Login with one signing key
    const localKey = generateSigningKey();
    runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
      env: { MORS_RELAY_SIGNING_KEY: localKey },
    });

    // Status with a different signing key should detect the mismatch
    const differentKey = generateSigningKey();
    const statusResult = runCli('status --json', {
      configDir: tempDir,
      env: { MORS_RELAY_SIGNING_KEY: differentKey },
    });

    // Token should fail verification since keys don't match
    expect(statusResult.exitCode).not.toBe(0);
    const parsed = JSON.parse(statusResult.stdout);
    expect(parsed.status).toBe('token_expired');
    expect(parsed.token_valid).toBe(false);
  });

  it('relay rejects login-issued token when keys differ and returns 401', async () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    // Login with key A
    const keyA = generateSigningKey();
    runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
      env: { MORS_RELAY_SIGNING_KEY: keyA },
    });

    const session = loadSession(tempDir) as AuthSession;
    expect(session).not.toBeNull();

    // Relay uses key B (mismatch)
    const keyB = generateSigningKey();
    const port = getTestPort();
    const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
    const verifier = createNativeTokenVerifier(keyB);
    const server = createRelayServer(config, { tokenVerifier: verifier });
    await server.start();

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/events`, {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          Accept: 'text/event-stream',
        },
      });
      // Must be 401 (not 200) — key mismatch
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

// ── Native auth session reliability across process restart ──

describe('native auth session reliability across process restart', () => {
  let tempDir: string;
  let relaySigningKey: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    relaySigningKey = generateSigningKey();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('login → status → relay verify all use consistent signing key from env', async () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    // Step 1: Login with env signing key
    const loginResult = runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
      env: { MORS_RELAY_SIGNING_KEY: relaySigningKey },
    });
    expect(loginResult.exitCode).toBe(0);

    // Step 2: Status verifies token (separate process)
    const statusResult = runCli('status --json', {
      configDir: tempDir,
      env: { MORS_RELAY_SIGNING_KEY: relaySigningKey },
    });
    expect(statusResult.exitCode).toBe(0);
    const statusParsed = JSON.parse(statusResult.stdout);
    expect(statusParsed.token_valid).toBe(true);

    // Step 3: Relay verifier accepts the token
    const session = loadSession(tempDir) as AuthSession;
    const verifier = createNativeTokenVerifier(relaySigningKey);
    const principal = await verifier(session.accessToken);
    expect(principal).not.toBeNull();
    expect(principal?.accountId).toBe(statusParsed.account_id);
  });

  it('MORS_RELAY_SIGNING_KEY takes precedence over local signing key for login', () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();
    const envKey = relaySigningKey;

    // Login with MORS_RELAY_SIGNING_KEY set
    runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
      env: { MORS_RELAY_SIGNING_KEY: envKey },
    });

    const session = loadSession(tempDir) as AuthSession;
    expect(session).not.toBeNull();

    // Token MUST be verifiable with the env key (not some other random local key)
    const payload = verifySessionToken(session.accessToken, envKey);
    expect(payload).not.toBeNull();
    expect(payload?.accountId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('without MORS_RELAY_SIGNING_KEY, login falls back to local signing key', () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    // Login without env key
    runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
    });

    const session = loadSession(tempDir) as AuthSession;
    expect(session).not.toBeNull();

    // Token should be verifiable with the local signing key
    const localKey = loadSigningKey(tempDir) as string;
    expect(localKey).not.toBeNull();
    const payload = verifySessionToken(session.accessToken, localKey);
    expect(payload).not.toBeNull();
  });

  it('token liveness uses MORS_RELAY_SIGNING_KEY when available for verification', () => {
    simulateFullInit(tempDir);
    const inviteToken = generateInviteToken();

    // Login with relay signing key
    runCli(`login --invite-token ${inviteToken} --json`, {
      configDir: tempDir,
      env: { MORS_RELAY_SIGNING_KEY: relaySigningKey },
    });

    // Status with the same env key should succeed
    const statusResult = runCli('status --json', {
      configDir: tempDir,
      env: { MORS_RELAY_SIGNING_KEY: relaySigningKey },
    });
    expect(statusResult.exitCode).toBe(0);
    const parsed = JSON.parse(statusResult.stdout);
    expect(parsed.token_valid).toBe(true);
  });
});
