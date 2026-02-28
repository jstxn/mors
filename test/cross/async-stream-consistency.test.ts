/**
 * Cross-surface consistency tests: async relay APIs vs realtime SSE stream.
 *
 * Validates:
 * - VAL-CROSS-002: Auth enforcement is consistent across async and realtime surfaces
 *   Invalid auth fails both relay APIs and SSE; valid auth succeeds both.
 * - VAL-CROSS-003: Retry/idempotency converges consistently across relay and stream
 *   Retries/replays converge to one logical outcome and both stream + inbox agree
 *   on final state.
 * - VAL-CROSS-004: Stream reconnect and inbox pull converge after interruption
 *   After interruption, resumed stream and inbox query converge to same complete state.
 *
 * Uses a real relay server with in-memory message store, controllable auth, and
 * raw HTTP to validate cross-surface behavioral consistency.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import {
  createRelayServer,
  type RelayServer,
  type RelayServerOptions,
} from '../../src/relay/server.js';
import { RelayMessageStore } from '../../src/relay/message-store.js';
import type { RelayConfig } from '../../src/relay/config.js';
import type { TokenVerifier, AuthPrincipal } from '../../src/relay/auth-middleware.js';

// ── Test helpers ─────────────────────────────────────────────────────

/** Minimal relay config for test use (port 0 for OS-assigned ephemeral). */
function testConfig(): RelayConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    baseUrl: undefined,
    githubClientId: undefined,
    githubScope: undefined,
    githubDeviceEndpoint: undefined,
    githubTokenEndpoint: undefined,
    authTokenIssuer: undefined,
    authAudience: undefined,
    diagnostics: [],
  };
}

/**
 * Create a controllable token verifier that can revoke tokens at any time.
 */
function controllableTokenVerifier(): {
  verifier: TokenVerifier;
  expireToken: (token: string) => void;
  restoreToken: (token: string, principal: AuthPrincipal) => void;
} {
  const principals = new Map<string, AuthPrincipal>([
    ['token-alice', { githubUserId: 1001, githubLogin: 'alice' }],
    ['token-bob', { githubUserId: 1002, githubLogin: 'bob' }],
  ]);

  const verifier: TokenVerifier = async (token: string) => {
    return principals.get(token) ?? null;
  };

  return {
    verifier,
    expireToken: (token: string) => principals.delete(token),
    restoreToken: (token: string, principal: AuthPrincipal) => principals.set(token, principal),
  };
}

/** Parse a raw SSE text chunk into structured events. */
interface SSEEvent {
  id?: string;
  event?: string;
  data?: string;
}

function parseSSEChunk(raw: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const blocks = raw.split('\n\n').filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const lines = block.split('\n');
    const isCommentOnly = lines.every((l) => l.startsWith(':') || l.trim() === '');
    if (isCommentOnly) continue;

    const event: SSEEvent = {};
    for (const line of lines) {
      if (line.startsWith(':')) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const field = line.slice(0, colonIdx);
      const value = line.slice(colonIdx + 1).trimStart();

      if (field === 'id') event.id = value;
      if (field === 'event') event.event = value;
      if (field === 'data') event.data = event.data ? event.data + '\n' + value : value;
    }
    if (event.event || event.data || event.id) {
      events.push(event);
    }
  }

  return events;
}

/** Parse the data field of an SSE event as JSON. */
function parseEventData(event: SSEEvent): Record<string, unknown> {
  expect(event.data).toBeDefined();
  return JSON.parse(event.data ?? '{}') as Record<string, unknown>;
}

/**
 * Open an SSE connection and collect events until a condition is met or timeout.
 */
function openSSE(
  port: number,
  token: string,
  opts?: { lastEventId?: string }
): {
  events: SSEEvent[];
  rawChunks: string[];
  statusCode: Promise<number>;
  headers: Promise<http.IncomingHttpHeaders>;
  close: () => void;
  waitForEvents: (count: number, timeoutMs?: number) => Promise<SSEEvent[]>;
  waitForEventType: (eventType: string, timeoutMs?: number) => Promise<SSEEvent>;
} {
  const events: SSEEvent[] = [];
  const rawChunks: string[] = [];
  let req: http.ClientRequest | null = null;
  let res: http.IncomingMessage | null = null;
  const eventWaiters: Array<{ count: number; resolve: (events: SSEEvent[]) => void }> = [];
  const typeWaiters: Array<{ eventType: string; resolve: (event: SSEEvent) => void }> = [];

  const reqHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'text/event-stream',
  };
  if (opts?.lastEventId) {
    reqHeaders['Last-Event-ID'] = opts.lastEventId;
  }

  let resolveStatus: (code: number) => void;
  let resolveHeaders: (h: http.IncomingHttpHeaders) => void;
  const statusCode = new Promise<number>((r) => {
    resolveStatus = r;
  });
  const headers = new Promise<http.IncomingHttpHeaders>((r) => {
    resolveHeaders = r;
  });

  function processEvents(parsed: SSEEvent[]): void {
    events.push(...parsed);

    for (let i = eventWaiters.length - 1; i >= 0; i--) {
      if (events.length >= eventWaiters[i].count) {
        eventWaiters[i].resolve([...events]);
        eventWaiters.splice(i, 1);
      }
    }

    for (const evt of parsed) {
      for (let i = typeWaiters.length - 1; i >= 0; i--) {
        if (evt.event === typeWaiters[i].eventType) {
          typeWaiters[i].resolve(evt);
          typeWaiters.splice(i, 1);
        }
      }
    }
  }

  req = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/events',
      method: 'GET',
      headers: reqHeaders,
    },
    (response) => {
      res = response;
      resolveStatus(response.statusCode ?? 0);
      resolveHeaders(response.headers);

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        rawChunks.push(chunk);
        const parsed = parseSSEChunk(chunk);
        processEvents(parsed);
      });
    }
  );

  req.on('error', () => {});
  req.end();

  function close(): void {
    if (res) res.destroy();
    if (req) req.destroy();
  }

  function waitForEvents(count: number, timeoutMs = 5000): Promise<SSEEvent[]> {
    if (events.length >= count) {
      return Promise.resolve([...events]);
    }
    return new Promise<SSEEvent[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for ${count} SSE events (got ${events.length} within ${timeoutMs}ms). ` +
              `Events: ${JSON.stringify(events)}`
          )
        );
      }, timeoutMs);

      eventWaiters.push({
        count,
        resolve: (evts) => {
          clearTimeout(timer);
          resolve(evts);
        },
      });
    });
  }

  function waitForEventType(eventType: string, timeoutMs = 5000): Promise<SSEEvent> {
    const found = events.find((e) => e.event === eventType);
    if (found) return Promise.resolve(found);

    return new Promise<SSEEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for event type "${eventType}" within ${timeoutMs}ms. ` +
              `Events so far: ${JSON.stringify(events)}`
          )
        );
      }, timeoutMs);

      typeWaiters.push({
        eventType,
        resolve: (evt) => {
          clearTimeout(timer);
          resolve(evt);
        },
      });
    });
  }

  return { events, rawChunks, statusCode, headers, close, waitForEvents, waitForEventType };
}

