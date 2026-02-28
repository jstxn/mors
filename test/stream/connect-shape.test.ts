/**
 * SSE watch connection and event shape contract tests.
 *
 * Validates:
 * - VAL-STREAM-001: Authenticated SSE watch connection succeeds with live state
 * - VAL-STREAM-002: Stream emits lifecycle events with required context fields
 *   (event type, event ID, message ID, thread ID, in_reply_to where applicable)
 *
 * Uses a real relay server with in-memory message store, stub auth, and raw HTTP
 * to validate SSE protocol compliance and event field contracts.
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

/** Stub token verifier that maps known tokens to principals. */
function stubTokenVerifier(): TokenVerifier {
  const principals = new Map<string, AuthPrincipal>([
    ['token-alice', { accountId: 'acct_1001', deviceId: 'device-alice' }],
    ['token-bob', { accountId: 'acct_1002', deviceId: 'device-bob' }],
  ]);
  return async (token: string) => principals.get(token) ?? null;
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
    // Skip comment-only blocks (like ": heartbeat")
    const lines = block.split('\n');
    const isCommentOnly = lines.every((l) => l.startsWith(':') || l.trim() === '');
    if (isCommentOnly) continue;

    const event: SSEEvent = {};
    for (const line of lines) {
      if (line.startsWith(':')) continue; // SSE comment
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

/**
 * Open an SSE connection and collect events until a condition is met or timeout.
 * Returns a handle for cleanup.
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
} {
  const events: SSEEvent[] = [];
  const rawChunks: string[] = [];
  let req: http.ClientRequest | null = null;
  let res: http.IncomingMessage | null = null;
  const eventWaiters: Array<{ count: number; resolve: (events: SSEEvent[]) => void }> = [];

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
        events.push(...parsed);

        // Check waiters
        for (let i = eventWaiters.length - 1; i >= 0; i--) {
          if (events.length >= eventWaiters[i].count) {
            eventWaiters[i].resolve([...events]);
            eventWaiters.splice(i, 1);
          }
        }
      });
    }
  );

  req.on('error', () => {
    // Connection closed/aborted — expected during cleanup
  });

  req.end();

  function close(): void {
    if (res) {
      res.destroy();
    }
    if (req) {
      req.destroy();
    }
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
              `Raw chunks: ${JSON.stringify(rawChunks)}`
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

  return { events, rawChunks, statusCode, headers, close, waitForEvents };
}

/**
 * Find an event by type in a list of SSE events.
 * Throws if not found (test should have already asserted existence).
 */
function findEvent(events: SSEEvent[], eventType: string): SSEEvent {
  const found = events.find((e) => e.event === eventType);
  if (!found) {
    throw new Error(`Event type "${eventType}" not found in: ${JSON.stringify(events)}`);
  }
  return found;
}

/** Parse the data field of an SSE event as JSON. */
function parseEventData(event: SSEEvent): Record<string, unknown> {
  expect(event.data).toBeDefined();
  return JSON.parse(event.data ?? '{}') as Record<string, unknown>;
}

// ── Test suite ───────────────────────────────────────────────────────

describe('SSE watch connection and event shape', () => {
  let server: RelayServer;
  let messageStore: RelayMessageStore;

  beforeEach(async () => {
    messageStore = new RelayMessageStore();
    const opts: RelayServerOptions = {
      logger: () => {},
      tokenVerifier: stubTokenVerifier(),
      participantStore: {
        async isParticipant(conversationId: string, userId: string) {
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

  // ── VAL-STREAM-001: Authenticated SSE watch connection ──────────

  describe('authenticated connection (VAL-STREAM-001)', () => {
    it('succeeds with valid auth and returns text/event-stream content type', async () => {
      const sse = openSSE(server.port, 'token-alice');
      try {
        const status = await sse.statusCode;
        const hdrs = await sse.headers;

        expect(status).toBe(200);
        expect(hdrs['content-type']).toBe('text/event-stream');
        expect(hdrs['cache-control']).toBe('no-cache');
      } finally {
        sse.close();
      }
    });

    it('sends initial heartbeat comment on connect', async () => {
      const sse = openSSE(server.port, 'token-alice');
      try {
        await sse.statusCode;
        // Wait a bit for the heartbeat
        await new Promise((r) => setTimeout(r, 100));
        const raw = sse.rawChunks.join('');
        expect(raw).toContain(': heartbeat');
      } finally {
        sse.close();
      }
    });

    it('emits a connected event with the authenticated principal', async () => {
      const sse = openSSE(server.port, 'token-alice');
      try {
        const evts = await sse.waitForEvents(1);
        expect(evts[0].event).toBe('connected');
        const data = parseEventData(evts[0]);
        expect(data.account_id).toBe('acct_1001');
        expect(data.device_id).toBe('device-alice');
      } finally {
        sse.close();
      }
    });

    it('rejects unauthenticated requests with 401', async () => {
      const resp = await rawRequest(server.port, '/events', {
        headers: { Accept: 'text/event-stream' },
      });
      expect(resp.statusCode).toBe(401);
    });

    it('rejects invalid token with 401', async () => {
      const resp = await rawRequest(server.port, '/events', {
        headers: {
          Authorization: 'Bearer bad-token',
          Accept: 'text/event-stream',
        },
      });
      expect(resp.statusCode).toBe(401);
    });
  });

  // ── VAL-STREAM-002: Event shape contract ────────────────────────

  describe('event shape contract (VAL-STREAM-002)', () => {
    it('message_created event includes all required context fields', async () => {
      const sse = openSSE(server.port, 'token-alice');
      try {
        // Wait for connected event
        await sse.waitForEvents(1);

        // Send a message from Bob to Alice
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Hello Alice',
          subject: 'Greetings',
        });

        // Wait for the message_created event
        const evts = await sse.waitForEvents(2);
        const msgEvt = findEvent(evts, 'message_created');

        // Required fields per VAL-STREAM-002
        expect(msgEvt.id).toBeDefined();
        expect(String(msgEvt.id).startsWith('evt_')).toBe(true);
        expect(msgEvt.event).toBe('message_created');

        const data = parseEventData(msgEvt);
        expect(data.message_id).toBeDefined();
        expect(String(data.message_id).startsWith('msg_')).toBe(true);
        expect(data.thread_id).toBeDefined();
        expect(String(data.thread_id).startsWith('thr_')).toBe(true);
        expect(data.in_reply_to).toBeNull();
        expect(data.sender_id).toBe('acct_1002');
        expect(data.recipient_id).toBe('acct_1001');
        expect(data.timestamp).toBeDefined();
      } finally {
        sse.close();
      }
    });

    it('reply_created event includes in_reply_to and inherits thread_id', async () => {
      const sse = openSSE(server.port, 'token-alice');
      try {
        await sse.waitForEvents(1);

        // Send a root message from Bob to Alice
        const root = messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Root message',
        });

        // Wait for message_created
        await sse.waitForEvents(2);

        // Send a reply from Alice to Bob
        messageStore.send('acct_1001', 'alice', {
          recipientId: 'acct_1002',
          body: 'Reply to root',
          inReplyTo: root.message.id,
        });

        // Wait for reply_created event
        const evts = await sse.waitForEvents(3);
        const replyEvt = findEvent(evts, 'reply_created');

        // Required fields
        expect(replyEvt.id).toBeDefined();
        expect(String(replyEvt.id).startsWith('evt_')).toBe(true);
        expect(replyEvt.event).toBe('reply_created');

        const data = parseEventData(replyEvt);
        expect(data.message_id).toBeDefined();
        expect(data.thread_id).toBe(root.message.thread_id);
        expect(data.in_reply_to).toBe(root.message.id);
        expect(data.sender_id).toBe('acct_1001');
        expect(data.recipient_id).toBe('acct_1002');
        expect(data.timestamp).toBeDefined();
      } finally {
        sse.close();
      }
    });

    it('message_acked event includes message context', async () => {
      const sse = openSSE(server.port, 'token-alice');
      try {
        await sse.waitForEvents(1);

        // Send a message from Bob to Alice
        const sent = messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Please ack me',
        });

        // Wait for message_created
        await sse.waitForEvents(2);

        // Alice acks the message
        messageStore.ack(sent.message.id, 'acct_1001');

        // Wait for message_acked event
        const evts = await sse.waitForEvents(3);
        const ackEvt = findEvent(evts, 'message_acked');

        // Required fields
        expect(ackEvt.id).toBeDefined();
        expect(String(ackEvt.id).startsWith('evt_')).toBe(true);
        expect(ackEvt.event).toBe('message_acked');

        const data = parseEventData(ackEvt);
        expect(data.message_id).toBe(sent.message.id);
        expect(data.thread_id).toBe(sent.message.thread_id);
        expect(data.in_reply_to).toBeNull();
        expect(data.timestamp).toBeDefined();
      } finally {
        sse.close();
      }
    });

    it('message_read event includes message context', async () => {
      const sse = openSSE(server.port, 'token-alice');
      try {
        await sse.waitForEvents(1);

        // Send a message from Bob to Alice
        const sent = messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Please read me',
        });

        // Wait for message_created
        await sse.waitForEvents(2);

        // Alice reads the message
        messageStore.read(sent.message.id, 'acct_1001');

        // Wait for message_read event
        const evts = await sse.waitForEvents(3);
        const readEvt = findEvent(evts, 'message_read');

        expect(readEvt.id).toBeDefined();
        expect(String(readEvt.id).startsWith('evt_')).toBe(true);
        expect(readEvt.event).toBe('message_read');

        const data = parseEventData(readEvt);
        expect(data.message_id).toBe(sent.message.id);
        expect(data.thread_id).toBe(sent.message.thread_id);
        expect(data.timestamp).toBeDefined();
      } finally {
        sse.close();
      }
    });

    it('each event has a unique event ID', async () => {
      const sse = openSSE(server.port, 'token-alice');
      try {
        await sse.waitForEvents(1);

        // Create two messages
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'First message',
        });
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Second message',
        });

        // Wait for both events
        const evts = await sse.waitForEvents(3);
        const eventIds = evts.map((e) => e.id).filter(Boolean);

        // All event IDs should be unique
        const uniqueIds = new Set(eventIds);
        expect(uniqueIds.size).toBe(eventIds.length);
      } finally {
        sse.close();
      }
    });

    it('events are only delivered to relevant participants', async () => {
      // Alice watches — should see messages where she is sender or recipient
      const sseAlice = openSSE(server.port, 'token-alice');
      const sseBob = openSSE(server.port, 'token-bob');
      try {
        await sseAlice.waitForEvents(1); // connected
        await sseBob.waitForEvents(1); // connected

        // Bob sends to Alice — both should see it
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Hello Alice from Bob',
        });

        const aliceEvts = await sseAlice.waitForEvents(2);
        const bobEvts = await sseBob.waitForEvents(2);

        const aliceMsg = aliceEvts.find((e) => e.event === 'message_created');
        const bobMsg = bobEvts.find((e) => e.event === 'message_created');

        expect(aliceMsg).toBeDefined();
        expect(bobMsg).toBeDefined();
      } finally {
        sseAlice.close();
        sseBob.close();
      }
    });

    it('events from unrelated conversations are not delivered', async () => {
      const sseAlice = openSSE(server.port, 'token-alice');
      try {
        await sseAlice.waitForEvents(1); // connected

        // Bob sends to someone else (user 'acct_9999') — Alice should NOT see this
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_9999',
          body: 'Hello stranger',
        });

        // Wait a bit, Alice should not get the event
        await new Promise((r) => setTimeout(r, 200));
        const nonConnected = sseAlice.events.filter((e) => e.event !== 'connected');
        expect(nonConnected.length).toBe(0);
      } finally {
        sseAlice.close();
      }
    });
  });
});

