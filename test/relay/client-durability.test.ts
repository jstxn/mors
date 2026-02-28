/**
 * Tests for durable offline queue persistence, flush retry/backoff,
 * and CLI relay client wiring.
 *
 * Covers:
 * - VAL-RELAY-006: Offline queued sends survive process restart
 * - VAL-RELAY-007: Flush reconciliation retries transient failures with bounded backoff
 *
 * TDD: These tests are written before the implementation (red phase).
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { loadRelayConfig } from '../../src/relay/config.js';
import type { TokenVerifier, ParticipantStore } from '../../src/relay/auth-middleware.js';
import { RelayMessageStore } from '../../src/relay/message-store.js';
import {
  RelayClient,
  type OfflineQueueEntry,
  loadOfflineQueue,
  saveOfflineQueue,
} from '../../src/relay/client.js';

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

/** Find a random available port for test isolation. */
function getTestPort(): number {
  return 30000 + Math.floor(Math.random() * 10000);
}

/** Helper for authenticated relay requests (for direct verification). */
async function relayFetch(
  port: number,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
  } = {}
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return { status: res.status, body };
}

// ── Durable Offline Queue Persistence ───────────────────────────────

describe('durable offline queue persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mors-queue-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saveOfflineQueue writes entries to a JSON file', () => {
    const queuePath = join(tmpDir, 'offline-queue.json');
    const entries: OfflineQueueEntry[] = [
      {
        type: 'send',
        payload: {
          recipientId: BOB.userId,
          body: 'Persistent message',
          dedupeKey: 'dup_test-1',
        },
        queuedAt: new Date().toISOString(),
      },
    ];

    saveOfflineQueue(queuePath, entries);

    expect(existsSync(queuePath)).toBe(true);
    const raw = readFileSync(queuePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].payload.body).toBe('Persistent message');
  });

  it('loadOfflineQueue reads entries from a JSON file', () => {
    const queuePath = join(tmpDir, 'offline-queue.json');
    const entries: OfflineQueueEntry[] = [
      {
        type: 'send',
        payload: {
          recipientId: BOB.userId,
          body: 'Load test message',
          dedupeKey: 'dup_load-1',
        },
        queuedAt: new Date().toISOString(),
      },
    ];

    writeFileSync(queuePath, JSON.stringify(entries));

    const loaded = loadOfflineQueue(queuePath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].payload.body).toBe('Load test message');
    expect(loaded[0].payload.dedupeKey).toBe('dup_load-1');
  });

  it('loadOfflineQueue returns empty array for missing file', () => {
    const queuePath = join(tmpDir, 'nonexistent-queue.json');
    const loaded = loadOfflineQueue(queuePath);
    expect(loaded).toEqual([]);
  });

  it('loadOfflineQueue returns empty array for corrupt file', () => {
    const queuePath = join(tmpDir, 'corrupt-queue.json');
    writeFileSync(queuePath, 'not valid json {{{');

    const loaded = loadOfflineQueue(queuePath);
    expect(loaded).toEqual([]);
  });

  it('loadOfflineQueue returns empty array for non-array JSON', () => {
    const queuePath = join(tmpDir, 'bad-queue.json');
    writeFileSync(queuePath, JSON.stringify({ not: 'an array' }));

    const loaded = loadOfflineQueue(queuePath);
    expect(loaded).toEqual([]);
  });

  it('RelayClient with queueStorePath persists queued sends to disk', async () => {
    const queuePath = join(tmpDir, 'client-queue.json');

    const client = new RelayClient({
      baseUrl: 'http://127.0.0.1:99999', // unreachable
      token: ALICE.token,
      maxRetries: 0,
      initialRetryDelayMs: 1,
      requestTimeoutMs: 100,
      queueStorePath: queuePath,
    });

    await client.send({ recipientId: BOB.userId, body: 'Durable send 1' });
    await client.send({ recipientId: BOB.userId, body: 'Durable send 2' });

    expect(client.queueSize).toBe(2);

    // Queue file must exist on disk
    expect(existsSync(queuePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(queuePath, 'utf-8'));
    expect(persisted).toHaveLength(2);
    expect(persisted[0].payload.body).toBe('Durable send 1');
    expect(persisted[1].payload.body).toBe('Durable send 2');
  });

  it('new RelayClient with queueStorePath loads previously persisted queue', async () => {
    const queuePath = join(tmpDir, 'reload-queue.json');

    // First client — queue messages while offline
    const client1 = new RelayClient({
      baseUrl: 'http://127.0.0.1:99999',
      token: ALICE.token,
      maxRetries: 0,
      initialRetryDelayMs: 1,
      requestTimeoutMs: 100,
      queueStorePath: queuePath,
    });

    await client1.send({ recipientId: BOB.userId, body: 'Survives restart 1' });
    await client1.send({ recipientId: BOB.userId, body: 'Survives restart 2' });
    expect(client1.queueSize).toBe(2);

    // Simulate process restart — create a new client that loads the same queue file
    const client2 = new RelayClient({
      baseUrl: 'http://127.0.0.1:99999',
      token: ALICE.token,
      maxRetries: 0,
      initialRetryDelayMs: 1,
      requestTimeoutMs: 100,
      queueStorePath: queuePath,
    });

    // New client should have the queued entries from disk
    expect(client2.queueSize).toBe(2);
    const entries = client2.pendingEntries;
    expect(entries[0].payload.body).toBe('Survives restart 1');
    expect(entries[1].payload.body).toBe('Survives restart 2');
  });

  it('offline queued sends survive process restart and deliver after reconnect', async () => {
    const port = getTestPort();
    const messageStore = new RelayMessageStore();
    const config = loadRelayConfig({
      MORS_RELAY_PORT: String(port),
      MORS_RELAY_HOST: '127.0.0.1',
    });
    const participantStore: ParticipantStore = {
      async isParticipant(conversationId: string, githubUserId: number): Promise<boolean> {
        return messageStore.isParticipant(conversationId, githubUserId);
      },
    };

    const queuePath = join(tmpDir, 'restart-queue.json');

    // Client1 queues while offline (no server)
    const client1 = new RelayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: ALICE.token,
      maxRetries: 0,
      initialRetryDelayMs: 1,
      requestTimeoutMs: 100,
      queueStorePath: queuePath,
    });

    const r1 = await client1.send({ recipientId: BOB.userId, body: 'Restart msg 1' });
    const r2 = await client1.send({ recipientId: BOB.userId, body: 'Restart msg 2' });
    expect(r1.queued).toBe(true);
    expect(r2.queued).toBe(true);

    // Simulate restart — new client, same queue path
    const client2 = new RelayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: ALICE.token,
      maxRetries: 0,
      initialRetryDelayMs: 1,
      requestTimeoutMs: 5000,
      queueStorePath: queuePath,
    });

    expect(client2.queueSize).toBe(2);

    // Now start the server
    const server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: stubVerifier,
      participantStore,
      messageStore,
    });
    await server.start();

    try {
      // Flush from the new client
      const flushResult = await client2.flush();
      expect(flushResult.sent).toBe(2);
      expect(flushResult.failed).toBe(0);
      expect(client2.queueSize).toBe(0);

      // Verify messages arrived at recipient inbox
      const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
      const inbox = inboxRes.body as Record<string, unknown>;
      const messages = inbox['messages'] as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(2);
      const bodies = messages.map((m) => m['body']);
      expect(bodies).toContain('Restart msg 1');
      expect(bodies).toContain('Restart msg 2');
    } finally {
      await server.close();
    }
  });

  it('successful flush clears the persisted queue file', async () => {
    const port = getTestPort();
    const messageStore = new RelayMessageStore();
    const config = loadRelayConfig({
      MORS_RELAY_PORT: String(port),
      MORS_RELAY_HOST: '127.0.0.1',
    });
    const participantStore: ParticipantStore = {
      async isParticipant(conversationId: string, githubUserId: number): Promise<boolean> {
        return messageStore.isParticipant(conversationId, githubUserId);
      },
    };

    const queuePath = join(tmpDir, 'clear-queue.json');

    // Queue while offline
    const client = new RelayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: ALICE.token,
      maxRetries: 0,
      initialRetryDelayMs: 1,
      requestTimeoutMs: 100,
      queueStorePath: queuePath,
    });

    await client.send({ recipientId: BOB.userId, body: 'Clear test' });
    expect(existsSync(queuePath)).toBe(true);

    // Start server and flush
    const server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: stubVerifier,
      participantStore,
      messageStore,
    });
    await server.start();

    try {
      await client.flush();
      expect(client.queueSize).toBe(0);

      // The persisted queue should now be empty
      const persisted = JSON.parse(readFileSync(queuePath, 'utf-8'));
      expect(persisted).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

// ── Flush Retry with Bounded Backoff ────────────────────────────────

describe('flush reconciliation with retry and bounded backoff', () => {
  let server: RelayServer | null = null;
  let port: number;
  let messageStore: RelayMessageStore;

  beforeEach(async () => {
    port = getTestPort();
    messageStore = new RelayMessageStore();

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
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('flush retries transient failures for individual entries with backoff', async () => {
    const logs: string[] = [];

    // Queue entries via offline (stop server first)
    const client = new RelayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: ALICE.token,
      maxRetries: 0,
      initialRetryDelayMs: 1,
      requestTimeoutMs: 100,
      flushRetries: 3,
      flushRetryDelayMs: 10,
      flushRetryBackoffMultiplier: 2,
      logger: (msg) => logs.push(msg),
    });

    // Take server offline to queue
    if (server) await server.close();
    await client.send({ recipientId: BOB.userId, body: 'Flush with backoff' });
    expect(client.queueSize).toBe(1);

    // Bring server back
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

    // Flush should succeed
    const flushResult = await client.flush();
    expect(flushResult.sent).toBe(1);
    expect(flushResult.failed).toBe(0);
  });

  it('flush with flushRetries retries on transient failure and eventually delivers', async () => {
    const logs: string[] = [];
    const tmpDir = mkdtempSync(join(tmpdir(), 'mors-flush-retry-'));
    const queuePath = join(tmpDir, 'queue.json');

    try {
      // Pre-populate queue file with a queued entry
      const entries: OfflineQueueEntry[] = [
        {
          type: 'send',
          payload: {
            recipientId: BOB.userId,
            body: 'Flush retry backoff msg',
            dedupeKey: 'dup_flush-retry-1',
          },
          queuedAt: new Date().toISOString(),
        },
      ];
      saveOfflineQueue(queuePath, entries);

      let flushCount = 0;
      const flushClient = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE.token,
        maxRetries: 0,
        initialRetryDelayMs: 1,
        requestTimeoutMs: 5000,
        flushRetries: 3,
        flushRetryDelayMs: 10,
        flushRetryBackoffMultiplier: 2,
        logger: (msg) => logs.push(msg),
        queueStorePath: queuePath,
        fetchFn: (() => {
          return async (url: string | URL | Request, init?: RequestInit) => {
            flushCount++;
            if (flushCount === 1) {
              throw new TypeError('fetch failed');
            }
            return fetch(url, init);
          };
        })(),
      });

      expect(flushClient.queueSize).toBe(1);

      const flushResult = await flushClient.flush();
      expect(flushResult.sent).toBe(1);
      expect(flushResult.failed).toBe(0);
      expect(flushClient.queueSize).toBe(0);
      expect(flushCount).toBeGreaterThan(1); // Must have retried

      // Verify message delivered
      const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
      const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages).toHaveLength(1);
      expect(messages[0]['body']).toBe('Flush retry backoff msg');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('flush retry observes bounded backoff delays', async () => {
    const timestamps: number[] = [];
    const tmpDir = mkdtempSync(join(tmpdir(), 'mors-backoff-'));
    const queuePath = join(tmpDir, 'queue.json');

    try {
      const entries: OfflineQueueEntry[] = [
        {
          type: 'send',
          payload: {
            recipientId: BOB.userId,
            body: 'Backoff timing msg',
            dedupeKey: 'dup_backoff-timing',
          },
          queuedAt: new Date().toISOString(),
        },
      ];
      saveOfflineQueue(queuePath, entries);

      const client = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE.token,
        maxRetries: 0,
        initialRetryDelayMs: 1,
        requestTimeoutMs: 5000,
        flushRetries: 3,
        flushRetryDelayMs: 50,
        flushRetryBackoffMultiplier: 2,
        queueStorePath: queuePath,
        fetchFn: (() => {
          let count = 0;
          return async (url: string | URL | Request, init?: RequestInit) => {
            timestamps.push(Date.now());
            count++;
            if (count <= 2) {
              throw new TypeError('fetch failed');
            }
            return fetch(url, init);
          };
        })(),
      });

      const result = await client.flush();
      expect(result.sent).toBe(1);
      expect(timestamps.length).toBe(3); // initial + 2 retries

      // Check increasing delays
      const delay1 = timestamps[1] - timestamps[0];
      const delay2 = timestamps[2] - timestamps[1];

      expect(delay1).toBeGreaterThanOrEqual(30); // ~50ms
      expect(delay2).toBeGreaterThanOrEqual(60); // ~100ms (50*2)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('flush retry gives up after exhausting retries and keeps entry in queue', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mors-exhaust-'));
    const queuePath = join(tmpDir, 'queue.json');

    try {
      const entries: OfflineQueueEntry[] = [
        {
          type: 'send',
          payload: {
            recipientId: BOB.userId,
            body: 'Will not deliver',
            dedupeKey: 'dup_exhaust-1',
          },
          queuedAt: new Date().toISOString(),
        },
      ];
      saveOfflineQueue(queuePath, entries);

      const client = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE.token,
        maxRetries: 0,
        initialRetryDelayMs: 1,
        requestTimeoutMs: 5000,
        flushRetries: 2,
        flushRetryDelayMs: 10,
        flushRetryBackoffMultiplier: 2,
        queueStorePath: queuePath,
        fetchFn: async () => {
          throw new TypeError('always fails');
        },
      });

      expect(client.queueSize).toBe(1);

      const result = await client.flush();
      expect(result.sent).toBe(0);
      expect(result.failed).toBe(1);
      expect(client.queueSize).toBe(1);

      // Persisted queue should still have the entry
      const persisted = JSON.parse(readFileSync(queuePath, 'utf-8'));
      expect(persisted).toHaveLength(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('flush does not retry 4xx errors (non-transient)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mors-no-retry-'));
    const queuePath = join(tmpDir, 'queue.json');
    let fetchCount = 0;

    try {
      const entries: OfflineQueueEntry[] = [
        {
          type: 'send',
          payload: {
            recipientId: BOB.userId,
            body: 'Client error in flush',
            dedupeKey: 'dup_client-err',
          },
          queuedAt: new Date().toISOString(),
        },
      ];
      saveOfflineQueue(queuePath, entries);

      const client = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE.token,
        maxRetries: 0,
        initialRetryDelayMs: 1,
        requestTimeoutMs: 5000,
        flushRetries: 3,
        flushRetryDelayMs: 10,
        flushRetryBackoffMultiplier: 2,
        queueStorePath: queuePath,
        fetchFn: async () => {
          fetchCount++;
          return new Response(JSON.stringify({ error: 'bad_request' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      const result = await client.flush();
      expect(result.sent).toBe(0);
      expect(result.failed).toBe(1);
      // Should NOT have retried — only 1 fetch call
      expect(fetchCount).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
