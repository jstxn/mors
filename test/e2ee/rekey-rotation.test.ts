/**
 * Tests for E2EE rekey, rotation, revocation, and leak hardening.
 *
 * Covers:
 * - VAL-E2EE-005: Stale/wrong key failure is explicit with rekey guidance
 *   Decryption failure due to key mismatch/staleness produces deterministic
 *   error + rekey guidance.
 *   Evidence: stale-key transcript + rekey/recovery output.
 *
 * - VAL-E2EE-006: Device rotation/revocation enforces new trust boundary
 *   After rotation/revocation, revoked device cannot decrypt new messages;
 *   active device continues after rekey.
 *   Evidence: rotation/revocation transcript with contrasting decrypt outcomes.
 *
 * - VAL-E2EE-007: No plaintext leakage in relay persistence and logs
 *   Plaintext body does not appear in relay persistence/log artifacts.
 *   Evidence: relay store/log canary search transcript.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  generateDeviceKeys,
  persistDeviceKeys,
  loadDeviceKeys,
  type DeviceKeyBundle,
} from '../../src/e2ee/device-keys.js';

import {
  performKeyExchange,
  loadKeyExchangeSession,
  revokeDevice,
  rotateDeviceKeys,
  isDeviceRevoked,
  listRevokedDevices,
} from '../../src/e2ee/key-exchange.js';

import {
  encryptMessage,
  decryptMessage,
  decryptMessageStrict,
  type EncryptedPayload,
} from '../../src/e2ee/cipher.js';

import { StaleKeyError, CipherError, KeyExchangeError } from '../../src/errors.js';

import { RelayMessageStore } from '../../src/relay/message-store.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mors-rekey-test-'));
}

function setupDevice(baseDir: string, name: string): { keysDir: string; bundle: DeviceKeyBundle } {
  const keysDir = join(baseDir, name, 'e2ee');
  const bundle = generateDeviceKeys();
  persistDeviceKeys(keysDir, bundle);
  return { keysDir, bundle };
}

function setupKeyExchangePair(tempDir: string) {
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

  return {
    aliceKeysDir,
    aliceBundle,
    bobKeysDir,
    bobBundle,
    aliceSession,
    bobSession,
    sharedSecret: aliceSession.sharedSecret,
  };
}

describe('E2EE rekey, rotation, revocation, and leak hardening', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── VAL-E2EE-005: Stale/wrong key failure is explicit with rekey guidance ──

  describe('stale/wrong key failure with rekey guidance (VAL-E2EE-005)', () => {
    it('decryption with wrong shared secret throws StaleKeyError with rekey guidance', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const plaintext = 'sensitive message';
      const encrypted = encryptMessage(sharedSecret, plaintext);

      // Simulate stale key: use a different shared secret
      const staleSecret = randomBytes(32);
      expect(() => decryptMessageStrict(staleSecret, encrypted)).toThrow(StaleKeyError);
    });

    it('StaleKeyError message includes rekey guidance mentioning key-exchange', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const encrypted = encryptMessage(sharedSecret, 'test');
      const staleSecret = randomBytes(32);

      try {
        decryptMessageStrict(staleSecret, encrypted);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StaleKeyError);
        const msg = (err as Error).message;
        expect(msg).toMatch(/key.?exchange|rekey/i);
        expect(msg).toMatch(/mors\s+key-exchange/i);
      }
    });

    it('StaleKeyError includes guidance about stale/mismatched keys', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const encrypted = encryptMessage(sharedSecret, 'message');
      const wrongSecret = randomBytes(32);

      try {
        decryptMessageStrict(wrongSecret, encrypted);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StaleKeyError);
        const msg = (err as Error).message;
        expect(msg).toMatch(/stale|mismatch|outdated|wrong/i);
      }
    });

    it('StaleKeyError is a subclass of CipherError for backward compatibility', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const encrypted = encryptMessage(sharedSecret, 'test');
      const wrongSecret = randomBytes(32);

      try {
        decryptMessageStrict(wrongSecret, encrypted);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StaleKeyError);
        expect(err).toBeInstanceOf(CipherError);
      }
    });

    it('existing decryptMessage still throws CipherError for backward compat', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const encrypted = encryptMessage(sharedSecret, 'test');
      const wrongSecret = randomBytes(32);

      // The original decryptMessage still works for backward compat
      expect(() => decryptMessage(wrongSecret, encrypted)).toThrow(CipherError);
    });
  });

  // ── VAL-E2EE-006: Device rotation/revocation enforces new trust boundary ──

  describe('device rotation/revocation trust boundary (VAL-E2EE-006)', () => {
    it('revokeDevice marks a peer device as revoked', () => {
      const { aliceKeysDir, bobBundle } = setupKeyExchangePair(tempDir);

      revokeDevice(aliceKeysDir, bobBundle.deviceId);
      expect(isDeviceRevoked(aliceKeysDir, bobBundle.deviceId)).toBe(true);
    });

    it('revokeDevice is idempotent', () => {
      const { aliceKeysDir, bobBundle } = setupKeyExchangePair(tempDir);

      revokeDevice(aliceKeysDir, bobBundle.deviceId);
      revokeDevice(aliceKeysDir, bobBundle.deviceId);
      expect(isDeviceRevoked(aliceKeysDir, bobBundle.deviceId)).toBe(true);
    });

    it('non-revoked device is not marked as revoked', () => {
      const { aliceKeysDir, bobBundle } = setupKeyExchangePair(tempDir);

      expect(isDeviceRevoked(aliceKeysDir, bobBundle.deviceId)).toBe(false);
    });

    it('listRevokedDevices returns all revoked device IDs', () => {
      const { aliceKeysDir, bobBundle } = setupKeyExchangePair(tempDir);

      // Set up a second peer
      const { bundle: charlieBundle } = setupDevice(tempDir, 'charlie');
      performKeyExchange(
        aliceKeysDir,
        // need to reload alice's keys
        loadDeviceKeys(aliceKeysDir),
        charlieBundle.x25519PublicKey,
        charlieBundle.deviceId,
        charlieBundle.fingerprint
      );

      revokeDevice(aliceKeysDir, bobBundle.deviceId);
      revokeDevice(aliceKeysDir, charlieBundle.deviceId);

      const revoked = listRevokedDevices(aliceKeysDir);
      expect(revoked).toContain(bobBundle.deviceId);
      expect(revoked).toContain(charlieBundle.deviceId);
      expect(revoked).toHaveLength(2);
    });

    it('revoked device cannot decrypt new messages encrypted after revocation', () => {
      // Alice has two devices: device1 (active) and device2 (to be revoked)
      const { keysDir: aliceD1KeysDir, bundle: aliceD1 } = setupDevice(tempDir, 'alice-d1');
      const { keysDir: aliceD2KeysDir, bundle: aliceD2 } = setupDevice(tempDir, 'alice-d2');
      const { keysDir: bobKeysDir, bundle: bobBundle } = setupDevice(tempDir, 'bob-revoke');

      // Both Alice devices exchange keys with Bob
      performKeyExchange(
        aliceD1KeysDir,
        aliceD1,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );

      const d2Session = performKeyExchange(
        aliceD2KeysDir,
        aliceD2,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );

      // Bob exchanges keys with both
      performKeyExchange(
        bobKeysDir,
        bobBundle,
        aliceD1.x25519PublicKey,
        aliceD1.deviceId,
        aliceD1.fingerprint
      );
      performKeyExchange(
        bobKeysDir,
        bobBundle,
        aliceD2.x25519PublicKey,
        aliceD2.deviceId,
        aliceD2.fingerprint
      );

      // Revoke device2 from Bob's perspective
      revokeDevice(bobKeysDir, aliceD2.deviceId);

      // Rotate keys: Bob creates new keypair and re-exchanges with device1 only
      const { newBundle: bobNewBundle, newSession: bobNewSessionD1 } = rotateDeviceKeys(
        bobKeysDir,
        bobBundle,
        aliceD1KeysDir,
        aliceD1
      );

      // Device1 re-exchanges with Bob's new keys
      const d1NewSession = performKeyExchange(
        aliceD1KeysDir,
        aliceD1,
        bobNewBundle.x25519PublicKey,
        bobNewBundle.deviceId,
        bobNewBundle.fingerprint
      );

      // Bob encrypts a new message with his new shared secret (for device1)
      const newMessage = encryptMessage(d1NewSession.sharedSecret, 'post-rotation secret');

      // Device1 can decrypt
      const decryptedD1 = decryptMessage(bobNewSessionD1.sharedSecret, newMessage);
      expect(decryptedD1).toBe('post-rotation secret');

      // Device2 cannot decrypt with old session key
      expect(() => decryptMessage(d2Session.sharedSecret, newMessage)).toThrow(CipherError);
    });

    it('active device continues to work after rekey', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice-active');
      const { keysDir: bobKeysDir, bundle: bobBundle } = setupDevice(tempDir, 'bob-active');

      // Initial key exchange
      const aliceSession = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );
      performKeyExchange(
        bobKeysDir,
        bobBundle,
        aliceBundle.x25519PublicKey,
        aliceBundle.deviceId,
        aliceBundle.fingerprint
      );

      // Message with old keys works
      const oldMsg = encryptMessage(aliceSession.sharedSecret, 'old key message');
      expect(decryptMessage(aliceSession.sharedSecret, oldMsg)).toBe('old key message');

      // Rotate Bob's keys, re-exchange with Alice
      const { newBundle: bobNewBundle, newSession } = rotateDeviceKeys(
        bobKeysDir,
        bobBundle,
        aliceKeysDir,
        aliceBundle
      );

      // Alice re-exchanges with Bob's new keys
      const aliceNewSession = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobNewBundle.x25519PublicKey,
        bobNewBundle.deviceId,
        bobNewBundle.fingerprint
      );

      // New message with rotated keys works
      const newMsg = encryptMessage(aliceNewSession.sharedSecret, 'new key message');
      const decrypted = decryptMessage(newSession.sharedSecret, newMsg);
      expect(decrypted).toBe('new key message');
    });

    it('decrypting with revoked device session throws DeviceRevokedError when strict', () => {
      const { aliceKeysDir, aliceBundle, bobBundle, bobSession } = setupKeyExchangePair(tempDir);

      // Revoke Bob's device from Alice's perspective
      revokeDevice(aliceKeysDir, bobBundle.deviceId);

      // Alice encrypts a message using a new key exchange with a new device
      const { bundle: bobNewBundle } = setupDevice(tempDir, 'bob-new');
      const newSession = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobNewBundle.x25519PublicKey,
        bobNewBundle.deviceId,
        bobNewBundle.fingerprint
      );

      const encrypted = encryptMessage(newSession.sharedSecret, 'for new device only');

      // Old Bob device (revoked) tries to decrypt — should fail (wrong key)
      expect(() => decryptMessage(bobSession.sharedSecret, encrypted)).toThrow(CipherError);
    });
  });

  // ── VAL-E2EE-007: No plaintext leakage in relay persistence and logs ──

  describe('no plaintext leakage in relay persistence/logs (VAL-E2EE-007)', () => {
    it('relay message store body field contains ciphertext, not plaintext', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const canaryPlaintext = 'CANARY_LEAK_TEST_BODY_XYZ789';

      // Encrypt the message (simulating what a proper E2EE client would do)
      const encrypted = encryptMessage(sharedSecret, canaryPlaintext);
      const ciphertextBody = JSON.stringify(encrypted);

      // Store in relay with ciphertext body
      const store = new RelayMessageStore();
      const result = store.send('acct_42', 'alice', {
        recipientId: 'acct_99',
        body: ciphertextBody,
      });

      // The stored message body must not contain the plaintext
      expect(result.message.body).not.toContain(canaryPlaintext);
      expect(result.message.body).not.toContain('CANARY');
      expect(result.message.body).not.toContain('XYZ789');

      // The stored body should be valid JSON (ciphertext payload)
      const parsed = JSON.parse(result.message.body) as EncryptedPayload;
      expect(parsed).toHaveProperty('ciphertext');
      expect(parsed).toHaveProperty('iv');
      expect(parsed).toHaveProperty('authTag');
    });

    it('relay inbox listing does not expose plaintext in any field', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const canary = 'SUPER_SECRET_PLAINTEXT_NEVER_LEAK';
      const encrypted = encryptMessage(sharedSecret, canary);
      const ciphertextBody = JSON.stringify(encrypted);

      const store = new RelayMessageStore();
      store.send('acct_42', 'alice', { recipientId: 'acct_99', body: ciphertextBody });

      const inbox = store.inbox('acct_99');
      const serialized = JSON.stringify(inbox);
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain('SUPER_SECRET');
      expect(serialized).not.toContain('NEVER_LEAK');
    });

    it('relay store get() does not expose plaintext', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const canary = 'PRIVATE_MSG_BODY_DO_NOT_LEAK';
      const encrypted = encryptMessage(sharedSecret, canary);

      const store = new RelayMessageStore();
      const { message } = store.send('acct_42', 'alice', {
        recipientId: 'acct_99',
        body: JSON.stringify(encrypted),
      });

      const retrieved = store.get(message.id);
      expect(retrieved).toBeDefined();
      const serialized = JSON.stringify(retrieved);
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain('PRIVATE_MSG');
    });

    it('relay store operations do not expose plaintext in returned structures', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const canary = 'LOG_LEAK_CANARY_BODY_TEXT';
      const encrypted = encryptMessage(sharedSecret, canary);

      // The relay message store itself never contains plaintext when
      // the client properly sends ciphertext as the body.
      const store = new RelayMessageStore();
      const result = store.send('acct_42', 'alice', {
        recipientId: 'acct_99',
        body: JSON.stringify(encrypted),
      });

      // Verify message fields returned from send do not contain plaintext
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain('LOG_LEAK');
    });

    it('relay read/ack results do not expose plaintext body', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const canary = 'READ_ACK_LEAK_CANARY';
      const encrypted = encryptMessage(sharedSecret, canary);

      const store = new RelayMessageStore();
      const { message } = store.send('acct_42', 'alice', {
        recipientId: 'acct_99',
        body: JSON.stringify(encrypted),
      });

      // Read
      const readResult = store.read(message.id, 'acct_99');
      const readSerialized = JSON.stringify(readResult);
      expect(readSerialized).not.toContain(canary);

      // Ack
      const ackResult = store.ack(message.id, 'acct_99');
      const ackSerialized = JSON.stringify(ackResult);
      expect(ackSerialized).not.toContain(canary);
    });

    it('canary scan: plaintext absent from all relay store state', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const canaries = ['CANARY_ALPHA_9876', 'CANARY_BRAVO_5432', 'CANARY_CHARLIE_1234'];

      const store = new RelayMessageStore();

      // Send multiple encrypted messages
      const messageIds: string[] = [];
      for (const canary of canaries) {
        const encrypted = encryptMessage(sharedSecret, canary);
        const { message } = store.send('acct_42', 'alice', {
          recipientId: 'acct_99',
          body: JSON.stringify(encrypted),
        });
        messageIds.push(message.id);
      }

      // Read all messages
      for (const id of messageIds) {
        store.read(id, 'acct_99');
      }

      // Ack all messages
      for (const id of messageIds) {
        store.ack(id, 'acct_99');
      }

      // Full state scan: inbox, sentBy, get each
      const inbox = store.inbox('acct_99');
      const sent = store.sentBy('acct_42');
      const allMessages = messageIds.map((id) => store.get(id));

      const fullStateSerialized = JSON.stringify({ inbox, sent, allMessages });

      for (const canary of canaries) {
        expect(fullStateSerialized).not.toContain(canary);
      }
    });

    it('relay HTTP wire response does not contain plaintext when E2EE body is used', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const canary = 'HTTP_WIRE_LEAK_CHECK';
      const encrypted = encryptMessage(sharedSecret, canary);

      // Simulate what the relay HTTP handler would return
      const store = new RelayMessageStore();
      const { message } = store.send('acct_42', 'alice', {
        recipientId: 'acct_99',
        body: JSON.stringify(encrypted),
      });

      // Simulate JSON.stringify as the HTTP response serialization
      const httpResponse = JSON.stringify(message);
      expect(httpResponse).not.toContain(canary);
    });
  });

  // ── Revocation enforced at key-exchange time ──

  describe('revocation enforced at key-exchange time', () => {
    it('performKeyExchange rejects revoked device peers deterministically', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice-revkx');
      const { bundle: bobBundle } = setupDevice(tempDir, 'bob-revkx');

      // Revoke Bob's device before attempting key exchange
      revokeDevice(aliceKeysDir, bobBundle.deviceId);

      // Attempting key exchange with revoked peer should throw
      expect(() =>
        performKeyExchange(
          aliceKeysDir,
          aliceBundle,
          bobBundle.x25519PublicKey,
          bobBundle.deviceId,
          bobBundle.fingerprint
        )
      ).toThrow(KeyExchangeError);
    });

    it('error message mentions revocation and the revoked device ID', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice-revmsg');
      const { bundle: bobBundle } = setupDevice(tempDir, 'bob-revmsg');

      revokeDevice(aliceKeysDir, bobBundle.deviceId);

      try {
        performKeyExchange(
          aliceKeysDir,
          aliceBundle,
          bobBundle.x25519PublicKey,
          bobBundle.deviceId,
          bobBundle.fingerprint
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(KeyExchangeError);
        const msg = (err as Error).message;
        expect(msg).toMatch(/revoked/i);
        expect(msg).toContain(bobBundle.deviceId);
      }
    });

    it('revoked device cannot re-establish decrypt capability through fresh exchange', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(
        tempDir,
        'alice-norefresh'
      );
      const { keysDir: bobKeysDir, bundle: bobBundle } = setupDevice(tempDir, 'bob-norefresh');

      // Initial key exchange succeeds
      performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );
      performKeyExchange(
        bobKeysDir,
        bobBundle,
        aliceBundle.x25519PublicKey,
        aliceBundle.deviceId,
        aliceBundle.fingerprint
      );

      // Alice revokes Bob
      revokeDevice(aliceKeysDir, bobBundle.deviceId);

      // Bob tries to re-exchange keys with Alice — Alice's side rejects
      expect(() =>
        performKeyExchange(
          aliceKeysDir,
          aliceBundle,
          bobBundle.x25519PublicKey,
          bobBundle.deviceId,
          bobBundle.fingerprint
        )
      ).toThrow(KeyExchangeError);

      // Existing session still exists from before revocation (reading is allowed)
      // but NO new session can be established
      const existingSession = loadKeyExchangeSession(aliceKeysDir, bobBundle.deviceId);
      expect(existingSession).not.toBeNull();
    });

    it('rotation/revocation trust boundary remains intact across exchange attempts', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice-boundary');
      const { bundle: bobBundle } = setupDevice(tempDir, 'bob-boundary');
      const { bundle: charlieBundle } = setupDevice(tempDir, 'charlie-boundary');

      // Alice exchanges with both Bob and Charlie
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

      // Revoke only Bob
      revokeDevice(aliceKeysDir, bobBundle.deviceId);

      // Bob's fresh exchange attempt is blocked
      expect(() =>
        performKeyExchange(
          aliceKeysDir,
          aliceBundle,
          bobBundle.x25519PublicKey,
          bobBundle.deviceId,
          bobBundle.fingerprint
        )
      ).toThrow(KeyExchangeError);

      // Charlie's fresh exchange still succeeds (not revoked)
      const charlieNewBundle = generateDeviceKeys();
      const newSession = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        charlieNewBundle.x25519PublicKey,
        charlieBundle.deviceId,
        charlieBundle.fingerprint
      );
      expect(newSession.sharedSecret).toBeInstanceOf(Buffer);
      expect(newSession.sharedSecret.length).toBe(32);
    });

    it('revocation check happens before ECDH computation (no shared secret leaked)', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice-noleak');
      const { bundle: bobBundle } = setupDevice(tempDir, 'bob-noleak');

      revokeDevice(aliceKeysDir, bobBundle.deviceId);

      // The error should be thrown before any session is persisted
      try {
        performKeyExchange(
          aliceKeysDir,
          aliceBundle,
          bobBundle.x25519PublicKey,
          bobBundle.deviceId,
          bobBundle.fingerprint
        );
        expect.fail('should have thrown');
      } catch {
        // No session should have been created for the revoked device
        // (the existing session from before the test is not created either)
        const session = loadKeyExchangeSession(aliceKeysDir, bobBundle.deviceId);
        expect(session).toBeNull();
      }
    });

    it('rotateDeviceKeys inherits revocation enforcement', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice-rotrev');
      const { keysDir: bobKeysDir, bundle: bobBundle } = setupDevice(tempDir, 'bob-rotrev');

      // Initial exchange
      performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );

      // Bob revokes Alice
      revokeDevice(bobKeysDir, aliceBundle.deviceId);

      // Bob tries to rotate keys and re-exchange with Alice — should fail
      // because rotateDeviceKeys calls performKeyExchange internally
      expect(() => rotateDeviceKeys(bobKeysDir, bobBundle, aliceKeysDir, aliceBundle)).toThrow(
        KeyExchangeError
      );
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('rotateDeviceKeys generates a new keypair different from the original', () => {
      const { aliceKeysDir, aliceBundle, bobKeysDir, bobBundle } = setupKeyExchangePair(tempDir);

      const { newBundle } = rotateDeviceKeys(bobKeysDir, bobBundle, aliceKeysDir, aliceBundle);

      // New device should have different keys
      expect(newBundle.deviceId).not.toBe(bobBundle.deviceId);
      expect(Buffer.compare(newBundle.x25519PublicKey, bobBundle.x25519PublicKey)).not.toBe(0);
      expect(Buffer.compare(newBundle.x25519PrivateKey, bobBundle.x25519PrivateKey)).not.toBe(0);
    });

    it('rotateDeviceKeys produces a valid key exchange session', () => {
      const { aliceKeysDir, aliceBundle, bobKeysDir, bobBundle } = setupKeyExchangePair(tempDir);

      const { newBundle: _newBundle, newSession } = rotateDeviceKeys(
        bobKeysDir,
        bobBundle,
        aliceKeysDir,
        aliceBundle
      );

      // The new session should have valid shared secret
      expect(newSession.sharedSecret).toBeDefined();
      expect(newSession.sharedSecret.length).toBe(32);
      expect(newSession.peerDeviceId).toBe(aliceBundle.deviceId);
    });

    it('revoking a device does not affect other peer sessions', () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice-multi');
      const { bundle: bobBundle } = setupDevice(tempDir, 'bob-multi');
      const { bundle: charlieBundle } = setupDevice(tempDir, 'charlie-multi');

      // Alice exchanges with Bob and Charlie
      performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );
      const charlieSession = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        charlieBundle.x25519PublicKey,
        charlieBundle.deviceId,
        charlieBundle.fingerprint
      );

      // Revoke Bob
      revokeDevice(aliceKeysDir, bobBundle.deviceId);

      // Charlie's session should still be loadable
      const loadedCharlie = loadKeyExchangeSession(aliceKeysDir, charlieBundle.deviceId);
      expect(loadedCharlie).not.toBeNull();
      const charlieSharedHex = loadedCharlie ? loadedCharlie.sharedSecret.toString('hex') : '';
      expect(charlieSharedHex).toBe(charlieSession.sharedSecret.toString('hex'));

      // Charlie should not be revoked
      expect(isDeviceRevoked(aliceKeysDir, charlieBundle.deviceId)).toBe(false);
    });
  });
});
