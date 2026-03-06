/**
 * Onboarding wizard tests for handle + profile registration.
 *
 * Covers:
 * - VAL-AUTH-008: Account identity uses global unique immutable handle
 * - VAL-AUTH-012: Onboarding wizard captures handle and basic profile
 *
 * Tests the full onboarding flow including:
 * - Handle uniqueness enforcement (duplicate rejection)
 * - Handle immutability (cannot change after creation)
 * - Profile metadata persistence (handle + display_name)
 * - CLI `mors onboard` command with --json output
 * - Relay account registration endpoints
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  AccountStore,
  DuplicateHandleError,
  ImmutableHandleError,
  InvalidHandleError,
} from '../src/relay/account-store.js';
import { generateSessionToken } from '../src/auth/native.js';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'index.js');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mors-onboard-'));
}

/**
 * Simulate a fully initialized + logged-in mors config directory.
 */
function simulateAuthenticatedInit(configDir: string, signingKey: string): void {
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
  writeFileSync(
    join(keysDir, 'device-keys.json'),
    JSON.stringify({
      x25519PublicKey: 'a'.repeat(64),
      ed25519PublicKey: 'b'.repeat(64),
      fingerprint: 'c'.repeat(64),
      deviceId: 'device-test-001',
      createdAt: new Date().toISOString(),
    })
  );
  writeFileSync(join(keysDir, 'x25519.key'), Buffer.alloc(32, 0xbb), { mode: 0o600 });
  writeFileSync(join(keysDir, 'ed25519.key'), Buffer.alloc(32, 0xcc), { mode: 0o600 });
  // Auth marker
  writeFileSync(join(configDir, '.auth-enabled'), new Date().toISOString());
  // Signing key
  writeFileSync(join(configDir, '.signing-key'), signingKey, { mode: 0o600 });

  // Session (logged in with native auth)
  const accountId = 'acct-' + randomBytes(8).toString('hex');
  const deviceId = 'device-' + randomBytes(8).toString('hex');
  const token = generateSessionToken({ accountId, deviceId, signingKey });
  writeFileSync(
    join(configDir, 'session.json'),
    JSON.stringify({
      accessToken: token,
      tokenType: 'bearer',
      accountId,
      deviceId,
      createdAt: new Date().toISOString(),
    }),
    { mode: 0o600 }
  );
}

/**
 * Run a CLI command asynchronously (non-blocking) to avoid deadlocking
 * when the child process needs to contact a relay server running in the
 * parent test process.
 */
function runCliAsync(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 10000
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env,
      timeout: timeoutMs,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8').trim(),
        stderr: Buffer.concat(stderrChunks).toString('utf-8').trim(),
      });
    });

    child.on('error', () => {
      resolve({
        exitCode: 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8').trim(),
        stderr: Buffer.concat(stderrChunks).toString('utf-8').trim(),
      });
    });
  });
}

// ── Account Store unit tests ──────────────────────────────────────────