/** Make a raw HTTP request and return the response. */
function rawRequest(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** Helper for authenticated relay requests (higher-level). */
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

// ── Test suite ───────────────────────────────────────────────────────

describe('cross-surface async/stream consistency', () => {
  // ═══════════════════════════════════════════════════════════════════
  // VAL-CROSS-002: Auth enforcement is consistent across async and
  //                realtime surfaces
  // ═══════════════════════════════════════════════════════════════════

  describe('VAL-CROSS-002: auth enforcement consistent across async APIs and SSE', () => {
    let server: RelayServer;
    let messageStore: RelayMessageStore;
    let tokenControl: ReturnType<typeof controllableTokenVerifier>;

    beforeEach(async () => {
      messageStore = new RelayMessageStore();
      tokenControl = controllableTokenVerifier();
      const opts: RelayServerOptions = {
        logger: () => {},
        tokenVerifier: tokenControl.verifier,
        participantStore: {
          async isParticipant(conversationId: string, userId: number) {
            return messageStore.isParticipant(conversationId, userId);
          },
        },
        messageStore,
        sseAuthRevalidateMs: 200,
      };
      server = createRelayServer(testConfig(), opts);
      await server.start();
    });

    afterEach(async () => {
      await server.close();
    });

    it('missing auth returns 401 on both /messages POST and /events GET', async () => {
      // Async API: POST /messages without auth
      const sendResp = await rawRequest(server.port, '/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_id: 1002, body: 'No auth' }),
      });
      expect(sendResp.statusCode).toBe(401);

      // SSE: GET /events without auth
      const sseResp = await rawRequest(server.port, '/events', {
        headers: { Accept: 'text/event-stream' },
      });
      expect(sseResp.statusCode).toBe(401);
    });

    it('invalid token returns 401 on both /inbox GET and /events GET', async () => {
      // Async API: GET /inbox with invalid token
      const inboxResp = await rawRequest(server.port, '/inbox', {
        headers: { Authorization: 'Bearer invalid-garbage-token' },
      });
      expect(inboxResp.statusCode).toBe(401);

      // SSE: GET /events with invalid token
      const sseResp = await rawRequest(server.port, '/events', {
        headers: {
          Authorization: 'Bearer invalid-garbage-token',
          Accept: 'text/event-stream',
        },
      });
      expect(sseResp.statusCode).toBe(401);
    });

    it('expired token returns 401 on both async APIs and SSE initial connect', async () => {
      // Expire Alice's token
      tokenControl.expireToken('token-alice');

      // Async API: POST /messages with expired token
      const sendResp = await rawRequest(server.port, '/messages', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-alice',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ recipient_id: 1002, body: 'Expired auth' }),
      });
      expect(sendResp.statusCode).toBe(401);

      // Async API: GET /inbox with expired token
      const inboxResp = await rawRequest(server.port, '/inbox', {
        headers: { Authorization: 'Bearer token-alice' },
      });
      expect(inboxResp.statusCode).toBe(401);

      // SSE: GET /events with expired token
      const sseResp = await rawRequest(server.port, '/events', {
        headers: {
          Authorization: 'Bearer token-alice',
          Accept: 'text/event-stream',
        },
      });
      expect(sseResp.statusCode).toBe(401);
    });

    it('valid auth succeeds on both async APIs and SSE', async () => {
      // Async API: POST /messages with valid token
      const sendResp = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: 1002, body: 'Valid auth test' },
      });
      expect(sendResp.status).toBe(201);

      // Async API: GET /inbox with valid token
      const inboxResp = await relayFetch(server.port, '/inbox', {
        token: 'token-bob',
      });
      expect(inboxResp.status).toBe(200);

      // SSE: GET /events with valid token succeeds
      const sse = openSSE(server.port, 'token-alice');
      try {
        const status = await sse.statusCode;
        expect(status).toBe(200);
        const evts = await sse.waitForEvents(1);
        expect(evts[0].event).toBe('connected');
      } finally {
        sse.close();
      }
    });

    it('mid-stream auth expiry on SSE is consistent with subsequent API rejection', async () => {
      // Start SSE stream with valid token
      const sse = openSSE(server.port, 'token-alice');
      try {
        const status = await sse.statusCode;
        expect(status).toBe(200);
        await sse.waitForEvents(1); // connected

        // Expire token mid-stream
        tokenControl.expireToken('token-alice');

        // SSE should get auth_expired event
        const authEvt = await sse.waitForEventType('auth_expired', 3000);
        expect(authEvt.event).toBe('auth_expired');

        // Now async APIs should also reject with 401
        const sendResp = await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: 1002, body: 'After expiry' },
        });
        expect(sendResp.status).toBe(401);

        const inboxResp = await relayFetch(server.port, '/inbox', {
          token: 'token-alice',
        });
        expect(inboxResp.status).toBe(401);
      } finally {
        sse.close();
      }
    });

    it('token restoration after expiry restores both async API and SSE access', async () => {
      // Expire Alice's token
      tokenControl.expireToken('token-alice');

      // Both should fail
      const sendFail = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: 1002, body: 'Should fail' },
      });
      expect(sendFail.status).toBe(401);

      const sseFail = await rawRequest(server.port, '/events', {
        headers: {
          Authorization: 'Bearer token-alice',
          Accept: 'text/event-stream',
        },
      });
      expect(sseFail.statusCode).toBe(401);

      // Restore token
      tokenControl.restoreToken('token-alice', { githubUserId: 1001, githubLogin: 'alice' });

      // Both should succeed
      const sendOk = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: 1002, body: 'After restore' },
      });
      expect(sendOk.status).toBe(201);

      const sse = openSSE(server.port, 'token-alice');
      try {
        const status = await sse.statusCode;
        expect(status).toBe(200);
      } finally {
        sse.close();
      }
    });

    it('read/ack API and SSE enforce the same auth boundary', async () => {
      // Create a message with valid auth
      const sendResp = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-bob',
        body: { recipient_id: 1001, body: 'Auth boundary test' },
      });
      expect(sendResp.status).toBe(201);
      const msgId = (sendResp.body as Record<string, unknown>)['id'] as string;

      // Expire Alice's token
      tokenControl.expireToken('token-alice');

      // Read and ack should fail with 401
      const readResp = await relayFetch(server.port, `/messages/${msgId}/read`, {
        method: 'POST',
        token: 'token-alice',
      });
      expect(readResp.status).toBe(401);

      const ackResp = await relayFetch(server.port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: 'token-alice',
      });
      expect(ackResp.status).toBe(401);

      // SSE should also fail
      const sseResp = await rawRequest(server.port, '/events', {
        headers: {
          Authorization: 'Bearer token-alice',
          Accept: 'text/event-stream',
        },
      });
      expect(sseResp.statusCode).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // VAL-CROSS-003: Retry/idempotency converges consistently across
  //                relay and stream
  // ═══════════════════════════════════════════════════════════════════

  describe('VAL-CROSS-003: retry/idempotency convergence across relay and stream', () => {
    let server: RelayServer;
    let messageStore: RelayMessageStore;

    beforeEach(async () => {
      messageStore = new RelayMessageStore();
      const opts: RelayServerOptions = {
        logger: () => {},
        tokenVerifier: async (token: string) => {
          const map: Record<string, AuthPrincipal> = {
            'token-alice': { githubUserId: 1001, githubLogin: 'alice' },
            'token-bob': { githubUserId: 1002, githubLogin: 'bob' },
          };
          return map[token] ?? null;
        },
        participantStore: {
          async isParticipant(conversationId: string, userId: number) {
            return messageStore.isParticipant(conversationId, userId);
          },
        },
        messageStore,
      };
      server = createRelayServer(testConfig(), opts);
      await server.start();
    });

    afterEach(async () => {
      await server.close();
    });

    it('deduped send produces exactly one stream event and one inbox message', async () => {
      // Open SSE stream for Bob (recipient) to observe events
      const sseBob = openSSE(server.port, 'token-bob');
      try {
        await sseBob.waitForEvents(1); // connected

        const dedupeKey = 'cross-dup-send-01';

        // Send twice with same dedupe key
        const send1 = await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: 1002, body: 'Deduped message', dedupe_key: dedupeKey },
        });
        expect(send1.status).toBe(201);

        const send2 = await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: 1002, body: 'Deduped message', dedupe_key: dedupeKey },
        });
        expect(send2.status).toBe(200); // idempotent

        // Both return same canonical message ID
        const msg1 = send1.body as Record<string, unknown>;
        const msg2 = send2.body as Record<string, unknown>;
        expect(msg1['id']).toBe(msg2['id']);

        // Wait for events — only 1 message_created should arrive (not 2)
        await sseBob.waitForEvents(2); // connected + 1 message_created
        await new Promise((r) => setTimeout(r, 200)); // wait for potential duplicates
        const msgEvents = sseBob.events.filter((e) => e.event === 'message_created');
        expect(msgEvents.length).toBe(1);

        // Verify stream event message_id matches the canonical message
        const evtData = parseEventData(msgEvents[0]);
        expect(evtData.message_id).toBe(msg1['id']);

        // Inbox also shows exactly one message
        const inboxResp = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
        const inbox = inboxResp.body as Record<string, unknown>;
        const messages = inbox['messages'] as Array<Record<string, unknown>>;
        expect(messages.length).toBe(1);
        expect(messages[0]['id']).toBe(msg1['id']);
      } finally {
        sseBob.close();
      }
    });

    it('deduped reply produces exactly one stream event and maintains thread consistency', async () => {
      // Open SSE for Alice (sender of root, recipient of reply)
      const sseAlice = openSSE(server.port, 'token-alice');
      try {
        await sseAlice.waitForEvents(1); // connected

        // Send root message from Alice to Bob
        const root = await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: 1002, body: 'Root for reply dedupe' },
        });
        const rootMsg = root.body as Record<string, unknown>;
        const rootMsgId = rootMsg['id'] as string;
        const rootThreadId = rootMsg['thread_id'] as string;

        // Wait for the message_created event on Alice's stream
        await sseAlice.waitForEvents(2);

        const replyKey = 'cross-dup-reply-01';

        // Bob replies twice with same dedupe key
        const reply1 = await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-bob',
          body: {
            recipient_id: 1001,
            body: 'Deduped reply',
            in_reply_to: rootMsgId,
            dedupe_key: replyKey,
          },
        });
        expect(reply1.status).toBe(201);

        const reply2 = await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-bob',
          body: {
            recipient_id: 1001,
            body: 'Deduped reply',
            in_reply_to: rootMsgId,
            dedupe_key: replyKey,
          },
        });
        expect(reply2.status).toBe(200);

        // Same canonical reply
        const r1 = reply1.body as Record<string, unknown>;
        const r2 = reply2.body as Record<string, unknown>;
        expect(r1['id']).toBe(r2['id']);
        expect(r1['thread_id']).toBe(rootThreadId);

        // Only one reply_created event on Alice's stream
        await sseAlice.waitForEvents(3); // connected + message_created + reply_created
        await new Promise((r) => setTimeout(r, 200));
        const replyEvents = sseAlice.events.filter((e) => e.event === 'reply_created');
        expect(replyEvents.length).toBe(1);

        // Verify thread_id and in_reply_to in stream event
        const evtData = parseEventData(replyEvents[0]);
        expect(evtData.thread_id).toBe(rootThreadId);
        expect(evtData.in_reply_to).toBe(rootMsgId);
        expect(evtData.message_id).toBe(r1['id']);
      } finally {
        sseAlice.close();
      }
    });

    it('idempotent ack produces exactly one stream ack event and consistent inbox state', async () => {
      // Open SSE for both Alice (sender) and Bob (recipient)
      const sseAlice = openSSE(server.port, 'token-alice');
      const sseBob = openSSE(server.port, 'token-bob');
      try {
        await sseAlice.waitForEvents(1);
        await sseBob.waitForEvents(1);

        // Send message from Alice to Bob
        const sendResp = await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: 1002, body: 'Ack idempotency test' },
        });
        const msgId = (sendResp.body as Record<string, unknown>)['id'] as string;

        // Wait for message_created on both streams
        await sseAlice.waitForEvents(2);
        await sseBob.waitForEvents(2);

        // Bob acks twice
        const ack1 = await relayFetch(server.port, `/messages/${msgId}/ack`, {
          method: 'POST',
          token: 'token-bob',
        });
        expect(ack1.status).toBe(200);
        expect((ack1.body as Record<string, unknown>)['first_ack']).toBe(true);

        const ack2 = await relayFetch(server.port, `/messages/${msgId}/ack`, {
          method: 'POST',
          token: 'token-bob',
        });
        expect(ack2.status).toBe(200);
        expect((ack2.body as Record<string, unknown>)['first_ack']).toBe(false);

        // Wait for ack event on streams
        await sseAlice.waitForEvents(3); // connected + message_created + message_acked
        await sseBob.waitForEvents(3);

        // Exactly one ack event on each stream
        await new Promise((r) => setTimeout(r, 200));
        const aliceAckEvents = sseAlice.events.filter((e) => e.event === 'message_acked');
        const bobAckEvents = sseBob.events.filter((e) => e.event === 'message_acked');
        expect(aliceAckEvents.length).toBe(1);
        expect(bobAckEvents.length).toBe(1);

        // Both streams agree on the same ack event ID and message_id
        const aliceAckData = parseEventData(aliceAckEvents[0]);
        const bobAckData = parseEventData(bobAckEvents[0]);
        expect(aliceAckData.message_id).toBe(msgId);
        expect(bobAckData.message_id).toBe(msgId);
        expect(aliceAckEvents[0].id).toBe(bobAckEvents[0].id);

        // Inbox confirms acked state
        const inboxResp = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
        const messages = (inboxResp.body as Record<string, unknown>)['messages'] as Array<
          Record<string, unknown>
        >;
        const ackedMsg = messages.find((m) => m['id'] === msgId);
        expect(ackedMsg).toBeDefined();
        expect(ackedMsg?.['state']).toBe('acked');
        expect(ackedMsg?.['acked_at']).not.toBeNull();
      } finally {
        sseAlice.close();
        sseBob.close();
      }
    });

    it('idempotent read produces exactly one stream read event and consistent inbox state', async () => {
      const sseBob = openSSE(server.port, 'token-bob');
      try {
        await sseBob.waitForEvents(1);

        // Send message from Alice to Bob
        const sendResp = await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: 1002, body: 'Read idempotency test' },
        });
        const msgId = (sendResp.body as Record<string, unknown>)['id'] as string;
        await sseBob.waitForEvents(2);

        // Bob reads twice
        const read1 = await relayFetch(server.port, `/messages/${msgId}/read`, {
          method: 'POST',
          token: 'token-bob',
        });
        expect((read1.body as Record<string, unknown>)['first_read']).toBe(true);

        const read2 = await relayFetch(server.port, `/messages/${msgId}/read`, {
          method: 'POST',
          token: 'token-bob',
        });
        expect((read2.body as Record<string, unknown>)['first_read']).toBe(false);

        // Exactly one read event on stream
        await sseBob.waitForEvents(3); // connected + message_created + message_read
        await new Promise((r) => setTimeout(r, 200));
        const readEvents = sseBob.events.filter((e) => e.event === 'message_read');
        expect(readEvents.length).toBe(1);

        // Inbox confirms read_at is set, state still delivered
        const inboxResp = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
        const messages = (inboxResp.body as Record<string, unknown>)['messages'] as Array<
          Record<string, unknown>
        >;
        const readMsg = messages.find((m) => m['id'] === msgId);
        expect(readMsg).toBeDefined();
        expect(readMsg?.['read_at']).not.toBeNull();
        expect(readMsg?.['state']).toBe('delivered'); // read does not imply ack
      } finally {
        sseBob.close();
      }
    });

    it('full send+read+ack lifecycle produces consistent stream events and inbox state', async () => {
      const sseBob = openSSE(server.port, 'token-bob');
      try {
        await sseBob.waitForEvents(1);

        // Send
        const sendResp = await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: 1002, body: 'Full lifecycle' },
        });
        const msgId = (sendResp.body as Record<string, unknown>)['id'] as string;
        await sseBob.waitForEvents(2); // connected + message_created

        // Read
        await relayFetch(server.port, `/messages/${msgId}/read`, {
          method: 'POST',
          token: 'token-bob',
        });
        await sseBob.waitForEvents(3); // + message_read

        // Ack
        await relayFetch(server.port, `/messages/${msgId}/ack`, {
          method: 'POST',
          token: 'token-bob',
        });
        await sseBob.waitForEvents(4); // + message_acked

        // Verify stream event sequence
        const nonConnected = sseBob.events.filter((e) => e.event !== 'connected');
        expect(nonConnected.length).toBe(3);
        expect(nonConnected[0].event).toBe('message_created');
        expect(nonConnected[1].event).toBe('message_read');
        expect(nonConnected[2].event).toBe('message_acked');

        // All events reference the same message
        for (const evt of nonConnected) {
          const data = parseEventData(evt);
          expect(data.message_id).toBe(msgId);
        }

        // Inbox shows final converged state
        const inboxResp = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
        const messages = (inboxResp.body as Record<string, unknown>)['messages'] as Array<
          Record<string, unknown>
        >;
        const finalMsg = messages.find((m) => m['id'] === msgId);
        expect(finalMsg).toBeDefined();
        expect(finalMsg?.['state']).toBe('acked');
        expect(finalMsg?.['read_at']).not.toBeNull();
        expect(finalMsg?.['acked_at']).not.toBeNull();
      } finally {
        sseBob.close();
      }
    });

    it('multiple deduped sends + ack retries produce clean convergent state', async () => {
      const sseAlice = openSSE(server.port, 'token-alice');
      const sseBob = openSSE(server.port, 'token-bob');
      try {
        await sseAlice.waitForEvents(1);
        await sseBob.waitForEvents(1);

        const key = 'cross-multi-retry';

        // 3 send retries with same dedupe key
        for (let i = 0; i < 3; i++) {
          await relayFetch(server.port, '/messages', {
            method: 'POST',
            token: 'token-alice',
            body: { recipient_id: 1002, body: 'Multi-retry', dedupe_key: key },
          });
        }

        // Wait for events
        await sseBob.waitForEvents(2); // connected + 1 message_created
        await new Promise((r) => setTimeout(r, 200));

        const bobMsgEvents = sseBob.events.filter((e) => e.event === 'message_created');
        expect(bobMsgEvents.length).toBe(1);
        const msgId = parseEventData(bobMsgEvents[0]).message_id as string;

        // 3 ack retries
        for (let i = 0; i < 3; i++) {
          await relayFetch(server.port, `/messages/${msgId}/ack`, {
            method: 'POST',
            token: 'token-bob',
          });
        }

        await sseBob.waitForEvents(3); // + message_acked
        await new Promise((r) => setTimeout(r, 200));

        const bobAckEvents = sseBob.events.filter((e) => e.event === 'message_acked');
        expect(bobAckEvents.length).toBe(1);

        // Inbox: one message, acked
        const inboxResp = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
        const messages = (inboxResp.body as Record<string, unknown>)['messages'] as Array<
          Record<string, unknown>
        >;
        expect(messages.length).toBe(1);
        expect(messages[0]['state']).toBe('acked');

        // Alice's stream also agrees
        await sseAlice.waitForEvents(3); // connected + message_created + message_acked
        const aliceMsgEvents = sseAlice.events.filter((e) => e.event === 'message_created');
        const aliceAckEvents = sseAlice.events.filter((e) => e.event === 'message_acked');
        expect(aliceMsgEvents.length).toBe(1);
        expect(aliceAckEvents.length).toBe(1);
      } finally {
        sseAlice.close();
        sseBob.close();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // VAL-CROSS-004: Stream reconnect and inbox pull converge after
  //                interruption
  // ═══════════════════════════════════════════════════════════════════

  describe('VAL-CROSS-004: stream reconnect and inbox pull converge after interruption', () => {
    let server: RelayServer;
    let messageStore: RelayMessageStore;

    beforeEach(async () => {
      messageStore = new RelayMessageStore();
      const opts: RelayServerOptions = {
        logger: () => {},
        tokenVerifier: async (token: string) => {
          const map: Record<string, AuthPrincipal> = {
            'token-alice': { githubUserId: 1001, githubLogin: 'alice' },
            'token-bob': { githubUserId: 1002, githubLogin: 'bob' },
          };
          return map[token] ?? null;
        },
        participantStore: {
          async isParticipant(conversationId: string, userId: number) {
            return messageStore.isParticipant(conversationId, userId);
          },
        },
        messageStore,
      };
      server = createRelayServer(testConfig(), opts);
      await server.start();
    });

    afterEach(async () => {
      await server.close();
    });

    it('after disconnect, resumed stream and inbox converge to same messages', async () => {
      // Phase 1: connect, receive initial event, disconnect
      const sse1 = openSSE(server.port, 'token-bob');
      try {
        await sse1.waitForEvents(1); // connected

        // Send message while connected
        await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: 1002, body: 'Before disconnect' },
        });
        await sse1.waitForEvents(2); // connected + message_created
        const lastEventId = sse1.events[sse1.events.length - 1].id;

        // Disconnect
        sse1.close();

        // Phase 2: events happen while disconnected
        await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: 1002, body: 'During disconnect 1' },
        });
        await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: 1002, body: 'During disconnect 2' },
        });

        // Phase 3: reconnect with cursor
        const sse2 = openSSE(server.port, 'token-bob', { lastEventId });
        try {
          // Should get connected + 2 replayed message_created events
          const evts = await sse2.waitForEvents(3);
          const msgEvents = evts.filter((e) => e.event === 'message_created');
          expect(msgEvents.length).toBe(2);

          // Collect message IDs from stream
          const streamMsgIds = new Set(
            msgEvents.map((e) => parseEventData(e).message_id as string)
          );

          // Phase 4: verify inbox shows same messages
          const inboxResp = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
          const inbox = inboxResp.body as Record<string, unknown>;
          const messages = inbox['messages'] as Array<Record<string, unknown>>;

          // Inbox should have all 3 messages (1 before disconnect + 2 during)
          expect(messages.length).toBe(3);

          // The 2 messages from the disconnect period should match stream
          const inboxMsgIds = new Set(messages.map((m) => m['id'] as string));
          for (const streamId of streamMsgIds) {
            expect(inboxMsgIds.has(streamId)).toBe(true);
          }
        } finally {
          sse2.close();
        }
      } finally {
        sse1.close();
      }
    });

    it('interrupted mid-sequence: read+ack events replay correctly and match inbox state', async () => {
      // Setup: create a message
      const sendResp = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: 1002, body: 'Interrupted lifecycle' },
      });
      const msgId = (sendResp.body as Record<string, unknown>)['id'] as string;

      // Phase 1: Bob connects, sees the message_created event, then disconnects
      const sse1 = openSSE(server.port, 'token-bob');
      try {
        await sse1.waitForEvents(1); // connected
        // The message was created before connection, so no event (deterministic startup).
        // We need to note the connected event cursor.
        const connectedId = sse1.events[0].id;
        sse1.close();

        // Phase 2: during disconnect, Bob reads and acks via API
        await relayFetch(server.port, `/messages/${msgId}/read`, {
          method: 'POST',
          token: 'token-bob',
        });
        await relayFetch(server.port, `/messages/${msgId}/ack`, {
          method: 'POST',
          token: 'token-bob',
        });

        // Phase 3: Bob reconnects — should see the message_created, message_read, message_acked events
        // (The message was created before sse1 connected so it wouldn't have a create event.
        // But read and ack happened AFTER the connected cursor, so they should replay.)
        // Wait — the message was created BEFORE sse1 connected, so message_created was in the log
        // but happened before connection. Let me re-check: the message was sent to the store,
        // which appended a stream event. The sse1 connected and got a connected cursor at that point.
        // Since the message was created before connection, the event is before the cursor.
        // But read and ack happened after sse1 disconnected, so they are after the cursor.
        const sse2 = openSSE(server.port, 'token-bob', { lastEventId: connectedId });
        try {
          // Should see: connected + message_read + message_acked
          const evts = await sse2.waitForEvents(3);
          const nonConnected = evts.filter((e) => e.event !== 'connected');
          expect(nonConnected.length).toBe(2);
          expect(nonConnected[0].event).toBe('message_read');
          expect(nonConnected[1].event).toBe('message_acked');

          // All reference the correct message
          for (const evt of nonConnected) {
            expect(parseEventData(evt).message_id).toBe(msgId);
          }

          // Inbox shows the same converged state
          const inboxResp = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
          const messages = (inboxResp.body as Record<string, unknown>)['messages'] as Array<
            Record<string, unknown>
          >;
          const msg = messages.find((m) => m['id'] === msgId);
          expect(msg).toBeDefined();
          expect(msg?.['state']).toBe('acked');
          expect(msg?.['read_at']).not.toBeNull();
          expect(msg?.['acked_at']).not.toBeNull();
        } finally {
          sse2.close();
        }
      } finally {
        sse1.close();
      }
    });

    it('multiple interruptions: final stream state converges with inbox', async () => {
      // Phase 1: Bob connects, Alice sends msg 1
      const sse1 = openSSE(server.port, 'token-bob');
      let lastCursor: string | undefined;
      try {
        await sse1.waitForEvents(1); // connected

        await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: 1002, body: 'Message 1' },
        });

        await sse1.waitForEvents(2); // connected + message_created
        lastCursor = sse1.events[sse1.events.length - 1].id;
        sse1.close();
      } finally {
        sse1.close();
      }

      // Phase 2: Alice sends msg 2 during first disconnect
      await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: 1002, body: 'Message 2' },
      });

      // Phase 3: Bob reconnects, catches up, then disconnects again
      const sse2 = openSSE(server.port, 'token-bob', { lastEventId: lastCursor });
      try {
        // connected + message_created (msg 2 catch-up)
        await sse2.waitForEvents(2);
        lastCursor = sse2.events[sse2.events.length - 1].id;
        sse2.close();
      } finally {
        sse2.close();
      }

      // Phase 4: Alice sends msg 3 during second disconnect
      await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: 1002, body: 'Message 3' },
      });

      // Phase 5: Bob reconnects final time
      const sse3 = openSSE(server.port, 'token-bob', { lastEventId: lastCursor });
      try {
        // connected + message_created (msg 3 catch-up)
        await sse3.waitForEvents(2);

        // Collect all message IDs from this final stream catch-up
        const msg3Events = sse3.events.filter((e) => e.event === 'message_created');
        expect(msg3Events.length).toBe(1);
        const streamMsg3Id = parseEventData(msg3Events[0]).message_id;

        // Inbox should show all 3 messages
        const inboxResp = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
        const messages = (inboxResp.body as Record<string, unknown>)['messages'] as Array<
          Record<string, unknown>
        >;
        expect(messages.length).toBe(3);

        // The message from the last catch-up should be in inbox
        const inboxIds = messages.map((m) => m['id']);
        expect(inboxIds).toContain(streamMsg3Id);
      } finally {
        sse3.close();
      }
    });

    it('stream reconnect after reply + ack during disconnect shows full thread state matching inbox', async () => {
      // Setup: Alice sends root to Bob
      const rootResp = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: 1002, body: 'Root message' },
      });
      const rootMsg = rootResp.body as Record<string, unknown>;
      const rootId = rootMsg['id'] as string;
      const rootThreadId = rootMsg['thread_id'] as string;

      // Bob connects and gets the connected event (root was created before)
      const sse1 = openSSE(server.port, 'token-bob');
      try {
        await sse1.waitForEvents(1); // connected
        const cursor = sse1.events[0].id;
        sse1.close();

        // While disconnected: Bob reads, acks, and Alice sends a reply
        await relayFetch(server.port, `/messages/${rootId}/read`, {
          method: 'POST',
          token: 'token-bob',
        });
        await relayFetch(server.port, `/messages/${rootId}/ack`, {
          method: 'POST',
          token: 'token-bob',
        });

        // Alice replies in the same thread
        const replyResp = await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: {
            recipient_id: 1002,
            body: 'Reply during disconnect',
            in_reply_to: rootId,
          },
        });
        const replyId = (replyResp.body as Record<string, unknown>)['id'] as string;

        // Bob reconnects
        const sse2 = openSSE(server.port, 'token-bob', { lastEventId: cursor });
        try {
          // Should see: connected + message_read + message_acked + reply_created
          const evts = await sse2.waitForEvents(4);
          const nonConnected = evts.filter((e) => e.event !== 'connected');
          expect(nonConnected.length).toBe(3);
          expect(nonConnected[0].event).toBe('message_read');
          expect(nonConnected[1].event).toBe('message_acked');
          expect(nonConnected[2].event).toBe('reply_created');

          // Verify thread consistency in stream events
          for (const evt of nonConnected) {
            const data = parseEventData(evt);
            expect(data.thread_id).toBe(rootThreadId);
          }

          // Verify reply event has correct in_reply_to
          const replyEvtData = parseEventData(nonConnected[2]);
          expect(replyEvtData.in_reply_to).toBe(rootId);
          expect(replyEvtData.message_id).toBe(replyId);

          // Inbox shows both messages with correct states
          const inboxResp = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
          const messages = (inboxResp.body as Record<string, unknown>)['messages'] as Array<
            Record<string, unknown>
          >;

          const root = messages.find((m) => m['id'] === rootId);
          expect(root).toBeDefined();
          expect(root?.['state']).toBe('acked');
          expect(root?.['read_at']).not.toBeNull();

          const reply = messages.find((m) => m['id'] === replyId);
          expect(reply).toBeDefined();
          expect(reply?.['thread_id']).toBe(rootThreadId);
          expect(reply?.['in_reply_to']).toBe(rootId);
        } finally {
          sse2.close();
        }
      } finally {
        sse1.close();
      }
    });

    it('stream event IDs from catch-up are stable for client-side dedup against inbox', async () => {
      // Bob connects, receives events, disconnects, reconnects — replayed event IDs are stable
      const sse1 = openSSE(server.port, 'token-bob');
      try {
        await sse1.waitForEvents(1); // connected
        const connectedCursor = sse1.events[0].id;

        // Alice sends a message
        await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: 1002, body: 'Event ID stability' },
        });

        await sse1.waitForEvents(2); // connected + message_created
        const originalEventId = sse1.events[1].id;
        const originalMsgId = parseEventData(sse1.events[1]).message_id;
        sse1.close();

        // Reconnect from the connected cursor — will replay the message_created event
        const sse2 = openSSE(server.port, 'token-bob', { lastEventId: connectedCursor });
        try {
          await sse2.waitForEvents(2); // connected + replayed message_created
          const replayedEvt = sse2.events.find((e) => e.event === 'message_created');
          expect(replayedEvt).toBeDefined();

          // Same event ID as original — enables client-side dedup
          expect(replayedEvt?.id).toBe(originalEventId);

          // Same message ID — matches what inbox would show
          expect(replayedEvt).toBeDefined();
          const replayedMsgId = parseEventData(replayedEvt as SSEEvent).message_id;
          expect(replayedMsgId).toBe(originalMsgId);

          // Inbox agrees on the same message
          const inboxResp = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
          const messages = (inboxResp.body as Record<string, unknown>)['messages'] as Array<
            Record<string, unknown>
          >;
          expect(messages.length).toBe(1);
          expect(messages[0]['id']).toBe(originalMsgId);
        } finally {
          sse2.close();
        }
      } finally {
        sse1.close();
      }
    });

    it('reconnect with connected-event cursor after replay does not produce avoidable duplicate replay', async () => {
      // Edge case: A client reconnects with a cursor, receives replayed events.
      // If it disconnects and reconnects using the connected event ID from the
      // replay session, those replayed events should NOT be re-sent.
      // This tests that the connected event cursor is registered after replay delivery.

      // Phase 1: Create initial connection and events
      const sse1 = openSSE(server.port, 'token-bob');
      try {
        await sse1.waitForEvents(1); // connected
        const cursor1 = sse1.events[0].id;

        // Alice sends 2 messages
        await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: 1002, body: 'Msg A' },
        });
        await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: 1002, body: 'Msg B' },
        });

        await sse1.waitForEvents(3); // connected + 2 events
        sse1.close();

        // Phase 2: Another event while disconnected
        await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: 1002, body: 'Msg C (during disconnect)' },
        });

        // Phase 3: Reconnect with cursor1 → replays A, B, C
        const sse2 = openSSE(server.port, 'token-bob', { lastEventId: cursor1 });
        try {
          await sse2.waitForEvents(4); // connected + 3 replayed
          const connected2Id = sse2.events.find((e) => e.event === 'connected')?.id;
          expect(connected2Id).toBeDefined();

          const replayed = sse2.events.filter((e) => e.event === 'message_created');
          expect(replayed.length).toBe(3);
          sse2.close();

          // Phase 4: Reconnect using connected2Id as cursor
          // Should NOT re-replay A, B, C
          const sse3 = openSSE(server.port, 'token-bob', { lastEventId: connected2Id });
          try {
            await sse3.waitForEvents(1); // connected only
            await new Promise((r) => setTimeout(r, 200));
            const nonConnected = sse3.events.filter((e) => e.event !== 'connected');
            expect(nonConnected.length).toBe(0);

            // Inbox still shows all 3 messages (complete view)
            const inboxResp = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
            const messages = (inboxResp.body as Record<string, unknown>)['messages'] as Array<
              Record<string, unknown>
            >;
            expect(messages.length).toBe(3);
          } finally {
            sse3.close();
          }
        } finally {
          sse2.close();
        }
      } finally {
        sse1.close();
      }
    });

    it('live events after catch-up continue to converge with inbox queries', async () => {
      // Bob connects, gets initial events, disconnects
      const sse1 = openSSE(server.port, 'token-bob');
      try {
        await sse1.waitForEvents(1);
        const cursor = sse1.events[0].id;

        // Send while connected
        await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: 1002, body: 'Before disconnect' },
        });
        await sse1.waitForEvents(2);
        sse1.close();

        // Send during disconnect
        await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: 1002, body: 'During disconnect' },
        });

        // Reconnect
        const sse2 = openSSE(server.port, 'token-bob', { lastEventId: cursor });
        try {
          // connected + replayed 'Before disconnect' + replayed 'During disconnect'
          await sse2.waitForEvents(3);

          // Now send a live event after reconnect
          await relayFetch(server.port, '/messages', {
            method: 'POST',
            token: 'token-alice',
            body: { recipient_id: 1002, body: 'After reconnect (live)' },
          });
          await sse2.waitForEvents(4); // + live message_created

          // Collect all message IDs from stream
          const allStreamMsgIds = sse2.events
            .filter((e) => e.event === 'message_created')
            .map((e) => parseEventData(e).message_id as string);
          expect(allStreamMsgIds.length).toBe(3);

          // Inbox should show all 3 messages
          const inboxResp = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
          const messages = (inboxResp.body as Record<string, unknown>)['messages'] as Array<
            Record<string, unknown>
          >;
          expect(messages.length).toBe(3);

          // All stream message IDs present in inbox
          const inboxIds = new Set(messages.map((m) => m['id'] as string));
          for (const streamId of allStreamMsgIds) {
            expect(inboxIds.has(streamId)).toBe(true);
          }
        } finally {
          sse2.close();
        }
      } finally {
        sse1.close();
      }
    });
  });
});
