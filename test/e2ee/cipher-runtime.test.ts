/**
 * Tests for E2EE cipher runtime: encrypt/decrypt on relay message path
 * and tamper detection.
 *
 * Covers:
 * - VAL-E2EE-003: Relay/wire payloads contain ciphertext, not plaintext body
 *   Message body is not visible in relay transport payloads.
 *   Evidence: wire/relay payload inspection with canary plaintext absence check.
 *
 * - VAL-E2EE-004: Intended recipient decrypts successfully with valid keys
 *   Recipient with correct keys can decrypt and read message content.
 *   Evidence: sender/recipient transcript showing successful decrypt.
 *
 * - VAL-E2EE-009: Ciphertext tampering is detected and rejected
 *   Modified ciphertext fails integrity/authentication checks and is not
 *   rendered as valid content.
 *   Evidence: tampered payload transcript showing reject/error outcome.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  generateDeviceKeys,
  persistDeviceKeys,
  type DeviceKeyBundle,
} from '../../src/e2ee/device-keys.js';

import { performKeyExchange } from '../../src/e2ee/key-exchange.js';

import { encryptMessage, decryptMessage, type EncryptedPayload } from '../../src/e2ee/cipher.js';

import { CipherError } from '../../src/errors.js';

import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { loadRelayConfig } from '../../src/relay/config.js';
import type { TokenVerifier } from '../../src/relay/auth-middleware.js';
import { RelayMessageStore, type RelayMessage } from '../../src/relay/message-store.js';
import { RelayClient, type RelayMessageResponse } from '../../src/relay/client.js';
import { getTestPort } from '../helpers/test-port.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mors-cipher-test-'));
}

/**
 * Create a bootstrapped device key setup for testing.
 */
function setupDevice(baseDir: string, name: string): { keysDir: string; bundle: DeviceKeyBundle } {
  const keysDir = join(baseDir, name, 'e2ee');
  const bundle = generateDeviceKeys();
  persistDeviceKeys(keysDir, bundle);
  return { keysDir, bundle };
}

/**
 * Set up two devices with completed key exchange and return both sessions' shared secrets.
 */
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