describe('AccountStore', () => {
  let store: AccountStore;

  beforeEach(() => {
    store = new AccountStore();
  });

  describe('handle registration', () => {
    it('registers a new handle with profile successfully', () => {
      const result = store.register({
        accountId: 'acct-001',
        handle: 'alice',
        displayName: 'Alice Smith',
      });

      expect(result.handle).toBe('alice');
      expect(result.displayName).toBe('Alice Smith');
      expect(result.accountId).toBe('acct-001');
      expect(result.createdAt).toBeDefined();
    });

    it('rejects duplicate handle registration deterministically', () => {
      store.register({
        accountId: 'acct-001',
        handle: 'alice',
        displayName: 'Alice Smith',
      });

      expect(() => {
        store.register({
          accountId: 'acct-002',
          handle: 'alice',
          displayName: 'Bob Jones',
        });
      }).toThrow(DuplicateHandleError);
    });

    it('rejects duplicate handle case-insensitively', () => {
      store.register({
        accountId: 'acct-001',
        handle: 'Alice',
        displayName: 'Alice Smith',
      });

      expect(() => {
        store.register({
          accountId: 'acct-002',
          handle: 'alice',
          displayName: 'Bob Jones',
        });
      }).toThrow(DuplicateHandleError);
    });

    it('allows same account to re-register with same handle (idempotent)', () => {
      const first = store.register({
        accountId: 'acct-001',
        handle: 'alice',
        displayName: 'Alice Smith',
      });

      const second = store.register({
        accountId: 'acct-001',
        handle: 'alice',
        displayName: 'Alice Smith',
      });

      expect(second.handle).toBe(first.handle);
      expect(second.accountId).toBe(first.accountId);
    });

    it('rejects handle mutation for an account that already has one', () => {
      store.register({
        accountId: 'acct-001',
        handle: 'alice',
        displayName: 'Alice Smith',
      });

      expect(() => {
        store.register({
          accountId: 'acct-001',
          handle: 'different-handle',
          displayName: 'Alice New',
        });
      }).toThrow(ImmutableHandleError);
    });
  });

  describe('handle validation', () => {
    it('rejects empty handle', () => {
      expect(() => {
        store.register({
          accountId: 'acct-001',
          handle: '',
          displayName: 'Alice',
        });
      }).toThrow(InvalidHandleError);
    });

    it('rejects handle with spaces', () => {
      expect(() => {
        store.register({
          accountId: 'acct-001',
          handle: 'alice smith',
          displayName: 'Alice',
        });
      }).toThrow(InvalidHandleError);
    });

    it('rejects handle shorter than 3 characters', () => {
      expect(() => {
        store.register({
          accountId: 'acct-001',
          handle: 'ab',
          displayName: 'Alice',
        });
      }).toThrow(InvalidHandleError);
    });

    it('rejects handle longer than 32 characters', () => {
      expect(() => {
        store.register({
          accountId: 'acct-001',
          handle: 'a'.repeat(33),
          displayName: 'Alice',
        });
      }).toThrow(InvalidHandleError);
    });

    it('rejects handle with special characters', () => {
      expect(() => {
        store.register({
          accountId: 'acct-001',
          handle: 'alice@bob',
          displayName: 'Alice',
        });
      }).toThrow(InvalidHandleError);
    });

    it('accepts handle with hyphens and underscores', () => {
      const result = store.register({
        accountId: 'acct-001',
        handle: 'alice-bob_123',
        displayName: 'Alice',
      });
      expect(result.handle).toBe('alice-bob_123');
    });
  });

  describe('handle normalization (trim + lowercase)', () => {
    it('normalizes handle by trimming whitespace before uniqueness check', () => {
      store.register({
        accountId: 'acct-001',
        handle: 'alice',
        displayName: 'Alice Smith',
      });

      // " alice " (with whitespace) should collide with "alice"
      expect(() => {
        store.register({
          accountId: 'acct-002',
          handle: '  alice  ',
          displayName: 'Bob',
        });
      }).toThrow(DuplicateHandleError);
    });

    it('normalizes handle by trimming + lowercasing together', () => {
      store.register({
        accountId: 'acct-001',
        handle: 'Alice',
        displayName: 'Alice Smith',
      });

      // " ALICE " should collide with "Alice" after trim+lowercase
      expect(() => {
        store.register({
          accountId: 'acct-002',
          handle: '  ALICE  ',
          displayName: 'Bob',
        });
      }).toThrow(DuplicateHandleError);
    });

    it('stores the normalized (trimmed+lowered) handle in profile', () => {
      const result = store.register({
        accountId: 'acct-001',
        handle: '  Alice  ',
        displayName: 'Alice Smith',
      });

      // Stored handle should be trimmed and lowercased
      expect(result.handle).toBe('alice');
    });

    it('isHandleAvailable normalizes with trim + lowercase', () => {
      store.register({
        accountId: 'acct-001',
        handle: 'alice',
        displayName: 'Alice',
      });
      expect(store.isHandleAvailable('  ALICE  ')).toBe(false);
      expect(store.isHandleAvailable(' alice ')).toBe(false);
    });

    it('getByHandle normalizes with trim + lowercase', () => {
      store.register({
        accountId: 'acct-001',
        handle: 'alice',
        displayName: 'Alice Smith',
      });

      const profile = store.getByHandle('  ALICE  ');
      expect(profile).not.toBeNull();
      expect(profile?.accountId).toBe('acct-001');
    });

    it('idempotent re-registration works with whitespace-variant handle', () => {
      store.register({
        accountId: 'acct-001',
        handle: 'alice',
        displayName: 'Alice Smith',
      });

      // Re-register with whitespace — should be idempotent (same normalized handle, same account)
      const result = store.register({
        accountId: 'acct-001',
        handle: '  alice  ',
        displayName: 'Alice Smith',
      });
      expect(result.handle).toBe('alice');
    });
  });

  describe('handle availability check', () => {
    it('reports handle as available when not taken', () => {
      expect(store.isHandleAvailable('alice')).toBe(true);
    });

    it('reports handle as unavailable when taken', () => {
      store.register({
        accountId: 'acct-001',
        handle: 'alice',
        displayName: 'Alice',
      });
      expect(store.isHandleAvailable('alice')).toBe(false);
    });

    it('checks availability case-insensitively', () => {
      store.register({
        accountId: 'acct-001',
        handle: 'Alice',
        displayName: 'Alice',
      });
      expect(store.isHandleAvailable('alice')).toBe(false);
      expect(store.isHandleAvailable('ALICE')).toBe(false);
    });
  });

  describe('profile lookup', () => {
    it('returns profile by account ID', () => {
      store.register({
        accountId: 'acct-001',
        handle: 'alice',
        displayName: 'Alice Smith',
      });

      const profile = store.getByAccountId('acct-001');
      expect(profile).not.toBeNull();
      expect(profile?.handle).toBe('alice');
      expect(profile?.displayName).toBe('Alice Smith');
    });

    it('returns null for unknown account ID', () => {
      expect(store.getByAccountId('unknown')).toBeNull();
    });

    it('returns profile by handle', () => {
      store.register({
        accountId: 'acct-001',
        handle: 'alice',
        displayName: 'Alice Smith',
      });

      const profile = store.getByHandle('alice');
      expect(profile).not.toBeNull();
      expect(profile?.accountId).toBe('acct-001');
    });

    it('returns null for unknown handle', () => {
      expect(store.getByHandle('unknown')).toBeNull();
    });
  });
});

