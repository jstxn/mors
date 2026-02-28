/**
 * Tests for CLI default encrypted remote messaging paths.
 *
 * Verifies that CLI remote send/read/reply commands route through
 * encrypted RelayClient methods by default when key-exchange context
 * exists, and provide actionable guidance when secure prerequisites
 * are missing.
 *
 * Covers:
 * - CLI remote send/reply use encrypted transport by default under active key exchange
 * - CLI remote read decrypts ciphertext payloads through secure path
 * - Missing exchange/bootstrap conditions return actionable secure-setup guidance
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { loadRelayConfig } from '../../src/relay/config.js';
import type { TokenVerifier, ParticipantStore } from '../../src/relay/auth-middleware.js';
import { RelayMessageStore } from '../../src/relay/message-store.js';
import { saveSession, markAuthEnabled, type AuthSession } from '../../src/auth/session.js';
import {
  generateDeviceKeys,
  persistDeviceKeys,
  getDeviceKeysDir,
  type DeviceKeyBundle,
} from '../../src/e2ee/device-keys.js';
import { performKeyExchange } from '../../src/e2ee/key-exchange.js';
import { encryptMessage, decryptMessage, type EncryptedPayload } from '../../src/e2ee/cipher.js';
import { getTestPort } from '../helpers/test-port.js';

// ── Test identities ─────────────────────────────────────────────────

const ALICE = { token: 'token-alice', userId: 1001, login: 'alice' };
const BOB = { token: 'token-bob', userId: 1002, login: 'bob' };

/** Stub token verifier mapping test tokens to principals. */
const stubVerifier: TokenVerifier = async (token: string) => {
  const map: Record<string, { githubUserId: number; githubLogin: string }> = {
    [ALICE.token]: { githubUserId: ALICE.userId, githubLogin: ALICE.login },
    [BOB.token]: { githubUserId: BOB.userId, githubLogin: BOB.login },
  };
  return map[token] ?? null;
};

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = join(ROOT, 'dist', 'index.js');

