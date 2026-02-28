/**
 * SSE resume/cursor and deduplication contract tests.
 *
 * Validates:
 * - VAL-STREAM-003: Reconnect resumes from cursor/Last-Event-ID with no missing logical events
 * - VAL-STREAM-004: Startup is deterministic (no historical create spam)
 * - VAL-STREAM-005: Duplicate replay does not create duplicate user-visible transitions
 *
 * Uses a real relay server with in-memory message store, stub auth, and raw HTTP
 * to validate SSE reconnect semantics, startup determinism, and deduplication.
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
    ['token-alice', { accountId: "acct_1001", deviceId: 'device-alice' }],
    ['token-bob', { accountId: "acct_1002", deviceId: 'device-bob' }],
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

        for (let i = eventWaiters.length - 1; i >= 0; i--) {
          if (events.length >= eventWaiters[i].count) {
            eventWaiters[i].resolve([...events]);
            eventWaiters.splice(i, 1);
          }
        }
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

  return { events, rawChunks, statusCode, headers, close, waitForEvents };
}

/** Parse the data field of an SSE event as JSON. */
function parseEventData(event: SSEEvent): Record<string, unknown> {
  expect(event.data).toBeDefined();
  return JSON.parse(event.data ?? '{}') as Record<string, unknown>;
}

// ── Test suite ───────────────────────────────────────────────────────

