/**
 * First-contact autonomy policy tests.
 *
 * Validates the first-contact permission model where:
 * - Message delivery always lands in inbox (never blocked by contact state)
 * - Unknown senders default to pending state with no autonomous actions
 * - Approved contacts allow autonomous actions; approval is remembered
 *
 * Covers:
 * - VAL-RELAY-011: Delivery to inbox is always allowed
 * - VAL-RELAY-012: First-contact permission gates autonomous actions only
 * - VAL-RELAY-013: Unknown senders in non-interactive mode remain pending
 *   with no auto-actions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { loadRelayConfig } from '../../src/relay/config.js';
import type { TokenVerifier, ParticipantStore } from '../../src/relay/auth-middleware.js';
import { RelayMessageStore } from '../../src/relay/message-store.js';
import { ContactStore } from '../../src/relay/contact-store.js';
import { getTestPort } from '../helpers/test-port.js';

// ── Test identities ─────────────────────────────────────────────────

const ALICE = { token: 'token-alice', userId: 'acct_1001', login: 'alice', deviceId: 'dev-alice' };
const BOB = { token: 'token-bob', userId: 'acct_1002', login: 'bob', deviceId: 'dev-bob' };
const CHARLIE = {
  token: 'token-charlie',
  userId: 'acct_1003',
  login: 'charlie',
  deviceId: 'dev-charlie',
};

/** Stub token verifier mapping test tokens to principals. */
const stubVerifier: TokenVerifier = async (token: string) => {
  const map: Record<string, { accountId: string; deviceId: string }> = {
    [ALICE.token]: { accountId: ALICE.userId, deviceId: ALICE.deviceId },
    [BOB.token]: { accountId: BOB.userId, deviceId: BOB.deviceId },
    [CHARLIE.token]: { accountId: CHARLIE.userId, deviceId: CHARLIE.deviceId },
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

// ── ContactStore unit tests ─────────────────────────────────────────

describe('ContactStore', () => {
  let contactStore: ContactStore;

  beforeEach(() => {
    contactStore = new ContactStore();
  });

  it('unknown sender returns pending status', () => {
    const status = contactStore.getContactStatus(BOB.userId, ALICE.userId);
    expect(status).toBe('pending');
  });

  it('isApprovedContact returns false for unknown sender', () => {
    expect(contactStore.isApprovedContact(BOB.userId, ALICE.userId)).toBe(false);
  });

  it('approving a contact changes status to approved', () => {
    contactStore.approveContact(BOB.userId, ALICE.userId);
    expect(contactStore.getContactStatus(BOB.userId, ALICE.userId)).toBe('approved');
    expect(contactStore.isApprovedContact(BOB.userId, ALICE.userId)).toBe(true);
  });

  it('approval is remembered (persistent within store lifecycle)', () => {
    contactStore.approveContact(BOB.userId, ALICE.userId);
    // Check multiple times — state is stable
    expect(contactStore.isApprovedContact(BOB.userId, ALICE.userId)).toBe(true);
    expect(contactStore.isApprovedContact(BOB.userId, ALICE.userId)).toBe(true);
  });

  it('approval is per-account scoped (not global)', () => {
    contactStore.approveContact(BOB.userId, ALICE.userId);
    // Alice is approved for Bob, but not for Charlie
    expect(contactStore.isApprovedContact(BOB.userId, ALICE.userId)).toBe(true);
    expect(contactStore.isApprovedContact(CHARLIE.userId, ALICE.userId)).toBe(false);
  });

  it('approval is directional (A approves B does not imply B approves A)', () => {
    contactStore.approveContact(BOB.userId, ALICE.userId);
    expect(contactStore.isApprovedContact(BOB.userId, ALICE.userId)).toBe(true);
    expect(contactStore.isApprovedContact(ALICE.userId, BOB.userId)).toBe(false);
  });

  it('approving same contact multiple times is idempotent', () => {
    contactStore.approveContact(BOB.userId, ALICE.userId);
    contactStore.approveContact(BOB.userId, ALICE.userId);
    expect(contactStore.isApprovedContact(BOB.userId, ALICE.userId)).toBe(true);
  });

  it('listPendingContacts returns senders who are not yet approved', () => {
    // Initially no pending contacts
    expect(contactStore.listPendingContacts(BOB.userId)).toEqual([]);

    // Record contact from Alice to Bob (not approved)
    contactStore.recordContact(BOB.userId, ALICE.userId);
    expect(contactStore.listPendingContacts(BOB.userId)).toEqual([ALICE.userId]);

    // Approve Alice — no longer pending
    contactStore.approveContact(BOB.userId, ALICE.userId);
    expect(contactStore.listPendingContacts(BOB.userId)).toEqual([]);
  });

  it('recordContact is idempotent for already-approved contacts', () => {
    contactStore.approveContact(BOB.userId, ALICE.userId);
    contactStore.recordContact(BOB.userId, ALICE.userId);
    expect(contactStore.isApprovedContact(BOB.userId, ALICE.userId)).toBe(true);
    expect(contactStore.listPendingContacts(BOB.userId)).toEqual([]);
  });
});

// ── Relay integration: VAL-RELAY-011 ────────────────────────────────

describe('VAL-RELAY-011: delivery to inbox is always allowed', () => {
  let server: RelayServer | null = null;
  let port: number;
  let messageStore: RelayMessageStore;
  let contactStore: ContactStore;

  beforeEach(async () => {
    port = getTestPort();
    messageStore = new RelayMessageStore();
    contactStore = new ContactStore();

    const config = loadRelayConfig({
      MORS_RELAY_PORT: String(port),
      MORS_RELAY_HOST: '127.0.0.1',
    });

    const participantStore: ParticipantStore = {
      async isParticipant(conversationId: string, accountId: string): Promise<boolean> {
        return messageStore.isParticipant(conversationId, accountId);
      },
    };

    server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: stubVerifier,
      participantStore,
      messageStore,
      contactStore,
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

  it('first-contact message from unknown sender is delivered to inbox', async () => {
    // Alice sends to Bob — first contact, no prior approval
    const sendRes = await relayFetch(port, '/messages', {
      method: 'POST',
      token: ALICE.token,
      body: { recipient_id: BOB.userId, body: 'Hello from a stranger!' },
    });
    expect(sendRes.status).toBe(201);

    // Bob's inbox shows the message
    const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
    const result = inboxRes.body as Record<string, unknown>;
    const messages = result['messages'] as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0]['body']).toBe('Hello from a stranger!');
    expect(messages[0]['sender_id']).toBe(ALICE.userId);
  });

  it('message from unknown sender includes first_contact annotation', async () => {
    const sendRes = await relayFetch(port, '/messages', {
      method: 'POST',
      token: ALICE.token,
      body: { recipient_id: BOB.userId, body: 'First contact message' },
    });
    expect(sendRes.status).toBe(201);
    const msg = sendRes.body as Record<string, unknown>;
    expect(msg['first_contact']).toBe(true);
  });

  it('message from approved sender does not have first_contact annotation', async () => {
    // Pre-approve Alice as Bob's contact
    contactStore.approveContact(BOB.userId, ALICE.userId);

    const sendRes = await relayFetch(port, '/messages', {
      method: 'POST',
      token: ALICE.token,
      body: { recipient_id: BOB.userId, body: 'Message from known contact' },
    });
    expect(sendRes.status).toBe(201);
    const msg = sendRes.body as Record<string, unknown>;
    expect(msg['first_contact']).toBe(false);
  });

  it('multiple first-contact messages from different unknown senders all land in inbox', async () => {
    await relayFetch(port, '/messages', {
      method: 'POST',
      token: ALICE.token,
      body: { recipient_id: BOB.userId, body: 'From Alice' },
    });
    await relayFetch(port, '/messages', {
      method: 'POST',
      token: CHARLIE.token,
      body: { recipient_id: BOB.userId, body: 'From Charlie' },
    });

    const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
    const result = inboxRes.body as Record<string, unknown>;
    const messages = result['messages'] as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    const bodies = messages.map((m) => m['body']);
    expect(bodies).toContain('From Alice');
    expect(bodies).toContain('From Charlie');
  });

  it('read and ack still work on first-contact messages', async () => {
    const sendRes = await relayFetch(port, '/messages', {
      method: 'POST',
      token: ALICE.token,
      body: { recipient_id: BOB.userId, body: 'First contact, can be read and acked' },
    });
    const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

    const readRes = await relayFetch(port, `/messages/${msgId}/read`, {
      method: 'POST',
      token: BOB.token,
    });
    expect(readRes.status).toBe(200);

    const ackRes = await relayFetch(port, `/messages/${msgId}/ack`, {
      method: 'POST',
      token: BOB.token,
    });
    expect(ackRes.status).toBe(200);
    const ackMsg = (ackRes.body as Record<string, unknown>)['message'] as Record<string, unknown>;
    expect(ackMsg['state']).toBe('acked');
  });
});

// ── Relay integration: VAL-RELAY-012 ────────────────────────────────

describe('VAL-RELAY-012: first-contact permission gates autonomous actions only', () => {
  let server: RelayServer | null = null;
  let port: number;
  let messageStore: RelayMessageStore;
  let contactStore: ContactStore;

  beforeEach(async () => {
    port = getTestPort();
    messageStore = new RelayMessageStore();
    contactStore = new ContactStore();

    const config = loadRelayConfig({
      MORS_RELAY_PORT: String(port),
      MORS_RELAY_HOST: '127.0.0.1',
    });

    const participantStore: ParticipantStore = {
      async isParticipant(conversationId: string, accountId: string): Promise<boolean> {
        return messageStore.isParticipant(conversationId, accountId);
      },
    };

    server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: stubVerifier,
      participantStore,
      messageStore,
      contactStore,
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

  it('autonomy status for unknown sender is pending (not allowed)', async () => {
    const statusRes = await relayFetch(port, '/contacts/status', {
      method: 'POST',
      token: BOB.token,
      body: { contact_account_id: ALICE.userId },
    });
    expect(statusRes.status).toBe(200);
    const result = statusRes.body as Record<string, unknown>;
    expect(result['status']).toBe('pending');
    expect(result['autonomy_allowed']).toBe(false);
  });

  it('approving a contact enables autonomy (remembered)', async () => {
    // Approve Alice via API
    const approveRes = await relayFetch(port, '/contacts/approve', {
      method: 'POST',
      token: BOB.token,
      body: { contact_account_id: ALICE.userId },
    });
    expect(approveRes.status).toBe(200);

    // Check status after approval
    const statusRes = await relayFetch(port, '/contacts/status', {
      method: 'POST',
      token: BOB.token,
      body: { contact_account_id: ALICE.userId },
    });
    expect(statusRes.status).toBe(200);
    const result = statusRes.body as Record<string, unknown>;
    expect(result['status']).toBe('approved');
    expect(result['autonomy_allowed']).toBe(true);
  });

  it('message from approved contact has autonomy_allowed=true', async () => {
    // Pre-approve Alice
    contactStore.approveContact(BOB.userId, ALICE.userId);

    const sendRes = await relayFetch(port, '/messages', {
      method: 'POST',
      token: ALICE.token,
      body: { recipient_id: BOB.userId, body: 'Approved sender message' },
    });
    expect(sendRes.status).toBe(201);

    // Check inbox — message should have autonomy annotation
    const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
    const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
      Record<string, unknown>
    >;
    expect(messages).toHaveLength(1);
    expect(messages[0]['first_contact']).toBe(false);
    expect(messages[0]['autonomy_allowed']).toBe(true);
  });

  it('message from unknown contact has autonomy_allowed=false', async () => {
    const sendRes = await relayFetch(port, '/messages', {
      method: 'POST',
      token: ALICE.token,
      body: { recipient_id: BOB.userId, body: 'Unknown sender message' },
    });
    expect(sendRes.status).toBe(201);

    const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
    const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
      Record<string, unknown>
    >;
    expect(messages).toHaveLength(1);
    expect(messages[0]['first_contact']).toBe(true);
    expect(messages[0]['autonomy_allowed']).toBe(false);
  });

  it('delivery succeeds regardless of first-contact status (inbox always populated)', async () => {
    // Send from unknown
    const unknownSend = await relayFetch(port, '/messages', {
      method: 'POST',
      token: ALICE.token,
      body: { recipient_id: BOB.userId, body: 'Unknown delivery' },
    });
    expect(unknownSend.status).toBe(201);

    // Pre-approve Charlie, then send
    contactStore.approveContact(BOB.userId, CHARLIE.userId);
    const knownSend = await relayFetch(port, '/messages', {
      method: 'POST',
      token: CHARLIE.token,
      body: { recipient_id: BOB.userId, body: 'Known delivery' },
    });
    expect(knownSend.status).toBe(201);

    // Both messages in inbox
    const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
    const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
      Record<string, unknown>
    >;
    expect(messages).toHaveLength(2);
  });

  it('approval remembers the contact permanently within store lifecycle', async () => {
    // Approve Alice
    await relayFetch(port, '/contacts/approve', {
      method: 'POST',
      token: BOB.token,
      body: { contact_account_id: ALICE.userId },
    });

    // Send multiple messages — all should be from approved contact
    await relayFetch(port, '/messages', {
      method: 'POST',
      token: ALICE.token,
      body: { recipient_id: BOB.userId, body: 'Message 1' },
    });
    await relayFetch(port, '/messages', {
      method: 'POST',
      token: ALICE.token,
      body: { recipient_id: BOB.userId, body: 'Message 2' },
    });

    const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
    const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
      Record<string, unknown>
    >;
    expect(messages).toHaveLength(2);
    for (const msg of messages) {
      expect(msg['first_contact']).toBe(false);
      expect(msg['autonomy_allowed']).toBe(true);
    }
  });
});

// ── Relay integration: VAL-RELAY-013 ────────────────────────────────

describe('VAL-RELAY-013: unknown senders in non-interactive mode remain pending with no auto-actions', () => {
  let server: RelayServer | null = null;
  let port: number;
  let messageStore: RelayMessageStore;
  let contactStore: ContactStore;

  beforeEach(async () => {
    port = getTestPort();
    messageStore = new RelayMessageStore();
    contactStore = new ContactStore();

    const config = loadRelayConfig({
      MORS_RELAY_PORT: String(port),
      MORS_RELAY_HOST: '127.0.0.1',
    });

    const participantStore: ParticipantStore = {
      async isParticipant(conversationId: string, accountId: string): Promise<boolean> {
        return messageStore.isParticipant(conversationId, accountId);
      },
    };

    server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: stubVerifier,
      participantStore,
      messageStore,
      contactStore,
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

  it('first-contact sender creates pending contact record on delivery', async () => {
    await relayFetch(port, '/messages', {
      method: 'POST',
      token: ALICE.token,
      body: { recipient_id: BOB.userId, body: 'First contact' },
    });

    // Contact should be recorded as pending
    expect(contactStore.getContactStatus(BOB.userId, ALICE.userId)).toBe('pending');
    expect(contactStore.isApprovedContact(BOB.userId, ALICE.userId)).toBe(false);
  });

  it('pending contacts list shows unapproved senders', async () => {
    await relayFetch(port, '/messages', {
      method: 'POST',
      token: ALICE.token,
      body: { recipient_id: BOB.userId, body: 'From Alice' },
    });
    await relayFetch(port, '/messages', {
      method: 'POST',
      token: CHARLIE.token,
      body: { recipient_id: BOB.userId, body: 'From Charlie' },
    });

    const pendingRes = await relayFetch(port, '/contacts/pending', {
      token: BOB.token,
    });
    expect(pendingRes.status).toBe(200);
    const result = pendingRes.body as Record<string, unknown>;
    const pending = result['pending'] as string[];
    expect(pending).toHaveLength(2);
    expect(pending).toContain(ALICE.userId);
    expect(pending).toContain(CHARLIE.userId);
  });

  it('no autonomous actions occur for messages from pending contacts', async () => {
    // Alice sends to Bob — first contact, pending state
    const sendRes = await relayFetch(port, '/messages', {
      method: 'POST',
      token: ALICE.token,
      body: { recipient_id: BOB.userId, body: 'Pending message' },
    });
    expect(sendRes.status).toBe(201);
    const msg = sendRes.body as Record<string, unknown>;

    // Message is delivered but marked as no-autonomy
    expect(msg['first_contact']).toBe(true);
    expect(msg['autonomy_allowed']).toBe(false);

    // Verify the message is in inbox but remains in delivered state
    // (no auto-ack or auto-read occurred)
    const inboxRes = await relayFetch(port, '/inbox', { token: BOB.token });
    const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
      Record<string, unknown>
    >;
    expect(messages).toHaveLength(1);
    expect(messages[0]['state']).toBe('delivered');
    expect(messages[0]['read_at']).toBeNull();
    expect(messages[0]['acked_at']).toBeNull();
  });

  it('approving a pending contact transitions them to approved and enables future autonomy', async () => {
    // Alice sends first-contact message
    await relayFetch(port, '/messages', {
      method: 'POST',
      token: ALICE.token,
      body: { recipient_id: BOB.userId, body: 'First contact' },
    });
    expect(contactStore.getContactStatus(BOB.userId, ALICE.userId)).toBe('pending');

    // Bob approves Alice
    const approveRes = await relayFetch(port, '/contacts/approve', {
      method: 'POST',
      token: BOB.token,
      body: { contact_account_id: ALICE.userId },
    });
    expect(approveRes.status).toBe(200);

    // Alice is now approved
    expect(contactStore.getContactStatus(BOB.userId, ALICE.userId)).toBe('approved');

    // Next message from Alice has autonomy allowed
    const sendRes = await relayFetch(port, '/messages', {
      method: 'POST',
      token: ALICE.token,
      body: { recipient_id: BOB.userId, body: 'Now approved' },
    });
    expect(sendRes.status).toBe(201);
    const msg = sendRes.body as Record<string, unknown>;
    expect(msg['first_contact']).toBe(false);
    expect(msg['autonomy_allowed']).toBe(true);
  });

  it('pending contact remains pending until explicit approval (no auto-approve on read/ack)', async () => {
    const sendRes = await relayFetch(port, '/messages', {
      method: 'POST',
      token: ALICE.token,
      body: { recipient_id: BOB.userId, body: 'Read me' },
    });
    const msgId = (sendRes.body as Record<string, unknown>)['id'] as string;

    // Bob reads and acks the message manually
    await relayFetch(port, `/messages/${msgId}/read`, {
      method: 'POST',
      token: BOB.token,
    });
    await relayFetch(port, `/messages/${msgId}/ack`, {
      method: 'POST',
      token: BOB.token,
    });

    // Contact is still pending — read/ack does NOT auto-approve
    expect(contactStore.getContactStatus(BOB.userId, ALICE.userId)).toBe('pending');
  });

  it('contact approval is specific — approving one sender does not approve all', async () => {
    // Both Alice and Charlie send to Bob
    await relayFetch(port, '/messages', {
      method: 'POST',
      token: ALICE.token,
      body: { recipient_id: BOB.userId, body: 'From Alice' },
    });
    await relayFetch(port, '/messages', {
      method: 'POST',
      token: CHARLIE.token,
      body: { recipient_id: BOB.userId, body: 'From Charlie' },
    });

    // Approve only Alice
    await relayFetch(port, '/contacts/approve', {
      method: 'POST',
      token: BOB.token,
      body: { contact_account_id: ALICE.userId },
    });

    // Alice is approved, Charlie still pending
    expect(contactStore.isApprovedContact(BOB.userId, ALICE.userId)).toBe(true);
    expect(contactStore.isApprovedContact(BOB.userId, CHARLIE.userId)).toBe(false);

    // Pending contacts list shows only Charlie
    const pendingRes = await relayFetch(port, '/contacts/pending', {
      token: BOB.token,
    });
    const result = pendingRes.body as Record<string, unknown>;
    const pending = result['pending'] as string[];
    expect(pending).toEqual([CHARLIE.userId]);
  });
});
