/**
 * Tests for E2EE 1:1 key exchange and scope enforcement.
 *
 * Covers:
 * - VAL-E2EE-002: 1:1 key exchange completes before encrypted send
 *   A 1:1 conversation performs key exchange before encrypted send succeeds.
 *   Evidence: key exchange transcript; send behavior before/after exchange.
 *
 * - VAL-E2EE-008: 1:1-only E2EE scope is enforced explicitly
 *   Group/channel E2EE attempts return explicit unsupported/deferred response.
 *   Evidence: group E2EE attempt transcript + deterministic unsupported output.
 *
 * Also supports:
 * - Key-exchange metadata persists for later encrypt/decrypt operations
 * - Stale/wrong key exchange detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

import {
  generateDeviceKeys,
  persistDeviceKeys,
  type DeviceKeyBundle,
} from '../../src/e2ee/device-keys.js';

import {
  performKeyExchange,
  loadKeyExchangeSession,
  isKeyExchangeComplete,
  listKeyExchangeSessions,
  requireKeyExchange,
  validateConversationType,
  type ConversationType,
} from '../../src/e2ee/key-exchange.js';

import {
  KeyExchangeError,
  KeyExchangeNotCompleteError,
  GroupE2EEUnsupportedError,
} from '../../src/errors.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mors-kx-test-'));
}

/**
 * Create a bootstrapped device key setup for testing.
 * Returns the keysDir and the device bundle.
 */
function setupDevice(baseDir: string, name: string): { keysDir: string; bundle: DeviceKeyBundle } {
  const keysDir = join(baseDir, name, 'e2ee');
  const bundle = generateDeviceKeys();
  persistDeviceKeys(keysDir, bundle);
  return { keysDir, bundle };
}