// ── Relay account registration endpoint tests ────────────────────────

describe('relay account registration', () => {
  let server: ReturnType<typeof import('../src/relay/server.js').createRelayServer> extends Promise<
    infer T
  >
    ? T
    : ReturnType<typeof import('../src/relay/server.js').createRelayServer>;
  let port: number;
  let signingKey: string;
  let store: AccountStore;

  beforeEach(async () => {
    const { createRelayServer } = await import('../src/relay/server.js');
    const { loadRelayConfig } = await import('../src/relay/config.js');
    const { createNativeTokenVerifier } = await import('../src/relay/auth-middleware.js');
    const { RelayMessageStore } = await import('../src/relay/message-store.js');

    signingKey = randomBytes(32).toString('hex');
    store = new AccountStore();

    const config = loadRelayConfig({ PORT: '0', MORS_RELAY_HOST: '127.0.0.1' });
    server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: createNativeTokenVerifier(signingKey),
      messageStore: new RelayMessageStore(),
      accountStore: store,
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    await server.close();
  });

  function makeToken(accountId: string, deviceId: string = 'device-001'): string {
    return generateSessionToken({ accountId, deviceId, signingKey });
  }

  it('registers account handle and profile via POST /accounts/register', async () => {
    const token = makeToken('acct-001');
    const res = await fetch(`http://127.0.0.1:${port}/accounts/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        handle: 'alice',
        display_name: 'Alice Smith',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['handle']).toBe('alice');
    expect(body['display_name']).toBe('Alice Smith');
    expect(body['account_id']).toBe('acct-001');
  });

  it('rejects duplicate handle with 409', async () => {
    const token1 = makeToken('acct-001');
    await fetch(`http://127.0.0.1:${port}/accounts/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token1}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        handle: 'alice',
        display_name: 'Alice Smith',
      }),
    });

    const token2 = makeToken('acct-002');
    const res = await fetch(`http://127.0.0.1:${port}/accounts/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token2}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        handle: 'alice',
        display_name: 'Bob Jones',
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('duplicate_handle');
  });

  it('rejects handle mutation attempt with 409', async () => {
    const token = makeToken('acct-001');
    await fetch(`http://127.0.0.1:${port}/accounts/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        handle: 'alice',
        display_name: 'Alice Smith',
      }),
    });

    const res = await fetch(`http://127.0.0.1:${port}/accounts/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        handle: 'different-handle',
        display_name: 'Alice New',
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('immutable_handle');
  });

  it('returns own profile via GET /accounts/me', async () => {
    const token = makeToken('acct-001');
    await fetch(`http://127.0.0.1:${port}/accounts/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        handle: 'alice',
        display_name: 'Alice Smith',
      }),
    });

    const res = await fetch(`http://127.0.0.1:${port}/accounts/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['handle']).toBe('alice');
    expect(body['display_name']).toBe('Alice Smith');
    expect(body['account_id']).toBe('acct-001');
  });

  it('returns 404 for GET /accounts/me when not onboarded', async () => {
    const token = makeToken('acct-001');
    const res = await fetch(`http://127.0.0.1:${port}/accounts/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('not_onboarded');
  });

  it('rejects registration without auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/accounts/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        handle: 'alice',
        display_name: 'Alice Smith',
      }),
    });

    expect(res.status).toBe(401);
  });

  it('validates handle format in registration', async () => {
    const token = makeToken('acct-001');
    const res = await fetch(`http://127.0.0.1:${port}/accounts/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        handle: 'ab', // too short
        display_name: 'Alice',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('invalid_handle');
  });

  it('requires handle field in registration', async () => {
    const token = makeToken('acct-001');
    const res = await fetch(`http://127.0.0.1:${port}/accounts/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        display_name: 'Alice',
      }),
    });

    expect(res.status).toBe(400);
  });

  it('requires display_name field in registration', async () => {
    const token = makeToken('acct-001');
    const res = await fetch(`http://127.0.0.1:${port}/accounts/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        handle: 'alice',
      }),
    });

    expect(res.status).toBe(400);
  });
});

// ── Relay handle normalization endpoint tests ────────────────────────

describe('relay account registration normalization', () => {
  let server: ReturnType<typeof import('../src/relay/server.js').createRelayServer> extends Promise<
    infer T
  >
    ? T
    : ReturnType<typeof import('../src/relay/server.js').createRelayServer>;
  let port: number;
  let signingKey: string;
  let store: AccountStore;

  beforeEach(async () => {
    const { createRelayServer } = await import('../src/relay/server.js');
    const { loadRelayConfig } = await import('../src/relay/config.js');
    const { createNativeTokenVerifier } = await import('../src/relay/auth-middleware.js');
    const { RelayMessageStore } = await import('../src/relay/message-store.js');

    signingKey = randomBytes(32).toString('hex');
    store = new AccountStore();

    const config = loadRelayConfig({ PORT: '0', MORS_RELAY_HOST: '127.0.0.1' });
    server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: createNativeTokenVerifier(signingKey),
      messageStore: new RelayMessageStore(),
      accountStore: store,
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    await server.close();
  });

  function makeToken(accountId: string, deviceId: string = 'device-001'): string {
    return generateSessionToken({ accountId, deviceId, signingKey });
  }

  it('normalizes handle by trimming whitespace in /accounts/register', async () => {
    const token = makeToken('acct-001');
    const res = await fetch(`http://127.0.0.1:${port}/accounts/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        handle: '  alice  ',
        display_name: 'Alice Smith',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['handle']).toBe('alice');
  });

  it('normalizes handle by lowercasing in /accounts/register', async () => {
    const token = makeToken('acct-001');
    const res = await fetch(`http://127.0.0.1:${port}/accounts/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        handle: 'ALICE',
        display_name: 'Alice Smith',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['handle']).toBe('alice');
  });

  it('rejects duplicate handle after normalization across accounts', async () => {
    const token1 = makeToken('acct-001');
    await fetch(`http://127.0.0.1:${port}/accounts/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token1}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        handle: 'alice',
        display_name: 'Alice Smith',
      }),
    });

    const token2 = makeToken('acct-002');
    const res = await fetch(`http://127.0.0.1:${port}/accounts/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token2}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        handle: '  ALICE  ',
        display_name: 'Bob Jones',
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('duplicate_handle');
  });
});

// ── CLI onboard command tests ────────────────────────────────────────

describe('CLI mors onboard', () => {
  let configDir: string;
  const signingKey = randomBytes(32).toString('hex');

  beforeEach(() => {
    configDir = makeTempDir();
    simulateAuthenticatedInit(configDir, signingKey);
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('requires --handle and --display-name flags', () => {
    let output: string;
    let didThrow = false;
    try {
      output = execSync(`node ${CLI} onboard --json 2>&1`, {
        env: {
          ...process.env,
          MORS_CONFIG_DIR: configDir,
          MORS_RELAY_BASE_URL: '',
          MORS_RELAY_SIGNING_KEY: signingKey,
          PATH: process.env['PATH'],
        },
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();
    } catch (err: unknown) {
      didThrow = true;
      const e = err as { status?: number; stdout?: string; output?: string[] };
      expect(e.status).not.toBe(0);
      output = (e.stdout ?? e.output?.[1] ?? '').trim();
    }

    expect(didThrow).toBe(true);

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(output);
    } catch {
      /* not JSON */
    }

    // Should indicate missing required fields
    if (parsed) {
      expect(parsed['status']).toBe('error');
      expect(parsed['error']).toBe('missing_required_fields');
    } else {
      expect(output.toLowerCase()).toContain('required');
    }
  });

  it('persists profile locally after successful onboard', () => {
    // Without a relay URL, the onboard command persists locally without
    // attempting relay registration.  The profile.json file MUST be created
    // and its content MUST match the supplied handle/display-name.
    const profilePath = join(configDir, 'profile.json');

    const stdout = execSync(
      `node ${CLI} onboard --handle testuser123 --display-name "Test User" --json 2>&1`,
      {
        env: {
          ...process.env,
          MORS_CONFIG_DIR: configDir,
          MORS_RELAY_SIGNING_KEY: signingKey,
          PATH: process.env['PATH'],
        },
        encoding: 'utf-8',
        timeout: 10000,
      }
    );

    // CLI must report success
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.status).toBe('onboarded');
    expect(parsed.handle).toBe('testuser123');

    // profile.json MUST exist (no silent conditional pass)
    expect(existsSync(profilePath)).toBe(true);
    const profile = JSON.parse(readFileSync(profilePath, 'utf-8'));
    expect(profile.handle).toBe('testuser123');
    expect(profile.displayName).toBe('Test User');
  });

  it('shows onboard in help output', () => {
    const result = execSync(`node ${CLI} --help 2>&1`, {
      env: {
        ...process.env,
        MORS_CONFIG_DIR: configDir,
        PATH: process.env['PATH'],
      },
      encoding: 'utf-8',
      timeout: 10000,
    });

    expect(result).toContain('onboard');
  });

  it('calls relay /accounts/register during onboard with relay available', async () => {
    // Start a real relay server that we can point the CLI at.
    // Uses async spawn (not execSync) to avoid deadlocking the parent event loop
    // while the child process tries to contact the relay server in the parent.
    const { createRelayServer } = await import('../src/relay/server.js');
    const { loadRelayConfig } = await import('../src/relay/config.js');
    const { createNativeTokenVerifier } = await import('../src/relay/auth-middleware.js');
    const { RelayMessageStore } = await import('../src/relay/message-store.js');

    const relayStore = new AccountStore();
    const config = loadRelayConfig({ PORT: '0', MORS_RELAY_HOST: '127.0.0.1' });
    const server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: createNativeTokenVerifier(signingKey),
      messageStore: new RelayMessageStore(),
      accountStore: relayStore,
    });
    await server.start();
    const relayPort = server.port;

    try {
      const result = await runCliAsync(
        ['onboard', '--handle', 'relaytest', '--display-name', 'Relay Test User', '--json'],
        {
          ...process.env,
          MORS_CONFIG_DIR: configDir,
          MORS_RELAY_SIGNING_KEY: signingKey,
          MORS_RELAY_BASE_URL: `http://127.0.0.1:${relayPort}`,
          PATH: process.env['PATH'],
        }
      );

      const parsed = JSON.parse(result.stdout);
      expect(parsed.status).toBe('onboarded');
      expect(parsed.handle).toBe('relaytest');

      // Verify the relay store received the registration
      const relayProfile = relayStore.getByHandle('relaytest');
      expect(relayProfile).not.toBeNull();
      expect(relayProfile?.displayName).toBe('Relay Test User');
    } finally {
      await server.close();
    }
  });

  it('rejects duplicate handle through relay during onboard', async () => {
    const { createRelayServer } = await import('../src/relay/server.js');
    const { loadRelayConfig } = await import('../src/relay/config.js');
    const { createNativeTokenVerifier } = await import('../src/relay/auth-middleware.js');
    const { RelayMessageStore } = await import('../src/relay/message-store.js');

    const relayStore = new AccountStore();
    const config = loadRelayConfig({ PORT: '0', MORS_RELAY_HOST: '127.0.0.1' });
    const server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: createNativeTokenVerifier(signingKey),
      messageStore: new RelayMessageStore(),
      accountStore: relayStore,
    });
    await server.start();
    const relayPort = server.port;

    try {
      // Pre-register the handle on the relay from another account
      relayStore.register({
        accountId: 'other-acct-999',
        handle: 'takenhandle',
        displayName: 'Other User',
      });

      const result = await runCliAsync(
        ['onboard', '--handle', 'takenhandle', '--display-name', 'Should Fail', '--json'],
        {
          ...process.env,
          MORS_CONFIG_DIR: configDir,
          MORS_RELAY_SIGNING_KEY: signingKey,
          MORS_RELAY_BASE_URL: `http://127.0.0.1:${relayPort}`,
          PATH: process.env['PATH'],
        }
      );

      expect(result.exitCode).not.toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.status).toBe('error');
      expect(parsed.error).toBe('duplicate_handle');

      // Profile should NOT be persisted locally on relay rejection
      expect(existsSync(join(configDir, 'profile.json'))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('normalizes handle via relay during onboard (trim+lowercase)', async () => {
    const { createRelayServer } = await import('../src/relay/server.js');
    const { loadRelayConfig } = await import('../src/relay/config.js');
    const { createNativeTokenVerifier } = await import('../src/relay/auth-middleware.js');
    const { RelayMessageStore } = await import('../src/relay/message-store.js');

    const relayStore = new AccountStore();
    const config = loadRelayConfig({ PORT: '0', MORS_RELAY_HOST: '127.0.0.1' });
    const server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: createNativeTokenVerifier(signingKey),
      messageStore: new RelayMessageStore(),
      accountStore: relayStore,
    });
    await server.start();
    const relayPort = server.port;

    try {
      // Pre-register 'alice' from another account
      relayStore.register({
        accountId: 'other-acct-999',
        handle: 'alice',
        displayName: 'Other Alice',
      });

      // Onboard with " Alice " — CLI normalizes to "alice" which should collide with relay
      const result = await runCliAsync(
        ['onboard', '--handle', ' Alice ', '--display-name', 'Tricky Alice', '--json'],
        {
          ...process.env,
          MORS_CONFIG_DIR: configDir,
          MORS_RELAY_SIGNING_KEY: signingKey,
          MORS_RELAY_BASE_URL: `http://127.0.0.1:${relayPort}`,
          PATH: process.env['PATH'],
        }
      );

      // Should be rejected because "Alice" normalizes to "alice" which is taken
      expect(result.exitCode).not.toBe(0);
    } finally {
      await server.close();
    }
  });

  it('requires authentication before onboarding', () => {
    // Create a config dir without auth session
    const noAuthDir = makeTempDir();
    mkdirSync(noAuthDir, { recursive: true });
    writeFileSync(join(noAuthDir, '.initialized'), '');
    writeFileSync(
      join(noAuthDir, 'identity.json'),
      JSON.stringify({
        publicKey: 'a'.repeat(64),
        fingerprint: 'b'.repeat(64),
        createdAt: new Date().toISOString(),
      })
    );
    writeFileSync(join(noAuthDir, 'identity.key'), Buffer.alloc(32, 0xaa), { mode: 0o600 });
    writeFileSync(join(noAuthDir, '.auth-enabled'), new Date().toISOString());

    let exitCode = 0;
    try {
      execSync(`node ${CLI} onboard --handle testuser --display-name "Test" --json 2>&1`, {
        env: {
          ...process.env,
          MORS_CONFIG_DIR: noAuthDir,
          PATH: process.env['PATH'],
        },
        encoding: 'utf-8',
        timeout: 10000,
      });
    } catch (err: unknown) {
      const e = err as { status?: number };
      exitCode = e.status ?? 1;
    }

    expect(exitCode).not.toBe(0);
    rmSync(noAuthDir, { recursive: true, force: true });
  });

  it('two sessions racing the same handle: exactly one succeeds, loser has no local profile', async () => {
    // Simulates two CLI sessions onboarding with the same handle against
    // the same relay. The relay must deterministically grant one and reject
    // the other. The rejected session must NOT persist a local profile.
    const { createRelayServer } = await import('../src/relay/server.js');
    const { loadRelayConfig } = await import('../src/relay/config.js');
    const { createNativeTokenVerifier } = await import('../src/relay/auth-middleware.js');
    const { RelayMessageStore } = await import('../src/relay/message-store.js');

    const relayStore = new AccountStore();
    const config = loadRelayConfig({ PORT: '0', MORS_RELAY_HOST: '127.0.0.1' });
    const server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: createNativeTokenVerifier(signingKey),
      messageStore: new RelayMessageStore(),
      accountStore: relayStore,
    });
    await server.start();
    const relayPort = server.port;

    // Create two separate config dirs (two "sessions")
    const configDir2 = makeTempDir();
    simulateAuthenticatedInit(configDir2, signingKey);

    try {
      const env1 = {
        ...process.env,
        MORS_CONFIG_DIR: configDir,
        MORS_RELAY_SIGNING_KEY: signingKey,
        MORS_RELAY_BASE_URL: `http://127.0.0.1:${relayPort}`,
        PATH: process.env['PATH'],
      };
      const env2 = {
        ...process.env,
        MORS_CONFIG_DIR: configDir2,
        MORS_RELAY_SIGNING_KEY: signingKey,
        MORS_RELAY_BASE_URL: `http://127.0.0.1:${relayPort}`,
        PATH: process.env['PATH'],
      };

      // Fire both onboard calls concurrently with the same handle
      const [result1, result2] = await Promise.all([
        runCliAsync(
          ['onboard', '--handle', 'racehandle', '--display-name', 'Session1', '--json'],
          env1
        ),
        runCliAsync(
          ['onboard', '--handle', 'racehandle', '--display-name', 'Session2', '--json'],
          env2
        ),
      ]);

      const parsed1 = JSON.parse(result1.stdout);
      const parsed2 = JSON.parse(result2.stdout);

      // Exactly one must succeed, the other must fail
      const statuses = [parsed1.status, parsed2.status].sort();
      expect(statuses).toEqual(['error', 'onboarded']);

      // Identify winner and loser
      const winnerDir = parsed1.status === 'onboarded' ? configDir : configDir2;
      const loserDir = parsed1.status === 'onboarded' ? configDir2 : configDir;
      const loserParsed = parsed1.status === 'onboarded' ? parsed2 : parsed1;

      // Winner has local profile
      expect(existsSync(join(winnerDir, 'profile.json'))).toBe(true);

      // Loser gets duplicate_handle error and does NOT have local profile
      expect(loserParsed.error).toBe('duplicate_handle');
      expect(existsSync(join(loserDir, 'profile.json'))).toBe(false);
    } finally {
      await server.close();
      rmSync(configDir2, { recursive: true, force: true });
    }
  });
});