describe('E2EE cipher runtime', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── VAL-E2EE-003: wire payloads are ciphertext-only ───────────────

  describe('ciphertext-only wire payloads (VAL-E2EE-003)', () => {
    it('encrypted payload does not contain plaintext message body', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const canaryPlaintext = 'TOP SECRET CANARY MESSAGE body_content_12345';

      const encrypted = encryptMessage(sharedSecret, canaryPlaintext);

      // The encrypted payload (serialized) must not contain the canary plaintext
      const serialized = JSON.stringify(encrypted);
      expect(serialized).not.toContain(canaryPlaintext);
      expect(serialized).not.toContain('TOP SECRET');
      expect(serialized).not.toContain('body_content_12345');
    });

    it('encrypted payload contains ciphertext, iv, and authTag fields', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const plaintext = 'hello, this is a test message';

      const encrypted = encryptMessage(sharedSecret, plaintext);

      expect(encrypted).toHaveProperty('ciphertext');
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('authTag');
      expect(typeof encrypted.ciphertext).toBe('string');
      expect(typeof encrypted.iv).toBe('string');
      expect(typeof encrypted.authTag).toBe('string');
      // All fields must be non-empty
      expect(encrypted.ciphertext.length).toBeGreaterThan(0);
      expect(encrypted.iv.length).toBeGreaterThan(0);
      expect(encrypted.authTag.length).toBeGreaterThan(0);
    });

    it('encrypting the same plaintext twice produces different ciphertext (random IV)', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const plaintext = 'same message both times';

      const enc1 = encryptMessage(sharedSecret, plaintext);
      const enc2 = encryptMessage(sharedSecret, plaintext);

      // Different IVs should produce different ciphertext
      expect(enc1.iv).not.toBe(enc2.iv);
      expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    });

    it('encrypted payload does not expose plaintext in any field', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const plaintext = 'sensitive agent instructions for mission alpha';

      const encrypted = encryptMessage(sharedSecret, plaintext);

      // Check every string field in the payload
      for (const [_key, value] of Object.entries(encrypted)) {
        if (typeof value === 'string') {
          expect(value).not.toContain(plaintext);
          expect(value).not.toContain('sensitive');
          expect(value).not.toContain('mission alpha');
        }
      }
    });
  });

  // ── VAL-E2EE-004: intended recipient decrypts successfully ────────

  describe('successful decryption by intended recipient (VAL-E2EE-004)', () => {
    it('recipient decrypts ciphertext with matching shared secret', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const originalMessage = 'Hello Bob, this is Alice!';

      // Alice encrypts
      const encrypted = encryptMessage(sharedSecret, originalMessage);

      // Bob decrypts (same shared secret from DH)
      const decrypted = decryptMessage(sharedSecret, encrypted);

      expect(decrypted).toBe(originalMessage);
    });

    it('round-trip encrypt/decrypt preserves message content exactly', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const messages = [
        'simple text',
        'unicode: 你好世界 🌍',
        'markdown: **bold** _italic_ `code`',
        '', // empty message
        'a'.repeat(10000), // large message
        'special chars: \n\t\r\0\\/"\'',
      ];

      for (const msg of messages) {
        const encrypted = encryptMessage(sharedSecret, msg);
        const decrypted = decryptMessage(sharedSecret, encrypted);
        expect(decrypted).toBe(msg);
      }
    });

    it('both parties decrypt each others messages with DH shared secret', () => {
      const { aliceSession, bobSession } = setupKeyExchangePair(tempDir);

      // Verify DH symmetry: both sessions have the same shared secret
      expect(Buffer.compare(aliceSession.sharedSecret, bobSession.sharedSecret)).toBe(0);

      // Alice encrypts, Bob decrypts
      const aliceMsg = 'Message from Alice';
      const encAlice = encryptMessage(aliceSession.sharedSecret, aliceMsg);
      const decByBob = decryptMessage(bobSession.sharedSecret, encAlice);
      expect(decByBob).toBe(aliceMsg);

      // Bob encrypts, Alice decrypts
      const bobMsg = 'Reply from Bob';
      const encBob = encryptMessage(bobSession.sharedSecret, bobMsg);
      const decByAlice = decryptMessage(aliceSession.sharedSecret, encBob);
      expect(decByAlice).toBe(bobMsg);
    });

    it('decryption with wrong shared secret fails with CipherError', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const plaintext = 'secret message';

      const encrypted = encryptMessage(sharedSecret, plaintext);

      // Use a completely different shared secret
      const wrongSecret = randomBytes(32);
      expect(() => decryptMessage(wrongSecret, encrypted)).toThrow(CipherError);
    });

    it('CipherError from wrong key includes actionable guidance', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const encrypted = encryptMessage(sharedSecret, 'test');

      const wrongSecret = randomBytes(32);
      try {
        decryptMessage(wrongSecret, encrypted);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CipherError);
        const msg = (err as Error).message;
        // Should mention decryption failure and possible causes
        expect(msg).toMatch(/decrypt|integrity|authentication/i);
      }
    });
  });

  // ── VAL-E2EE-009: ciphertext tampering detection ──────────────────

  describe('ciphertext tampering detection (VAL-E2EE-009)', () => {
    it('tampered ciphertext fails integrity check with CipherError', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const plaintext = 'untampered message content';

      const encrypted = encryptMessage(sharedSecret, plaintext);

      // Tamper with ciphertext: flip a byte in the middle
      const ciphertextBuf = Buffer.from(encrypted.ciphertext, 'base64');
      ciphertextBuf[Math.floor(ciphertextBuf.length / 2)] ^= 0xff;
      const tampered: EncryptedPayload = {
        ...encrypted,
        ciphertext: ciphertextBuf.toString('base64'),
      };

      expect(() => decryptMessage(sharedSecret, tampered)).toThrow(CipherError);
    });

    it('tampered authTag fails authentication check with CipherError', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const plaintext = 'message with authentication';

      const encrypted = encryptMessage(sharedSecret, plaintext);

      // Tamper with auth tag
      const authTagBuf = Buffer.from(encrypted.authTag, 'base64');
      authTagBuf[0] ^= 0xff;
      const tampered: EncryptedPayload = {
        ...encrypted,
        authTag: authTagBuf.toString('base64'),
      };

      expect(() => decryptMessage(sharedSecret, tampered)).toThrow(CipherError);
    });

    it('tampered IV fails decryption with CipherError', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const plaintext = 'message with IV';

      const encrypted = encryptMessage(sharedSecret, plaintext);

      // Tamper with IV
      const ivBuf = Buffer.from(encrypted.iv, 'base64');
      ivBuf[0] ^= 0xff;
      const tampered: EncryptedPayload = {
        ...encrypted,
        iv: ivBuf.toString('base64'),
      };

      expect(() => decryptMessage(sharedSecret, tampered)).toThrow(CipherError);
    });

    it('truncated ciphertext fails with CipherError', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const plaintext = 'full message that will be truncated';

      const encrypted = encryptMessage(sharedSecret, plaintext);

      // Truncate ciphertext to half
      const ciphertextBuf = Buffer.from(encrypted.ciphertext, 'base64');
      const truncated: EncryptedPayload = {
        ...encrypted,
        ciphertext: ciphertextBuf
          .subarray(0, Math.floor(ciphertextBuf.length / 2))
          .toString('base64'),
      };

      expect(() => decryptMessage(sharedSecret, truncated)).toThrow(CipherError);
    });

    it('completely replaced ciphertext fails with CipherError', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const plaintext = 'original message';

      const encrypted = encryptMessage(sharedSecret, plaintext);

      // Replace ciphertext entirely
      const tampered: EncryptedPayload = {
        ...encrypted,
        ciphertext: randomBytes(32).toString('base64'),
      };

      expect(() => decryptMessage(sharedSecret, tampered)).toThrow(CipherError);
    });

    it('tampered ciphertext does not produce original plaintext', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const plaintext = 'critical message';

      const encrypted = encryptMessage(sharedSecret, plaintext);

      // Try multiple tamper variations — none should produce valid decrypt
      const ciphertextBuf = Buffer.from(encrypted.ciphertext, 'base64');
      const tamperPositions = [
        0,
        1,
        ciphertextBuf.length - 1,
        Math.floor(ciphertextBuf.length / 2),
      ];

      for (const pos of tamperPositions) {
        if (pos < ciphertextBuf.length) {
          const tamperedBuf = Buffer.from(ciphertextBuf);
          tamperedBuf[pos] ^= 0x01;
          const tampered: EncryptedPayload = {
            ...encrypted,
            ciphertext: tamperedBuf.toString('base64'),
          };

          expect(() => decryptMessage(sharedSecret, tampered)).toThrow(CipherError);
        }
      }
    });

    it('CipherError from tampered payload is deterministic (not random/undefined)', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const encrypted = encryptMessage(sharedSecret, 'test tampering');

      // Tamper with ciphertext
      const ciphertextBuf = Buffer.from(encrypted.ciphertext, 'base64');
      ciphertextBuf[0] ^= 0xff;
      const tampered: EncryptedPayload = {
        ...encrypted,
        ciphertext: ciphertextBuf.toString('base64'),
      };

      // Run multiple times — error should be consistent
      const errors: string[] = [];
      for (let i = 0; i < 3; i++) {
        try {
          decryptMessage(sharedSecret, tampered);
          expect.fail('should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(CipherError);
          errors.push((err as Error).message);
        }
      }

      // All error messages should be the same (deterministic)
      expect(errors[0]).toBe(errors[1]);
      expect(errors[1]).toBe(errors[2]);
    });
  });

  // ── Input validation ──────────────────────────────────────────────

  describe('input validation', () => {
    it('rejects shared secret of wrong length', () => {
      expect(() => encryptMessage(Buffer.alloc(16), 'test')).toThrow(CipherError);
      expect(() => encryptMessage(Buffer.alloc(64), 'test')).toThrow(CipherError);
    });

    it('rejects empty shared secret', () => {
      expect(() => encryptMessage(Buffer.alloc(0), 'test')).toThrow(CipherError);
    });

    it('decrypt rejects malformed payload fields', () => {
      const sharedSecret = randomBytes(32);

      // Missing iv
      expect(() =>
        decryptMessage(sharedSecret, { ciphertext: 'aaa', iv: '', authTag: 'bbb' })
      ).toThrow(CipherError);

      // Missing authTag
      expect(() =>
        decryptMessage(sharedSecret, { ciphertext: 'aaa', iv: 'bbb', authTag: '' })
      ).toThrow(CipherError);

      // Null/undefined ciphertext (cast to bypass TS for runtime check)
      expect(() =>
        decryptMessage(sharedSecret, {
          ciphertext: null as unknown as string,
          iv: 'aaa',
          authTag: 'bbb',
        })
      ).toThrow(CipherError);
    });
  });

  // ── Relay payload canary inspection ───────────────────────────────

  describe('relay payload canary absence (VAL-E2EE-003 + VAL-E2EE-007)', () => {
    it('canary plaintext string is absent from all encrypted payload fields', () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const canary = 'CANARY_PLAINTEXT_MARKER_XYZ789';

      const encrypted = encryptMessage(sharedSecret, canary);

      // Simulate a relay wire payload (what would be transmitted/stored)
      const wirePayload = JSON.stringify({
        encrypted_body: encrypted,
        sender_id: 'acct_42',
        recipient_id: 'acct_99',
      });

      // Canary must not appear anywhere in the wire payload
      expect(wirePayload).not.toContain(canary);
      expect(wirePayload).not.toContain('CANARY');
      expect(wirePayload).not.toContain('XYZ789');
    });
  });
});

