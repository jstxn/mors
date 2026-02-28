/**
 * Tests for relay-aware reply/thread behavior with causal linkage and
 * idempotent dedupe/read/ack retry handling across reconnect and restart boundaries.
 *
 * Covers:
 * - VAL-RELAY-004: Reply preserves causal thread linkage
 * - VAL-RELAY-005: Dedupe/replay is idempotent for send/reply
 * - VAL-RELAY-009: Dedupe scope is account/context-safe
 * - VAL-RELAY-010: Read/ack retries are idempotent across reconnect/restart
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

/** Create a test server with fresh message store. Returns port + cleanup. */
function createTestServer(messageStore?: RelayMessageStore) {
  const port = getTestPort();
  const store = messageStore ?? new RelayMessageStore();

  const participantStore: ParticipantStore = {
    async isParticipant(conversationId: string, githubUserId: number): Promise<boolean> {
      return store.isParticipant(conversationId, githubUserId);
    },
  };

  const config = loadRelayConfig({ MORS_RELAY_PORT: String(port), MORS_RELAY_HOST: '127.0.0.1' });
  const server = createRelayServer(config, {
    logger: () => {},
    tokenVerifier: stubVerifier,
    participantStore,
    messageStore: store,
  });

  return { server, port, store };
}

describe('relay thread/reply dedupe and idempotent transitions', () => {
  let server: RelayServer | null = null;
  let port: number;
  let messageStore: RelayMessageStore;

  beforeEach(async () => {
    const setup = createTestServer();
    server = setup.server;
    port = setup.port;
    messageStore = setup.store;
    await server.start();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  // ── VAL-RELAY-004: Reply preserves causal thread linkage ──────────

  describe('VAL-RELAY-004: reply preserves causal thread linkage', () => {
    it('reply to a root message inherits thread_id from parent', async () => {
      // Alice sends a root message to Bob
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Root message' },
      });
      const rootMsg = sendRes.body as Record<string, unknown>;
      const rootThreadId = rootMsg['thread_id'] as string;
      const rootMsgId = rootMsg['id'] as string;

      // Bob replies to Alice's message
      const replyRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: BOB.token,
        body: {
          recipient_id: ALICE.userId,
          body: 'Reply to root',
          in_reply_to: rootMsgId,
        },
      });

      expect(replyRes.status).toBe(201);
      const replyMsg = replyRes.body as Record<string, unknown>;
      expect(replyMsg['thread_id']).toBe(rootThreadId);
      expect(replyMsg['in_reply_to']).toBe(rootMsgId);
    });

    it('nested reply preserves root thread_id', async () => {
      // Alice sends root
      const root = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Root' },
      });
      const rootMsg = root.body as Record<string, unknown>;
      const rootThreadId = rootMsg['thread_id'] as string;

      // Bob replies (depth 1)
      const reply1 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: BOB.token,
        body: {
          recipient_id: ALICE.userId,
          body: 'Reply depth 1',
          in_reply_to: rootMsg['id'] as string,
        },
      });
      const reply1Msg = reply1.body as Record<string, unknown>;

      // Alice replies to Bob's reply (depth 2)
      const reply2 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Reply depth 2',
          in_reply_to: reply1Msg['id'] as string,
        },
      });
      const reply2Msg = reply2.body as Record<string, unknown>;

      // All share the same root thread_id
      expect(reply1Msg['thread_id']).toBe(rootThreadId);
      expect(reply2Msg['thread_id']).toBe(rootThreadId);

      // Each reply points to its immediate parent
      expect(reply1Msg['in_reply_to']).toBe(rootMsg['id']);
      expect(reply2Msg['in_reply_to']).toBe(reply1Msg['id']);
    });

    it('root messages without in_reply_to get their own unique thread_id', async () => {
      const msg1 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Thread A' },
      });
      const msg2 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Thread B' },
      });

      const thread1 = (msg1.body as Record<string, unknown>)['thread_id'];
      const thread2 = (msg2.body as Record<string, unknown>)['thread_id'];

      expect(thread1).toMatch(/^thr_/);
      expect(thread2).toMatch(/^thr_/);
      expect(thread1).not.toBe(thread2);
    });

    it('reply to nonexistent parent returns error', async () => {
      const res = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Orphan reply',
          in_reply_to: 'msg_nonexistent',
        },
      });

      expect(res.status).toBe(404);
    });
  });

  // ── VAL-RELAY-005: Dedupe/replay is idempotent for send/reply ─────

  describe('VAL-RELAY-005: dedupe/replay is idempotent for send/reply', () => {
    it('sending with same dedupe_key twice returns the same canonical message', async () => {
      const dedupeKey = 'dup_test-unique-key-1';

      const send1 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Deduped message',
          dedupe_key: dedupeKey,
        },
      });

      const send2 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Deduped message',
          dedupe_key: dedupeKey,
        },
      });

      expect(send1.status).toBe(201);
      expect(send2.status).toBe(200); // Second returns 200 (idempotent, not 201)

      const msg1 = send1.body as Record<string, unknown>;
      const msg2 = send2.body as Record<string, unknown>;

      // Same canonical message returned
      expect(msg1['id']).toBe(msg2['id']);
      expect(msg1['thread_id']).toBe(msg2['thread_id']);
    });

    it('inbox shows only one message for deduplicated sends', async () => {
      const dedupeKey = 'dup_inbox-dedupe-check';

      await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Inbox count check',
          dedupe_key: dedupeKey,
        },
      });

      await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Inbox count check',
          dedupe_key: dedupeKey,
        },
      });

      const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
      const result = inboxRes.body as Record<string, unknown>;
      const messages = result['messages'] as Array<Record<string, unknown>>;

      expect(messages).toHaveLength(1);
    });

    it('reply with same dedupe_key twice returns the same canonical reply', async () => {
      // Send root message
      const root = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Root for reply dedupe' },
      });
      const rootMsgId = (root.body as Record<string, unknown>)['id'] as string;
      const rootThreadId = (root.body as Record<string, unknown>)['thread_id'] as string;

      const replyDedupeKey = 'dup_reply-dedupe-1';

      const reply1 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: BOB.token,
        body: {
          recipient_id: ALICE.userId,
          body: 'Reply deduped',
          in_reply_to: rootMsgId,
          dedupe_key: replyDedupeKey,
        },
      });

      const reply2 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: BOB.token,
        body: {
          recipient_id: ALICE.userId,
          body: 'Reply deduped',
          in_reply_to: rootMsgId,
          dedupe_key: replyDedupeKey,
        },
      });

      expect(reply1.status).toBe(201);
      expect(reply2.status).toBe(200);

      const r1 = reply1.body as Record<string, unknown>;
      const r2 = reply2.body as Record<string, unknown>;

      expect(r1['id']).toBe(r2['id']);
      expect(r1['thread_id']).toBe(rootThreadId);
      expect(r2['thread_id']).toBe(rootThreadId);
    });

    it('different dedupe_keys create distinct messages', async () => {
      const send1 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Message A',
          dedupe_key: 'dup_key-a',
        },
      });

      const send2 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Message B',
          dedupe_key: 'dup_key-b',
        },
      });

      const msg1 = send1.body as Record<string, unknown>;
      const msg2 = send2.body as Record<string, unknown>;

      expect(msg1['id']).not.toBe(msg2['id']);
    });

    it('sends without dedupe_key always create new messages', async () => {
      const send1 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'No key 1' },
      });

      const send2 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'No key 2' },
      });

      const msg1 = send1.body as Record<string, unknown>;
      const msg2 = send2.body as Record<string, unknown>;

      expect(msg1['id']).not.toBe(msg2['id']);
    });
  });

  // ── VAL-RELAY-009: Dedupe scope is account/context-safe ───────────

  describe('VAL-RELAY-009: dedupe scope is account/context-safe', () => {
    it('same dedupe_key from different accounts creates distinct messages', async () => {
      const sharedKey = 'dup_shared-key';

      const aliceSend = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'From Alice',
          dedupe_key: sharedKey,
        },
      });

      const eveSend = await relayFetch(port, '/messages', {
        method: 'POST',
        token: EVE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'From Eve',
          dedupe_key: sharedKey,
        },
      });

      expect(aliceSend.status).toBe(201);
      expect(eveSend.status).toBe(201);

      const aliceMsg = aliceSend.body as Record<string, unknown>;
      const eveMsg = eveSend.body as Record<string, unknown>;

      expect(aliceMsg['id']).not.toBe(eveMsg['id']);
    });

    it('same dedupe_key from same account but different recipients deduplicates', async () => {
      // The dedupe scope is per-sender — same sender + same key = same message
      // regardless of recipient. This is because dedupe keys represent the client's
      // intent to send a specific logical message.
      const key = 'dup_same-sender-diff-recipient';

      const send1 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'To Bob',
          dedupe_key: key,
        },
      });

      const send2 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: EVE.userId,
          body: 'To Eve',
          dedupe_key: key,
        },
      });

      // Second send should return the canonical message (deduped by sender + key)
      expect(send1.status).toBe(201);
      expect(send2.status).toBe(200);

      const msg1 = send1.body as Record<string, unknown>;
      const msg2 = send2.body as Record<string, unknown>;
      expect(msg1['id']).toBe(msg2['id']);
    });

    it('bob inbox shows only one message when alice retries with same dedupe_key', async () => {
      const key = 'dup_bob-inbox-safe';

      await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Safe delivery', dedupe_key: key },
      });

      await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Safe delivery', dedupe_key: key },
      });

      const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
      const result = inboxRes.body as Record<string, unknown>;
      const messages = result['messages'] as Array<Record<string, unknown>>;

      expect(messages).toHaveLength(1);
    });

    it('multiple retries (3+) with same dedupe_key all converge', async () => {
      const key = 'dup_triple-retry';

      const results: Array<{ status: number; body: unknown }> = [];
      for (let i = 0; i < 5; i++) {
        results.push(
          await relayFetch(port, '/messages', {
            method: 'POST',
            token: ALICE.token,
            body: { recipient_id: BOB.userId, body: 'Triple retry', dedupe_key: key },
          })
        );
      }

      // First is 201, rest are 200
      expect(results[0].status).toBe(201);
      for (let i = 1; i < results.length; i++) {
        expect(results[i].status).toBe(200);
      }

      // All return same message ID
      const ids = results.map((r) => (r.body as Record<string, unknown>)['id']);
      const uniqueIds = [...new Set(ids)];
      expect(uniqueIds).toHaveLength(1);
    });
  });

  // ── VAL-RELAY-010: Read/ack retries idempotent across reconnect/restart ─

  describe('VAL-RELAY-010: read/ack retries idempotent across reconnect/restart', () => {
    it('read retry after server restart does not create extra transitions', async () => {
      // Send a message
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Read stability' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // First read
      const read1 = await relayFetch(port, `/messages/${msgId}/read`, {
        method: 'POST',
        token: BOB.token,
      });
      expect(read1.status).toBe(200);
      const read1Body = read1.body as Record<string, unknown>;
      expect(read1Body['first_read']).toBe(true);
      const read1At = (read1Body['message'] as Record<string, unknown>)['read_at'];

      // Simulate "reconnect" — restart the server with the same store
      if (server) await server.close();
      const newSetup = createTestServer(messageStore);
      server = newSetup.server;
      port = newSetup.port;
      await server.start();

      // Re-read after restart
      const read2 = await relayFetch(port, `/messages/${msgId}/read`, {
        method: 'POST',
        token: BOB.token,
      });
      expect(read2.status).toBe(200);
      const read2Body = read2.body as Record<string, unknown>;
      expect(read2Body['first_read']).toBe(false);
      const read2At = (read2Body['message'] as Record<string, unknown>)['read_at'];

      // read_at timestamp is stable (no extra transition)
      expect(read2At).toBe(read1At);
    });

    it('ack retry after server restart does not create extra transitions', async () => {
      // Send a message
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Ack stability' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // First ack
      const ack1 = await relayFetch(port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: BOB.token,
      });
      expect(ack1.status).toBe(200);
      const ack1Body = ack1.body as Record<string, unknown>;
      expect(ack1Body['first_ack']).toBe(true);
      const ack1At = (ack1Body['message'] as Record<string, unknown>)['acked_at'];

      // Simulate "reconnect" — restart the server with the same store
      if (server) await server.close();
      const newSetup = createTestServer(messageStore);
      server = newSetup.server;
      port = newSetup.port;
      await server.start();

      // Re-ack after restart
      const ack2 = await relayFetch(port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: BOB.token,
      });
      expect(ack2.status).toBe(200);
      const ack2Body = ack2.body as Record<string, unknown>;
      expect(ack2Body['first_ack']).toBe(false);
      const ack2At = (ack2Body['message'] as Record<string, unknown>)['acked_at'];

      // acked_at timestamp is stable (no extra transition)
      expect(ack2At).toBe(ack1At);
    });

    it('read then ack, restart, re-read and re-ack all remain stable', async () => {
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Full lifecycle stability' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // Read and ack
      await relayFetch(port, `/messages/${msgId}/read`, {
        method: 'POST',
        token: BOB.token,
      });
      const ack = await relayFetch(port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: BOB.token,
      });
      const ackMsg = (ack.body as Record<string, unknown>)['message'] as Record<string, unknown>;
      const origReadAt = ackMsg['read_at'];
      const origAckedAt = ackMsg['acked_at'];
      const origState = ackMsg['state'];

      // Restart server
      if (server) await server.close();
      const newSetup = createTestServer(messageStore);
      server = newSetup.server;
      port = newSetup.port;
      await server.start();

      // Re-read and re-ack
      const reRead = await relayFetch(port, `/messages/${msgId}/read`, {
        method: 'POST',
        token: BOB.token,
      });
      const reAck = await relayFetch(port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: BOB.token,
      });

      const reReadBody = reRead.body as Record<string, unknown>;
      const reAckBody = reAck.body as Record<string, unknown>;
      const reAckMsg = reAckBody['message'] as Record<string, unknown>;

      // No extra transitions
      expect(reReadBody['first_read']).toBe(false);
      expect(reAckBody['first_ack']).toBe(false);
      expect(reAckMsg['read_at']).toBe(origReadAt);
      expect(reAckMsg['acked_at']).toBe(origAckedAt);
      expect(reAckMsg['state']).toBe(origState);
    });

    it('concurrent read retries produce stable state', async () => {
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Concurrent reads' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // Fire 5 concurrent reads
      const reads = await Promise.all(
        Array.from({ length: 5 }, () =>
          relayFetch(port, `/messages/${msgId}/read`, {
            method: 'POST',
            token: BOB.token,
          })
        )
      );

      // Exactly one should report first_read: true
      const firstReads = reads.filter(
        (r) => (r.body as Record<string, unknown>)['first_read'] === true
      );
      expect(firstReads).toHaveLength(1);

      // All should succeed
      reads.forEach((r) => expect(r.status).toBe(200));

      // All should show same read_at
      const readAts = reads.map(
        (r) =>
          ((r.body as Record<string, unknown>)['message'] as Record<string, unknown>)['read_at']
      );
      const uniqueReadAts = [...new Set(readAts)];
      expect(uniqueReadAts).toHaveLength(1);
    });

    it('concurrent ack retries produce stable state', async () => {
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Concurrent acks' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // Fire 5 concurrent acks
      const acks = await Promise.all(
        Array.from({ length: 5 }, () =>
          relayFetch(port, `/messages/${msgId}/ack`, {
            method: 'POST',
            token: BOB.token,
          })
        )
      );

      // Exactly one should report first_ack: true
      const firstAcks = acks.filter(
        (r) => (r.body as Record<string, unknown>)['first_ack'] === true
      );
      expect(firstAcks).toHaveLength(1);

      // All should succeed
      acks.forEach((r) => expect(r.status).toBe(200));

      // All should show same acked_at and state
      const ackedAts = acks.map(
        (r) =>
          ((r.body as Record<string, unknown>)['message'] as Record<string, unknown>)['acked_at']
      );
      const uniqueAckedAts = [...new Set(ackedAts)];
      expect(uniqueAckedAts).toHaveLength(1);
    });

    it('dedupe key survives server restart (same store)', async () => {
      const key = 'dup_restart-dedupe';

      // First send
      const send1 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Restart dedupe', dedupe_key: key },
      });
      expect(send1.status).toBe(201);
      const msg1Id = (send1.body as Record<string, unknown>)['id'] as string;

      // Restart server with same store
      if (server) await server.close();
      const newSetup = createTestServer(messageStore);
      server = newSetup.server;
      port = newSetup.port;
      await server.start();

      // Retry send with same dedupe key
      const send2 = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Restart dedupe', dedupe_key: key },
      });

      expect(send2.status).toBe(200);
      expect((send2.body as Record<string, unknown>)['id']).toBe(msg1Id);

      // Inbox has only one message
      const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
      const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages).toHaveLength(1);
    });
  });
});
