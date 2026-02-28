/**
 * Tests for relay sender identity binding and spoof prevention.
 *
 * Covers:
 * - VAL-RELAY-008: Sender spoofing is prevented by auth principal binding
 *   - Relay rejects or ignores client-provided spoofed sender values
 *   - Delivered messages always reflect authenticated principal identity
 *
 * Tests verify that:
 * 1. Spoofed sender_id in request body is rejected with 403
 * 2. Spoofed sender_login in request body is rejected with 403
 * 3. Messages always reflect the authenticated principal, never client-provided sender fields
 * 4. Legitimate sends (without spoofed fields) continue to work
 * 5. Spoof rejection applies to reply paths as well
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { loadRelayConfig } from '../../src/relay/config.js';
import type { TokenVerifier, ParticipantStore } from '../../src/relay/auth-middleware.js';
import { RelayMessageStore } from '../../src/relay/message-store.js';
import { getTestPort } from '../helpers/test-port.js';

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

describe('relay sender identity binding and spoof prevention (VAL-RELAY-008)', () => {
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

  // ── Spoofed sender_id rejection ───────────────────────────────────

  describe('spoofed sender_id rejection', () => {
    it('rejects send with sender_id that does not match authenticated principal', async () => {
      const { status, body } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Spoofed message from Eve',
          sender_id: EVE.userId, // Alice is authenticated but claims to be Eve
        },
      });

      expect(status).toBe(403);
      const result = body as Record<string, unknown>;
      expect(result['error']).toBe('forbidden');
      expect(typeof result['detail']).toBe('string');
      expect((result['detail'] as string).toLowerCase()).toMatch(/sender|spoof|identity/);
    });

    it('rejects send with sender_id of recipient (impersonation attempt)', async () => {
      const { status } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Pretending to be Bob',
          sender_id: BOB.userId, // Alice claims to be Bob
        },
      });

      expect(status).toBe(403);
    });

    it('spoofed send does not create a message in recipient inbox', async () => {
      // Attempt spoof
      await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Should not be delivered',
          sender_id: EVE.userId,
        },
      });

      // Bob's inbox should be empty
      const { body } = await relayFetch(port, '/inbox', { token: BOB.token });
      const result = body as Record<string, unknown>;
      const messages = result['messages'] as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(0);
    });
  });

  // ── Spoofed sender_login rejection ────────────────────────────────

  describe('spoofed sender_login rejection', () => {
    it('rejects send with sender_login that does not match authenticated principal', async () => {
      const { status, body } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Spoofed login',
          sender_login: 'eve', // Alice claims to have Eve's login
        },
      });

      expect(status).toBe(403);
      const result = body as Record<string, unknown>;
      expect(result['error']).toBe('forbidden');
    });

    it('rejects send with both spoofed sender_id and sender_login', async () => {
      const { status } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Full spoof attempt',
          sender_id: EVE.userId,
          sender_login: 'eve',
        },
      });

      expect(status).toBe(403);
    });
  });

  // ── Matching sender fields are accepted ───────────────────────────

  describe('matching sender fields are accepted (no false positive)', () => {
    it('accepts send with sender_id matching authenticated principal', async () => {
      const { status, body } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Correct sender_id',
          sender_id: ALICE.userId, // Matches auth principal
        },
      });

      expect(status).toBe(201);
      const msg = body as Record<string, unknown>;
      expect(msg['sender_id']).toBe(ALICE.userId);
      expect(msg['sender_login']).toBe(ALICE.login);
    });

    it('accepts send with sender_login matching authenticated principal', async () => {
      const { status, body } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Correct sender_login',
          sender_login: 'alice', // Matches auth principal
        },
      });

      expect(status).toBe(201);
      const msg = body as Record<string, unknown>;
      expect(msg['sender_login']).toBe(ALICE.login);
    });

    it('accepts send with both matching sender_id and sender_login', async () => {
      const { status } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Both match',
          sender_id: ALICE.userId,
          sender_login: 'alice',
        },
      });

      expect(status).toBe(201);
    });
  });

  // ── Legitimate sends without sender fields work ───────────────────

  describe('legitimate sends without spoofed fields', () => {
    it('send without sender fields uses auth principal identity', async () => {
      const { status, body } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Normal message',
        },
      });

      expect(status).toBe(201);
      const msg = body as Record<string, unknown>;
      expect(msg['sender_id']).toBe(ALICE.userId);
      expect(msg['sender_login']).toBe(ALICE.login);
    });

    it('delivered messages always reflect authenticated principal identity', async () => {
      // Alice sends as herself
      await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'From Alice' },
      });

      // Eve sends as herself
      await relayFetch(port, '/messages', {
        method: 'POST',
        token: EVE.token,
        body: { recipient_id: BOB.userId, body: 'From Eve' },
      });

      // Bob's inbox should show correct sender identities
      const { body } = await relayFetch(port, '/inbox', { token: BOB.token });
      const result = body as Record<string, unknown>;
      const messages = result['messages'] as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(2);

      const aliceMsg = messages.find((m) => m['body'] === 'From Alice');
      const eveMsg = messages.find((m) => m['body'] === 'From Eve');

      expect(aliceMsg).toBeDefined();
      expect(aliceMsg?.['sender_id']).toBe(ALICE.userId);
      expect(aliceMsg?.['sender_login']).toBe(ALICE.login);

      expect(eveMsg).toBeDefined();
      expect(eveMsg?.['sender_id']).toBe(EVE.userId);
      expect(eveMsg?.['sender_login']).toBe(EVE.login);
    });
  });

  // ── Spoof prevention on reply path ────────────────────────────────

  describe('spoof prevention on reply path', () => {
    it('rejects reply with spoofed sender_id', async () => {
      // Alice sends a legitimate message first
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Root message' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // Bob tries to reply with spoofed sender_id
      const { status } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: BOB.token,
        body: {
          recipient_id: ALICE.userId,
          body: 'Spoofed reply',
          in_reply_to: msgId,
          sender_id: EVE.userId, // Bob claims to be Eve in the reply
        },
      });

      expect(status).toBe(403);
    });

    it('legitimate reply without spoofed fields works correctly', async () => {
      // Alice sends a message
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Root message' },
      });
      const rootMsg = sendRes.body as Record<string, unknown>;
      const rootId = rootMsg['id'] as string;
      const threadId = rootMsg['thread_id'] as string;

      // Bob replies legitimately
      const { status, body } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: BOB.token,
        body: {
          recipient_id: ALICE.userId,
          body: 'Legitimate reply',
          in_reply_to: rootId,
        },
      });

      expect(status).toBe(201);
      const reply = body as Record<string, unknown>;
      expect(reply['sender_id']).toBe(BOB.userId);
      expect(reply['sender_login']).toBe(BOB.login);
      expect(reply['thread_id']).toBe(threadId);
      expect(reply['in_reply_to']).toBe(rootId);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('rejects sender_id=0 (invalid spoofed value)', async () => {
      const { status } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Zero sender',
          sender_id: 0,
        },
      });

      expect(status).toBe(403);
    });

    it('ignores non-number sender_id (treated as absent, not a spoof)', async () => {
      // A string sender_id is not a valid spoof attempt — it's just junk that should be ignored
      const { status, body } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'String sender_id',
          sender_id: 'not-a-number',
        },
      });

      expect(status).toBe(201);
      const msg = body as Record<string, unknown>;
      expect(msg['sender_id']).toBe(ALICE.userId);
    });

    it('ignores non-string sender_login (treated as absent, not a spoof)', async () => {
      // A numeric sender_login is not a valid spoof attempt — it's junk
      const { status, body } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Numeric sender_login',
          sender_login: 12345,
        },
      });

      expect(status).toBe(201);
      const msg = body as Record<string, unknown>;
      expect(msg['sender_login']).toBe(ALICE.login);
    });

    it('no spoofed delivery even with valid-looking but mismatched sender fields', async () => {
      // Eve tries to send as Alice with Alice's correct userId but Eve's token
      // This should succeed because the *auth principal* (Eve) is who matters
      const { status } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: EVE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Eve claiming to be Alice',
          sender_id: ALICE.userId,
        },
      });

      // Should be rejected since Eve's token resolves to Eve, not Alice
      expect(status).toBe(403);

      // Verify no message was delivered
      const inbox = await relayFetch(port, '/inbox', { token: BOB.token });
      const result = inbox.body as Record<string, unknown>;
      const messages = result['messages'] as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(0);
    });
  });
});