describe('SSE resume, cursor determinism, and deduplication', () => {
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

  // ── VAL-STREAM-003: Reconnect resumes from cursor/Last-Event-ID ──

  describe('reconnect resume from cursor (VAL-STREAM-003)', () => {
    it('resumes from Last-Event-ID without missing logical events', async () => {
      // Step 1: Open an initial connection and receive a connected event + one message event
      const sse1 = openSSE(server.port, 'token-alice');
      try {
        await sse1.waitForEvents(1); // connected event

        // Send a message from Bob to Alice
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'First message',
        });

        const evts1 = await sse1.waitForEvents(2);
        const lastEventId = evts1[evts1.length - 1].id;
        expect(lastEventId).toBeDefined();

        // Close connection (simulate disconnect)
        sse1.close();

        // Step 2: While disconnected, more events happen
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Second message (during disconnect)',
        });
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Third message (during disconnect)',
        });
      } finally {
        sse1.close();
      }

      // Step 3: Reconnect with Last-Event-ID from last seen event
      const sse2 = openSSE(server.port, 'token-alice', {
        lastEventId: sse1.events[sse1.events.length - 1].id,
      });
      try {
        // Should get: connected event + 2 missed message_created events
        const evts2 = await sse2.waitForEvents(3);
        const connectedEvt = evts2.find((e) => e.event === 'connected');
        expect(connectedEvt).toBeDefined();

        // The 2 missed events should be replayed
        const messageEvents = evts2.filter((e) => e.event === 'message_created');
        expect(messageEvents.length).toBe(2);

        // Verify the replayed events have correct data
        const data0 = parseEventData(messageEvents[0]);
        const data1 = parseEventData(messageEvents[1]);
        expect(data0.sender_id).toBe('acct_1002');
        expect(data1.sender_id).toBe('acct_1002');
      } finally {
        sse2.close();
      }
    });

    it('replays events in order after reconnect', async () => {
      // Setup: create events while connected, then disconnect, create more, reconnect
      const sse1 = openSSE(server.port, 'token-alice');
      try {
        await sse1.waitForEvents(1); // connected

        const sent = messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Root message',
        });

        await sse1.waitForEvents(2);
        const lastId = sse1.events[sse1.events.length - 1].id;
        sse1.close();

        // While disconnected: reply + ack
        messageStore.send('acct_1001', 'alice', {
          recipientId: 'acct_1002',
          body: 'Reply from Alice',
          inReplyTo: sent.message.id,
        });
        messageStore.ack(sent.message.id, 'acct_1001');

        // Reconnect
        const sse2 = openSSE(server.port, 'token-alice', { lastEventId: lastId });
        try {
          // connected + reply_created + message_acked = 3 events
          const evts = await sse2.waitForEvents(3);
          const nonConnected = evts.filter((e) => e.event !== 'connected');

          // Events should come in the order they occurred
          expect(nonConnected.length).toBe(2);
          expect(nonConnected[0].event).toBe('reply_created');
          expect(nonConnected[1].event).toBe('message_acked');
        } finally {
          sse2.close();
        }
      } finally {
        sse1.close();
      }
    });

    it('replays only events relevant to the authenticated user after reconnect', async () => {
      // Setup: Alice connects, sees event, disconnects
      const sse1 = openSSE(server.port, 'token-alice');
      try {
        await sse1.waitForEvents(1);

        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'For Alice',
        });

        await sse1.waitForEvents(2);
        const lastId = sse1.events[sse1.events.length - 1].id;
        sse1.close();

        // While disconnected: event for Alice + event NOT for Alice
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Also for Alice',
        });
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_9999',
          body: 'Not for Alice (different recipient)',
        });

        // Reconnect
        const sse2 = openSSE(server.port, 'token-alice', { lastEventId: lastId });
        try {
          // connected + 1 relevant event
          const evts = await sse2.waitForEvents(2);
          const msgEvents = evts.filter((e) => e.event === 'message_created');
          expect(msgEvents.length).toBe(1);

          const data = parseEventData(msgEvents[0]);
          expect(data.recipient_id).toBe('acct_1001');
        } finally {
          sse2.close();
        }
      } finally {
        sse1.close();
      }
    });

    it('returns no missed events when reconnect with current cursor', async () => {
      // Connect, receive events, disconnect, reconnect with current cursor — no catch-up
      const sse1 = openSSE(server.port, 'token-alice');
      try {
        await sse1.waitForEvents(1);

        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'A message',
        });

        await sse1.waitForEvents(2);
        const lastId = sse1.events[sse1.events.length - 1].id;
        sse1.close();

        // Reconnect with current cursor — nothing happened since disconnect
        const sse2 = openSSE(server.port, 'token-alice', { lastEventId: lastId });
        try {
          // Should only get the connected event
          const evts = await sse2.waitForEvents(1);
          expect(evts.length).toBe(1);
          expect(evts[0].event).toBe('connected');

          // Wait a moment to make sure no extra events arrive
          await new Promise((r) => setTimeout(r, 200));
          expect(sse2.events.length).toBe(1);
        } finally {
          sse2.close();
        }
      } finally {
        sse1.close();
      }
    });

    it('live events still arrive after replay catch-up', async () => {
      // Connect, get events, disconnect, events happen, reconnect, get replay + then live event
      const sse1 = openSSE(server.port, 'token-alice');
      try {
        await sse1.waitForEvents(1);

        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Before disconnect',
        });

        await sse1.waitForEvents(2);
        const lastId = sse1.events[sse1.events.length - 1].id;
        sse1.close();

        // Event during disconnect
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'During disconnect',
        });

        // Reconnect
        const sse2 = openSSE(server.port, 'token-alice', { lastEventId: lastId });
        try {
          // connected + 1 replayed event
          await sse2.waitForEvents(2);

          // Now send a live event
          messageStore.send('acct_1002', 'bob', {
            recipientId: 'acct_1001',
            body: 'After reconnect (live)',
          });

          // Should receive the live event too
          const evts = await sse2.waitForEvents(3);
          const msgEvents = evts.filter((e) => e.event === 'message_created');
          expect(msgEvents.length).toBe(2); // 1 replayed + 1 live
        } finally {
          sse2.close();
        }
      } finally {
        sse1.close();
      }
    });
  });

  // ── VAL-STREAM-004: Startup is deterministic (no historical create spam) ──

  describe('deterministic startup (VAL-STREAM-004)', () => {
    it('does not emit historical create events for pre-existing messages on fresh connect', async () => {
      // Create messages before any SSE connection
      messageStore.send('acct_1002', 'bob', {
        recipientId: 'acct_1001',
        body: 'Pre-existing message 1',
      });
      messageStore.send('acct_1002', 'bob', {
        recipientId: 'acct_1001',
        body: 'Pre-existing message 2',
      });
      messageStore.send('acct_1002', 'bob', {
        recipientId: 'acct_1001',
        body: 'Pre-existing message 3',
      });

      // Now connect SSE — should NOT replay those 3 creates
      const sse = openSSE(server.port, 'token-alice');
      try {
        // Should get connected event
        const evts = await sse.waitForEvents(1);
        expect(evts[0].event).toBe('connected');

        // Wait to make sure no historical create events arrive
        await new Promise((r) => setTimeout(r, 300));
        const nonConnected = sse.events.filter((e) => e.event !== 'connected');
        expect(nonConnected.length).toBe(0);
      } finally {
        sse.close();
      }
    });

    it('emits only new events occurring after connection is established', async () => {
      // Pre-existing messages
      messageStore.send('acct_1002', 'bob', {
        recipientId: 'acct_1001',
        body: 'Pre-existing message',
      });

      // Connect
      const sse = openSSE(server.port, 'token-alice');
      try {
        await sse.waitForEvents(1); // connected

        // Send a new message AFTER connection
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'New message after connect',
        });

        const evts = await sse.waitForEvents(2);
        const msgEvents = evts.filter((e) => e.event === 'message_created');
        expect(msgEvents.length).toBe(1);

        const data = parseEventData(msgEvents[0]);
        expect(data.sender_id).toBe('acct_1002');
      } finally {
        sse.close();
      }
    });

    it('concurrent initial connections do not receive historical create events', async () => {
      // Pre-existing messages
      for (let i = 0; i < 5; i++) {
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: `Pre-existing #${i}`,
        });
      }

      // Connect multiple SSE clients simultaneously
      const sseAlice = openSSE(server.port, 'token-alice');
      const sseBob = openSSE(server.port, 'token-bob');
      try {
        await sseAlice.waitForEvents(1);
        await sseBob.waitForEvents(1);

        // Wait to ensure no historical events flood
        await new Promise((r) => setTimeout(r, 300));

        const aliceNonConnected = sseAlice.events.filter((e) => e.event !== 'connected');
        const bobNonConnected = sseBob.events.filter((e) => e.event !== 'connected');
        expect(aliceNonConnected.length).toBe(0);
        expect(bobNonConnected.length).toBe(0);
      } finally {
        sseAlice.close();
        sseBob.close();
      }
    });
  });

  // ── VAL-STREAM-005: Duplicate replay → exactly-once user-visible ──

  describe('at-least-once dedup to exactly-once transitions (VAL-STREAM-005)', () => {
    it('replayed events after reconnect have same event IDs as original', async () => {
      // Connect, receive events with known IDs, disconnect, reconnect — replayed events use same IDs
      const sse1 = openSSE(server.port, 'token-alice');
      try {
        await sse1.waitForEvents(1);

        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Message for dedupe check',
        });

        const evts1 = await sse1.waitForEvents(2);
        const connectedId = evts1[0].id;
        const msgEventId = evts1[1].id;
        expect(msgEventId).toBeDefined();

        sse1.close();

        // Send another message while disconnected
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'During disconnect for dedupe',
        });

        // Reconnect from the connected event ID — should replay the msg event
        const sse2 = openSSE(server.port, 'token-alice', { lastEventId: connectedId });
        try {
          // connected + replayed message_created + new message_created
          const evts2 = await sse2.waitForEvents(3);
          const msgEvts = evts2.filter((e) => e.event === 'message_created');
          expect(msgEvts.length).toBe(2);

          // The replayed event should have the SAME event ID as original
          expect(msgEvts[0].id).toBe(msgEventId);
        } finally {
          sse2.close();
        }
      } finally {
        sse1.close();
      }
    });

    it('stable event IDs enable client-side deduplication across reconnects', async () => {
      // This test verifies the property that enables exactly-once:
      // Event IDs are stable, so a client can track seen IDs and skip duplicates
      const sse1 = openSSE(server.port, 'token-alice');
      const seenEventIds = new Set<string>();

      try {
        await sse1.waitForEvents(1);

        // Send 3 messages
        for (let i = 0; i < 3; i++) {
          messageStore.send('acct_1002', 'bob', {
            recipientId: 'acct_1001',
            body: `Message ${i}`,
          });
        }

        const evts1 = await sse1.waitForEvents(4); // connected + 3 messages
        const connectedId = evts1[0].id;

        // Record all event IDs
        for (const e of evts1) {
          if (e.id) seenEventIds.add(e.id);
        }

        sse1.close();

        // Reconnect from the connected event — will replay all 3 message events
        const sse2 = openSSE(server.port, 'token-alice', { lastEventId: connectedId });
        try {
          const evts2 = await sse2.waitForEvents(4); // connected + 3 replayed
          const msgEvts = evts2.filter((e) => e.event === 'message_created');
          expect(msgEvts.length).toBe(3);

          // All replayed message events should have IDs we already saw
          for (const evt of msgEvts) {
            expect(evt.id).toBeDefined();
            expect(seenEventIds.has(evt.id as string)).toBe(true);
          }

          // A client deduping by event ID would see 0 new transitions
          const newTransitions = msgEvts.filter((e) => !seenEventIds.has(e.id as string));
          expect(newTransitions.length).toBe(0);
        } finally {
          sse2.close();
        }
      } finally {
        sse1.close();
      }
    });

    it('read and ack state transitions are not duplicated on replay', async () => {
      // Connect, see read and ack events, disconnect before cursor, reconnect
      // Replayed read/ack events should have same IDs
      const sse1 = openSSE(server.port, 'token-alice');
      try {
        await sse1.waitForEvents(1);

        const sent = messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Message for read+ack dedupe',
        });

        await sse1.waitForEvents(2);
        const cursorAfterCreate = sse1.events[0].id; // connected event as cursor

        // Read and ack
        messageStore.read(sent.message.id, 'acct_1001');
        messageStore.ack(sent.message.id, 'acct_1001');

        const evts1 = await sse1.waitForEvents(4); // connected + created + read + acked
        const readEvt = evts1.find((e) => e.event === 'message_read');
        const ackEvt = evts1.find((e) => e.event === 'message_acked');
        expect(readEvt).toBeDefined();
        expect(ackEvt).toBeDefined();

        sse1.close();

        // Reconnect from the connected event — should replay create + read + ack
        const sse2 = openSSE(server.port, 'token-alice', { lastEventId: cursorAfterCreate });
        try {
          const evts2 = await sse2.waitForEvents(4); // connected + 3 replayed
          const readEvts = evts2.filter((e) => e.event === 'message_read');
          const ackEvts = evts2.filter((e) => e.event === 'message_acked');

          // Exactly 1 read and 1 ack event (not duplicated)
          expect(readEvts.length).toBe(1);
          expect(ackEvts.length).toBe(1);

          // Same event IDs as originals (readEvt/ackEvt asserted defined above)
          expect(readEvts[0].id).toBe(readEvt?.id);
          expect(ackEvts[0].id).toBe(ackEvt?.id);
        } finally {
          sse2.close();
        }
      } finally {
        sse1.close();
      }
    });

    it('idempotent operations (re-read, re-ack) do not produce additional stream events', async () => {
      const sse = openSSE(server.port, 'token-alice');
      try {
        await sse.waitForEvents(1);

        const sent = messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Idempotent test message',
        });
        await sse.waitForEvents(2);

        // First read and ack
        messageStore.read(sent.message.id, 'acct_1001');
        messageStore.ack(sent.message.id, 'acct_1001');
        await sse.waitForEvents(4);

        // Re-read and re-ack (idempotent)
        messageStore.read(sent.message.id, 'acct_1001');
        messageStore.ack(sent.message.id, 'acct_1001');

        // Wait — no additional events should appear
        await new Promise((r) => setTimeout(r, 200));
        expect(sse.events.length).toBe(4); // connected + created + read + ack — no extras
      } finally {
        sse.close();
      }
    });

    it('message_created events from multiple senders have distinct stable IDs', async () => {
      // Verify that each distinct event gets a unique, stable ID
      const sse = openSSE(server.port, 'token-alice');
      try {
        await sse.waitForEvents(1);

        // Bob sends to Alice
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'From Bob',
        });

        // Alice sends to Bob (Alice sees as sender)
        messageStore.send('acct_1001', 'alice', {
          recipientId: 'acct_1002',
          body: 'From Alice',
        });

        const evts = await sse.waitForEvents(3); // connected + 2 message events
        const msgEvts = evts.filter((e) => e.event !== 'connected');
        expect(msgEvts.length).toBe(2);

        // Both should have distinct event IDs
        expect(msgEvts[0].id).toBeDefined();
        expect(msgEvts[1].id).toBeDefined();
        expect(msgEvts[0].id).not.toBe(msgEvts[1].id);
      } finally {
        sse.close();
      }
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('reconnect with unknown Last-Event-ID falls back to no replay', async () => {
      // If the cursor is unknown (e.g., server restarted), treat as fresh connection
      messageStore.send('acct_1002', 'bob', {
        recipientId: 'acct_1001',
        body: 'Pre-existing message',
      });

      const sse = openSSE(server.port, 'token-alice', { lastEventId: 'evt_nonexistent' });
      try {
        const evts = await sse.waitForEvents(1);
        expect(evts[0].event).toBe('connected');

        // Wait — should not receive historical events
        await new Promise((r) => setTimeout(r, 300));
        const nonConnected = sse.events.filter((e) => e.event !== 'connected');
        expect(nonConnected.length).toBe(0);
      } finally {
        sse.close();
      }
    });

    it('reconnect using connected event ID as cursor does not replay events already delivered during that session', async () => {
      // Edge case: Client connects, receives connected event + N replayed events during
      // the initial catch-up. If it disconnects and reconnects using the connected event ID,
      // those N events should NOT be re-replayed because the cursor for the connected event
      // should account for any events replayed after it.
      //
      // Scenario: Events exist before connection. Client connects with Last-Event-ID that
      // causes a replay. The connected event's cursor should be registered AFTER replay
      // so reconnecting with the connected event ID doesn't re-send replayed events.

      // Step 1: Create initial session to establish some cursor state
      const sse0 = openSSE(server.port, 'token-alice');
      try {
        await sse0.waitForEvents(1); // connected
        const initialCursor = sse0.events[0].id;

        // Create events while sse0 is connected
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Event A',
        });
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Event B',
        });
        await sse0.waitForEvents(3); // connected + 2 events
        sse0.close();

        // Step 2: More events happen while disconnected
        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Event C (during disconnect)',
        });

        // Step 3: Reconnect with the initial cursor — should replay A, B, C
        const sse1 = openSSE(server.port, 'token-alice', { lastEventId: initialCursor });
        try {
          // connected + 3 replayed events (A, B, C)
          const evts1 = await sse1.waitForEvents(4);
          const connectedId = evts1.find((e) => e.event === 'connected')?.id;
          expect(connectedId).toBeDefined();

          const msgEvts = evts1.filter((e) => e.event === 'message_created');
          expect(msgEvts.length).toBe(3);
          sse1.close();

          // Step 4: Reconnect using the connected event ID from sse1
          // Since all 3 events were replayed in sse1, reconnecting with
          // the connected event ID should NOT replay them again.
          const sse2 = openSSE(server.port, 'token-alice', { lastEventId: connectedId });
          try {
            // Should only get connected event, no re-replay
            const evts2 = await sse2.waitForEvents(1);
            expect(evts2[0].event).toBe('connected');

            await new Promise((r) => setTimeout(r, 200));
            const nonConnected = sse2.events.filter((e) => e.event !== 'connected');
            expect(nonConnected.length).toBe(0);
          } finally {
            sse2.close();
          }
        } finally {
          sse1.close();
        }
      } finally {
        sse0.close();
      }
    });

    it('lastSentEventId in auth_expired payload reflects replayed events, not just connected event', async () => {
      // Edge case: When auth expires after replay catch-up but before any live event,
      // the auth_expired event's last_event_id should be the last replayed event ID
      // (not the connected event ID), so the client can resume correctly after re-auth.

      // Setup controllable auth
      const principals = new Map<string, AuthPrincipal>([
        ['token-alice', { accountId: "acct_1001", deviceId: 'device-alice' }],
        ['token-bob', { accountId: "acct_1002", deviceId: 'device-bob' }],
      ]);
      const controlledVerifier = async (token: string) => principals.get(token) ?? null;

      // Create a server with fast revalidation
      await server.close();
      const controlledStore = new RelayMessageStore();
      const opts: RelayServerOptions = {
        logger: () => {},
        tokenVerifier: controlledVerifier,
        messageStore: controlledStore,
        sseAuthRevalidateMs: 100, // Fast revalidation for test
      };
      server = createRelayServer(testConfig(), opts);
      await server.start();

      // Step 1: Create initial connection and some events
      const sse0 = openSSE(server.port, 'token-alice');
      try {
        await sse0.waitForEvents(1);
        const initialCursor = sse0.events[0].id;

        // Create events
        controlledStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Event for replay',
        });
        controlledStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Another event for replay',
        });

        await sse0.waitForEvents(3);
        const lastLiveEventId = sse0.events[sse0.events.length - 1].id;
        sse0.close();

        // Step 2: Reconnect with initial cursor — replay will catch up
        const sse1 = openSSE(server.port, 'token-alice', { lastEventId: initialCursor });
        try {
          // connected + 2 replayed events
          await sse1.waitForEvents(3);
          const replayed = sse1.events.filter((e) => e.event === 'message_created');
          expect(replayed.length).toBe(2);
          const lastReplayedId = replayed[replayed.length - 1].id;
          expect(lastReplayedId).toBe(lastLiveEventId);

          // Step 3: Expire the token so auth_expired fires
          principals.delete('token-alice');

          // Wait for auth_expired event
          const authEvt = await sse1.waitForEvents(4, 3000);
          const authExpired = authEvt.find((e) => e.event === 'auth_expired');
          expect(authExpired).toBeDefined();

          // The auth_expired event should report last_event_id as the last replayed event
          // (not the connected event ID)
          if (!authExpired) throw new Error('auth_expired event not found');
          const authData = parseEventData(authExpired);
          expect(authData.last_event_id).toBe(lastReplayedId);
        } finally {
          sse1.close();
        }
      } finally {
        sse0.close();
      }
    });

    it('reconnect after replay uses last replayed event as effective resume point', async () => {
      // Edge case: Client connects with Last-Event-ID and gets replayed events.
      // If it disconnects immediately after replay and reconnects using the LAST
      // replayed event's ID as cursor, it should get no duplicate events.

      const sse0 = openSSE(server.port, 'token-alice');
      try {
        await sse0.waitForEvents(1);
        const cursor0 = sse0.events[0].id;

        // Create events
        messageStore.send('acct_1002', 'bob', { recipientId: 'acct_1001', body: 'Msg 1' });
        messageStore.send('acct_1002', 'bob', { recipientId: 'acct_1001', body: 'Msg 2' });
        messageStore.send('acct_1002', 'bob', { recipientId: 'acct_1001', body: 'Msg 3' });

        await sse0.waitForEvents(4); // connected + 3 events
        sse0.close();

        // Reconnect with the initial cursor — should replay all 3
        const sse1 = openSSE(server.port, 'token-alice', { lastEventId: cursor0 });
        try {
          await sse1.waitForEvents(4); // connected + 3 replayed
          const replayed = sse1.events.filter((e) => e.event === 'message_created');
          expect(replayed.length).toBe(3);
          const lastReplayedId = replayed[replayed.length - 1].id;
          sse1.close();

          // Create another event after disconnect
          messageStore.send('acct_1002', 'bob', { recipientId: 'acct_1001', body: 'Msg 4 (new)' });

          // Reconnect using the last replayed event ID as cursor
          const sse2 = openSSE(server.port, 'token-alice', { lastEventId: lastReplayedId });
          try {
            // Should get connected + only Msg 4 (no re-replay of Msg 1-3)
            const evts2 = await sse2.waitForEvents(2);
            const msgEvts = evts2.filter((e) => e.event === 'message_created');
            expect(msgEvts.length).toBe(1);
          } finally {
            sse2.close();
          }
        } finally {
          sse1.close();
        }
      } finally {
        sse0.close();
      }
    });

    it('event log retains events for replay across multiple reconnects', async () => {
      // Connect, get events, disconnect, reconnect multiple times
      const sse1 = openSSE(server.port, 'token-alice');
      try {
        await sse1.waitForEvents(1);

        messageStore.send('acct_1002', 'bob', {
          recipientId: 'acct_1001',
          body: 'Event to replay',
        });

        const evts1 = await sse1.waitForEvents(2);
        const connectedId = evts1[0].id;
        sse1.close();

        // First reconnect
        const sse2 = openSSE(server.port, 'token-alice', { lastEventId: connectedId });
        try {
          const evts2 = await sse2.waitForEvents(2); // connected + 1 replayed
          expect(evts2.filter((e) => e.event === 'message_created').length).toBe(1);
          sse2.close();
        } finally {
          sse2.close();
        }

        // Second reconnect from same cursor
        const sse3 = openSSE(server.port, 'token-alice', { lastEventId: connectedId });
        try {
          const evts3 = await sse3.waitForEvents(2); // connected + 1 replayed again
          expect(evts3.filter((e) => e.event === 'message_created').length).toBe(1);
        } finally {
          sse3.close();
        }
      } finally {
        sse1.close();
      }
    });
  });
});