function makeSession(overrides?: Partial<AuthSession>): AuthSession {
  return {
    accessToken: 'token-alice',
    tokenType: 'bearer',
    scope: 'read:user',
    githubUserId: ALICE.userId,
    githubLogin: ALICE.login,
    deviceId: 'device-cli-001',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Initialize a mors config directory with sentinel files so init gate passes.
 */
function simulateInit(configDir: string): void {
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
 * Bootstrap E2EE device keys in a config directory.
 * Returns the device key bundle for use in key exchange.
 */
function bootstrapDeviceKeys(configDir: string): DeviceKeyBundle {
  const keysDir = getDeviceKeysDir(configDir);
  const bundle = generateDeviceKeys();
  persistDeviceKeys(keysDir, bundle);
  return bundle;
}

/**
 * Set up a key exchange between local device and a peer device.
 * Returns the shared secret and peer device info.
 */
function setupKeyExchange(
  configDir: string,
  localBundle: DeviceKeyBundle
): { peerBundle: DeviceKeyBundle; sharedSecret: Buffer; peerKeysDir: string } {
  // Generate peer device keys
  const peerKeysDir = mkdtempSync(join(tmpdir(), 'mors-peer-'));
  const peerBundle = generateDeviceKeys();
  persistDeviceKeys(peerKeysDir, peerBundle);

  // Perform key exchange: local → peer
  const keysDir = getDeviceKeysDir(configDir);
  const session = performKeyExchange(
    keysDir,
    localBundle,
    peerBundle.x25519PublicKey,
    peerBundle.deviceId,
    peerBundle.fingerprint
  );

  // Also perform peer → local so peer can decrypt
  performKeyExchange(
    peerKeysDir,
    peerBundle,
    localBundle.x25519PublicKey,
    localBundle.deviceId,
    localBundle.fingerprint
  );

  return { peerBundle, sharedSecret: session.sharedSecret, peerKeysDir };
}

/**
 * Run CLI command asynchronously with optional env overrides.
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
    }, options.timeout ?? 15_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

// ── Encrypted remote send/read/reply via CLI ────────────────────────

describe('CLI default encrypted remote messaging paths', () => {
  let server: RelayServer | null = null;
  let port: number;
  let messageStore: RelayMessageStore;
  let tempDir: string;
  let peerTempDirs: string[];

  beforeEach(async () => {
    port = getTestPort();
    messageStore = new RelayMessageStore();
    tempDir = mkdtempSync(join(tmpdir(), 'mors-cli-enc-'));
    peerTempDirs = [];
    simulateInit(tempDir);

    const config = loadRelayConfig({
      MORS_RELAY_PORT: String(port),
      MORS_RELAY_HOST: '127.0.0.1',
    });

    const participantStore: ParticipantStore = {
      async isParticipant(conversationId: string, githubUserId: number): Promise<boolean> {
        return messageStore.isParticipant(conversationId, githubUserId);
      },
    };

    server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: stubVerifier,
      participantStore,
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
    for (const dir of peerTempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Remote send uses encrypted transport by default ───────────────

  it('send --remote encrypts body by default when key exchange exists', async () => {
    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());
    const localBundle = bootstrapDeviceKeys(tempDir);
    const { peerBundle, sharedSecret, peerKeysDir } = setupKeyExchange(tempDir, localBundle);
    peerTempDirs.push(peerKeysDir);

    const result = await runCliAsync(
      [
        'send',
        '--to',
        String(BOB.userId),
        '--body',
        'secret message for bob',
        '--remote',
        '--json',
        '--peer-device',
        peerBundle.deviceId,
      ],
      {
        configDir: tempDir,
        env: { MORS_RELAY_BASE_URL: `http://127.0.0.1:${port}` },
      }
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('sent');
    expect(parsed.mode).toBe('remote');
    expect(parsed.encrypted).toBe(true);

    // Verify the relay store has ciphertext, NOT plaintext
    const inbox = messageStore.inbox(BOB.userId);
    expect(inbox.length).toBe(1);
    expect(inbox[0].body).not.toContain('secret message for bob');

    // Verify the body is a valid encrypted payload
    const storedPayload = JSON.parse(inbox[0].body) as EncryptedPayload;
    expect(storedPayload).toHaveProperty('ciphertext');
    expect(storedPayload).toHaveProperty('iv');
    expect(storedPayload).toHaveProperty('authTag');

    // Verify decryption with the shared secret succeeds
    const decrypted = decryptMessage(sharedSecret, storedPayload);
    expect(decrypted).toBe('secret message for bob');
  });

  // ── Remote read decrypts ciphertext payloads ──────────────────────

  it('read --remote decrypts ciphertext body when key exchange exists', async () => {
    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());
    const localBundle = bootstrapDeviceKeys(tempDir);
    const { peerBundle, sharedSecret, peerKeysDir } = setupKeyExchange(tempDir, localBundle);
    peerTempDirs.push(peerKeysDir);

    // Pre-populate relay with an encrypted message for Alice
    const plaintext = 'encrypted hello from bob';
    const encrypted = encryptMessage(sharedSecret, plaintext);
    const ciphertextBody = JSON.stringify(encrypted);
    const sent = messageStore.send(BOB.userId, BOB.login, {
      recipientId: ALICE.userId,
      body: ciphertextBody,
    });

    const result = await runCliAsync(
      ['read', sent.message.id, '--remote', '--json', '--peer-device', peerBundle.deviceId],
      {
        configDir: tempDir,
        env: { MORS_RELAY_BASE_URL: `http://127.0.0.1:${port}` },
      }
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('ok');
    expect(parsed.mode).toBe('remote');
    expect(parsed.encrypted).toBe(true);
    expect(parsed.decrypted_body).toBe('encrypted hello from bob');
  });

  // ── Remote reply uses encrypted transport by default ──────────────

  it('reply --remote encrypts body by default when key exchange exists', async () => {
    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());
    const localBundle = bootstrapDeviceKeys(tempDir);
    const { peerBundle, sharedSecret, peerKeysDir } = setupKeyExchange(tempDir, localBundle);
    peerTempDirs.push(peerKeysDir);

    // Pre-populate: Bob sends to Alice
    const sent = messageStore.send(BOB.userId, BOB.login, {
      recipientId: ALICE.userId,
      body: 'reply to this',
    });

    const result = await runCliAsync(
      [
        'reply',
        sent.message.id,
        '--to',
        String(BOB.userId),
        '--body',
        'encrypted reply from alice',
        '--remote',
        '--json',
        '--peer-device',
        peerBundle.deviceId,
      ],
      {
        configDir: tempDir,
        env: { MORS_RELAY_BASE_URL: `http://127.0.0.1:${port}` },
      }
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('replied');
    expect(parsed.mode).toBe('remote');
    expect(parsed.encrypted).toBe(true);

    // Verify the relay store has ciphertext, NOT plaintext
    const bobInbox = messageStore.inbox(BOB.userId);
    const reply = bobInbox.find((m) => m.in_reply_to === sent.message.id);
    expect(reply).toBeDefined();
    // Use intermediate variable to satisfy no-non-null-assertion lint rule
    const replyMsg = reply as typeof reply & { body: string };
    expect(replyMsg.body).not.toContain('encrypted reply from alice');

    // Verify decryption succeeds
    const storedPayload = JSON.parse(replyMsg.body) as EncryptedPayload;
    const decrypted = decryptMessage(sharedSecret, storedPayload);
    expect(decrypted).toBe('encrypted reply from alice');
  });

  // ── No-encrypt flag bypasses encryption ───────────────────────────

  it('send --remote --no-encrypt sends plaintext even with key exchange', async () => {
    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());
    const localBundle = bootstrapDeviceKeys(tempDir);
    const { peerKeysDir } = setupKeyExchange(tempDir, localBundle);
    peerTempDirs.push(peerKeysDir);

    const result = await runCliAsync(
      [
        'send',
        '--to',
        String(BOB.userId),
        '--body',
        'plaintext message',
        '--remote',
        '--no-encrypt',
        '--json',
      ],
      {
        configDir: tempDir,
        env: { MORS_RELAY_BASE_URL: `http://127.0.0.1:${port}` },
      }
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('sent');
    expect(parsed.mode).toBe('remote');
    // Should not have encrypted flag
    expect(parsed.encrypted).toBeUndefined();

    // Verify the relay store has plaintext
    const inbox = messageStore.inbox(BOB.userId);
    expect(inbox.length).toBe(1);
    expect(inbox[0].body).toBe('plaintext message');
  });
});

// ── Missing secure prerequisites guidance ───────────────────────────

describe('CLI secure-setup guidance when prerequisites missing', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mors-cli-noenc-'));
    simulateInit(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('send --remote without device bootstrap returns bootstrap guidance', async () => {
    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());
    // No device keys bootstrapped

    const result = await runCliAsync(
      [
        'send',
        '--to',
        String(BOB.userId),
        '--body',
        'test',
        '--remote',
        '--json',
        '--peer-device',
        'some-device',
      ],
      {
        configDir: tempDir,
        env: { MORS_RELAY_BASE_URL: 'http://127.0.0.1:3100' },
      }
    );

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('device_not_bootstrapped');
    expect(parsed.message).toContain('mors init');
  });

  it('send --remote with bootstrap but no key exchange returns exchange guidance', async () => {
    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());
    bootstrapDeviceKeys(tempDir);
    // No key exchange done

    const result = await runCliAsync(
      [
        'send',
        '--to',
        String(BOB.userId),
        '--body',
        'test',
        '--remote',
        '--json',
        '--peer-device',
        'nonexistent-device',
      ],
      {
        configDir: tempDir,
        env: { MORS_RELAY_BASE_URL: 'http://127.0.0.1:3100' },
      }
    );

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('key_exchange_required');
    expect(parsed.message).toContain('key-exchange');
  });

  it('read --remote without key exchange returns exchange guidance', async () => {
    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());
    bootstrapDeviceKeys(tempDir);

    const result = await runCliAsync(
      ['read', 'msg_some-id', '--remote', '--json', '--peer-device', 'nonexistent-device'],
      {
        configDir: tempDir,
        env: { MORS_RELAY_BASE_URL: 'http://127.0.0.1:3100' },
      }
    );

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('key_exchange_required');
    expect(parsed.message).toContain('key-exchange');
  });

  it('reply --remote without device bootstrap returns bootstrap guidance', async () => {
    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());
    // No device keys bootstrapped

    const result = await runCliAsync(
      [
        'reply',
        'msg_some-id',
        '--to',
        String(BOB.userId),
        '--body',
        'test',
        '--remote',
        '--json',
        '--peer-device',
        'some-device',
      ],
      {
        configDir: tempDir,
        env: { MORS_RELAY_BASE_URL: 'http://127.0.0.1:3100' },
      }
    );

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('device_not_bootstrapped');
    expect(parsed.message).toContain('mors init');
  });

  it('send --remote --no-encrypt works even without device bootstrap', async () => {
    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());
    // No device keys bootstrapped — but --no-encrypt should bypass

    // Note: this will fail with relay connection error since no server running,
    // but it should NOT fail with bootstrap error
    const result = await runCliAsync(
      [
        'send',
        '--to',
        String(BOB.userId),
        '--body',
        'plaintext',
        '--remote',
        '--no-encrypt',
        '--json',
      ],
      {
        configDir: tempDir,
        env: { MORS_RELAY_BASE_URL: 'http://127.0.0.1:3100' },
      }
    );

    // Should NOT have bootstrap error — may have relay error since server not running
    const output = result.stdout;
    expect(output).not.toContain('device_not_bootstrapped');
    expect(output).not.toContain('key_exchange_required');
  });
});
