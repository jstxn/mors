/**
 * Integration tests for relay-backed async messaging: send, inbox, read, ack.
 *
 * Covers:
 * - VAL-RELAY-001: Cross-developer send/inbox delivery works through relay
 * - VAL-RELAY-002: Read state remains independent from ack state
 * - VAL-RELAY-003: Ack state converges across sender, recipient, and their devices
 *
 * Tests run against a real relay HTTP server with in-memory message store,
 * using stub auth to simulate multi-identity scenarios.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { loadRelayConfig } from '../../src/relay/config.js';
import type { TokenVerifier, ParticipantStore } from '../../src/relay/auth-middleware.js';
import { RelayMessageStore } from '../../src/relay/message-store.js';

// ── Test identities ─────────────────────────────────────────────────

const ALICE = { token: 'token-alice', userId: 1001, login: 'alice' };
const BOB = { token: 'token-bob', userId: 1002, login: 'bob' };
const EVE = { token: 'token-eve', userId: 1003, login: 'eve' };

/** Stub token verifier mapping test tokens to principals. */
const stubVerifier: TokenVerifier = async (token: string) => {
  const map: Record<string, { githubUserId: number; githubLogin: string }> = {
    [ALICE.token]: { githubUserId: ALICE.userId, githubLogin: ALICE.login },
    [BOB.token]: { githubUserId: BOB.userId, githubLogin: BOB.login },
    [EVE.token]: { githubUserId: EVE.userId, githubLogin: EVE.login },
  };
  return map[token] ?? null;
};

/** Find a random available port for test isolation. */
function getTestPort(): number {
  return 30000 + Math.floor(Math.random() * 10000);
}

/** Helper for authenticated relay requests. */
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

