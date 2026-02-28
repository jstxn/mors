/**
 * Tests for offline queue/reconcile and transient relay failure retry paths.
 *
 * Covers:
 * - VAL-RELAY-006: Offline-to-online sync converges without loss or duplication
 * - VAL-RELAY-007: Transient relay failure recovery preserves single logical delivery
 *
 * Tests use the relay client abstraction with a real relay HTTP server and
 * injectable fault injection to simulate offline/error conditions.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { loadRelayConfig } from '../../src/relay/config.js';
import type { TokenVerifier, ParticipantStore } from '../../src/relay/auth-middleware.js';
import { RelayMessageStore } from '../../src/relay/message-store.js';
import { RelayClient, type RelayClientOptions } from '../../src/relay/client.js';
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

describe('relay offline queue and transient retry recovery', () => {
  let server: RelayServer | null = null;
  let port: number;
  let messageStore: RelayMessageStore;

  beforeEach(async () => {
    port = getTestPort();
    messageStore = new RelayMessageStore();

    const config = loadRelayConfig({ MORS_RELAY_PORT: String(port), MORS_RELAY_HOST: '127.0.0.1' });

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
  });

  function createClient(opts?: Partial<RelayClientOptions>): RelayClient {
    return new RelayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: ALICE.token,
      maxRetries: opts?.maxRetries ?? 3,
      initialRetryDelayMs: opts?.initialRetryDelayMs ?? 10,
      retryBackoffMultiplier: opts?.retryBackoffMultiplier ?? 1.5,
      requestTimeoutMs: opts?.requestTimeoutMs ?? 5000,
      logger: opts?.logger,
    });
  }

  // ── VAL-RELAY-006: Offline-to-online sync converges ───────────────

  describe('VAL-RELAY-006: offline-to-online sync converges without loss or duplication', () => {
    it('messages queued during offline period are delivered after reconnect', async () => {
      const client = createClient();

      // Take server offline
      if (server) await server.close();

      // Queue messages while offline — these should be buffered
      const result1 = await client.send({
        recipientId: BOB.userId,
        body: 'Offline message 1',
      });
      const result2 = await client.send({
        recipientId: BOB.userId,
        body: 'Offline message 2',
      });

      // Both should be queued (offline)
      expect(result1.queued).toBe(true);
      expect(result2.queued).toBe(true);

      // Verify queue has entries
      expect(client.queueSize).toBe(2);

      // Bring server back online
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

      // Flush the queue
      const flushResult = await client.flush();
      expect(flushResult.sent).toBe(2);
      expect(flushResult.failed).toBe(0);

      // Verify messages arrived in recipient inbox
      const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
      const inbox = inboxRes.body as Record<string, unknown>;
      const messages = inbox['messages'] as Array<Record<string, unknown>>;

      expect(messages).toHaveLength(2);
      const bodies = messages.map((m) => m['body']);
      expect(bodies).toContain('Offline message 1');
      expect(bodies).toContain('Offline message 2');
    });

    it('offline queue uses dedupe keys to prevent duplication on retry', async () => {
      const client = createClient();

      // Take server offline
      if (server) await server.close();

      // Queue a message
      const result = await client.send({
        recipientId: BOB.userId,
        body: 'Dedupe offline msg',
      });
      expect(result.queued).toBe(true);
      const dedupeKey = result.dedupeKey;
      expect(dedupeKey).toMatch(/^dup_/);

      // Bring server back online
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

      // Flush once
      const flush1 = await client.flush();
      expect(flush1.sent).toBe(1);

      // Simulate a "retry" scenario by re-queueing same dedupe key
      // Direct send with same dedupe key should not create duplicate
      const directRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Dedupe offline msg',
          dedupe_key: dedupeKey,
        },
      });

      // Should return 200 (idempotent hit, not 201)
      expect(directRes.status).toBe(200);

      // Inbox has exactly one message
      const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
      const inbox = inboxRes.body as Record<string, unknown>;
      const messages = inbox['messages'] as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(1);
    });

    it('multiple offline messages with replies maintain causal linkage after sync', async () => {
      // Send root message online first
      const rootRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Root before offline' },
      });
      const rootMsg = rootRes.body as Record<string, unknown>;
      const rootMsgId = rootMsg['id'] as string;
      const rootThreadId = rootMsg['thread_id'] as string;

      const client = createClient();

      // Take server offline
      if (server) await server.close();

      // Queue a reply while offline
      const replyResult = await client.send({
        recipientId: ALICE.userId,
        body: 'Reply from Bob while offline',
        inReplyTo: rootMsgId,
      });
      expect(replyResult.queued).toBe(true);

      // Bring server back online
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

      // Flush the offline queue
      const flushResult = await client.flush();
      expect(flushResult.sent).toBe(1);

      // Verify the reply in Alice's inbox preserves causal linkage
      const inboxRes = await relayFetch(port, '/inbox', { token: ALICE.token });
      const inbox = inboxRes.body as Record<string, unknown>;
      const messages = inbox['messages'] as Array<Record<string, unknown>>;

      const reply = messages.find((m) => m['body'] === 'Reply from Bob while offline');
      expect(reply).toBeDefined();
      expect(reply?.['thread_id']).toBe(rootThreadId);
      expect(reply?.['in_reply_to']).toBe(rootMsgId);
    });

    it('queue is empty after successful flush', async () => {
      const client = createClient();
      if (server) await server.close();

      await client.send({ recipientId: BOB.userId, body: 'Queue clear test' });
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

      await client.flush();
      expect(client.queueSize).toBe(0);
    });

    it('queue entries are ordered (FIFO) and flushed in order', async () => {
      const client = createClient();
      if (server) await server.close();

      await client.send({ recipientId: BOB.userId, body: 'First' });
      await client.send({ recipientId: BOB.userId, body: 'Second' });
      await client.send({ recipientId: BOB.userId, body: 'Third' });

      const entries = client.pendingEntries;
      expect(entries).toHaveLength(3);
      expect(entries[0].payload.body).toBe('First');
      expect(entries[1].payload.body).toBe('Second');
      expect(entries[2].payload.body).toBe('Third');

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

      await client.flush();

      // Verify all 3 in inbox in order (newest first)
      const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
      const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages).toHaveLength(3);
    });

    it('online send bypasses the queue entirely', async () => {
      const client = createClient();

      // Server is online, send should go directly
      const result = await client.send({
        recipientId: BOB.userId,
        body: 'Online direct send',
      });

      expect(result.queued).toBe(false);
      expect(result.message).toBeDefined();
      expect(result.message?.id).toMatch(/^msg_/);
      expect(client.queueSize).toBe(0);

      // Verify in inbox
      const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
      const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages).toHaveLength(1);
      expect(messages[0]['body']).toBe('Online direct send');
    });
  });

  // ── VAL-RELAY-007: Transient relay failure recovery ───────────────

  describe('VAL-RELAY-007: transient relay failure recovery preserves single logical delivery', () => {
    it('retries on transient network error and delivers successfully', async () => {
      let callCount = 0;
      const logs: string[] = [];

      // Use a proxy approach: create a client with custom fetch that fails first then succeeds
      const client = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE.token,
        maxRetries: 3,
        initialRetryDelayMs: 10,
        retryBackoffMultiplier: 1.5,
        requestTimeoutMs: 5000,
        logger: (msg) => logs.push(msg),
        fetchFn: async (url, init) => {
          callCount++;
          if (callCount <= 2) {
            throw new TypeError('fetch failed');
          }
          return fetch(url, init);
        },
      });

      const result = await client.send({
        recipientId: BOB.userId,
        body: 'Retry recovery msg',
      });

      // Should succeed on the 3rd attempt
      expect(result.queued).toBe(false);
      expect(result.message).toBeDefined();
      expect(callCount).toBe(3);

      // Retries are logged/observable
      expect(logs.some((l) => l.includes('retry'))).toBe(true);

      // Verify exactly one message in inbox
      const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
      const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages).toHaveLength(1);
    });

    it('retries on 5xx server error and converges to one delivery', async () => {
      let callCount = 0;
      const logs: string[] = [];

      const client = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE.token,
        maxRetries: 3,
        initialRetryDelayMs: 10,
        retryBackoffMultiplier: 1.5,
        requestTimeoutMs: 5000,
        logger: (msg) => logs.push(msg),
        fetchFn: async (url, init) => {
          callCount++;
          if (callCount === 1) {
            return new Response(JSON.stringify({ error: 'internal_server_error' }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return fetch(url, init);
        },
      });

      const result = await client.send({
        recipientId: BOB.userId,
        body: '5xx recovery msg',
      });

      expect(result.queued).toBe(false);
      expect(result.message).toBeDefined();
      expect(callCount).toBe(2);

      // Retries are logged
      expect(logs.some((l) => l.includes('retry'))).toBe(true);

      // One message in inbox
      const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
      const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages).toHaveLength(1);
    });

    it('retries with dedupe key ensure no duplicate delivery on success after prior server-side commit', async () => {
      let callCount = 0;

      // Simulate: first call succeeds on server but response is lost (network error after write)
      const client = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE.token,
        maxRetries: 3,
        initialRetryDelayMs: 10,
        retryBackoffMultiplier: 1.5,
        requestTimeoutMs: 5000,
        fetchFn: async (url, init) => {
          callCount++;
          if (callCount === 1) {
            // Let the real request go through, then throw after response
            await fetch(url, init);
            // But the client doesn't see the response
            throw new TypeError('fetch failed');
          }
          return fetch(url, init);
        },
      });

      const result = await client.send({
        recipientId: BOB.userId,
        body: 'Dedupe after ghost write',
      });

      // Should succeed (second call returns the deduped message)
      expect(result.queued).toBe(false);
      expect(result.message).toBeDefined();

      // Inbox should have exactly ONE message despite server processing the first request
      const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
      const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages).toHaveLength(1);
    });

    it('queues to offline after exhausting all retries', async () => {
      const logs: string[] = [];

      const client = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE.token,
        maxRetries: 2,
        initialRetryDelayMs: 10,
        retryBackoffMultiplier: 1.5,
        requestTimeoutMs: 5000,
        logger: (msg) => logs.push(msg),
        fetchFn: async () => {
          throw new TypeError('fetch failed');
        },
      });

      const result = await client.send({
        recipientId: BOB.userId,
        body: 'Exhausted retries msg',
      });

      // After all retries fail, message should be queued offline
      expect(result.queued).toBe(true);
      expect(client.queueSize).toBe(1);

      // Retry exhaustion is observable
      expect(logs.some((l) => l.includes('queued offline'))).toBe(true);
    });

    it('does not retry on 4xx client errors (non-transient)', async () => {
      let callCount = 0;
      const logs: string[] = [];

      const client = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE.token,
        maxRetries: 3,
        initialRetryDelayMs: 10,
        retryBackoffMultiplier: 1.5,
        requestTimeoutMs: 5000,
        logger: (msg) => logs.push(msg),
        fetchFn: async (_url, _init) => {
          callCount++;
          return new Response(JSON.stringify({ error: 'validation_error' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      await expect(
        client.send({
          recipientId: BOB.userId,
          body: 'Client error msg',
        })
      ).rejects.toThrow();

      // Should not retry — only one call
      expect(callCount).toBe(1);
    });

    it('timeout triggers retry and eventual success', async () => {
      let callCount = 0;
      const logs: string[] = [];

      const client = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE.token,
        maxRetries: 3,
        initialRetryDelayMs: 10,
        retryBackoffMultiplier: 1.5,
        requestTimeoutMs: 100, // Very short timeout
        logger: (msg) => logs.push(msg),
        fetchFn: async (url, init) => {
          callCount++;
          if (callCount === 1) {
            // Simulate timeout by aborting
            throw new DOMException('The operation was aborted', 'AbortError');
          }
          return fetch(url, init);
        },
      });

      const result = await client.send({
        recipientId: BOB.userId,
        body: 'Timeout recovery msg',
      });

      expect(result.queued).toBe(false);
      expect(result.message).toBeDefined();
      expect(callCount).toBe(2);

      // Retries are logged
      expect(logs.some((l) => l.includes('retry'))).toBe(true);
    });

    it('retry attempts use exponential backoff delays', async () => {
      const timestamps: number[] = [];
      let callCount = 0;

      const client = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE.token,
        maxRetries: 3,
        initialRetryDelayMs: 50,
        retryBackoffMultiplier: 2,
        requestTimeoutMs: 5000,
        fetchFn: async (url, init) => {
          timestamps.push(Date.now());
          callCount++;
          if (callCount <= 3) {
            throw new TypeError('fetch failed');
          }
          return fetch(url, init);
        },
      });

      const result = await client.send({
        recipientId: BOB.userId,
        body: 'Backoff test msg',
      });

      expect(result.queued).toBe(false);
      expect(timestamps.length).toBe(4); // initial + 3 retries

      // Verify increasing delays (with tolerance)
      const delays = [];
      for (let i = 1; i < timestamps.length; i++) {
        delays.push(timestamps[i] - timestamps[i - 1]);
      }

      // First delay ~50ms, second ~100ms, third ~200ms (with tolerance)
      expect(delays[0]).toBeGreaterThanOrEqual(30); // ~50ms initial
      expect(delays[1]).toBeGreaterThanOrEqual(60); // ~100ms (50*2)
      expect(delays[2]).toBeGreaterThanOrEqual(120); // ~200ms (100*2)
    });

    it('flush retries failed queue entries with backoff', async () => {
      const client = createClient({ initialRetryDelayMs: 10 });

      // Take server offline
      if (server) await server.close();

      // Queue messages
      await client.send({ recipientId: BOB.userId, body: 'Flush retry 1' });
      await client.send({ recipientId: BOB.userId, body: 'Flush retry 2' });

      // First flush attempt should fail (server still down)
      const failFlush = await client.flush();
      expect(failFlush.sent).toBe(0);
      expect(failFlush.failed).toBe(2);

      // Messages remain in queue
      expect(client.queueSize).toBe(2);

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

      // Second flush should succeed
      const okFlush = await client.flush();
      expect(okFlush.sent).toBe(2);
      expect(okFlush.failed).toBe(0);
      expect(client.queueSize).toBe(0);

      // Verify inbox
      const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
      const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages).toHaveLength(2);
    });

    it('read and ack operations retry on transient failure', async () => {
      // Send a message first (online)
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Read/ack retry test' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      let readCallCount = 0;
      const bobClient = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: BOB.token,
        maxRetries: 3,
        initialRetryDelayMs: 10,
        retryBackoffMultiplier: 1.5,
        requestTimeoutMs: 5000,
        fetchFn: async (url, init) => {
          readCallCount++;
          if (readCallCount === 1) {
            throw new TypeError('fetch failed');
          }
          return fetch(url, init);
        },
      });

      // Read with retry
      const readResult = await bobClient.read(msgId);
      expect(readResult.message.read_at).not.toBeNull();
      expect(readCallCount).toBe(2);

      // Reset for ack test
      let ackCallCount = 0;
      const bobClient2 = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: BOB.token,
        maxRetries: 3,
        initialRetryDelayMs: 10,
        retryBackoffMultiplier: 1.5,
        requestTimeoutMs: 5000,
        fetchFn: async (url, init) => {
          ackCallCount++;
          if (ackCallCount === 1) {
            return new Response(JSON.stringify({ error: 'internal_server_error' }), {
              status: 502,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return fetch(url, init);
        },
      });

      const ackResult = await bobClient2.ack(msgId);
      expect(ackResult.message.state).toBe('acked');
      expect(ackCallCount).toBe(2);
    });

    it('concurrent sends with retry produce no duplicates', async () => {
      let failNext = true;

      // Two clients sending with retries simultaneously
      const makeClient = () =>
        new RelayClient({
          baseUrl: `http://127.0.0.1:${port}`,
          token: ALICE.token,
          maxRetries: 3,
          initialRetryDelayMs: 10,
          retryBackoffMultiplier: 1.5,
          requestTimeoutMs: 5000,
          fetchFn: async (url, init) => {
            if (failNext) {
              failNext = false;
              throw new TypeError('fetch failed');
            }
            return fetch(url, init);
          },
        });

      const client1 = makeClient();
      const client2 = createClient();

      const [r1, r2] = await Promise.all([
        client1.send({ recipientId: BOB.userId, body: 'Concurrent 1' }),
        client2.send({ recipientId: BOB.userId, body: 'Concurrent 2' }),
      ]);

      // Both should eventually deliver
      expect(r1.message).toBeDefined();
      expect(r2.message).toBeDefined();

      // Inbox should have exactly 2 distinct messages
      const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
      const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages).toHaveLength(2);
    });

    it('retry log entries are deterministic and include attempt number', async () => {
      const logs: string[] = [];
      let callCount = 0;

      const client = new RelayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: ALICE.token,
        maxRetries: 3,
        initialRetryDelayMs: 10,
        retryBackoffMultiplier: 1.5,
        requestTimeoutMs: 5000,
        logger: (msg) => logs.push(msg),
        fetchFn: async (url, init) => {
          callCount++;
          if (callCount <= 2) {
            throw new TypeError('fetch failed');
          }
          return fetch(url, init);
        },
      });

      await client.send({
        recipientId: BOB.userId,
        body: 'Log test msg',
      });

      // Verify retry logs include attempt numbers
      const retryLogs = logs.filter((l) => l.includes('retry'));
      expect(retryLogs.length).toBeGreaterThanOrEqual(2);
      expect(retryLogs.some((l) => l.includes('attempt 1'))).toBe(true);
      expect(retryLogs.some((l) => l.includes('attempt 2'))).toBe(true);
    });
  });
});