// ── SSE device auto-registration ─────────────────────────────────────
// Validates that SSE-authenticated connections also perform device
// auto-registration so watch-only clients appear in device listings.

import { AccountStore } from '../../src/relay/account-store.js';

describe('SSE device auto-registration', () => {
  let server: RelayServer;
  let messageStore: RelayMessageStore;
  let accountStore: AccountStore;

  beforeEach(async () => {
    messageStore = new RelayMessageStore();
    accountStore = new AccountStore();
    const opts: RelayServerOptions = {
      logger: () => {},
      tokenVerifier: stubTokenVerifier(),
      messageStore,
      accountStore,
    };
    server = createRelayServer(testConfig(), opts);
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it('SSE connection auto-registers the device in account device listing', async () => {
    // Before SSE connection, no devices registered for Alice
    expect(accountStore.listDevices('acct_1001')).toHaveLength(0);

    const sse = openSSE(server.port, 'token-alice');
    try {
      // Wait for connected event to confirm SSE session is established
      await sse.waitForEvents(1);

      // The SSE connection should have auto-registered Alice's device
      const devices = accountStore.listDevices('acct_1001');
      expect(devices).toHaveLength(1);
      expect(devices[0].deviceId).toBe('device-alice');
    } finally {
      sse.close();
    }
  });

  it('SSE-only device appears in GET /accounts/me/devices', async () => {
    const sse = openSSE(server.port, 'token-alice');
    try {
      await sse.waitForEvents(1);

      // Query the device listing API
      const resp = await rawRequest(server.port, '/accounts/me/devices', {
        headers: { Authorization: 'Bearer token-alice' },
      });

      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body) as Record<string, unknown>;
      const devices = body['devices'] as Array<Record<string, unknown>>;

      // Alice's SSE device should appear (plus the API request device — same device)
      const deviceIds = devices.map((d) => d['device_id']);
      expect(deviceIds).toContain('device-alice');
    } finally {
      sse.close();
    }
  });

  it('watch-only device and API-only device both appear in device listing', async () => {
    // Bob connects only via SSE (watch-only)
    const sseBob = openSSE(server.port, 'token-bob');
    try {
      await sseBob.waitForEvents(1);

      // Alice connects via API only (triggers auto-registration through normal route)
      await rawRequest(server.port, '/accounts/me/devices', {
        headers: { Authorization: 'Bearer token-alice' },
      });

      // Verify Alice's devices
      const aliceDevices = accountStore.listDevices('acct_1001');
      expect(aliceDevices).toHaveLength(1);
      expect(aliceDevices[0].deviceId).toBe('device-alice');

      // Verify Bob's devices (SSE-only)
      const bobDevices = accountStore.listDevices('acct_1002');
      expect(bobDevices).toHaveLength(1);
      expect(bobDevices[0].deviceId).toBe('device-bob');
    } finally {
      sseBob.close();
    }
  });

  it('SSE device registration is idempotent with subsequent API requests', async () => {
    // Connect via SSE first
    const sse = openSSE(server.port, 'token-alice');
    try {
      await sse.waitForEvents(1);

      // Then make an API request (which also auto-registers)
      await rawRequest(server.port, '/accounts/me/devices', {
        headers: { Authorization: 'Bearer token-alice' },
      });

      // Device should only appear once (idempotent registration)
      const devices = accountStore.listDevices('acct_1001');
      expect(devices).toHaveLength(1);
      expect(devices[0].deviceId).toBe('device-alice');
    } finally {
      sse.close();
    }
  });
});
