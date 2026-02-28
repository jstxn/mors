/**
 * Cross-area golden-path hardening tests.
 *
 * Validates the final cross-area integration points for the
 * install-to-messaging golden path, E2EE lifecycle continuity,
 * multi-device onboarding, revocation effects, and relay restart/deploy
 * state integrity.
 *
 * Covers:
 * - VAL-CROSS-001: Golden path from install to authenticated messaging succeeds
 *   Fresh install -> login -> send -> recipient inbox/read -> ack completes successfully.
 * - VAL-CROSS-005: E2EE confidentiality is preserved across lifecycle
 *   Encrypted send/reply/ack lifecycle keeps relay plaintext-free while
 *   recipient decrypt remains successful.
 * - VAL-CROSS-006: Multi-device onboarding preserves secure delivery continuity
 *   Two devices on same account can authenticate, exchange keys, and receive
 *   secure messages correctly.
 * - VAL-CROSS-007: Revoked device cannot decrypt new messages after rotation
 *   After revocation/rotation, revoked device fails decrypt while active device
 *   continues normally.
 * - VAL-CROSS-008: Relay restart/deploy preserves pending/delivered/acked integrity
 *   After relay restart/deploy, message lifecycle states remain consistent and actionable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createRelayServer,
  type RelayServer,
  type RelayServerOptions,
} from '../../src/relay/server.js';
import {
  RelayMessageStore,
  type RelayMessageStoreSnapshot,
} from '../../src/relay/message-store.js';
import type { RelayConfig } from '../../src/relay/config.js';
import type { TokenVerifier, AuthPrincipal } from '../../src/relay/auth-middleware.js';

import {
  generateDeviceKeys,
  persistDeviceKeys,
  type DeviceKeyBundle,
} from '../../src/e2ee/device-keys.js';

import { performKeyExchange, revokeDevice, isDeviceRevoked } from '../../src/e2ee/key-exchange.js';

import {
  encryptMessage,
  decryptMessage,
  decryptMessageStrict,
  type EncryptedPayload,
} from '../../src/e2ee/cipher.js';

import { StaleKeyError, CipherError } from '../../src/errors.js';

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

/** Standard test principals. */
const ALICE_PRINCIPAL: AuthPrincipal = { githubUserId: 1001, githubLogin: 'alice' };
const BOB_PRINCIPAL: AuthPrincipal = { githubUserId: 1002, githubLogin: 'bob' };

