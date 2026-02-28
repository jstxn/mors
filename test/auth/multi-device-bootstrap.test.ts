/**
 * Multi-device bootstrap continuity tests.
 *
 * Ensures multiple devices can authenticate under one native account
 * with distinct device identities while preserving secure device
 * bootstrap continuity.
 *
 * Covers:
 * - VAL-AUTH-009: Multi-device login creates distinct devices under one native account
 * - VAL-CROSS-006: Multi-device onboarding preserves secure delivery continuity
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  validateInviteToken,
  generateInviteToken,
  generateSessionToken,
  verifySessionToken,
  generateSigningKey,
} from '../../src/auth/native.js';

import { saveSession, loadSession, saveSigningKey } from '../../src/auth/session.js';

import { AccountStore } from '../../src/relay/account-store.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = join(ROOT, 'dist', 'index.js');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mors-multi-device-'));
}

/**
 * Simulate a fully initialized mors config directory for a device.
 * Uses the given invite token to derive the same accountId across devices.
 */
function simulateDeviceInit(
  configDir: string,
  signingKey: string,
  inviteToken: string,
  deviceId?: string
): { accountId: string; deviceId: string; token: string } {
  mkdirSync(configDir, { recursive: true });

  // Identity files
  writeFileSync(
    join(configDir, 'identity.json'),
    JSON.stringify({
      publicKey: randomBytes(32).toString('hex'),
      fingerprint: randomBytes(32).toString('hex'),
      createdAt: new Date().toISOString(),
    })
  );
  writeFileSync(join(configDir, 'identity.key'), randomBytes(32), { mode: 0o600 });

  // Init sentinel
  writeFileSync(join(configDir, '.initialized'), '');

  // Device E2EE keys
  const keysDir = join(configDir, 'e2ee');
  mkdirSync(keysDir, { recursive: true });
  const devId = deviceId ?? `device-${randomBytes(16).toString('hex')}`;
  writeFileSync(
    join(keysDir, 'device-keys.json'),
    JSON.stringify({
      x25519PublicKey: randomBytes(32).toString('hex'),
      ed25519PublicKey: randomBytes(32).toString('hex'),
      fingerprint: randomBytes(32).toString('hex'),
      deviceId: devId,
      createdAt: new Date().toISOString(),
    })
  );
  writeFileSync(join(keysDir, 'x25519.key'), randomBytes(32), { mode: 0o600 });
  writeFileSync(join(keysDir, 'ed25519.key'), randomBytes(32), { mode: 0o600 });

  // Auth marker
  writeFileSync(join(configDir, '.auth-enabled'), new Date().toISOString());

  // Signing key
  saveSigningKey(configDir, signingKey);

  // Derive accountId from invite token (same as native.ts does)
  const inviteResult = validateInviteToken(inviteToken);
  if (!inviteResult.valid) throw new Error('Invalid invite token in test setup');

  // Session
  const sessionToken = generateSessionToken({
    accountId: inviteResult.accountId,
    deviceId: devId,
    signingKey,
  });

  saveSession(configDir, {
    accessToken: sessionToken,
    tokenType: 'bearer',
    accountId: inviteResult.accountId,
    deviceId: devId,
    createdAt: new Date().toISOString(),
  });

  return { accountId: inviteResult.accountId, deviceId: devId, token: sessionToken };
}

// ── Unit tests: AccountStore multi-device tracking ───────────────────