describe('E2EE 1:1 key exchange', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── VAL-E2EE-002: key exchange before encrypted send ──────────────

  describe('key exchange handshake', () => {
    it('performs key exchange between two device bundles and produces shared session', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice');
      const { bundle: bobBundle } = setupDevice(tempDir, 'bob');

      const session = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );

      expect(session).toBeDefined();
      expect(session.peerDeviceId).toBe(bobBundle.deviceId);
      expect(session.peerFingerprint).toBe(bobBundle.fingerprint);
      expect(session.sharedSecret).toBeInstanceOf(Buffer);
      expect(session.sharedSecret.length).toBeGreaterThan(0);
      expect(session.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(session.localDeviceId).toBe(aliceBundle.deviceId);
    });

    it('produces matching shared secrets when both sides perform exchange', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice');
      const { keysDir: bobKeysDir, bundle: bobBundle } = setupDevice(tempDir, 'bob');

      const aliceSession = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );

      const bobSession = performKeyExchange(
        bobKeysDir,
        bobBundle,
        aliceBundle.x25519PublicKey,
        aliceBundle.deviceId,
        aliceBundle.fingerprint
      );

      // DH shared secrets must match (symmetric property)
      expect(Buffer.compare(aliceSession.sharedSecret, bobSession.sharedSecret)).toBe(0);
    });

    it('generates different shared secrets with different peers', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice');
      const { bundle: bobBundle } = setupDevice(tempDir, 'bob');
      const { bundle: charlieBundle } = setupDevice(tempDir, 'charlie');

      const sessionBob = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );

      const sessionCharlie = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        charlieBundle.x25519PublicKey,
        charlieBundle.deviceId,
        charlieBundle.fingerprint
      );

      expect(Buffer.compare(sessionBob.sharedSecret, sessionCharlie.sharedSecret)).not.toBe(0);
    });

    it('throws KeyExchangeError when peer public key is invalid', () => {
      const { keysDir, bundle } = setupDevice(tempDir, 'alice');

      expect(() =>
        performKeyExchange(
          keysDir,
          bundle,
          Buffer.alloc(16), // Wrong size
          'device_bad',
          'bad_fingerprint'
        )
      ).toThrow(KeyExchangeError);
    });

    it('throws KeyExchangeError when peer public key is all zeros', () => {
      const { keysDir, bundle } = setupDevice(tempDir, 'alice');

      expect(() =>
        performKeyExchange(
          keysDir,
          bundle,
          Buffer.alloc(32, 0), // All zeros — invalid X25519 point
          'device_zero',
          'zero_fingerprint'
        )
      ).toThrow(KeyExchangeError);
    });
  });

  // ── Session persistence ───────────────────────────────────────────

  describe('key exchange session persistence', () => {
    it('persists key exchange session and reloads correctly', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice');
      const { bundle: bobBundle } = setupDevice(tempDir, 'bob');

      const session = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );

      // Load persisted session
      const loaded = loadKeyExchangeSession(aliceKeysDir, bobBundle.deviceId);
      expect(loaded).not.toBeNull();
      if (!loaded) throw new Error('session should exist');
      expect(loaded.peerDeviceId).toBe(session.peerDeviceId);
      expect(loaded.peerFingerprint).toBe(session.peerFingerprint);
      expect(Buffer.compare(loaded.sharedSecret, session.sharedSecret)).toBe(0);
      expect(loaded.completedAt).toBe(session.completedAt);
      expect(loaded.localDeviceId).toBe(session.localDeviceId);
    });

    it('returns null when loading non-existent session', () => {
      const { keysDir } = setupDevice(tempDir, 'alice');
      const result = loadKeyExchangeSession(keysDir, 'device_nonexistent');
      expect(result).toBeNull();
    });

    it('isKeyExchangeComplete returns true after exchange', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice');
      const { bundle: bobBundle } = setupDevice(tempDir, 'bob');

      expect(isKeyExchangeComplete(aliceKeysDir, bobBundle.deviceId)).toBe(false);

      performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );

      expect(isKeyExchangeComplete(aliceKeysDir, bobBundle.deviceId)).toBe(true);
    });

    it('session files have owner-only permissions (0o600)', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice');
      const { bundle: bobBundle } = setupDevice(tempDir, 'bob');

      performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );

      // Check session file permissions
      const sessionsDir = join(aliceKeysDir, 'sessions');
      expect(existsSync(sessionsDir)).toBe(true);

      const files = readdirSync(sessionsDir);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const stat = statSync(join(sessionsDir, file));
        expect(stat.mode & 0o777).toBe(0o600);
      }
    });

    it('sessions directory has owner-only permissions (0o700)', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice');
      const { bundle: bobBundle } = setupDevice(tempDir, 'bob');

      performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );

      const sessionsDir = join(aliceKeysDir, 'sessions');
      const dirStat = statSync(sessionsDir);
      expect(dirStat.mode & 0o777).toBe(0o700);
    });

    it('persisted session does not contain raw private key material', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice');
      const { bundle: bobBundle } = setupDevice(tempDir, 'bob');

      performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );

      const sessionsDir = join(aliceKeysDir, 'sessions');
      const files = readdirSync(sessionsDir);
      for (const file of files) {
        const content = readFileSync(join(sessionsDir, file), 'utf-8');
        // Should not contain the raw private key in hex
        expect(content).not.toContain(aliceBundle.x25519PrivateKey.toString('hex'));
        expect(content).not.toContain(aliceBundle.ed25519PrivateKey.toString('hex'));
      }
    });
  });

  // ── List sessions ─────────────────────────────────────────────────

  describe('list key exchange sessions', () => {
    it('returns empty array when no sessions exist', () => {
      const { keysDir } = setupDevice(tempDir, 'alice');
      const sessions = listKeyExchangeSessions(keysDir);
      expect(sessions).toEqual([]);
    });

    it('lists all completed sessions', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice');
      const { bundle: bobBundle } = setupDevice(tempDir, 'bob');
      const { bundle: charlieBundle } = setupDevice(tempDir, 'charlie');

      performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );

      performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        charlieBundle.x25519PublicKey,
        charlieBundle.deviceId,
        charlieBundle.fingerprint
      );

      const sessions = listKeyExchangeSessions(aliceKeysDir);
      expect(sessions.length).toBe(2);

      const peerIds = sessions.map((s) => s.peerDeviceId).sort();
      expect(peerIds).toContain(bobBundle.deviceId);
      expect(peerIds).toContain(charlieBundle.deviceId);
    });
  });

  // ── requireKeyExchange guard ──────────────────────────────────────

  describe('requireKeyExchange guard', () => {
    it('returns session when key exchange is complete', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice');
      const { bundle: bobBundle } = setupDevice(tempDir, 'bob');

      performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );

      const session = requireKeyExchange(aliceKeysDir, bobBundle.deviceId);
      expect(session.peerDeviceId).toBe(bobBundle.deviceId);
      expect(session.sharedSecret).toBeInstanceOf(Buffer);
    });

    it('throws KeyExchangeNotCompleteError when exchange not done', () => {
      const { keysDir } = setupDevice(tempDir, 'alice');

      expect(() => requireKeyExchange(keysDir, 'device_unknown')).toThrow(
        KeyExchangeNotCompleteError
      );
    });

    it('KeyExchangeNotCompleteError includes actionable exchange guidance', () => {
      const { keysDir } = setupDevice(tempDir, 'alice');

      try {
        requireKeyExchange(keysDir, 'device_unknown');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(KeyExchangeNotCompleteError);
        const msg = (err as Error).message;
        expect(msg).toMatch(/key exchange/i);
        expect(msg).toMatch(/device_unknown/);
      }
    });
  });

  // ── VAL-E2EE-002: send blocked before exchange, succeeds after ────

  describe('encrypted send gate (VAL-E2EE-002)', () => {
    it('requireKeyExchange blocks send when no exchange exists for peer', () => {
      const { keysDir } = setupDevice(tempDir, 'alice');

      // Simulate a secure send attempt before key exchange
      expect(() => requireKeyExchange(keysDir, 'device_bob')).toThrow(KeyExchangeNotCompleteError);
    });

    it('requireKeyExchange allows send after exchange completes', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice');
      const { bundle: bobBundle } = setupDevice(tempDir, 'bob');

      // Before exchange — should throw
      expect(() => requireKeyExchange(aliceKeysDir, bobBundle.deviceId)).toThrow(
        KeyExchangeNotCompleteError
      );

      // Perform exchange
      performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );

      // After exchange — should succeed
      const session = requireKeyExchange(aliceKeysDir, bobBundle.deviceId);
      expect(session.sharedSecret).toBeInstanceOf(Buffer);
      expect(session.sharedSecret.length).toBeGreaterThan(0);
    });
  });

  // ── VAL-E2EE-008: group/channel E2EE scope enforcement ───────────

  describe('group/channel E2EE rejection (VAL-E2EE-008)', () => {
    it('validateConversationType accepts "direct" conversation type', () => {
      expect(() => validateConversationType('direct')).not.toThrow();
    });

    it('validateConversationType rejects "group" with GroupE2EEUnsupportedError', () => {
      expect(() => validateConversationType('group')).toThrow(GroupE2EEUnsupportedError);
    });

    it('validateConversationType rejects "channel" with GroupE2EEUnsupportedError', () => {
      expect(() => validateConversationType('channel')).toThrow(GroupE2EEUnsupportedError);
    });

    it('GroupE2EEUnsupportedError has deterministic message with deferred/unsupported text', () => {
      try {
        validateConversationType('group');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GroupE2EEUnsupportedError);
        const msg = (err as Error).message;
        // Must contain explicit unsupported/deferred language per VAL-E2EE-008
        expect(msg).toMatch(/unsupported|not supported|deferred/i);
        expect(msg).toMatch(/group|channel/i);
        expect(msg).toMatch(/1:1|direct/i);
      }
    });

    it('GroupE2EEUnsupportedError includes the attempted conversation type', () => {
      try {
        validateConversationType('channel');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GroupE2EEUnsupportedError);
        const msg = (err as Error).message;
        expect(msg).toContain('channel');
      }
    });

    it('validateConversationType rejects unknown types with GroupE2EEUnsupportedError', () => {
      expect(() => validateConversationType('broadcast' as ConversationType)).toThrow(
        GroupE2EEUnsupportedError
      );
    });
  });

  // ── Re-exchange / update existing session ─────────────────────────

  describe('key exchange re-negotiation', () => {
    it('re-exchange with same peer overwrites previous session', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice');
      const bob1 = generateDeviceKeys();
      const bob2 = generateDeviceKeys();

      // Use same deviceId but different keys (simulates key rotation)
      const session1 = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bob1.x25519PublicKey,
        'device_bob_fixed',
        bob1.fingerprint
      );

      const session2 = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bob2.x25519PublicKey,
        'device_bob_fixed',
        bob2.fingerprint
      );

      // Sessions should have different shared secrets
      expect(Buffer.compare(session1.sharedSecret, session2.sharedSecret)).not.toBe(0);

      // Loading should return the latest
      const loaded = loadKeyExchangeSession(aliceKeysDir, 'device_bob_fixed');
      expect(loaded).not.toBeNull();
      if (!loaded) throw new Error('session should exist');
      expect(Buffer.compare(loaded.sharedSecret, session2.sharedSecret)).toBe(0);
      expect(loaded.peerFingerprint).toBe(bob2.fingerprint);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('cannot exchange keys with self', () => {
      const { keysDir, bundle } = setupDevice(tempDir, 'alice');

      expect(() =>
        performKeyExchange(
          keysDir,
          bundle,
          bundle.x25519PublicKey,
          bundle.deviceId,
          bundle.fingerprint
        )
      ).toThrow(KeyExchangeError);
    });

    it('key exchange works when sessions directory already exists', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice');
      const { bundle: bobBundle } = setupDevice(tempDir, 'bob');
      const { bundle: charlieBundle } = setupDevice(tempDir, 'charlie');

      // First exchange creates sessions dir
      performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );

      // Second exchange should not fail due to existing dir
      const session = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        charlieBundle.x25519PublicKey,
        charlieBundle.deviceId,
        charlieBundle.fingerprint
      );

      expect(session.peerDeviceId).toBe(charlieBundle.deviceId);
    });
  });
});