// ── E2EE Relay Transport Integration ────────────────────────────────
//
// These tests verify that E2EE cipher operations are integrated into the
// actual relay transport path: client → server → client read, with
// ciphertext-only wire payloads, successful recipient decrypt, and
// tamper detection in the real relay send/read flow.

const ALICE_RELAY = { token: 'token-alice-e2ee', userId: 'acct_2001', login: 'alice-e2ee' };
const BOB_RELAY = { token: 'token-bob-e2ee', userId: 'acct_2002', login: 'bob-e2ee' };

const e2eeStubVerifier: TokenVerifier = async (token: string) => {
  const map: Record<string, { accountId: string; deviceId: string }> = {
    [ALICE_RELAY.token]: { accountId: ALICE_RELAY.userId, deviceId: ALICE_RELAY.login },
    [BOB_RELAY.token]: { accountId: BOB_RELAY.userId, deviceId: BOB_RELAY.login },
  };
  return map[token] ?? null;
};

describe('E2EE relay transport integration', () => {
  let tempDir: string;
  let server: RelayServer | null = null;
  let messageStore: RelayMessageStore;
  let port: number;

  /** Captured wire payloads for inspection. */
  let capturedWirePayloads: string[] = [];

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mors-e2ee-relay-'));
    port = getTestPort();
    messageStore = new RelayMessageStore();
    capturedWirePayloads = [];

    const config = loadRelayConfig({
      MORS_RELAY_PORT: String(port),
      MORS_RELAY_HOST: '127.0.0.1',
    });

    server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: e2eeStubVerifier,
      participantStore: {
        async isParticipant(conversationId: string, accountId: string): Promise<boolean> {
          return messageStore.isParticipant(conversationId, accountId);
        },
      },
      messageStore,
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── VAL-E2EE-003: Relay client sends ciphertext payloads ──────────

  describe('relay client sends ciphertext payloads (VAL-E2EE-003)', () => {
    it('sendEncrypted sends ciphertext body through relay — no plaintext on wire', async () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const canary = 'SUPER_SECRET_PLAINTEXT_CANARY_42';

      const aliceClient = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE_RELAY.token,
        // Intercept fetch to capture wire payload
        fetchFn: async (url, init) => {
          if (init?.body) {
            capturedWirePayloads.push(init.body as string);
          }
          return fetch(url, init);
        },
      });

      const result = await aliceClient.sendEncrypted({
        recipientId: BOB_RELAY.userId,
        body: canary,
        sharedSecret,
      });

      expect(result.queued).toBe(false);
      expect(result.message).toBeDefined();

      // Wire payload must not contain plaintext canary
      expect(capturedWirePayloads.length).toBeGreaterThan(0);
      for (const payload of capturedWirePayloads) {
        expect(payload).not.toContain(canary);
        expect(payload).not.toContain('SUPER_SECRET');
        expect(payload).not.toContain('CANARY_42');
      }

      // Relay store body must not contain plaintext
      const stored = messageStore.inbox(BOB_RELAY.userId);
      expect(stored.length).toBe(1);
      expect(stored[0].body).not.toContain(canary);
      expect(stored[0].body).not.toContain('SUPER_SECRET');
    });

    it('sendEncrypted wire payload contains valid EncryptedPayload JSON structure', async () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);

      const aliceClient = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE_RELAY.token,
      });

      await aliceClient.sendEncrypted({
        recipientId: BOB_RELAY.userId,
        body: 'test encrypted structure',
        sharedSecret,
      });

      // The stored body in relay should be a valid EncryptedPayload JSON
      const stored = messageStore.inbox(BOB_RELAY.userId);
      expect(stored.length).toBe(1);
      const parsed = JSON.parse(stored[0].body) as EncryptedPayload;
      expect(parsed).toHaveProperty('ciphertext');
      expect(parsed).toHaveProperty('iv');
      expect(parsed).toHaveProperty('authTag');
      expect(typeof parsed.ciphertext).toBe('string');
      expect(typeof parsed.iv).toBe('string');
      expect(typeof parsed.authTag).toBe('string');
    });
  });

  // ── VAL-E2EE-004: Recipient read path decrypts ────────────────────

  describe('recipient read path decrypts with valid key exchange context (VAL-E2EE-004)', () => {
    it('readDecrypted decrypts relay message with matching shared secret', async () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const plaintext = 'Hello Bob, this is a secret message from Alice!';

      // Alice sends encrypted
      const aliceClient = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE_RELAY.token,
      });

      const sendResult = await aliceClient.sendEncrypted({
        recipientId: BOB_RELAY.userId,
        body: plaintext,
        sharedSecret,
      });

      const message = sendResult.message;
      expect(message).toBeDefined();
      const messageId = (message as RelayMessageResponse).id;

      // Bob reads and decrypts
      const bobClient = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: BOB_RELAY.token,
      });

      const readResult = await bobClient.readDecrypted(messageId, sharedSecret);
      expect(readResult.decryptedBody).toBe(plaintext);
      expect(readResult.firstRead).toBe(true);
    });

    it('readDecrypted round-trip preserves unicode and special characters', async () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const messages = [
        'unicode: 你好世界 🌍',
        'special: \n\t\r\\/"\'',
        'markdown: **bold** _italic_ `code`',
        'a'.repeat(5000),
      ];

      const aliceClient = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE_RELAY.token,
      });
      const bobClient = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: BOB_RELAY.token,
      });

      for (const plaintext of messages) {
        const sendResult = await aliceClient.sendEncrypted({
          recipientId: BOB_RELAY.userId,
          body: plaintext,
          sharedSecret,
        });

        const msg = sendResult.message as RelayMessageResponse;
        const readResult = await bobClient.readDecrypted(msg.id, sharedSecret);
        expect(readResult.decryptedBody).toBe(plaintext);
      }
    });

    it('readDecrypted with wrong shared secret throws CipherError', async () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);

      const aliceClient = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE_RELAY.token,
      });

      const sendResult = await aliceClient.sendEncrypted({
        recipientId: BOB_RELAY.userId,
        body: 'secret for right eyes only',
        sharedSecret,
      });

      const bobClient = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: BOB_RELAY.token,
      });

      const msg = sendResult.message as RelayMessageResponse;
      const wrongSecret = randomBytes(32);
      await expect(bobClient.readDecrypted(msg.id, wrongSecret)).rejects.toThrow(CipherError);
    });
  });

  // ── VAL-E2EE-009: Tampered ciphertext rejected in relay flow ──────

  describe('tampered ciphertext is rejected in relay-backed flow (VAL-E2EE-009)', () => {
    it('tampered ciphertext in relay store is detected and rejected on readDecrypted', async () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);

      const aliceClient = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE_RELAY.token,
      });

      const sendResult = await aliceClient.sendEncrypted({
        recipientId: BOB_RELAY.userId,
        body: 'tamper-proof message',
        sharedSecret,
      });

      const sentMsg = sendResult.message as RelayMessageResponse;
      const messageId = sentMsg.id;

      // Tamper with the stored message body in the relay store directly
      const stored = messageStore.get(messageId);
      expect(stored).toBeDefined();

      const parsed = JSON.parse((stored as RelayMessage).body) as EncryptedPayload;
      const ciphertextBuf = Buffer.from(parsed.ciphertext, 'base64');
      ciphertextBuf[0] ^= 0xff; // flip a byte
      const tampered: EncryptedPayload = {
        ...parsed,
        ciphertext: ciphertextBuf.toString('base64'),
      };
      // Mutate the store directly (simulating relay-level tampering)
      (stored as { body: string }).body = JSON.stringify(tampered);

      // Bob tries to read — should detect tampering
      const bobClient = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: BOB_RELAY.token,
      });

      await expect(bobClient.readDecrypted(messageId, sharedSecret)).rejects.toThrow(CipherError);
    });

    it('tampered authTag in relay store is detected on readDecrypted', async () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);

      const aliceClient = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE_RELAY.token,
      });

      const sendResult = await aliceClient.sendEncrypted({
        recipientId: BOB_RELAY.userId,
        body: 'authenticated message',
        sharedSecret,
      });

      const sentMsg = sendResult.message as RelayMessageResponse;
      const messageId = sentMsg.id;
      const stored = messageStore.get(messageId);
      expect(stored).toBeDefined();

      const parsed = JSON.parse((stored as RelayMessage).body) as EncryptedPayload;
      const authTagBuf = Buffer.from(parsed.authTag, 'base64');
      authTagBuf[0] ^= 0xff;
      const tampered: EncryptedPayload = {
        ...parsed,
        authTag: authTagBuf.toString('base64'),
      };
      (stored as { body: string }).body = JSON.stringify(tampered);

      const bobClient = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: BOB_RELAY.token,
      });

      await expect(bobClient.readDecrypted(messageId, sharedSecret)).rejects.toThrow(CipherError);
    });

    it('relay store plaintext canary is absent after sendEncrypted (VAL-E2EE-007)', async () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);
      const canary = 'RELAY_STORE_PLAINTEXT_LEAK_CANARY';

      const aliceClient = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE_RELAY.token,
      });

      const sendResult = await aliceClient.sendEncrypted({
        recipientId: BOB_RELAY.userId,
        body: canary,
        sharedSecret,
      });

      // Inspect relay store: body must be ciphertext JSON, not plaintext
      const sentMsg = sendResult.message as RelayMessageResponse;
      const stored = messageStore.get(sentMsg.id);
      expect(stored).toBeDefined();
      const storedMsg = stored as RelayMessage;
      expect(storedMsg.body).not.toContain(canary);
      expect(storedMsg.body).not.toContain('PLAINTEXT_LEAK');

      // Verify the body parses as a valid EncryptedPayload
      const parsed = JSON.parse(storedMsg.body) as EncryptedPayload;
      expect(parsed.ciphertext).toBeDefined();
      expect(parsed.iv).toBeDefined();
      expect(parsed.authTag).toBeDefined();
    });
  });
});