describe('AccountStore multi-device', () => {
  let store: AccountStore;

  beforeEach(() => {
    store = new AccountStore();
  });

  it('tracks distinct device registrations under one account', () => {
    store.register({
      accountId: 'acct-001',
      handle: 'alice',
      displayName: 'Alice Smith',
    });

    store.registerDevice('acct-001', 'device-aaa');
    store.registerDevice('acct-001', 'device-bbb');

    const devices = store.listDevices('acct-001');
    expect(devices).toHaveLength(2);
    expect(devices.map((d) => d.deviceId)).toContain('device-aaa');
    expect(devices.map((d) => d.deviceId)).toContain('device-bbb');
  });

  it('device registration is idempotent', () => {
    store.register({
      accountId: 'acct-001',
      handle: 'alice',
      displayName: 'Alice',
    });

    store.registerDevice('acct-001', 'device-aaa');
    store.registerDevice('acct-001', 'device-aaa');

    const devices = store.listDevices('acct-001');
    expect(devices).toHaveLength(1);
    expect(devices[0].deviceId).toBe('device-aaa');
  });

  it('returns empty array when no devices registered for account', () => {
    const devices = store.listDevices('acct-nonexistent');
    expect(devices).toEqual([]);
  });

  it('device lists are account-scoped (no cross-account leakage)', () => {
    store.register({ accountId: 'acct-001', handle: 'alice', displayName: 'Alice' });
    store.register({ accountId: 'acct-002', handle: 'bob-user', displayName: 'Bob' });

    store.registerDevice('acct-001', 'device-aaa');
    store.registerDevice('acct-002', 'device-bbb');

    const aliceDevices = store.listDevices('acct-001');
    const bobDevices = store.listDevices('acct-002');

    expect(aliceDevices).toHaveLength(1);
    expect(aliceDevices[0].deviceId).toBe('device-aaa');

    expect(bobDevices).toHaveLength(1);
    expect(bobDevices[0].deviceId).toBe('device-bbb');
  });

  it('device registration stores a registeredAt timestamp', () => {
    store.register({ accountId: 'acct-001', handle: 'alice', displayName: 'Alice' });
    store.registerDevice('acct-001', 'device-aaa');

    const devices = store.listDevices('acct-001');
    expect(devices[0].registeredAt).toBeDefined();
    expect(new Date(devices[0].registeredAt).getTime()).not.toBeNaN();
  });
});

// ── Two-device login: same invite token → same accountId, distinct deviceIds ─

describe('VAL-AUTH-009: two-device login under one account', () => {
  const signingKey = generateSigningKey();
  let inviteToken: string;
  let configDirA: string;
  let configDirB: string;

  beforeEach(() => {
    inviteToken = generateInviteToken();
    configDirA = makeTempDir();
    configDirB = makeTempDir();
  });

  afterEach(() => {
    rmSync(configDirA, { recursive: true, force: true });
    rmSync(configDirB, { recursive: true, force: true });
  });

  it('same invite token produces same accountId on both devices', () => {
    const deviceA = simulateDeviceInit(configDirA, signingKey, inviteToken, 'device-aaa');
    const deviceB = simulateDeviceInit(configDirB, signingKey, inviteToken, 'device-bbb');

    expect(deviceA.accountId).toBe(deviceB.accountId);
    expect(deviceA.accountId).toBeTruthy();
  });

  it('each device has a distinct deviceId', () => {
    const deviceA = simulateDeviceInit(configDirA, signingKey, inviteToken, 'device-aaa');
    const deviceB = simulateDeviceInit(configDirB, signingKey, inviteToken, 'device-bbb');

    expect(deviceA.deviceId).not.toBe(deviceB.deviceId);
  });

  it('both device tokens verify with same accountId but different deviceId', () => {
    const deviceA = simulateDeviceInit(configDirA, signingKey, inviteToken, 'device-aaa');
    const deviceB = simulateDeviceInit(configDirB, signingKey, inviteToken, 'device-bbb');

    const payloadA = verifySessionToken(deviceA.token, signingKey);
    const payloadB = verifySessionToken(deviceB.token, signingKey);

    expect(payloadA).not.toBeNull();
    expect(payloadB).not.toBeNull();

    if (payloadA && payloadB) {
      expect(payloadA.accountId).toBe(payloadB.accountId);
      expect(payloadA.deviceId).not.toBe(payloadB.deviceId);
    }
  });

  it('sessions persist and reload with correct device identity across restart', () => {
    const deviceA = simulateDeviceInit(configDirA, signingKey, inviteToken, 'device-aaa');
    const deviceB = simulateDeviceInit(configDirB, signingKey, inviteToken, 'device-bbb');

    // Simulate "restart" by re-loading sessions
    const sessionA = loadSession(configDirA);
    const sessionB = loadSession(configDirB);

    expect(sessionA).not.toBeNull();
    expect(sessionB).not.toBeNull();

    if (sessionA && sessionB) {
      expect(sessionA.accountId).toBe(deviceA.accountId);
      expect(sessionA.deviceId).toBe('device-aaa');

      expect(sessionB.accountId).toBe(deviceB.accountId);
      expect(sessionB.deviceId).toBe('device-bbb');

      // Both share the same account
      expect(sessionA.accountId).toBe(sessionB.accountId);
    }
  });
});

// ── Relay multi-device: two devices register under one account ───────

