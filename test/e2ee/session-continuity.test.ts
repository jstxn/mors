/**
 * E2EE key-continuity and bundle-integrity guards (C1 / C2).
 *
 * A relay is untrusted: it distributes peer device bundles and could tamper
 * with them. These tests assert the client refuses bundles whose fingerprint
 * does not match their keys, and refuses to silently re-key a peer whose
 * identity key changed after a session was pinned.
 */

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
  type PeerDeviceBundle,
} from '../../src/e2ee/auto-session.js';
import { PeerBundleIntegrityError, PeerIdentityChangedError } from '../../src/errors.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mors-continuity-'));
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
  };
}

describe('E2EE bundle integrity (C1)', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = makeTempDir();
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects a bundle whose fingerprint does not hash its own keys', () => {
    const { keysDir: aliceKeysDir } = setupDevice(tempDir, 'alice');
    const { bundle: bobBundle } = setupDevice(tempDir, 'bob');

    const tampered = toPeerBundle('acct_bob', bobBundle);
    // Relay swaps in a different X25519 key but leaves the advertised fingerprint.
    const attacker = generateDeviceKeys();
    tampered.x25519PublicKey = attacker.x25519PublicKey.toString('hex');

    expect(() => ensureSessionFromPeerBundle(aliceKeysDir, tampered)).toThrow(
      PeerBundleIntegrityError
    );
  });

  it('rejects a bundle with malformed public keys', () => {
    const { keysDir: aliceKeysDir } = setupDevice(tempDir, 'alice');
    const { bundle: bobBundle } = setupDevice(tempDir, 'bob');
    const malformed = toPeerBundle('acct_bob', bobBundle);
    malformed.x25519PublicKey = 'not-hex';
    expect(() => ensureSessionFromPeerBundle(aliceKeysDir, malformed)).toThrow(
      PeerBundleIntegrityError
    );
  });
});

describe('E2EE key continuity (C2)', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = makeTempDir();
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('refuses to silently re-key when the peer identity key changes', () => {
    const { keysDir: aliceKeysDir } = setupDevice(tempDir, 'alice');
    const { bundle: bobBundle } = setupDevice(tempDir, 'bob');

    // First contact pins Bob's key.
    ensureSessionFromPeerBundle(aliceKeysDir, toPeerBundle('acct_bob', bobBundle));

    // The relay now presents a different (attacker) key under Bob's device id.
    const attacker = generateDeviceKeys();
    const swapped: PeerDeviceBundle = {
      accountId: 'acct_bob',
      deviceId: bobBundle.deviceId,
      fingerprint: attacker.fingerprint,
      x25519PublicKey: attacker.x25519PublicKey.toString('hex'),
      ed25519PublicKey: attacker.ed25519PublicKey.toString('hex'),
    };

    expect(() => ensureSessionFromPeerBundle(aliceKeysDir, swapped)).toThrow(
      PeerIdentityChangedError
    );
  });

  it('allows an explicit key change after out-of-band re-verification', () => {
    const { keysDir: aliceKeysDir } = setupDevice(tempDir, 'alice');
    const { bundle: bobBundle } = setupDevice(tempDir, 'bob');
    ensureSessionFromPeerBundle(aliceKeysDir, toPeerBundle('acct_bob', bobBundle));

    const rotated = generateDeviceKeys();
    const rotatedBundle: PeerDeviceBundle = {
      accountId: 'acct_bob',
      deviceId: bobBundle.deviceId,
      fingerprint: rotated.fingerprint,
      x25519PublicKey: rotated.x25519PublicKey.toString('hex'),
      ed25519PublicKey: rotated.ed25519PublicKey.toString('hex'),
    };

    const session = ensureSessionFromPeerBundle(aliceKeysDir, rotatedBundle, undefined, {
      allowKeyChange: true,
    });
    expect(session.peerFingerprint).toBe(rotated.fingerprint);
  });

  it('reuses the pinned session when the bundle is unchanged', () => {
    const { keysDir: aliceKeysDir } = setupDevice(tempDir, 'alice');
    const { bundle: bobBundle } = setupDevice(tempDir, 'bob');
    const peer = toPeerBundle('acct_bob', bobBundle);
    const first = ensureSessionFromPeerBundle(aliceKeysDir, peer);
    const second = ensureSessionFromPeerBundle(aliceKeysDir, peer);
    expect(second.completedAt).toBe(first.completedAt);
  });
});
