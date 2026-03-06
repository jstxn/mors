import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateDeviceKeys,
  persistDeviceKeys,
  type DeviceKeyBundle,
} from '../../src/e2ee/device-keys.js';
import {
  ensureSessionFromPeerBundle,
  ensureSessionForInboundMessage,
  type PeerDeviceBundle,
} from '../../src/e2ee/auto-session.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mors-auto-session-'));
}

function setupDevice(baseDir: string, name: string): { keysDir: string; bundle: DeviceKeyBundle } {
  const keysDir = join(baseDir, name, 'e2ee');
  const bundle = generateDeviceKeys();
  persistDeviceKeys(keysDir, bundle);
  return { keysDir, bundle };
}

function toPeerBundle(accountId: string, bundle: DeviceKeyBundle): PeerDeviceBundle {
  return {
    accountId,
    deviceId: bundle.deviceId,
    fingerprint: bundle.fingerprint,
    x25519PublicKey: bundle.x25519PublicKey.toString('hex'),
    ed25519PublicKey: bundle.ed25519PublicKey.toString('hex'),
    createdAt: '2026-03-06T00:00:00.000Z',
    publishedAt: '2026-03-06T00:00:01.000Z',
  };
}

describe('auto E2EE session establishment', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a new session from a published peer bundle', () => {
    const { keysDir: aliceKeysDir } = setupDevice(tempDir, 'alice');
    const { bundle: bobBundle } = setupDevice(tempDir, 'bob');

    const session = ensureSessionFromPeerBundle(aliceKeysDir, toPeerBundle('acct_bob', bobBundle));

    expect(session.peerDeviceId).toBe(bobBundle.deviceId);
    expect(session.peerFingerprint).toBe(bobBundle.fingerprint);
    expect(session.sharedSecret).toBeInstanceOf(Buffer);
  });

  it('reuses an existing session when the published peer bundle is unchanged', () => {
    const { keysDir: aliceKeysDir } = setupDevice(tempDir, 'alice');
    const { bundle: bobBundle } = setupDevice(tempDir, 'bob');
    const peerBundle = toPeerBundle('acct_bob', bobBundle);

    const first = ensureSessionFromPeerBundle(aliceKeysDir, peerBundle);
    const second = ensureSessionFromPeerBundle(aliceKeysDir, peerBundle);

    expect(second.completedAt).toBe(first.completedAt);
    expect(Buffer.compare(second.sharedSecret, first.sharedSecret)).toBe(0);
  });

  it('creates or reuses a session for an inbound message using sender_device_id metadata', async () => {
    const { keysDir: aliceKeysDir } = setupDevice(tempDir, 'alice');
    const { bundle: bobBundle } = setupDevice(tempDir, 'bob');
    const peerBundle = toPeerBundle('acct_bob', bobBundle);

    const session = await ensureSessionForInboundMessage({
      keysDir: aliceKeysDir,
      message: {
        sender_id: 'acct_bob',
        sender_device_id: bobBundle.deviceId,
      },
      resolvePeerBundle: async (accountId, deviceId) => {
        expect(accountId).toBe('acct_bob');
        expect(deviceId).toBe(bobBundle.deviceId);
        return peerBundle;
      },
    });

    expect(session).not.toBeNull();
    expect(session?.peerDeviceId).toBe(bobBundle.deviceId);
  });

  it('returns null for inbound messages that do not identify a sender device', async () => {
    const { keysDir: aliceKeysDir } = setupDevice(tempDir, 'alice');

    const session = await ensureSessionForInboundMessage({
      keysDir: aliceKeysDir,
      message: {
        sender_id: 'acct_bob',
        sender_device_id: null,
      },
      resolvePeerBundle: async () => {
        throw new Error('resolver should not be called without sender_device_id');
      },
    });

    expect(session).toBeNull();
  });

  it('returns null when the relay cannot resolve the sender device bundle', async () => {
    const { keysDir: aliceKeysDir } = setupDevice(tempDir, 'alice');
    const { bundle: bobBundle } = setupDevice(tempDir, 'bob');

    const session = await ensureSessionForInboundMessage({
      keysDir: aliceKeysDir,
      message: {
        sender_id: 'acct_bob',
        sender_device_id: bobBundle.deviceId,
      },
      resolvePeerBundle: async () => null,
    });

    expect(session).toBeNull();
  });
});
