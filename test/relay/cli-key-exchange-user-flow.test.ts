import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { loadRelayConfig } from '../../src/relay/config.js';
import type { ParticipantStore, TokenVerifier } from '../../src/relay/auth-middleware.js';
import { RelayMessageStore } from '../../src/relay/message-store.js';
import { saveSession, markAuthEnabled, type AuthSession } from '../../src/auth/session.js';
import {
  generateDeviceKeys,
  persistDeviceKeys,
  getDeviceKeysDir,
  type DeviceKeyBundle,
} from '../../src/e2ee/device-keys.js';
import { getTestPort } from '../helpers/test-port.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = join(ROOT, 'dist', 'index.js');

const ALICE = { token: 'token-alice', accountId: 'acct_1001', login: 'alice' };
const BOB = { token: 'token-bob', accountId: 'acct_1002', login: 'bob' };

const stubVerifier: TokenVerifier = async (token: string) => {
  const map: Record<string, { accountId: string; deviceId: string }> = {
    [ALICE.token]: { accountId: ALICE.accountId, deviceId: ALICE.login },
    [BOB.token]: { accountId: BOB.accountId, deviceId: BOB.login },
  };
  return map[token] ?? null;
};

function makeSession(token: string, accountId: string, deviceId: string): AuthSession {
  return {
    accessToken: token,
    tokenType: 'bearer',
    accountId,
    deviceId,
    createdAt: new Date().toISOString(),
  };
}

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

function bootstrapDeviceKeys(configDir: string): DeviceKeyBundle {
  const keysDir = getDeviceKeysDir(configDir);
  const bundle = generateDeviceKeys();
  persistDeviceKeys(keysDir, bundle);
  return bundle;
}