describe('relay async messaging core', () => {
  let server: RelayServer | null = null;
  let port: number;
  let messageStore: RelayMessageStore;

  beforeEach(async () => {
    port = getTestPort();
    messageStore = new RelayMessageStore();

    const config = loadRelayConfig({ MORS_RELAY_PORT: String(port), MORS_RELAY_HOST: '127.0.0.1' });

    // Create participant store backed by message store
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

  // ── VAL-RELAY-001: Cross-developer send/inbox delivery ────────────

  describe('VAL-RELAY-001: cross-developer send/inbox delivery', () => {
    it('alice can send a message to bob via relay', async () => {
      const { status, body } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Hello from Alice!',
          subject: 'Test message',
        },
      });

      expect(status).toBe(201);
      const msg = body as Record<string, unknown>;
      expect(msg['id']).toMatch(/^msg_/);
      expect(msg['thread_id']).toMatch(/^thr_/);
      expect(msg['sender_id']).toBe(ALICE.userId);
      expect(msg['sender_login']).toBe(ALICE.login);
      expect(msg['recipient_id']).toBe(BOB.userId);
      expect(msg['body']).toBe('Hello from Alice!');
      expect(msg['state']).toBe('delivered');
    });

    it('bob sees alice message in inbox', async () => {
      // Alice sends
      await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Hello Bob!' },
      });

      // Bob checks inbox
      const { status, body } = await relayFetch(port, '/inbox', {
        token: BOB.token,
      });

      expect(status).toBe(200);
      const result = body as Record<string, unknown>;
      const messages = result['messages'] as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(1);
      expect(messages[0]['body']).toBe('Hello Bob!');
      expect(messages[0]['sender_id']).toBe(ALICE.userId);
    });

    it('alice does not see bob-bound message in her own inbox', async () => {
      await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'For Bob only' },
      });

      const { status, body } = await relayFetch(port, '/inbox', {
        token: ALICE.token,
      });

      expect(status).toBe(200);
      const result = body as Record<string, unknown>;
      const messages = result['messages'] as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(0);
    });

    it('message IDs match between send response and inbox', async () => {
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'ID check' },
      });

      const sendMsg = sendRes.body as Record<string, unknown>;
      const sentId = sendMsg['id'];

      const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
      const inboxResult = inboxRes.body as Record<string, unknown>;
      const inboxMessages = inboxResult['messages'] as Array<Record<string, unknown>>;

      expect(inboxMessages[0]['id']).toBe(sentId);
    });

    it('multiple messages from different senders appear in recipient inbox', async () => {
      await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'From Alice' },
      });

      await relayFetch(port, '/messages', {
        method: 'POST',
        token: EVE.token,
        body: { recipient_id: BOB.userId, body: 'From Eve' },
      });

      const { body } = await relayFetch(port, '/inbox', { token: BOB.token });
      const result = body as Record<string, unknown>;
      const messages = result['messages'] as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(2);

      const bodies = messages.map((m) => m['body']);
      expect(bodies).toContain('From Alice');
      expect(bodies).toContain('From Eve');
    });

    it('send requires authentication', async () => {
      const { status } = await relayFetch(port, '/messages', {
        method: 'POST',
        body: { recipient_id: BOB.userId, body: 'No auth' },
      });

      expect(status).toBe(401);
    });

    it('inbox requires authentication', async () => {
      const { status } = await relayFetch(port, '/inbox', {});
      expect(status).toBe(401);
    });

    it('send validates required fields', async () => {
      const { status, body } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId },
      });

      expect(status).toBe(400);
      const result = body as Record<string, unknown>;
      expect(result['error']).toBeDefined();
    });

    it('send rejects missing recipient_id', async () => {
      const { status } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { body: 'No recipient' },
      });

      expect(status).toBe(400);
    });
  });

  // ── VAL-RELAY-002: Read state independent from ack state ──────────

  describe('VAL-RELAY-002: read state independent from ack state', () => {
    it('reading a message does not change its state from delivered', async () => {
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Read test' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // Bob reads the message
      const readRes = await relayFetch(port, `/messages/${msgId}/read`, {
        method: 'POST',
        token: BOB.token,
      });

      expect(readRes.status).toBe(200);
      const readMsg = (readRes.body as Record<string, unknown>)['message'] as Record<
        string,
        unknown
      >;
      expect(readMsg['state']).toBe('delivered');
      expect(readMsg['read_at']).not.toBeNull();
      expect(readMsg['acked_at']).toBeNull();
    });

    it('reading does not imply ack', async () => {
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Read not ack' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // Read
      await relayFetch(port, `/messages/${msgId}/read`, {
        method: 'POST',
        token: BOB.token,
      });

      // Check state from inbox — should still be delivered, not acked
      const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
      const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      const msg = messages.find((m) => m['id'] === msgId);
      expect(msg).toBeDefined();
      expect(msg?.['state']).toBe('delivered');
      expect(msg?.['read_at']).not.toBeNull();
      expect(msg?.['acked_at']).toBeNull();
    });

    it('ack can happen independently of read', async () => {
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Ack without read' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // Ack without reading first
      const ackRes = await relayFetch(port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: BOB.token,
      });

      expect(ackRes.status).toBe(200);
      const ackMsg = (ackRes.body as Record<string, unknown>)['message'] as Record<string, unknown>;
      expect(ackMsg['state']).toBe('acked');
      expect(ackMsg['acked_at']).not.toBeNull();
      // read_at should still be null since we didn't read
      expect(ackMsg['read_at']).toBeNull();
    });

    it('read then ack produces correct final state', async () => {
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Read then ack' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // Read
      await relayFetch(port, `/messages/${msgId}/read`, {
        method: 'POST',
        token: BOB.token,
      });

      // Ack
      const ackRes = await relayFetch(port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: BOB.token,
      });

      const ackMsg = (ackRes.body as Record<string, unknown>)['message'] as Record<string, unknown>;
      expect(ackMsg['state']).toBe('acked');
      expect(ackMsg['read_at']).not.toBeNull();
      expect(ackMsg['acked_at']).not.toBeNull();
    });

    it('re-reading is idempotent (read_at does not change)', async () => {
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Idempotent read' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // First read
      const read1 = await relayFetch(port, `/messages/${msgId}/read`, {
        method: 'POST',
        token: BOB.token,
      });
      const firstReadAt = (
        (read1.body as Record<string, unknown>)['message'] as Record<string, unknown>
      )['read_at'];
      const firstReadFlag = (read1.body as Record<string, unknown>)['first_read'];

      expect(firstReadFlag).toBe(true);

      // Second read
      const read2 = await relayFetch(port, `/messages/${msgId}/read`, {
        method: 'POST',
        token: BOB.token,
      });
      const secondReadAt = (
        (read2.body as Record<string, unknown>)['message'] as Record<string, unknown>
      )['read_at'];
      const secondReadFlag = (read2.body as Record<string, unknown>)['first_read'];

      expect(secondReadFlag).toBe(false);
      expect(secondReadAt).toBe(firstReadAt);
    });

    it('only recipient can read a message', async () => {
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Auth check' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // Eve tries to read Bob's message
      const { status } = await relayFetch(port, `/messages/${msgId}/read`, {
        method: 'POST',
        token: EVE.token,
      });

      expect(status).toBe(403);
    });

    it('only recipient can ack a message', async () => {
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Auth check ack' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // Eve tries to ack Bob's message
      const { status } = await relayFetch(port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: EVE.token,
      });

      expect(status).toBe(403);
    });
  });

  // ── VAL-RELAY-003: Ack state convergence across views ─────────────

  describe('VAL-RELAY-003: ack state converges across sender, recipient, and devices', () => {
    it('sender view reflects acked state after recipient acks', async () => {
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Convergence test' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // Bob acks
      await relayFetch(port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: BOB.token,
      });

      // Alice checks the message status (sender view)
      const senderView = await relayFetch(port, `/messages/${msgId}`, {
        token: ALICE.token,
      });

      expect(senderView.status).toBe(200);
      const msg = (senderView.body as Record<string, unknown>)['message'] as Record<
        string,
        unknown
      >;
      expect(msg['state']).toBe('acked');
      expect(msg['acked_at']).not.toBeNull();
    });

    it('recipient view and sender view converge on same acked state', async () => {
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'View convergence' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // Bob reads and acks
      await relayFetch(port, `/messages/${msgId}/read`, {
        method: 'POST',
        token: BOB.token,
      });
      await relayFetch(port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: BOB.token,
      });

      // Recipient view (Bob's inbox)
      const bobInbox = await relayFetch(port, '/inbox', { token: BOB.token });
      const bobMessages = (bobInbox.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      const bobView = bobMessages.find((m) => m['id'] === msgId);
      expect(bobView).toBeDefined();

      // Sender view (Alice fetches message)
      const aliceView = await relayFetch(port, `/messages/${msgId}`, {
        token: ALICE.token,
      });
      const aliceMsg = (aliceView.body as Record<string, unknown>)['message'] as Record<
        string,
        unknown
      >;

      // Both views agree on state
      expect(bobView?.['state']).toBe('acked');
      expect(aliceMsg['state']).toBe('acked');
      expect(bobView?.['acked_at']).toBe(aliceMsg['acked_at']);
      expect(bobView?.['read_at']).toBe(aliceMsg['read_at']);
    });

    it('re-acking is idempotent', async () => {
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Idempotent ack' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // First ack
      const ack1 = await relayFetch(port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: BOB.token,
      });
      expect((ack1.body as Record<string, unknown>)['first_ack']).toBe(true);

      // Second ack
      const ack2 = await relayFetch(port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: BOB.token,
      });
      expect(ack2.status).toBe(200);
      expect((ack2.body as Record<string, unknown>)['first_ack']).toBe(false);

      // State remains consistent
      const msg1 = (ack1.body as Record<string, unknown>)['message'] as Record<string, unknown>;
      const msg2 = (ack2.body as Record<string, unknown>)['message'] as Record<string, unknown>;
      expect(msg1['acked_at']).toBe(msg2['acked_at']);
    });

    it('multi-message ack convergence: each message acks independently', async () => {
      // Alice sends two messages to Bob
      const send1 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Message 1' },
      });
      const send2 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Message 2' },
      });

      const id1 = (send1.body as Record<string, unknown>)['id'] as string;
      const id2 = (send2.body as Record<string, unknown>)['id'] as string;

      // Bob acks only message 1
      await relayFetch(port, `/messages/${id1}/ack`, {
        method: 'POST',
        token: BOB.token,
      });

      // Check both messages from recipient view
      const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
      const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      const msg1 = messages.find((m) => m['id'] === id1);
      const msg2 = messages.find((m) => m['id'] === id2);
      expect(msg1).toBeDefined();
      expect(msg2).toBeDefined();

      expect(msg1?.['state']).toBe('acked');
      expect(msg2?.['state']).toBe('delivered');
    });

    it('device-level view reflects same state as account-level view', async () => {
      // Simulate two "devices" for Bob by using same auth principal
      // Both see the same relay-side state since the store is account-level
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Device convergence' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // "Device 1" acks
      await relayFetch(port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: BOB.token,
      });

      // "Device 2" (same user, same token) sees acked state
      const device2View = await relayFetch(port, `/messages/${msgId}`, {
        token: BOB.token,
      });

      const msg = (device2View.body as Record<string, unknown>)['message'] as Record<
        string,
        unknown
      >;
      expect(msg['state']).toBe('acked');
    });
  });

  // ── Error handling and edge cases ─────────────────────────────────

  describe('error handling', () => {
    it('read returns 404 for nonexistent message', async () => {
      const { status } = await relayFetch(port, '/messages/msg_nonexistent/read', {
        method: 'POST',
        token: BOB.token,
      });
      expect(status).toBe(404);
    });

    it('ack returns 404 for nonexistent message', async () => {
      const { status } = await relayFetch(port, '/messages/msg_nonexistent/ack', {
        method: 'POST',
        token: BOB.token,
      });
      expect(status).toBe(404);
    });

    it('GET single message returns 404 for nonexistent message', async () => {
      const { status } = await relayFetch(port, '/messages/msg_nonexistent', {
        token: ALICE.token,
      });
      expect(status).toBe(404);
    });

    it('GET single message requires auth', async () => {
      const { status } = await relayFetch(port, '/messages/msg_foo', {});
      expect(status).toBe(401);
    });

    it('read/ack require POST method', async () => {
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Method check' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      const readGet = await relayFetch(port, `/messages/${msgId}/read`, {
        token: BOB.token,
      });
      expect(readGet.status).toBe(405);

      const ackGet = await relayFetch(port, `/messages/${msgId}/ack`, {
        token: BOB.token,
      });
      expect(ackGet.status).toBe(405);
    });

    it('GET /messages/:id requires the caller to be a conversation participant', async () => {
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Private message' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // Eve is not a participant
      const { status } = await relayFetch(port, `/messages/${msgId}`, {
        token: EVE.token,
      });
      expect(status).toBe(403);
    });
  });
});
