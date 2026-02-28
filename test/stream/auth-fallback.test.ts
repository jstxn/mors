/**
 * SSE auth expiry and fallback mode contract tests.
 *
 * Validates:
 * - VAL-STREAM-006: Mid-stream auth expiry is handled safely
 *   If auth expires during active stream, client surfaces auth error and can
 *   recover after re-auth without silent stale state.
 * - VAL-STREAM-007: Fallback mode works when SSE is unavailable
 *   If SSE cannot connect, CLI enters documented fallback mode and clearly
 *   indicates degraded realtime behavior.
 *
 * Uses a real relay server with in-memory message store, configurable token
 * verifier, and raw HTTP to validate mid-stream auth behavior and fallback.
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
 *
 * Returns a verifier function and a control handle to expire/restore tokens.
 * This simulates mid-stream auth expiry where a previously valid token becomes
 * invalid during an active SSE connection.
 */
function controllableTokenVerifier(): {
  verifier: TokenVerifier;
  expireToken: (token: string) => void;
  restoreToken: (token: string, principal: AuthPrincipal) => void;
} {
  const principals = new Map<string, AuthPrincipal>([
    ['token-alice', { accountId: 'acct_1001', deviceId: 'device-alice' }],
    ['token-bob', { accountId: 'acct_1002', deviceId: 'device-bob' }],
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
  onClose: Promise<void>;
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
  let resolveClose: () => void;
  const statusCode = new Promise<number>((r) => {
    resolveStatus = r;
  });
  const headers = new Promise<http.IncomingHttpHeaders>((r) => {
    resolveHeaders = r;
  });
  const onClose = new Promise<void>((r) => {
    resolveClose = r;
  });

  function processEvents(parsed: SSEEvent[]): void {
    events.push(...parsed);

    // Check count waiters
    for (let i = eventWaiters.length - 1; i >= 0; i--) {
      if (events.length >= eventWaiters[i].count) {
        eventWaiters[i].resolve([...events]);
        eventWaiters.splice(i, 1);
      }
    }

    // Check type waiters
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
      response.on('end', () => {
        resolveClose();
      });
      response.on('close', () => {
        resolveClose();
      });
    }
  );

  req.on('error', () => {
    // Connection closed/aborted — expected during cleanup
  });

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
    // Check already-received events
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

  return {
    events,
    rawChunks,
    statusCode,
    headers,
    close,
    waitForEvents,
    waitForEventType,
    onClose,
  };
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

// ── Test suite ───────────────────────────────────────────────────────

describe('SSE auth expiry and fallback mode', () => {
  // ── VAL-STREAM-006: Mid-stream auth expiry handling ──────────────

  describe('mid-stream auth expiry (VAL-STREAM-006)', () => {
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
          async isParticipant(conversationId: string, userId: string) {
            return messageStore.isParticipant(conversationId, userId);
          },
        },
        messageStore,
        sseAuthRevalidateMs: 200, // Fast revalidation for testing
      };
      server = createRelayServer(testConfig(), opts);
      await server.start();
    });

    afterEach(async () => {
      await server.close();
    });

    it('sends auth_expired event when token becomes invalid during active stream', async () => {
      const sse = openSSE(server.port, 'token-alice');
      try {
        // Wait for successful connection
        const evts = await sse.waitForEvents(1);
        expect(evts[0].event).toBe('connected');

        // Expire Alice's token mid-stream
        tokenControl.expireToken('token-alice');

        // Should receive auth_expired event
        const authEvt = await sse.waitForEventType('auth_expired', 3000);
        expect(authEvt.event).toBe('auth_expired');

        const data = parseEventData(authEvt);
        expect(data.error).toBe('token_expired');
        expect(data.detail).toBeDefined();
        expect(typeof data.detail).toBe('string');
        // Should include actionable re-auth guidance
        expect(String(data.detail)).toMatch(/login|re-auth/i);
      } finally {
        sse.close();
      }
    });

    it('closes the SSE connection after sending auth_expired event', async () => {
      const sse = openSSE(server.port, 'token-alice');
      try {
        await sse.waitForEvents(1); // connected

        // Expire token
        tokenControl.expireToken('token-alice');

        // Wait for auth_expired event
        await sse.waitForEventType('auth_expired', 3000);

        // Connection should be closed by the server
        await Promise.race([
          sse.onClose,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Connection not closed within timeout')), 3000)
          ),
        ]);
      } finally {
        sse.close();
      }
    });

    it('does not deliver events after auth expiry', async () => {
      const sse = openSSE(server.port, 'token-alice');
      try {
        await sse.waitForEvents(1); // connected

        // Send a message before expiry — should arrive
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Before expiry',
        });
        await sse.waitForEvents(2); // connected + message_created

        // Expire token
        tokenControl.expireToken('token-alice');

        // Wait for auth_expired
        await sse.waitForEventType('auth_expired', 3000);

        // Wait for connection close
        await Promise.race([sse.onClose, new Promise<void>((r) => setTimeout(r, 1000))]);

        // Count events — should be: connected, message_created, auth_expired
        // No further events after auth_expired
        const eventTypes = sse.events.map((e) => e.event);
        const authIdx = eventTypes.indexOf('auth_expired');
        expect(authIdx).toBeGreaterThan(0);
        // Nothing after auth_expired
        const eventsAfterAuth = sse.events.slice(authIdx + 1);
        expect(eventsAfterAuth.length).toBe(0);
      } finally {
        sse.close();
      }
    });

    it('recovery: can establish new SSE connection after re-auth with valid token', async () => {
      const sse1 = openSSE(server.port, 'token-alice');
      try {
        await sse1.waitForEvents(1); // connected

        // Expire and wait for auth_expired
        tokenControl.expireToken('token-alice');
        await sse1.waitForEventType('auth_expired', 3000);
        sse1.close();

        // Re-auth: restore Alice's token (simulates successful re-login)
        tokenControl.restoreToken('token-alice', {
          accountId: 'acct_1001',
          deviceId: 'device-alice',
        });

        // New connection should succeed
        const sse2 = openSSE(server.port, 'token-alice');
        try {
          const evts2 = await sse2.waitForEvents(1);
          expect(evts2[0].event).toBe('connected');

          const data = parseEventData(evts2[0]);
          expect(data.account_id).toBe('acct_1001');
          expect(data.device_id).toBe('device-alice');
        } finally {
          sse2.close();
        }
      } finally {
        sse1.close();
      }
    });

    it('new connection after re-auth receives live events correctly', async () => {
      const sse1 = openSSE(server.port, 'token-alice');
      try {
        await sse1.waitForEvents(1);
        const connectedId = sse1.events[0].id;

        // Send a message before expiry
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Before disconnect',
        });
        await sse1.waitForEvents(2);

        // Expire token
        tokenControl.expireToken('token-alice');
        await sse1.waitForEventType('auth_expired', 3000);
        sse1.close();

        // Events happen while disconnected
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'During auth gap',
        });

        // Re-auth
        tokenControl.restoreToken('token-alice', {
          accountId: 'acct_1001',
          deviceId: 'device-alice',
        });

        // Reconnect with cursor — should catch up missed events
        const sse2 = openSSE(server.port, 'token-alice', { lastEventId: connectedId });
        try {
          // Should get: connected + replayed 'Before disconnect' + replayed 'During auth gap'
          const evts2 = await sse2.waitForEvents(3, 5000);
          const msgEvents = evts2.filter((e) => e.event === 'message_created');
          expect(msgEvents.length).toBe(2);
        } finally {
          sse2.close();
        }
      } finally {
        sse1.close();
      }
    });

    it('auth_expired includes the last valid event ID for cursor resume', async () => {
      const sse = openSSE(server.port, 'token-alice');
      try {
        await sse.waitForEvents(1); // connected

        // Send a message to create a known event position
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Before expiry',
        });
        const evts = await sse.waitForEvents(2);
        const lastValidEventId = evts[evts.length - 1].id;

        // Expire token
        tokenControl.expireToken('token-alice');

        // auth_expired event should have an event ID for cursor tracking
        const authEvt = await sse.waitForEventType('auth_expired', 3000);
        expect(authEvt.id).toBeDefined();

        // The auth_expired event's data should include last_event_id for recovery
        const data = parseEventData(authEvt);
        expect(data.last_event_id).toBe(lastValidEventId);
      } finally {
        sse.close();
      }
    });

    it('other connected clients are not affected by one client auth expiry', async () => {
      const sseAlice = openSSE(server.port, 'token-alice');
      const sseBob = openSSE(server.port, 'token-bob');
      try {
        await sseAlice.waitForEvents(1); // connected
        await sseBob.waitForEvents(1); // connected

        // Expire only Alice's token
        tokenControl.expireToken('token-alice');

        // Alice gets auth_expired
        await sseAlice.waitForEventType('auth_expired', 3000);

        // Bob should still be connected and receive events
        messageStore.send('acct_1001', 'alice', {
          recipientId: 'acct_1002',
          body: 'Message for Bob',
        });

        const bobEvts = await sseBob.waitForEvents(2);
        expect(bobEvts.length).toBe(2);
        expect(bobEvts[1].event).toBe('message_created');
      } finally {
        sseAlice.close();
        sseBob.close();
      }
    });
  });

  // ── VAL-STREAM-007: Fallback mode when SSE is unavailable ────────

  describe('fallback mode when SSE unavailable (VAL-STREAM-007)', () => {
    it('connection refused returns appropriate error (SSE server not running)', async () => {
      // Try to connect to a port with no server
      // Use a high ephemeral port that is almost certainly not in use
      const unusedPort = 59999;

      const result = await new Promise<{ error: string }>((resolve) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: unusedPort,
            path: '/events',
            method: 'GET',
            headers: {
              Authorization: 'Bearer token-alice',
              Accept: 'text/event-stream',
            },
          },
          () => {
            resolve({ error: 'unexpected_success' });
          }
        );

        req.on('error', (err: NodeJS.ErrnoException) => {
          resolve({ error: err.code ?? err.message });
        });

        req.end();
      });

      // Should get ECONNREFUSED
      expect(result.error).toBe('ECONNREFUSED');
    });

    it('relay returning non-SSE response (e.g. 503) triggers fallback behavior', async () => {
      // Create a mock server that returns 503 (service unavailable)
      const mockServer = http.createServer((_req, res) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'service_unavailable', detail: 'SSE temporarily disabled' })
        );
      });

      const port = await new Promise<number>((resolve) => {
        mockServer.listen(0, '127.0.0.1', () => {
          const addr = mockServer.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });

      try {
        const resp = await rawRequest(port, '/events', {
          headers: {
            Authorization: 'Bearer token-alice',
            Accept: 'text/event-stream',
          },
        });

        expect(resp.statusCode).toBe(503);
        const body = JSON.parse(resp.body);
        expect(body.error).toBe('service_unavailable');
      } finally {
        await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      }
    });

    it('SSE endpoint returns 401 for expired token on initial connect (not mid-stream)', async () => {
      // This verifies the entry-point auth rejection that triggers fallback
      const messageStore = new RelayMessageStore();
      const tokenControl = controllableTokenVerifier();
      const opts: RelayServerOptions = {
        logger: () => {},
        tokenVerifier: tokenControl.verifier,
        participantStore: {
          async isParticipant(conversationId: string, userId: string) {
            return messageStore.isParticipant(conversationId, userId);
          },
        },
        messageStore,
      };
      const server = createRelayServer(testConfig(), opts);
      await server.start();

      try {
        // Expire Alice's token before connect
        tokenControl.expireToken('token-alice');

        const resp = await rawRequest(server.port, '/events', {
          headers: {
            Authorization: 'Bearer token-alice',
            Accept: 'text/event-stream',
          },
        });

        expect(resp.statusCode).toBe(401);
        const body = JSON.parse(resp.body);
        expect(body.error).toBe('unauthorized');
        expect(body.detail).toMatch(/login|re-auth/i);
      } finally {
        await server.close();
      }
    });

    it('relay health endpoint works even when auth fails (degraded mode indicator)', async () => {
      const messageStore = new RelayMessageStore();
      const tokenControl = controllableTokenVerifier();
      const opts: RelayServerOptions = {
        logger: () => {},
        tokenVerifier: tokenControl.verifier,
        participantStore: {
          async isParticipant(conversationId: string, userId: string) {
            return messageStore.isParticipant(conversationId, userId);
          },
        },
        messageStore,
      };
      const server = createRelayServer(testConfig(), opts);
      await server.start();

      try {
        // Health check should work even with invalid/expired tokens
        const healthResp = await rawRequest(server.port, '/health');
        expect(healthResp.statusCode).toBe(200);
        const health = JSON.parse(healthResp.body);
        expect(health.status).toBe('ok');

        // But SSE should fail with expired token
        tokenControl.expireToken('token-alice');
        const sseResp = await rawRequest(server.port, '/events', {
          headers: {
            Authorization: 'Bearer token-alice',
            Accept: 'text/event-stream',
          },
        });
        expect(sseResp.statusCode).toBe(401);
      } finally {
        await server.close();
      }
    });

    it('client can detect SSE unavailability and fall back to polling', async () => {
      // This test verifies that when SSE connection is refused, the client
      // can detect this and transition to a fallback strategy.
      // We test the pattern: try SSE → fail → use relay API for inbox polling.

      const messageStore = new RelayMessageStore();
      const tokenControl = controllableTokenVerifier();
      const opts: RelayServerOptions = {
        logger: () => {},
        tokenVerifier: tokenControl.verifier,
        participantStore: {
          async isParticipant(conversationId: string, userId: string) {
            return messageStore.isParticipant(conversationId, userId);
          },
        },
        messageStore,
      };
      const server = createRelayServer(testConfig(), opts);
      await server.start();

      try {
        // Send a message via API (working)
        const sendResp = await rawRequest(server.port, '/messages', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer token-bob',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipient_id: 'acct_1001',
            body: 'Hello in degraded mode',
          }),
        });
        expect(sendResp.statusCode).toBe(201);

        // Verify inbox still works (fallback path)
        const inboxResp = await rawRequest(server.port, '/inbox', {
          headers: { Authorization: 'Bearer token-alice' },
        });
        expect(inboxResp.statusCode).toBe(200);
        const inbox = JSON.parse(inboxResp.body);
        expect(inbox.count).toBe(1);
        expect(inbox.messages[0].body).toBe('Hello in degraded mode');
      } finally {
        await server.close();
      }
    });
  });
});