describe('relay multi-device registration', () => {
  let server: ReturnType<typeof import('../../src/relay/server.js').createRelayServer>;
  let port: number;
  let signingKey: string;
  let accountStore: AccountStore;

  beforeEach(async () => {
    const { createRelayServer } = await import('../../src/relay/server.js');
    const { loadRelayConfig } = await import('../../src/relay/config.js');
    const { createNativeTokenVerifier } = await import('../../src/relay/auth-middleware.js');
    const { RelayMessageStore } = await import('../../src/relay/message-store.js');

    signingKey = randomBytes(32).toString('hex');
    accountStore = new AccountStore();

    const config = loadRelayConfig({ PORT: '0', MORS_RELAY_HOST: '127.0.0.1' });
    server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: createNativeTokenVerifier(signingKey),
      messageStore: new RelayMessageStore(),
      accountStore,
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    await server.close();
  });

  function makeToken(accountId: string, deviceId: string): string {
    return generateSessionToken({ accountId, deviceId, signingKey });
  }

  it('two devices register under same account with distinct device identities', async () => {
    const accountId = 'acct-shared-001';
    const tokenA = makeToken(accountId, 'device-aaa');
    const tokenB = makeToken(accountId, 'device-bbb');

    // Register handle from device A
    const regRes = await fetch(`http://127.0.0.1:${port}/accounts/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ handle: 'shared-user', display_name: 'Shared User' }),
    });
    expect(regRes.status).toBe(201);

    // Idempotent re-registration from device B (same account, same handle)
    const regRes2 = await fetch(`http://127.0.0.1:${port}/accounts/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenB}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ handle: 'shared-user', display_name: 'Shared User' }),
    });
    expect(regRes2.status).toBe(201);

    // Both devices can see account profile
    const meResA = await fetch(`http://127.0.0.1:${port}/accounts/me`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const meResB = await fetch(`http://127.0.0.1:${port}/accounts/me`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });

    expect(meResA.status).toBe(200);
    expect(meResB.status).toBe(200);

    const profileA = (await meResA.json()) as Record<string, unknown>;
    const profileB = (await meResB.json()) as Record<string, unknown>;

    expect(profileA['account_id']).toBe(accountId);
    expect(profileB['account_id']).toBe(accountId);
    expect(profileA['handle']).toBe('shared-user');
    expect(profileB['handle']).toBe('shared-user');
  });

  it('GET /accounts/me/devices lists distinct devices for the account', async () => {
    const accountId = 'acct-shared-002';
    const tokenA = makeToken(accountId, 'device-aaa');
    const tokenB = makeToken(accountId, 'device-bbb');

    // Register the account
    await fetch(`http://127.0.0.1:${port}/accounts/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ handle: 'multi-dev', display_name: 'Multi Device User' }),
    });

    // Access from both devices (auto-registers device identities)
    await fetch(`http://127.0.0.1:${port}/accounts/me`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    await fetch(`http://127.0.0.1:${port}/accounts/me`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });

    // List devices
    const devicesRes = await fetch(`http://127.0.0.1:${port}/accounts/me/devices`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    expect(devicesRes.status).toBe(200);
    const body = (await devicesRes.json()) as Record<string, unknown>;
    const devices = body['devices'] as Array<Record<string, unknown>>;

    expect(devices).toHaveLength(2);
    const deviceIds = devices.map((d) => d['device_id']);
    expect(deviceIds).toContain('device-aaa');
    expect(deviceIds).toContain('device-bbb');

    // All devices share the same account_id
    expect(body['account_id']).toBe(accountId);
  });

  it('device list requires authentication', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/accounts/me/devices`);
    expect(res.status).toBe(401);
  });

  it('device list auto-registers the requesting device', async () => {
    const accountId = 'acct-fresh-003';
    const token = makeToken(accountId, 'device-zzz');

    // Even without prior explicit registration, the requesting device is auto-registered
    const devicesRes = await fetch(`http://127.0.0.1:${port}/accounts/me/devices`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(devicesRes.status).toBe(200);
    const body = (await devicesRes.json()) as Record<string, unknown>;
    const devices = body['devices'] as Array<Record<string, unknown>>;

    // The requesting device is auto-registered on authenticated access
    expect(devices).toHaveLength(1);
    expect(devices[0]['device_id']).toBe('device-zzz');
  });
});

// ── CLI two-device login transcript ──────────────────────────────────

