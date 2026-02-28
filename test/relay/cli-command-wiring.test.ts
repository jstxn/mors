/**
 * Tests for CLI-to-RelayClient command wiring.
 *
 * Verifies that CLI messaging commands (send, inbox, read, ack, reply)
 * execute through RelayClient when an authenticated remote session is active,
 * and fall back to local mode with deterministic guidance when prerequisites
 * are absent.
 *
 * Covers:
 * - CLI protected messaging commands execute through RelayClient in authenticated remote mode
 * - Remote path uses durable queue/retry behavior from RelayClient
 * - Local mode remains explicit and deterministic when remote prerequisites are absent
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

// ── Remote Send/Inbox/Read/Ack/Reply via RelayClient ────────────────

describe('CLI command wiring to RelayClient (remote mode)', () => {
  let server: RelayServer | null = null;
  let port: number;
  let messageStore: RelayMessageStore;
  let tempDir: string;

  beforeEach(async () => {
    port = getTestPort();
    messageStore = new RelayMessageStore();
    tempDir = mkdtempSync(join(tmpdir(), 'mors-cli-relay-'));
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
  });

  // ── Remote Send ───────────────────────────────────────────────────

  it('send --remote routes through relay and returns relay message ID', async () => {
    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());

    const result = await runCliAsync(
      [
        'send',
        '--to',
        String(BOB.userId),
        '--body',
        'hello from relay',
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
    expect(parsed.id).toMatch(/^msg_/);
    expect(parsed.mode).toBe('remote');

    // Verify message landed in relay store
    const inbox = messageStore.inbox(BOB.userId);
    expect(inbox.length).toBe(1);
    expect(inbox[0].body).toBe('hello from relay');
  });

  // ── Remote Inbox ──────────────────────────────────────────────────

  it('inbox --remote fetches from relay for authenticated user', async () => {
    // Pre-populate relay with a message for Alice
    messageStore.send(BOB.userId, BOB.login, {
      recipientId: ALICE.userId,
      body: 'test message for inbox',
    });

    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());

    const result = await runCliAsync(['inbox', '--remote', '--json'], {
      configDir: tempDir,
      env: { MORS_RELAY_BASE_URL: `http://127.0.0.1:${port}` },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('ok');
    expect(parsed.mode).toBe('remote');
    expect(parsed.count).toBe(1);
    expect(parsed.messages[0].body).toBe('test message for inbox');
  });

  // ── Remote Read ───────────────────────────────────────────────────

  it('read --remote reads a message through relay', async () => {
    // Pre-populate: Bob sends to Alice
    const sent = messageStore.send(BOB.userId, BOB.login, {
      recipientId: ALICE.userId,
      body: 'read me via relay',
    });

    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());

    const result = await runCliAsync(
      ['read', sent.message.id, '--remote', '--no-encrypt', '--json'],
      {
        configDir: tempDir,
        env: { MORS_RELAY_BASE_URL: `http://127.0.0.1:${port}` },
      }
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('ok');
    expect(parsed.mode).toBe('remote');
    expect(parsed.message.id).toBe(sent.message.id);
    expect(parsed.message.read_at).toBeTruthy();
  });

  // ── Remote Ack ────────────────────────────────────────────────────

  it('ack --remote acknowledges a message through relay', async () => {
    // Pre-populate: Bob sends to Alice
    const sent = messageStore.send(BOB.userId, BOB.login, {
      recipientId: ALICE.userId,
      body: 'ack me via relay',
    });

    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());

    const result = await runCliAsync(['ack', sent.message.id, '--remote', '--json'], {
      configDir: tempDir,
      env: { MORS_RELAY_BASE_URL: `http://127.0.0.1:${port}` },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('acked');
    expect(parsed.mode).toBe('remote');
    expect(parsed.id).toBe(sent.message.id);
    expect(parsed.state).toBe('acked');
  });

  // ── Remote Reply ──────────────────────────────────────────────────

  it('reply --remote sends a reply through relay with causal linkage', async () => {
    // Pre-populate: Bob sends to Alice
    const sent = messageStore.send(BOB.userId, BOB.login, {
      recipientId: ALICE.userId,
      body: 'reply to this',
    });

    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());

    const result = await runCliAsync(
      [
        'reply',
        sent.message.id,
        '--to',
        String(BOB.userId),
        '--body',
        'relay reply',
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
    expect(parsed.status).toBe('replied');
    expect(parsed.mode).toBe('remote');
    expect(parsed.in_reply_to).toBe(sent.message.id);
    expect(parsed.thread_id).toBe(sent.message.thread_id);
  });

  // ── Read/Ack separation preserved in remote mode ──────────────────

  it('remote read does not ack; remote ack is separate', async () => {
    const sent = messageStore.send(BOB.userId, BOB.login, {
      recipientId: ALICE.userId,
      body: 'test read/ack separation',
    });

    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());

    // Read first (--no-encrypt for plaintext read path)
    const readResult = await runCliAsync(
      ['read', sent.message.id, '--remote', '--no-encrypt', '--json'],
      {
        configDir: tempDir,
        env: { MORS_RELAY_BASE_URL: `http://127.0.0.1:${port}` },
      }
    );

    const readParsed = JSON.parse(readResult.stdout);
    expect(readParsed.message.read_at).toBeTruthy();
    expect(readParsed.message.state).toBe('delivered'); // NOT acked
    expect(readParsed.message.acked_at).toBeNull();

    // Then ack
    const ackResult = await runCliAsync(['ack', sent.message.id, '--remote', '--json'], {
      configDir: tempDir,
      env: { MORS_RELAY_BASE_URL: `http://127.0.0.1:${port}` },
    });

    const ackParsed = JSON.parse(ackResult.stdout);
    expect(ackParsed.state).toBe('acked');
  });

  // ── Durable queue behavior in remote send ─────────────────────────

  it('send --remote queues offline when relay is unreachable', async () => {
    // Stop the server to simulate unreachable relay
    if (server) {
      await server.close();
      server = null;
    }

    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());

    const result = await runCliAsync(
      [
        'send',
        '--to',
        String(BOB.userId),
        '--body',
        'queued offline',
        '--remote',
        '--no-encrypt',
        '--json',
      ],
      {
        configDir: tempDir,
        env: {
          MORS_RELAY_BASE_URL: `http://127.0.0.1:${port}`,
        },
      }
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('queued');
    expect(parsed.mode).toBe('remote');
    expect(parsed.dedupe_key).toMatch(/^dup_/);
  });
});

// ── Fallback Guidance (local mode) ──────────────────────────────────

describe('CLI fallback guidance when remote prerequisites absent', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mors-cli-fallback-'));
    simulateInit(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('send --remote without MORS_RELAY_BASE_URL fails with actionable guidance', async () => {
    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());

    const result = await runCliAsync(
      ['send', '--to', '1002', '--body', 'test', '--remote', '--json'],
      {
        configDir: tempDir,
        env: {
          // No MORS_RELAY_BASE_URL set
        },
      }
    );

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('remote_unavailable');
    expect(parsed.message).toContain('MORS_RELAY_BASE_URL');
  });

  it('send --remote without authenticated session fails with login guidance', async () => {
    markAuthEnabled(tempDir);
    // No session saved → cleared/logged out

    const result = await runCliAsync(
      ['send', '--to', '1002', '--body', 'test', '--remote', '--json'],
      {
        configDir: tempDir,
        env: { MORS_RELAY_BASE_URL: 'http://127.0.0.1:3100' },
      }
    );

    expect(result.exitCode).not.toBe(0);
    const output = result.stdout;
    expect(output).toContain('not_authenticated');
    expect(output).toContain('mors login');
  });

  it('commands without --remote use local store (no relay needed)', async () => {
    // When user has never logged in, local mode works without relay
    // inbox will fail with store error (no DB), but NOT with relay/auth error
    const result = await runCliAsync(['inbox', '--json'], {
      configDir: tempDir,
    });

    // Should fail with store error, not relay error
    const output = result.stdout + result.stderr;
    expect(output).not.toContain('remote_unavailable');
    expect(output).not.toContain('MORS_RELAY_BASE_URL');
  });

  it('send without --remote falls back to local store even when authenticated', async () => {
    markAuthEnabled(tempDir);
    saveSession(tempDir, makeSession());

    // Without --remote, should try local store (which will fail with key/DB error
    // since we only simulated init, didn't create real DB)
    const result = await runCliAsync(['send', '--to', 'bob', '--body', 'local send', '--json'], {
      configDir: tempDir,
      env: { MORS_RELAY_BASE_URL: 'http://127.0.0.1:3100' },
    });

    // Should NOT contain remote mode indicators
    const output = result.stdout + result.stderr;
    expect(output).not.toContain('"mode":"remote"');
  });
});
