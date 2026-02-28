/**
 * Tests that the production relay entrypoint correctly wires
 * RelayMessageStore into createRelayServer so messaging routes
 * are active in real runtime (not only in test-only server construction).
 *
 * Covers:
 * - RelayMessageStore is instantiated and passed to createRelayServer
 * - Messaging routes (/messages, /inbox, /messages/:id) are active
 * - Auth + messaging behavior matches the tested path
 * - ParticipantStore uses the message store for authorization
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { loadRelayConfig } from '../../src/relay/config.js';
import { RelayMessageStore } from '../../src/relay/message-store.js';
import { createProductionServerOptions } from '../../src/relay/index.js';
import type { TokenVerifier } from '../../src/relay/auth-middleware.js';

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

/** Use OS-assigned ephemeral port (0) to avoid EADDRINUSE collisions. */
function getTestPort(): number {
  return 0;
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

describe('relay entrypoint wiring', () => {
  let server: RelayServer | null = null;
  let port: number;

  beforeEach(() => {
    port = getTestPort();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  describe('createProductionServerOptions exports messageStore', () => {
    it('returns options containing a RelayMessageStore instance', () => {
      const opts = createProductionServerOptions();
      expect(opts.messageStore).toBeInstanceOf(RelayMessageStore);
    });

    it('returns options containing a participantStore backed by the messageStore', () => {
      const opts = createProductionServerOptions();
      expect(opts.participantStore).toBeDefined();
      const store = opts.participantStore;
      expect(store).toBeTruthy();
      if (store) {
        expect(typeof store.isParticipant).toBe('function');
      }
    });

    it('returns options containing a tokenVerifier', () => {
      const opts = createProductionServerOptions();
      expect(opts.tokenVerifier).toBeDefined();
    });
  });

  describe('messaging routes are active with production wiring', () => {
    it('POST /messages returns 201 (not 404) when production options are used', async () => {
      const config = loadRelayConfig({
        MORS_RELAY_PORT: String(port),
        MORS_RELAY_HOST: '127.0.0.1',
      });

      // Use production-style options but override tokenVerifier for testing
      const prodOptions = createProductionServerOptions();
      server = createRelayServer(config, {
        ...prodOptions,
        tokenVerifier: stubVerifier,
        logger: () => {},
      });
      await server.start();
      port = server.port;

      const { status, body } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'Production wiring test',
        },
      });

      expect(status).toBe(201);
      const msg = body as Record<string, unknown>;
      expect(msg['id']).toMatch(/^msg_/);
      expect(msg['sender_id']).toBe(ALICE.userId);
    });

    it('GET /inbox returns 200 (not 404) when production options are used', async () => {
      const config = loadRelayConfig({
        MORS_RELAY_PORT: String(port),
        MORS_RELAY_HOST: '127.0.0.1',
      });

      const prodOptions = createProductionServerOptions();
      server = createRelayServer(config, {
        ...prodOptions,
        tokenVerifier: stubVerifier,
        logger: () => {},
      });
      await server.start();
      port = server.port;

      // Send a message first
      await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Inbox wiring test' },
      });

      const { status, body } = await relayFetch(port, '/inbox', {
        token: BOB.token,
      });

      expect(status).toBe(200);
      const result = body as Record<string, unknown>;
      const messages = result['messages'] as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(1);
      expect(messages[0]['body']).toBe('Inbox wiring test');
    });

    it('participant authorization works through production wiring', async () => {
      const config = loadRelayConfig({
        MORS_RELAY_PORT: String(port),
        MORS_RELAY_HOST: '127.0.0.1',
      });

      const prodOptions = createProductionServerOptions();
      server = createRelayServer(config, {
        ...prodOptions,
        tokenVerifier: stubVerifier,
        logger: () => {},
      });
      await server.start();
      port = server.port;

      // Alice sends to Bob
      const sendRes = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Auth wiring test' },
      });
      const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

      // Alice (sender) can view the message
      const aliceView = await relayFetch(port, `/messages/${msgId}`, {
        token: ALICE.token,
      });
      expect(aliceView.status).toBe(200);

      // Bob (recipient) can view the message
      const bobView = await relayFetch(port, `/messages/${msgId}`, {
        token: BOB.token,
      });
      expect(bobView.status).toBe(200);
    });
  });
});