/** Controllable token verifier for test auth. */
function controllableTokenVerifier(): {
  verifier: TokenVerifier;
  expireToken: (token: string) => void;
  restoreToken: (token: string, principal: AuthPrincipal) => void;
} {
  const principals = new Map<string, AuthPrincipal>([
    ['token-alice', ALICE_PRINCIPAL],
    ['token-bob', BOB_PRINCIPAL],
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

/** Create a temp directory for E2EE key storage. */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mors-golden-path-'));
}

/** Setup a device with bootstrapped E2EE keys. */
function setupDevice(baseDir: string, name: string): { keysDir: string; bundle: DeviceKeyBundle } {
  const keysDir = join(baseDir, name, 'e2ee');
  const bundle = generateDeviceKeys();
  persistDeviceKeys(keysDir, bundle);
  return { keysDir, bundle };
}

/** Setup two devices with completed key exchange. */
function setupKeyExchangePair(tempDir: string) {
  const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice');
  const { keysDir: bobKeysDir, bundle: bobBundle } = setupDevice(tempDir, 'bob');

  const aliceSession = performKeyExchange(
    aliceKeysDir,
    aliceBundle,
    bobBundle.x25519PublicKey,
    bobBundle.deviceId,
    bobBundle.fingerprint
  );

  const bobSession = performKeyExchange(
    bobKeysDir,
    bobBundle,
    aliceBundle.x25519PublicKey,
    aliceBundle.deviceId,
    aliceBundle.fingerprint
  );

  return {
    aliceKeysDir,
    aliceBundle,
    bobKeysDir,
    bobBundle,
    aliceSession,
    bobSession,
    sharedSecret: aliceSession.sharedSecret,
  };
}

/** Parse SSE events from raw text chunks. */
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

function parseEventData(event: SSEEvent): Record<string, unknown> {
  expect(event.data).toBeDefined();
  return JSON.parse(event.data ?? '{}') as Record<string, unknown>;
}

/** Open an SSE connection with event collection helpers. */
function openSSE(
  port: number,
  token: string,
  opts?: { lastEventId?: string }
): {
  events: SSEEvent[];
  statusCode: Promise<number>;
  close: () => void;
  waitForEvents: (count: number, timeoutMs?: number) => Promise<SSEEvent[]>;
  waitForEventType: (eventType: string, timeoutMs?: number) => Promise<SSEEvent>;
} {
  const events: SSEEvent[] = [];
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
  const statusCode = new Promise<number>((r) => {
    resolveStatus = r;
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
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
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
    if (events.length >= count) return Promise.resolve([...events]);
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

  return { events, statusCode, close, waitForEvents, waitForEventType };
}

/** Authenticated relay fetch helper. */
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

// ── Test Suite ───────────────────────────────────────────────────────

describe('cross-area golden-path hardening', () => {
  // ═══════════════════════════════════════════════════════════════════
  // VAL-CROSS-001: Golden path from install to authenticated messaging
  // ═══════════════════════════════════════════════════════════════════

  describe('VAL-CROSS-001: golden path from install to authenticated messaging', () => {
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
      };
      server = createRelayServer(testConfig(), opts);
      await server.start();
    });

    afterEach(async () => {
      await server.close();
    });

    it('fresh install -> auth -> send -> inbox -> read -> ack golden path completes', async () => {
      // Step 1: Unauthenticated user cannot send (simulates pre-login state)
      const noAuthSend = await relayFetch(server.port, '/messages', {
        method: 'POST',
        body: { recipient_id: BOB_PRINCIPAL.githubUserId, body: 'Before login' },
      });
      expect(noAuthSend.status).toBe(401);

      // Step 2: Alice authenticates (simulated by having a valid token)
      // Step 3: Alice sends a message to Bob
      const sendResp = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: {
          recipient_id: BOB_PRINCIPAL.githubUserId,
          body: 'Hello Bob, this is the golden path!',
        },
      });
      expect(sendResp.status).toBe(201);
      const sentMsg = sendResp.body as Record<string, unknown>;
      const msgId = sentMsg['id'] as string;
      expect(msgId).toMatch(/^msg_/);
      expect(sentMsg['thread_id']).toMatch(/^thr_/);
      expect(sentMsg['sender_id']).toBe(ALICE_PRINCIPAL.githubUserId);
      expect(sentMsg['recipient_id']).toBe(BOB_PRINCIPAL.githubUserId);
      expect(sentMsg['state']).toBe('delivered');
      expect(sentMsg['read_at']).toBeNull();
      expect(sentMsg['acked_at']).toBeNull();

      // Step 4: Bob checks inbox — message appears
      const inboxResp = await relayFetch(server.port, '/inbox', {
        token: 'token-bob',
      });
      expect(inboxResp.status).toBe(200);
      const inbox = inboxResp.body as Record<string, unknown>;
      const messages = inbox['messages'] as Array<Record<string, unknown>>;
      expect(messages.length).toBe(1);
      expect(messages[0]['id']).toBe(msgId);

      // Step 5: Bob reads the message — read_at set, state remains delivered
      const readResp = await relayFetch(server.port, `/messages/${msgId}/read`, {
        method: 'POST',
        token: 'token-bob',
      });
      expect(readResp.status).toBe(200);
      const readResult = readResp.body as Record<string, unknown>;
      expect((readResult['message'] as Record<string, unknown>)['read_at']).not.toBeNull();
      expect((readResult['message'] as Record<string, unknown>)['state']).toBe('delivered');

      // Step 6: Bob acks the message — state transitions to acked
      const ackResp = await relayFetch(server.port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: 'token-bob',
      });
      expect(ackResp.status).toBe(200);
      const ackResult = ackResp.body as Record<string, unknown>;
      expect((ackResult['message'] as Record<string, unknown>)['state']).toBe('acked');
      expect((ackResult['message'] as Record<string, unknown>)['acked_at']).not.toBeNull();

      // Step 7: Verify final inbox state is consistent
      const finalInbox = await relayFetch(server.port, '/inbox', {
        token: 'token-bob',
      });
      const finalMessages = (finalInbox.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(finalMessages[0]['state']).toBe('acked');
      expect(finalMessages[0]['read_at']).not.toBeNull();
      expect(finalMessages[0]['acked_at']).not.toBeNull();
    });

    it('golden path with reply preserves causal thread linkage', async () => {
      // Alice sends root message
      const rootResp = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: BOB_PRINCIPAL.githubUserId, body: 'Root message' },
      });
      expect(rootResp.status).toBe(201);
      const rootMsg = rootResp.body as Record<string, unknown>;
      const rootId = rootMsg['id'] as string;
      const threadId = rootMsg['thread_id'] as string;

      // Bob reads and replies
      await relayFetch(server.port, `/messages/${rootId}/read`, {
        method: 'POST',
        token: 'token-bob',
      });

      const replyResp = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-bob',
        body: {
          recipient_id: ALICE_PRINCIPAL.githubUserId,
          body: 'Reply to root',
          in_reply_to: rootId,
        },
      });
      expect(replyResp.status).toBe(201);
      const replyMsg = replyResp.body as Record<string, unknown>;
      expect(replyMsg['thread_id']).toBe(threadId);
      expect(replyMsg['in_reply_to']).toBe(rootId);

      // Alice acks root, reads reply, acks reply
      await relayFetch(server.port, `/messages/${rootId}/ack`, {
        method: 'POST',
        token: 'token-bob',
      });

      const replyId = replyMsg['id'] as string;
      await relayFetch(server.port, `/messages/${replyId}/read`, {
        method: 'POST',
        token: 'token-alice',
      });
      await relayFetch(server.port, `/messages/${replyId}/ack`, {
        method: 'POST',
        token: 'token-alice',
      });

      // Both participants see converged state
      const aliceInbox = await relayFetch(server.port, '/inbox', { token: 'token-alice' });
      const aliceMessages = (aliceInbox.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      const aliceReply = aliceMessages.find((m) => m['id'] === replyId);
      expect(aliceReply).toBeDefined();
      expect(aliceReply?.['state']).toBe('acked');
      expect(aliceReply?.['thread_id']).toBe(threadId);
    });

    it('golden path with SSE stream shows consistent events for full lifecycle', async () => {
      // Bob opens SSE stream
      const sseBob = openSSE(server.port, 'token-bob');
      try {
        await sseBob.waitForEvents(1); // connected

        // Alice sends message
        const sendResp = await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: BOB_PRINCIPAL.githubUserId, body: 'SSE golden path' },
        });
        const msgId = (sendResp.body as Record<string, unknown>)['id'] as string;
        await sseBob.waitForEvents(2); // connected + message_created

        // Bob reads
        await relayFetch(server.port, `/messages/${msgId}/read`, {
          method: 'POST',
          token: 'token-bob',
        });
        await sseBob.waitForEvents(3); // + message_read

        // Bob acks
        await relayFetch(server.port, `/messages/${msgId}/ack`, {
          method: 'POST',
          token: 'token-bob',
        });
        await sseBob.waitForEvents(4); // + message_acked

        // Verify event sequence
        const nonConnected = sseBob.events.filter((e) => e.event !== 'connected');
        expect(nonConnected.length).toBe(3);
        expect(nonConnected[0].event).toBe('message_created');
        expect(nonConnected[1].event).toBe('message_read');
        expect(nonConnected[2].event).toBe('message_acked');

        // All reference the same message
        for (const evt of nonConnected) {
          expect(parseEventData(evt).message_id).toBe(msgId);
        }
      } finally {
        sseBob.close();
      }
    });

    it('dedupe ensures idempotent golden path on retry', async () => {
      const dedupeKey = 'golden-path-dedupe-01';

      // Send same message twice with dedupe key
      const send1 = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: {
          recipient_id: BOB_PRINCIPAL.githubUserId,
          body: 'Deduped golden path',
          dedupe_key: dedupeKey,
        },
      });
      expect(send1.status).toBe(201);

      const send2 = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: {
          recipient_id: BOB_PRINCIPAL.githubUserId,
          body: 'Deduped golden path',
          dedupe_key: dedupeKey,
        },
      });
      expect(send2.status).toBe(200); // idempotent

      const msg1 = send1.body as Record<string, unknown>;
      const msg2 = send2.body as Record<string, unknown>;
      expect(msg1['id']).toBe(msg2['id']);

      // Inbox shows exactly one message
      const inboxResp = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
      const messages = (inboxResp.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages.length).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // VAL-CROSS-005: E2EE confidentiality preserved across lifecycle
  // ═══════════════════════════════════════════════════════════════════

  describe('VAL-CROSS-005: E2EE confidentiality preserved across send/reply/ack lifecycle', () => {
    let server: RelayServer;
    let messageStore: RelayMessageStore;
    let tempDir: string;

    beforeEach(async () => {
      tempDir = makeTempDir();
      messageStore = new RelayMessageStore();
      const opts: RelayServerOptions = {
        logger: () => {},
        tokenVerifier: async (token: string) => {
          const map: Record<string, AuthPrincipal> = {
            'token-alice': ALICE_PRINCIPAL,
            'token-bob': BOB_PRINCIPAL,
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
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('encrypted send keeps relay plaintext-free; recipient decrypts successfully', async () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);

      const canaryPlaintext = 'TOP_SECRET_GOLDEN_PATH_CONTENT_e2ee_test_12345';

      // Encrypt before sending
      const encrypted = encryptMessage(sharedSecret, canaryPlaintext);

      // Send encrypted payload through relay
      const sendResp = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: {
          recipient_id: BOB_PRINCIPAL.githubUserId,
          body: JSON.stringify(encrypted),
        },
      });
      expect(sendResp.status).toBe(201);
      const sentMsg = sendResp.body as Record<string, unknown>;
      const msgId = sentMsg['id'] as string;

      // Verify relay body does NOT contain plaintext
      const relayBody = sentMsg['body'] as string;
      expect(relayBody).not.toContain(canaryPlaintext);
      expect(relayBody).toContain('ciphertext');
      expect(relayBody).toContain('iv');
      expect(relayBody).toContain('authTag');

      // Bob reads from inbox — body is still encrypted
      const inboxResp = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
      const messages = (inboxResp.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      const inboxBody = messages[0]['body'] as string;
      expect(inboxBody).not.toContain(canaryPlaintext);

      // Bob decrypts the message
      const parsedPayload = JSON.parse(inboxBody) as EncryptedPayload;
      const decrypted = decryptMessage(sharedSecret, parsedPayload);
      expect(decrypted).toBe(canaryPlaintext);

      // Read and ack do not leak plaintext
      const readResp = await relayFetch(server.port, `/messages/${msgId}/read`, {
        method: 'POST',
        token: 'token-bob',
      });
      const readMsg = (readResp.body as Record<string, unknown>)['message'] as Record<
        string,
        unknown
      >;
      expect(readMsg['body'] as string).not.toContain(canaryPlaintext);

      const ackResp = await relayFetch(server.port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: 'token-bob',
      });
      const ackedMsg = (ackResp.body as Record<string, unknown>)['message'] as Record<
        string,
        unknown
      >;
      expect(ackedMsg['body'] as string).not.toContain(canaryPlaintext);
      expect(ackedMsg['state']).toBe('acked');
    });

    it('encrypted reply preserves confidentiality with thread linkage intact', async () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);

      const rootCanary = 'ROOT_SECRET_msg_content_xyz123';
      const replyCanary = 'REPLY_SECRET_msg_content_abc789';

      // Alice sends encrypted root
      const encRoot = encryptMessage(sharedSecret, rootCanary);
      const rootResp = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: {
          recipient_id: BOB_PRINCIPAL.githubUserId,
          body: JSON.stringify(encRoot),
        },
      });
      const rootMsg = rootResp.body as Record<string, unknown>;
      const rootId = rootMsg['id'] as string;
      const threadId = rootMsg['thread_id'] as string;

      // Bob replies with encrypted content
      const encReply = encryptMessage(sharedSecret, replyCanary);
      const replyResp = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-bob',
        body: {
          recipient_id: ALICE_PRINCIPAL.githubUserId,
          body: JSON.stringify(encReply),
          in_reply_to: rootId,
        },
      });
      const replyMsg = replyResp.body as Record<string, unknown>;
      expect(replyMsg['thread_id']).toBe(threadId);
      expect(replyMsg['in_reply_to']).toBe(rootId);

      // Verify no plaintext leakage in relay responses
      const replyBody = replyMsg['body'] as string;
      expect(replyBody).not.toContain(rootCanary);
      expect(replyBody).not.toContain(replyCanary);

      // Both messages decrypt correctly
      const parsedRoot = JSON.parse(rootMsg['body'] as string) as EncryptedPayload;
      expect(decryptMessage(sharedSecret, parsedRoot)).toBe(rootCanary);

      const parsedReply = JSON.parse(replyBody) as EncryptedPayload;
      expect(decryptMessage(sharedSecret, parsedReply)).toBe(replyCanary);

      // Ack root and reply — lifecycle completes with encryption intact
      await relayFetch(server.port, `/messages/${rootId}/ack`, {
        method: 'POST',
        token: 'token-bob',
      });
      const replyId = replyMsg['id'] as string;
      await relayFetch(server.port, `/messages/${replyId}/ack`, {
        method: 'POST',
        token: 'token-alice',
      });

      // Final inbox check — all encrypted, no plaintext
      const aliceInbox = await relayFetch(server.port, '/inbox', { token: 'token-alice' });
      const aliceMsgs = (aliceInbox.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      for (const msg of aliceMsgs) {
        expect(msg['body'] as string).not.toContain(rootCanary);
        expect(msg['body'] as string).not.toContain(replyCanary);
      }
    });

    it('SSE stream events do not leak plaintext during encrypted lifecycle', async () => {
      const { sharedSecret } = setupKeyExchangePair(tempDir);

      const sseBob = openSSE(server.port, 'token-bob');
      try {
        await sseBob.waitForEvents(1); // connected

        const canary = 'SSE_PLAINTEXT_LEAK_CANARY_98765';
        const encrypted = encryptMessage(sharedSecret, canary);

        // Send encrypted message
        await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: {
            recipient_id: BOB_PRINCIPAL.githubUserId,
            body: JSON.stringify(encrypted),
          },
        });

        // Wait for message_created event
        const createEvt = await sseBob.waitForEventType('message_created');

        // SSE event data should NOT contain plaintext
        // Note: SSE events only contain metadata (message_id, thread_id, etc.),
        // not the message body — so this is inherently safe, but let's verify
        expect(createEvt.data).not.toContain(canary);

        const evtData = parseEventData(createEvt);
        expect(evtData.message_id).toBeDefined();
        expect(evtData.thread_id).toBeDefined();
      } finally {
        sseBob.close();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // VAL-CROSS-006: Multi-device onboarding preserves secure delivery
  // ═══════════════════════════════════════════════════════════════════

  describe('VAL-CROSS-006: multi-device onboarding secure delivery continuity', () => {
    let server: RelayServer;
    let messageStore: RelayMessageStore;
    let tempDir: string;

    // Multi-device setup: Bob has two devices (bob-d1, bob-d2), Alice has one.
    // Both Bob devices are "on the same account" (same githubUserId).
    const BOB_D1_TOKEN = 'token-bob-d1';
    const BOB_D2_TOKEN = 'token-bob-d2';

    beforeEach(async () => {
      tempDir = makeTempDir();
      messageStore = new RelayMessageStore();
      const opts: RelayServerOptions = {
        logger: () => {},
        tokenVerifier: async (token: string) => {
          const map: Record<string, AuthPrincipal> = {
            'token-alice': ALICE_PRINCIPAL,
            // Both Bob device tokens authenticate as the same Bob account
            [BOB_D1_TOKEN]: BOB_PRINCIPAL,
            [BOB_D2_TOKEN]: BOB_PRINCIPAL,
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
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('two devices on same account each complete key exchange and decrypt messages', async () => {
      // Setup Alice's device
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice');

      // Setup Bob's two devices
      const { keysDir: bobD1KeysDir, bundle: bobD1Bundle } = setupDevice(tempDir, 'bob-d1');
      const { keysDir: bobD2KeysDir, bundle: bobD2Bundle } = setupDevice(tempDir, 'bob-d2');

      // Verify distinct device IDs
      expect(bobD1Bundle.deviceId).not.toBe(bobD2Bundle.deviceId);

      // Alice exchanges keys with both Bob devices
      const aliceSessionD1 = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobD1Bundle.x25519PublicKey,
        bobD1Bundle.deviceId,
        bobD1Bundle.fingerprint
      );

      const aliceSessionD2 = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobD2Bundle.x25519PublicKey,
        bobD2Bundle.deviceId,
        bobD2Bundle.fingerprint
      );

      // Bob D1 and D2 exchange keys with Alice
      const bobD1Session = performKeyExchange(
        bobD1KeysDir,
        bobD1Bundle,
        aliceBundle.x25519PublicKey,
        aliceBundle.deviceId,
        aliceBundle.fingerprint
      );

      const bobD2Session = performKeyExchange(
        bobD2KeysDir,
        bobD2Bundle,
        aliceBundle.x25519PublicKey,
        aliceBundle.deviceId,
        aliceBundle.fingerprint
      );

      // Each device pair has a different shared secret (different DH key pairs)
      // but each pair's secrets match
      expect(aliceSessionD1.sharedSecret).toEqual(bobD1Session.sharedSecret);
      expect(aliceSessionD2.sharedSecret).toEqual(bobD2Session.sharedSecret);
      expect(aliceSessionD1.sharedSecret).not.toEqual(aliceSessionD2.sharedSecret);

      const canary = 'MULTI_DEVICE_SECRET_MESSAGE_42';

      // Alice encrypts for Bob D1 and sends
      const encForD1 = encryptMessage(aliceSessionD1.sharedSecret, canary);
      const sendD1 = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: {
          recipient_id: BOB_PRINCIPAL.githubUserId,
          body: JSON.stringify(encForD1),
        },
      });
      expect(sendD1.status).toBe(201);

      // Alice encrypts for Bob D2 and sends
      const encForD2 = encryptMessage(aliceSessionD2.sharedSecret, canary);
      const sendD2 = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: {
          recipient_id: BOB_PRINCIPAL.githubUserId,
          body: JSON.stringify(encForD2),
        },
      });
      expect(sendD2.status).toBe(201);

      // Bob's inbox shows both messages (same account)
      const inboxResp = await relayFetch(server.port, '/inbox', { token: BOB_D1_TOKEN });
      const messages = (inboxResp.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages.length).toBe(2);

      // D1 decrypts its message
      const d1Msg = messages.find(
        (m) => m['id'] === (sendD1.body as Record<string, unknown>)['id']
      );
      expect(d1Msg).toBeDefined();
      const d1Body = (d1Msg as Record<string, unknown>)['body'] as string;
      const d1Payload = JSON.parse(d1Body) as EncryptedPayload;
      expect(decryptMessage(bobD1Session.sharedSecret, d1Payload)).toBe(canary);

      // D2 decrypts its message
      const d2Msg = messages.find(
        (m) => m['id'] === (sendD2.body as Record<string, unknown>)['id']
      );
      expect(d2Msg).toBeDefined();
      const d2Body = (d2Msg as Record<string, unknown>)['body'] as string;
      const d2Payload = JSON.parse(d2Body) as EncryptedPayload;
      expect(decryptMessage(bobD2Session.sharedSecret, d2Payload)).toBe(canary);

      // Cross-device decrypt fails (wrong shared secret)
      expect(() => decryptMessage(bobD1Session.sharedSecret, d2Payload)).toThrow(CipherError);
      expect(() => decryptMessage(bobD2Session.sharedSecret, d1Payload)).toThrow(CipherError);
    });

    it('both devices can SSE-stream the same account inbox events concurrently', async () => {
      // Both Bob devices open SSE connections
      const sseD1 = openSSE(server.port, BOB_D1_TOKEN);
      const sseD2 = openSSE(server.port, BOB_D2_TOKEN);
      try {
        await sseD1.waitForEvents(1); // connected
        await sseD2.waitForEvents(1); // connected

        // Alice sends a message to Bob
        const sendResp = await relayFetch(server.port, '/messages', {
          method: 'POST',
          token: 'token-alice',
          body: { recipient_id: BOB_PRINCIPAL.githubUserId, body: 'Multi-device SSE test' },
        });
        const msgId = (sendResp.body as Record<string, unknown>)['id'] as string;

        // Both devices receive the message_created event
        await sseD1.waitForEvents(2);
        await sseD2.waitForEvents(2);

        const d1MsgEvents = sseD1.events.filter((e) => e.event === 'message_created');
        const d2MsgEvents = sseD2.events.filter((e) => e.event === 'message_created');

        expect(d1MsgEvents.length).toBe(1);
        expect(d2MsgEvents.length).toBe(1);

        expect(parseEventData(d1MsgEvents[0]).message_id).toBe(msgId);
        expect(parseEventData(d2MsgEvents[0]).message_id).toBe(msgId);

        // D1 acks — both devices see the ack event
        await relayFetch(server.port, `/messages/${msgId}/ack`, {
          method: 'POST',
          token: BOB_D1_TOKEN,
        });

        await sseD1.waitForEvents(3); // connected + message_created + message_acked
        await sseD2.waitForEvents(3);

        const d1AckEvents = sseD1.events.filter((e) => e.event === 'message_acked');
        const d2AckEvents = sseD2.events.filter((e) => e.event === 'message_acked');

        expect(d1AckEvents.length).toBe(1);
        expect(d2AckEvents.length).toBe(1);
      } finally {
        sseD1.close();
        sseD2.close();
      }
    });

    it('multi-device read/ack from different devices converges to same state', async () => {
      // Alice sends two messages to Bob
      const send1 = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: BOB_PRINCIPAL.githubUserId, body: 'Message 1' },
      });
      const send2 = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: BOB_PRINCIPAL.githubUserId, body: 'Message 2' },
      });

      const msg1Id = (send1.body as Record<string, unknown>)['id'] as string;
      const msg2Id = (send2.body as Record<string, unknown>)['id'] as string;

      // D1 reads msg1, D2 reads msg2
      await relayFetch(server.port, `/messages/${msg1Id}/read`, {
        method: 'POST',
        token: BOB_D1_TOKEN,
      });
      await relayFetch(server.port, `/messages/${msg2Id}/read`, {
        method: 'POST',
        token: BOB_D2_TOKEN,
      });

      // D1 acks msg1, D2 acks msg2
      await relayFetch(server.port, `/messages/${msg1Id}/ack`, {
        method: 'POST',
        token: BOB_D1_TOKEN,
      });
      await relayFetch(server.port, `/messages/${msg2Id}/ack`, {
        method: 'POST',
        token: BOB_D2_TOKEN,
      });

      // Both devices see the same converged inbox state
      const d1Inbox = await relayFetch(server.port, '/inbox', { token: BOB_D1_TOKEN });
      const d2Inbox = await relayFetch(server.port, '/inbox', { token: BOB_D2_TOKEN });

      const d1Messages = (d1Inbox.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      const d2Messages = (d2Inbox.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;

      // Both views see both messages acked
      expect(d1Messages.length).toBe(2);
      expect(d2Messages.length).toBe(2);

      for (const msgs of [d1Messages, d2Messages]) {
        const m1 = msgs.find((m) => m['id'] === msg1Id);
        const m2 = msgs.find((m) => m['id'] === msg2Id);
        expect(m1?.['state']).toBe('acked');
        expect(m2?.['state']).toBe('acked');
        expect(m1?.['read_at']).not.toBeNull();
        expect(m2?.['read_at']).not.toBeNull();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // VAL-CROSS-007: Revoked device cannot decrypt after rotation
  // ═══════════════════════════════════════════════════════════════════

  describe('VAL-CROSS-007: revoked device fails decrypt while active device continues', () => {
    let server: RelayServer;
    let messageStore: RelayMessageStore;
    let tempDir: string;

    beforeEach(async () => {
      tempDir = makeTempDir();
      messageStore = new RelayMessageStore();
      const opts: RelayServerOptions = {
        logger: () => {},
        tokenVerifier: async (token: string) => {
          const map: Record<string, AuthPrincipal> = {
            'token-alice': ALICE_PRINCIPAL,
            'token-bob': BOB_PRINCIPAL,
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
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('after revocation+rotation, revoked device fails decrypt; active device succeeds', async () => {
      // Initial setup: Alice and Bob exchange keys
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice');
      const { keysDir: bobKeysDir, bundle: bobBundle } = setupDevice(tempDir, 'bob');

      // Original key exchange
      const aliceSessionOld = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );
      performKeyExchange(
        bobKeysDir,
        bobBundle,
        aliceBundle.x25519PublicKey,
        aliceBundle.deviceId,
        aliceBundle.fingerprint
      );

      const oldSharedSecret = aliceSessionOld.sharedSecret;

      // Pre-revocation: send an encrypted message (both can decrypt)
      const preCanary = 'PRE_REVOCATION_MESSAGE_001';
      const preEncrypted = encryptMessage(oldSharedSecret, preCanary);
      const preSend = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: {
          recipient_id: BOB_PRINCIPAL.githubUserId,
          body: JSON.stringify(preEncrypted),
        },
      });
      expect(preSend.status).toBe(201);

      // Bob can decrypt pre-revocation message
      const prePayload = JSON.parse(
        (preSend.body as Record<string, unknown>)['body'] as string
      ) as EncryptedPayload;
      expect(decryptMessage(oldSharedSecret, prePayload)).toBe(preCanary);

      // Alice revokes Bob's old device and rotates her keys
      revokeDevice(aliceKeysDir, bobBundle.deviceId);
      expect(isDeviceRevoked(aliceKeysDir, bobBundle.deviceId)).toBe(true);

      // Bob gets a new device (rotation)
      const { keysDir: bobNewKeysDir, bundle: bobNewBundle } = setupDevice(tempDir, 'bob-new');

      // Alice exchanges keys with Bob's new device
      const aliceSessionNew = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobNewBundle.x25519PublicKey,
        bobNewBundle.deviceId,
        bobNewBundle.fingerprint
      );

      performKeyExchange(
        bobNewKeysDir,
        bobNewBundle,
        aliceBundle.x25519PublicKey,
        aliceBundle.deviceId,
        aliceBundle.fingerprint
      );

      const newSharedSecret = aliceSessionNew.sharedSecret;

      // Post-revocation: send encrypted message with new shared secret
      const postCanary = 'POST_REVOCATION_MESSAGE_002';
      const postEncrypted = encryptMessage(newSharedSecret, postCanary);
      const postSend = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: {
          recipient_id: BOB_PRINCIPAL.githubUserId,
          body: JSON.stringify(postEncrypted),
        },
      });
      expect(postSend.status).toBe(201);

      // New device (active) decrypts post-revocation message successfully
      const postPayload = JSON.parse(
        (postSend.body as Record<string, unknown>)['body'] as string
      ) as EncryptedPayload;
      expect(decryptMessage(newSharedSecret, postPayload)).toBe(postCanary);

      // Old (revoked) device cannot decrypt post-revocation message
      expect(() => decryptMessage(oldSharedSecret, postPayload)).toThrow(CipherError);

      // Strict variant gives rekey guidance
      expect(() => decryptMessageStrict(oldSharedSecret, postPayload)).toThrow(StaleKeyError);
    });

    it('revoked device is blocked from new key exchange', async () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice-rev');
      const { bundle: bobBundle } = setupDevice(tempDir, 'bob-rev');

      // Complete initial exchange
      performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobBundle.x25519PublicKey,
        bobBundle.deviceId,
        bobBundle.fingerprint
      );

      // Alice revokes Bob's device
      revokeDevice(aliceKeysDir, bobBundle.deviceId);

      // Bob's revoked device cannot re-exchange with Alice
      expect(() =>
        performKeyExchange(
          aliceKeysDir,
          aliceBundle,
          bobBundle.x25519PublicKey,
          bobBundle.deviceId,
          bobBundle.fingerprint
        )
      ).toThrow(/revoked/i);
    });

    it('relay lifecycle (read/ack) continues normally for active device after revocation', async () => {
      const { keysDir: aliceKeysDir, bundle: aliceBundle } = setupDevice(tempDir, 'alice-lc');
      const { keysDir: bobNewKeysDir, bundle: bobNewBundle } = setupDevice(tempDir, 'bob-new-lc');

      // Exchange with active new device
      const aliceSession = performKeyExchange(
        aliceKeysDir,
        aliceBundle,
        bobNewBundle.x25519PublicKey,
        bobNewBundle.deviceId,
        bobNewBundle.fingerprint
      );
      performKeyExchange(
        bobNewKeysDir,
        bobNewBundle,
        aliceBundle.x25519PublicKey,
        aliceBundle.deviceId,
        aliceBundle.fingerprint
      );

      const canary = 'ACTIVE_DEVICE_LIFECYCLE_MSG';
      const encrypted = encryptMessage(aliceSession.sharedSecret, canary);

      // Send, read, ack cycle with active device
      const sendResp = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: {
          recipient_id: BOB_PRINCIPAL.githubUserId,
          body: JSON.stringify(encrypted),
        },
      });
      expect(sendResp.status).toBe(201);
      const msgId = (sendResp.body as Record<string, unknown>)['id'] as string;

      // Bob reads and acks with active device
      const readResp = await relayFetch(server.port, `/messages/${msgId}/read`, {
        method: 'POST',
        token: 'token-bob',
      });
      expect(readResp.status).toBe(200);

      const ackResp = await relayFetch(server.port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: 'token-bob',
      });
      expect(ackResp.status).toBe(200);

      // Verify final state
      const inboxResp = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
      const messages = (inboxResp.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages[0]['state']).toBe('acked');

      // Active device can still decrypt
      const payload = JSON.parse(messages[0]['body'] as string) as EncryptedPayload;
      expect(decryptMessage(aliceSession.sharedSecret, payload)).toBe(canary);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // VAL-CROSS-008: Relay restart/deploy preserves lifecycle integrity
  // ═══════════════════════════════════════════════════════════════════

  describe('VAL-CROSS-008: relay restart/deploy preserves pending/delivered/acked integrity', () => {
    let messageStore: RelayMessageStore;
    let server: RelayServer;
    let tokenControl: ReturnType<typeof controllableTokenVerifier>;

    /**
     * Create a fresh server from a rehydrated message store.
     *
     * When a snapshot is provided, the server is created with a brand-new
     * RelayMessageStore deserialized from the snapshot — crossing a real
     * persistence boundary (no shared in-memory references with the
     * previous store instance). This satisfies the AGENTS.md requirement:
     * "Restart integrity tests must cross a real persistence boundary
     * (persist + rehydrate), not reuse the same in-memory store instance."
     *
     * When no snapshot is provided (initial creation), a fresh empty
     * store is used.
     */
    async function createServer(snapshot?: RelayMessageStoreSnapshot): Promise<RelayServer> {
      // Rehydrate from snapshot or create fresh — never reuse an existing instance
      messageStore = snapshot ? RelayMessageStore.fromSnapshot(snapshot) : new RelayMessageStore();

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
      };
      const s = createRelayServer(testConfig(), opts);
      await s.start();
      return s;
    }

    /**
     * Simulate a relay restart by:
     * 1. Serializing current store state to a JSON-safe snapshot
     * 2. Passing through JSON.stringify → JSON.parse to prove serialization fidelity
     * 3. Closing the current server
     * 4. Creating a new server from the deserialized snapshot
     *
     * This crosses a true persistence boundary — the new server gets a
     * completely independent RelayMessageStore instance reconstructed
     * from serialized state, with no shared object references.
     */
    async function simulateRestart(): Promise<void> {
      // Persist: serialize current state through a JSON round-trip
      const serialized = JSON.stringify(messageStore.snapshot());
      const rehydrated = JSON.parse(serialized) as RelayMessageStoreSnapshot;

      // Stop old server
      await server.close();

      // Start new server from rehydrated state
      server = await createServer(rehydrated);
    }

    beforeEach(async () => {
      server = await createServer();
    });

    afterEach(async () => {
      await server.close();
    });

    it('messages in delivered state survive restart and can be read/acked', async () => {
      // Send a message (stays in delivered state)
      const sendResp = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: BOB_PRINCIPAL.githubUserId, body: 'Surviving restart' },
      });
      expect(sendResp.status).toBe(201);
      const msgId = (sendResp.body as Record<string, unknown>)['id'] as string;

      // Verify delivered state
      const preInbox = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
      const preMessages = (preInbox.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(preMessages[0]['state']).toBe('delivered');

      // Restart: persist → rehydrate across a real persistence boundary
      await simulateRestart();

      // After restart, inbox still shows the message in delivered state
      const postInbox = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
      const postMessages = (postInbox.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(postMessages.length).toBe(1);
      expect(postMessages[0]['id']).toBe(msgId);
      expect(postMessages[0]['state']).toBe('delivered');

      // Read and ack work after restart
      const readResp = await relayFetch(server.port, `/messages/${msgId}/read`, {
        method: 'POST',
        token: 'token-bob',
      });
      expect(readResp.status).toBe(200);
      expect(
        ((readResp.body as Record<string, unknown>)['message'] as Record<string, unknown>)[
          'read_at'
        ]
      ).not.toBeNull();

      const ackResp = await relayFetch(server.port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: 'token-bob',
      });
      expect(ackResp.status).toBe(200);
      expect(
        ((ackResp.body as Record<string, unknown>)['message'] as Record<string, unknown>)['state']
      ).toBe('acked');
    });

    it('acked state persists through restart', async () => {
      // Create and fully ack a message
      const sendResp = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: BOB_PRINCIPAL.githubUserId, body: 'Acked before restart' },
      });
      const msgId = (sendResp.body as Record<string, unknown>)['id'] as string;

      await relayFetch(server.port, `/messages/${msgId}/read`, {
        method: 'POST',
        token: 'token-bob',
      });
      await relayFetch(server.port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: 'token-bob',
      });

      // Verify acked state before restart
      const preInbox = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
      expect(
        (
          (preInbox.body as Record<string, unknown>)['messages'] as Array<Record<string, unknown>>
        )[0]['state']
      ).toBe('acked');

      // Restart: persist → rehydrate across a real persistence boundary
      await simulateRestart();

      // Acked state preserved
      const postInbox = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
      const postMessages = (postInbox.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(postMessages[0]['id']).toBe(msgId);
      expect(postMessages[0]['state']).toBe('acked');
      expect(postMessages[0]['read_at']).not.toBeNull();
      expect(postMessages[0]['acked_at']).not.toBeNull();

      // Re-ack after restart is idempotent
      const reAck = await relayFetch(server.port, `/messages/${msgId}/ack`, {
        method: 'POST',
        token: 'token-bob',
      });
      expect(reAck.status).toBe(200);
      expect((reAck.body as Record<string, unknown>)['first_ack']).toBe(false);
    });

    it('mixed lifecycle states survive restart with correct per-message integrity', async () => {
      // Create three messages with different states
      const send1 = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: BOB_PRINCIPAL.githubUserId, body: 'Msg 1 - will be delivered' },
      });
      const send2 = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: BOB_PRINCIPAL.githubUserId, body: 'Msg 2 - will be read' },
      });
      const send3 = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: BOB_PRINCIPAL.githubUserId, body: 'Msg 3 - will be acked' },
      });

      const msg1Id = (send1.body as Record<string, unknown>)['id'] as string;
      const msg2Id = (send2.body as Record<string, unknown>)['id'] as string;
      const msg3Id = (send3.body as Record<string, unknown>)['id'] as string;

      // Advance msg2 to read, msg3 to acked
      await relayFetch(server.port, `/messages/${msg2Id}/read`, {
        method: 'POST',
        token: 'token-bob',
      });
      await relayFetch(server.port, `/messages/${msg3Id}/read`, {
        method: 'POST',
        token: 'token-bob',
      });
      await relayFetch(server.port, `/messages/${msg3Id}/ack`, {
        method: 'POST',
        token: 'token-bob',
      });

      // Restart: persist → rehydrate across a real persistence boundary
      await simulateRestart();

      // Verify per-message state integrity after restart
      const inbox = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
      const messages = (inbox.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;

      const m1 = messages.find((m) => m['id'] === msg1Id);
      const m2 = messages.find((m) => m['id'] === msg2Id);
      const m3 = messages.find((m) => m['id'] === msg3Id);

      // Msg 1: delivered, not read, not acked
      expect(m1?.['state']).toBe('delivered');
      expect(m1?.['read_at']).toBeNull();
      expect(m1?.['acked_at']).toBeNull();

      // Msg 2: delivered (read doesn't change state), read_at set, not acked
      expect(m2?.['state']).toBe('delivered');
      expect(m2?.['read_at']).not.toBeNull();
      expect(m2?.['acked_at']).toBeNull();

      // Msg 3: acked, read_at set, acked_at set
      expect(m3?.['state']).toBe('acked');
      expect(m3?.['read_at']).not.toBeNull();
      expect(m3?.['acked_at']).not.toBeNull();
    });

    it('SSE watch after restart delivers live events for post-restart actions', async () => {
      // Create a message before restart
      const sendResp = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: BOB_PRINCIPAL.githubUserId, body: 'Pre-restart message' },
      });
      const msgId = (sendResp.body as Record<string, unknown>)['id'] as string;

      // Restart: persist → rehydrate across a real persistence boundary
      await simulateRestart();

      // Bob opens SSE after restart
      const sseBob = openSSE(server.port, 'token-bob');
      try {
        await sseBob.waitForEvents(1); // connected

        // Post-restart: Bob reads the pre-restart message
        await relayFetch(server.port, `/messages/${msgId}/read`, {
          method: 'POST',
          token: 'token-bob',
        });
        await sseBob.waitForEvents(2); // connected + message_read

        // Post-restart: Bob acks the message
        await relayFetch(server.port, `/messages/${msgId}/ack`, {
          method: 'POST',
          token: 'token-bob',
        });
        await sseBob.waitForEvents(3); // + message_acked

        // Verify event types
        const nonConnected = sseBob.events.filter((e) => e.event !== 'connected');
        expect(nonConnected.length).toBe(2);
        expect(nonConnected[0].event).toBe('message_read');
        expect(nonConnected[1].event).toBe('message_acked');

        // Both events reference the pre-restart message
        for (const evt of nonConnected) {
          expect(parseEventData(evt).message_id).toBe(msgId);
        }
      } finally {
        sseBob.close();
      }
    });

    it('new messages after restart work through full lifecycle', async () => {
      // Pre-restart: send a message
      await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: BOB_PRINCIPAL.githubUserId, body: 'Pre-restart' },
      });

      // Restart: persist → rehydrate across a real persistence boundary
      await simulateRestart();

      // Post-restart: send a new message
      const newSend = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: BOB_PRINCIPAL.githubUserId, body: 'Post-restart new message' },
      });
      expect(newSend.status).toBe(201);
      const newMsgId = (newSend.body as Record<string, unknown>)['id'] as string;

      // Full lifecycle on post-restart message
      await relayFetch(server.port, `/messages/${newMsgId}/read`, {
        method: 'POST',
        token: 'token-bob',
      });
      await relayFetch(server.port, `/messages/${newMsgId}/ack`, {
        method: 'POST',
        token: 'token-bob',
      });

      // Inbox shows both pre and post-restart messages
      const inbox = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
      const messages = (inbox.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages.length).toBe(2);

      // New message is properly acked
      const newMsg = messages.find((m) => m['id'] === newMsgId);
      expect(newMsg?.['state']).toBe('acked');
    });

    it('thread integrity preserved across restart boundary', async () => {
      // Send root message and reply before restart
      const rootResp = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: { recipient_id: BOB_PRINCIPAL.githubUserId, body: 'Root before restart' },
      });
      const rootId = (rootResp.body as Record<string, unknown>)['id'] as string;
      const threadId = (rootResp.body as Record<string, unknown>)['thread_id'] as string;

      const replyResp = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-bob',
        body: {
          recipient_id: ALICE_PRINCIPAL.githubUserId,
          body: 'Reply before restart',
          in_reply_to: rootId,
        },
      });
      const replyId = (replyResp.body as Record<string, unknown>)['id'] as string;

      // Restart: persist → rehydrate across a real persistence boundary
      await simulateRestart();

      // Post-restart: thread linkage preserved
      const aliceInbox = await relayFetch(server.port, '/inbox', { token: 'token-alice' });
      const aliceMessages = (aliceInbox.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      const reply = aliceMessages.find((m) => m['id'] === replyId);
      expect(reply?.['thread_id']).toBe(threadId);
      expect(reply?.['in_reply_to']).toBe(rootId);

      // Post-restart: can reply to existing thread
      const newReplyResp = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: {
          recipient_id: BOB_PRINCIPAL.githubUserId,
          body: 'Reply after restart',
          in_reply_to: replyId,
        },
      });
      expect(newReplyResp.status).toBe(201);
      const newReply = newReplyResp.body as Record<string, unknown>;
      expect(newReply['thread_id']).toBe(threadId);
      expect(newReply['in_reply_to']).toBe(replyId);
    });

    it('dedupe state preserved across restart boundary', async () => {
      const dedupeKey = 'restart-dedupe-01';

      // Send with dedupe key before restart
      const send1 = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: {
          recipient_id: BOB_PRINCIPAL.githubUserId,
          body: 'Deduped across restart',
          dedupe_key: dedupeKey,
        },
      });
      expect(send1.status).toBe(201);
      const originalId = (send1.body as Record<string, unknown>)['id'] as string;

      // Restart: persist → rehydrate across a real persistence boundary
      await simulateRestart();

      // Retry with same dedupe key after restart — should get canonical message
      const send2 = await relayFetch(server.port, '/messages', {
        method: 'POST',
        token: 'token-alice',
        body: {
          recipient_id: BOB_PRINCIPAL.githubUserId,
          body: 'Deduped across restart',
          dedupe_key: dedupeKey,
        },
      });
      expect(send2.status).toBe(200); // idempotent
      expect((send2.body as Record<string, unknown>)['id']).toBe(originalId);

      // Only one message in inbox
      const inbox = await relayFetch(server.port, '/inbox', { token: 'token-bob' });
      const messages = (inbox.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages.length).toBe(1);
    });
  });
});