function runCli(
  args: string[],
  options: {
    configDir: string;
    env?: Record<string, string>;
    stdin?: string;
  }
): { stdout: string; stderr: string; exitCode: number } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...options.env,
    MORS_CONFIG_DIR: options.configDir,
  };

  const result = spawnSync('node', [CLI, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    input: options.stdin,
    timeout: 15_000,
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function runCliAsync(
  args: string[],
  options: {
    configDir: string;
    env?: Record<string, string>;
    stdin?: string;
    timeout?: number;
  }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...options.env,
      MORS_CONFIG_DIR: options.configDir,
    };

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

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, options.timeout ?? 15_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

describe('CLI key-exchange end-user flow', () => {
  let server: RelayServer | null = null;
  let messageStore: RelayMessageStore;
  let port: number;
  let aliceDir: string;
  let bobDir: string;
  let aliceBundle: DeviceKeyBundle;
  let bobBundle: DeviceKeyBundle;

  beforeEach(async () => {
    port = getTestPort();
    messageStore = new RelayMessageStore();
    aliceDir = mkdtempSync(join(tmpdir(), 'mors-kx-alice-'));
    bobDir = mkdtempSync(join(tmpdir(), 'mors-kx-bob-'));

    simulateInit(aliceDir);
    simulateInit(bobDir);

    aliceBundle = bootstrapDeviceKeys(aliceDir);
    bobBundle = bootstrapDeviceKeys(bobDir);

    markAuthEnabled(aliceDir);
    markAuthEnabled(bobDir);
    saveSession(aliceDir, makeSession(ALICE.token, ALICE.accountId, aliceBundle.deviceId));
    saveSession(bobDir, makeSession(BOB.token, BOB.accountId, bobBundle.deviceId));

    const config = loadRelayConfig({
      MORS_RELAY_PORT: String(port),
      MORS_RELAY_HOST: '127.0.0.1',
    });

    const participantStore: ParticipantStore = {
      async isParticipant(conversationId: string, accountId: string): Promise<boolean> {
        return messageStore.isParticipant(conversationId, accountId);
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
    rmSync(aliceDir, { recursive: true, force: true });
    rmSync(bobDir, { recursive: true, force: true });
  });

  it('supports manual bundle exchange and encrypted remote messaging without --peer-device when one session exists', async () => {
    const relayEnv = { MORS_RELAY_BASE_URL: `http://127.0.0.1:${port}` };

    const aliceOffer = runCli(['key-exchange', 'offer', '--json'], {
      configDir: aliceDir,
    });
    expect(aliceOffer.exitCode).toBe(0);
    const aliceOfferPayload = JSON.parse(aliceOffer.stdout);
    expect(aliceOfferPayload.bundle.device_id).toBe(aliceBundle.deviceId);

    const bobAccept = runCli(['key-exchange', 'accept', '--bundle', '-', '--json'], {
      configDir: bobDir,
      stdin: aliceOffer.stdout,
    });
    expect(bobAccept.exitCode).toBe(0);
    const bobAcceptPayload = JSON.parse(bobAccept.stdout);
    expect(bobAcceptPayload.status).toBe('ok');
    expect(bobAcceptPayload.peer_device_id).toBe(aliceBundle.deviceId);

    const bobOffer = runCli(['key-exchange', 'offer', '--json'], {
      configDir: bobDir,
    });
    expect(bobOffer.exitCode).toBe(0);
    const bobOfferPayload = JSON.parse(bobOffer.stdout);
    expect(bobOfferPayload.bundle.device_id).toBe(bobBundle.deviceId);

    const bobBundleFile = join(tmpdir(), `mors-kx-bob-${Date.now()}.json`);
    writeFileSync(bobBundleFile, bobOffer.stdout);

    const aliceAccept = runCli(
      ['key-exchange', 'accept', '--bundle-file', bobBundleFile, '--json'],
      {
        configDir: aliceDir,
      }
    );
    expect(aliceAccept.exitCode).toBe(0);
    const aliceAcceptPayload = JSON.parse(aliceAccept.stdout);
    expect(aliceAcceptPayload.status).toBe('ok');
    expect(aliceAcceptPayload.peer_device_id).toBe(bobBundle.deviceId);

    const aliceSessions = runCli(['key-exchange', 'list', '--json'], {
      configDir: aliceDir,
    });
    expect(aliceSessions.exitCode).toBe(0);
    expect(JSON.parse(aliceSessions.stdout)).toMatchObject({
      status: 'ok',
      count: 1,
      sessions: [{ peer_device_id: bobBundle.deviceId }],
    });

    const bobSessions = runCli(['key-exchange', 'list', '--json'], {
      configDir: bobDir,
    });
    expect(bobSessions.exitCode).toBe(0);
    expect(JSON.parse(bobSessions.stdout)).toMatchObject({
      status: 'ok',
      count: 1,
      sessions: [{ peer_device_id: aliceBundle.deviceId }],
    });

    const aliceSend = await runCliAsync(
      [
        'send',
        '--remote',
        '--json',
        '--to',
        BOB.accountId,
        '--body',
        'hello bob from alice',
      ],
      {
        configDir: aliceDir,
        env: relayEnv,
      }
    );
    expect(aliceSend.exitCode).toBe(0);
    const aliceSendPayload = JSON.parse(aliceSend.stdout);
    expect(aliceSendPayload.status).toBe('sent');
    expect(aliceSendPayload.encrypted).toBe(true);

    const bobInbox = await runCliAsync(['inbox', '--remote', '--json'], {
      configDir: bobDir,
      env: relayEnv,
    });
    expect(bobInbox.exitCode).toBe(0);
    const bobInboxPayload = JSON.parse(bobInbox.stdout);
    expect(bobInboxPayload.messages).toHaveLength(1);

    const bobRead = await runCliAsync(['read', bobInboxPayload.messages[0].id, '--remote', '--json'], {
      configDir: bobDir,
      env: relayEnv,
    });
    expect(bobRead.exitCode).toBe(0);
    const bobReadPayload = JSON.parse(bobRead.stdout);
    expect(bobReadPayload.decrypted_body).toBe('hello bob from alice');
    expect(bobReadPayload.encrypted).toBe(true);

    const bobReply = await runCliAsync(
      [
        'reply',
        bobInboxPayload.messages[0].id,
        '--remote',
        '--json',
        '--body',
        'hello alice from bob',
        '--to',
        ALICE.accountId,
      ],
      {
        configDir: bobDir,
        env: relayEnv,
      }
    );
    expect(bobReply.exitCode).toBe(0);
    const bobReplyPayload = JSON.parse(bobReply.stdout);
    expect(bobReplyPayload.status).toBe('replied');
    expect(bobReplyPayload.encrypted).toBe(true);

    const aliceInbox = await runCliAsync(['inbox', '--remote', '--json'], {
      configDir: aliceDir,
      env: relayEnv,
    });
    expect(aliceInbox.exitCode).toBe(0);
    const aliceInboxPayload = JSON.parse(aliceInbox.stdout);
    expect(aliceInboxPayload.messages).toHaveLength(1);

    const aliceRead = await runCliAsync(['read', aliceInboxPayload.messages[0].id, '--remote', '--json'], {
      configDir: aliceDir,
      env: relayEnv,
    });
    expect(aliceRead.exitCode).toBe(0);
    const aliceReadPayload = JSON.parse(aliceRead.stdout);
    expect(aliceReadPayload.decrypted_body).toBe('hello alice from bob');
    expect(aliceReadPayload.encrypted).toBe(true);

    rmSync(bobBundleFile, { force: true });
  });
});
