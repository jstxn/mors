/**
 * Tests that the production relay entrypoint correctly wires
 * RelayMessageStore and ContactStore into createRelayServer so messaging
 * routes and autonomy first-contact policy are active in real runtime
 * (not only in test-only server construction).
 *
 * Covers:
 * - RelayMessageStore is instantiated and passed to createRelayServer
 * - Messaging routes (/messages, /inbox, /messages/:id) are active
 * - Auth + messaging behavior matches the tested path
 * - ParticipantStore uses the message store for authorization
 * - ContactStore is wired so /contacts/* routes and first-contact annotations are active
 */

import { describe, it, expect, afterEach, beforeEach, afterAll, beforeAll } from 'vitest';
import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { loadRelayConfig } from '../../src/relay/config.js';
import { RelayMessageStore } from '../../src/relay/message-store.js';
import { ContactStore } from '../../src/relay/contact-store.js';
import { createProductionServerOptions } from '../../src/relay/index.js';
import type { TokenVerifier } from '../../src/relay/auth-middleware.js';
import { getTestPort } from '../helpers/test-port.js';
import { generateSigningKey } from '../../src/auth/native.js';

// ── Test identities ─────────────────────────────────────────────────

const ALICE = { token: 'token-alice', userId: 'acct_1001', login: 'alice' };
const BOB = { token: 'token-bob', userId: 'acct_1002', login: 'bob' };

/** Stub token verifier mapping test tokens to principals. */
const stubVerifier: TokenVerifier = async (token: string) => {
  const map: Record<string, { accountId: string; deviceId: string }> = {
    [ALICE.token]: { accountId: ALICE.userId, deviceId: ALICE.login },
    [BOB.token]: { accountId: BOB.userId, deviceId: BOB.login },
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

describe('relay entrypoint wiring', () => {
  let server: RelayServer | null = null;
  let port: number;
  let originalSigningKey: string | undefined;

  beforeAll(() => {
    originalSigningKey = process.env['MORS_RELAY_SIGNING_KEY'];
    // createProductionServerOptions requires a non-empty signing key (fail-closed)
    process.env['MORS_RELAY_SIGNING_KEY'] = generateSigningKey();
  });

  afterAll(() => {
    if (originalSigningKey === undefined) {
      delete process.env['MORS_RELAY_SIGNING_KEY'];
    } else {
      process.env['MORS_RELAY_SIGNING_KEY'] = originalSigningKey;
    }
  });

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

  describe('createProductionServerOptions exports contactStore', () => {
    it('returns options containing a ContactStore instance', () => {
      const opts = createProductionServerOptions();
      expect(opts.contactStore).toBeInstanceOf(ContactStore);
    });

    it('contactStore is functional (can record and evaluate contacts)', () => {
      const opts = createProductionServerOptions();
      const store = opts.contactStore;
      expect(store).toBeDefined();
      if (!store) return;
      // Initially unknown contacts are pending
      expect(store.getContactStatus('owner', 'sender')).toBe('pending');
      // After approval, status changes
      store.approveContact('owner', 'sender');
      expect(store.getContactStatus('owner', 'sender')).toBe('approved');
    });
  });

  describe('first-contact policy routes are active with production wiring', () => {
    it('POST /contacts/status returns 200 (not 404) when production options are used', async () => {
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

      const { status, body } = await relayFetch(port, '/contacts/status', {
        method: 'POST',
        token: ALICE.token,
        body: { contact_account_id: BOB.userId },
      });

      expect(status).toBe(200);
      const result = body as Record<string, unknown>;
      expect(result['owner_account_id']).toBe(ALICE.userId);
      expect(result['contact_account_id']).toBe(BOB.userId);
      expect(result['status']).toBe('pending');
      expect(result['autonomy_allowed']).toBe(false);
    });

    it('POST /contacts/approve returns 200 (not 404) when production options are used', async () => {
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

      const { status, body } = await relayFetch(port, '/contacts/approve', {
        method: 'POST',
        token: ALICE.token,
        body: { contact_account_id: BOB.userId },
      });

      expect(status).toBe(200);
      const result = body as Record<string, unknown>;
      expect(result['status']).toBe('approved');
      expect(result['autonomy_allowed']).toBe(true);
    });

    it('GET /contacts/pending returns 200 (not 404) when production options are used', async () => {
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

      const { status, body } = await relayFetch(port, '/contacts/pending', {
        token: ALICE.token,
      });

      expect(status).toBe(200);
      const result = body as Record<string, unknown>;
      expect(result['owner_account_id']).toBe(ALICE.userId);
      expect(result['pending']).toEqual([]);
      expect(result['count']).toBe(0);
    });

    it('first-contact annotations appear on messages sent through production wiring', async () => {
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

      // First message from Alice to Bob — should be first contact
      const { status, body } = await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: {
          recipient_id: BOB.userId,
          body: 'First contact annotation test',
        },
      });

      expect(status).toBe(201);
      const msg = body as Record<string, unknown>;
      expect(msg['first_contact']).toBe(true);
      expect(msg['autonomy_allowed']).toBe(false);
    });

    it('inbox messages include first-contact annotations through production wiring', async () => {
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

      // Send a message
      await relayFetch(port, '/messages', {
        method: 'POST',
        token: ALICE.token,
        body: { recipient_id: BOB.userId, body: 'Inbox annotation test' },
      });

      // Check inbox includes first-contact annotations
      const { status, body } = await relayFetch(port, '/inbox', {
        token: BOB.token,
      });

      expect(status).toBe(200);
      const result = body as Record<string, unknown>;
      const messages = result['messages'] as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(1);
      expect(messages[0]['first_contact']).toBe(true);
      expect(messages[0]['autonomy_allowed']).toBe(false);
    });
  });
});