describe('CLI two-device login transcript (VAL-AUTH-009)', () => {
  const signingKey = generateSigningKey();
  let configDirA: string;
  let configDirB: string;
  let inviteToken: string;

  beforeEach(() => {
    configDirA = makeTempDir();
    configDirB = makeTempDir();
    inviteToken = generateInviteToken();
  });

  afterEach(() => {
    rmSync(configDirA, { recursive: true, force: true });
    rmSync(configDirB, { recursive: true, force: true });
  });

  /**
   * Simulate `mors init` (without session) then `mors login` for a device config dir.
   * Does NOT pre-create a session — lets `mors login` create it fresh.
   */
  function initAndLogin(configDir: string): { stdout: string; parsed: Record<string, unknown> } {
    // Simulate init WITHOUT session (mors init creates identity + device keys + sentinel)
    mkdirSync(configDir, { recursive: true });

    // Identity files
    writeFileSync(
      join(configDir, 'identity.json'),
      JSON.stringify({
        publicKey: randomBytes(32).toString('hex'),
        fingerprint: randomBytes(32).toString('hex'),
        createdAt: new Date().toISOString(),
      })
    );
    writeFileSync(join(configDir, 'identity.key'), randomBytes(32), { mode: 0o600 });

    // Init sentinel
    writeFileSync(join(configDir, '.initialized'), '');

    // Device E2EE keys
    const keysDir = join(configDir, 'e2ee');
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(
      join(keysDir, 'device-keys.json'),
      JSON.stringify({
        x25519PublicKey: randomBytes(32).toString('hex'),
        ed25519PublicKey: randomBytes(32).toString('hex'),
        fingerprint: randomBytes(32).toString('hex'),
        deviceId: `device-${randomBytes(16).toString('hex')}`,
        createdAt: new Date().toISOString(),
      })
    );
    writeFileSync(join(keysDir, 'x25519.key'), randomBytes(32), { mode: 0o600 });
    writeFileSync(join(keysDir, 'ed25519.key'), randomBytes(32), { mode: 0o600 });

    // Run mors login via CLI
    const stdout = execSync(`node ${CLI} login --invite-token "${inviteToken}" --json 2>&1`, {
      env: {
        ...process.env,
        MORS_CONFIG_DIR: configDir,
        MORS_RELAY_SIGNING_KEY: signingKey,
        PATH: process.env['PATH'],
      },
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();

    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return { stdout, parsed };
  }

  it('two devices produce same account_id but different device_id via CLI', () => {
    const resultA = initAndLogin(configDirA);
    const resultB = initAndLogin(configDirB);

    expect(resultA.parsed['status']).toBe('authenticated');
    expect(resultB.parsed['status']).toBe('authenticated');

    // Same account (both used same invite token)
    expect(resultA.parsed['account_id']).toBe(resultB.parsed['account_id']);

    // Different devices
    expect(resultA.parsed['device_id']).not.toBe(resultB.parsed['device_id']);
  });

  it('sessions remain deterministic across restart (reload from disk)', () => {
    initAndLogin(configDirA);
    initAndLogin(configDirB);

    // Reload sessions from disk (simulating process restart)
    const sessionA = loadSession(configDirA);
    const sessionB = loadSession(configDirB);

    expect(sessionA).not.toBeNull();
    expect(sessionB).not.toBeNull();

    if (sessionA && sessionB) {
      // Account identity is shared
      expect(sessionA.accountId).toBe(sessionB.accountId);

      // Device identity is distinct
      expect(sessionA.deviceId).not.toBe(sessionB.deviceId);

      // Token payload verifies correctly for both
      const payloadA = verifySessionToken(sessionA.accessToken, signingKey);
      const payloadB = verifySessionToken(sessionB.accessToken, signingKey);

      expect(payloadA).not.toBeNull();
      expect(payloadB).not.toBeNull();
      if (payloadA && payloadB) {
        expect(payloadA.accountId).toBe(payloadB.accountId);
        expect(payloadA.deviceId).not.toBe(payloadB.deviceId);
      }
    }
  });

  it('mors status --json shows correct device identity on each device', () => {
    initAndLogin(configDirA);
    initAndLogin(configDirB);

    const statusA = execSync(`node ${CLI} status --json 2>&1`, {
      env: {
        ...process.env,
        MORS_CONFIG_DIR: configDirA,
        MORS_RELAY_SIGNING_KEY: signingKey,
        PATH: process.env['PATH'],
      },
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();

    const statusB = execSync(`node ${CLI} status --json 2>&1`, {
      env: {
        ...process.env,
        MORS_CONFIG_DIR: configDirB,
        MORS_RELAY_SIGNING_KEY: signingKey,
        PATH: process.env['PATH'],
      },
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();

    const parsedA = JSON.parse(statusA) as Record<string, unknown>;
    const parsedB = JSON.parse(statusB) as Record<string, unknown>;

    expect(parsedA['status']).toBe('authenticated');
    expect(parsedB['status']).toBe('authenticated');

    // Same account
    expect(parsedA['account_id']).toBe(parsedB['account_id']);

    // Different devices
    expect(parsedA['device_id']).not.toBe(parsedB['device_id']);
  });
});
