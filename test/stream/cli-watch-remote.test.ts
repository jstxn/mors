/**
 * CLI `mors watch --remote` integration tests.
 *
 * Validates:
 * - VAL-STREAM-001: watch --remote connects to relay SSE with auth session
 * - VAL-STREAM-003: Remote watch reconnect uses cursor/Last-Event-ID path
 * - VAL-STREAM-007: When SSE is unavailable, CLI displays explicit fallback/degraded
 *   mode and continues with documented behavior
 *
 * These tests exercise the remote watch SSE client logic that connects
 * to the relay /events endpoint with an auth token, handles reconnect
 * with Last-Event-ID cursor, and provides explicit degraded fallback
 * indication when SSE is unavailable.
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
import {
  connectRemoteWatch,
  type RemoteWatchHandle,
  type RemoteWatchEvent,
} from '../../src/remote-watch.js';

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
    ['token-alice', { githubUserId: 1001, githubLogin: 'alice' }],
    ['token-bob', { githubUserId: 1002, githubLogin: 'bob' }],
  ]);
  return async (token: string) => principals.get(token) ?? null;
}

/** Controllable token verifier for expiry tests. */
function controllableTokenVerifier(): {
  verifier: TokenVerifier;
  expireToken: (token: string) => void;
  restoreToken: (token: string, principal: AuthPrincipal) => void;
} {
  const principals = new Map<string, AuthPrincipal>([
    ['token-alice', { githubUserId: 1001, githubLogin: 'alice' }],
    ['token-bob', { githubUserId: 1002, githubLogin: 'bob' }],
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

/** Collect events from a remote watch handle until a condition. */
async function collectEvents(
  handle: RemoteWatchHandle,
  count: number,
  timeoutMs = 5000
): Promise<RemoteWatchEvent[]> {
  const start = Date.now();
  while (handle.events.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for ${count} events (got ${handle.events.length} within ${timeoutMs}ms). ` +
          `Events: ${JSON.stringify(handle.events)}`
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return [...handle.events];
}

/** Wait for a specific event type from the handle. */
async function waitForEventType(
  handle: RemoteWatchHandle,
  eventType: string,
  timeoutMs = 5000
): Promise<RemoteWatchEvent> {
  const start = Date.now();
  while (true) {
    const found = handle.events.find((e) => e.event === eventType);
    if (found) return found;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for event type "${eventType}" within ${timeoutMs}ms. ` +
          `Events so far: ${JSON.stringify(handle.events)}`
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ── Test suite ───────────────────────────────────────────────────────

describe('CLI watch --remote integration', () => {
  // ── VAL-STREAM-001: Authenticated SSE watch connection ───────────

  describe('authenticated SSE connection (VAL-STREAM-001)', () => {
    let server: RelayServer;
    let messageStore: RelayMessageStore;

    beforeEach(async () => {
      messageStore = new RelayMessageStore();
      const opts: RelayServerOptions = {
        logger: () => {},
        tokenVerifier: stubTokenVerifier(),
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

    it('connects to relay SSE with auth token and receives connected event', async () => {
      const handle = connectRemoteWatch({
        baseUrl: `http://127.0.0.1:${server.port}`,
        token: 'token-alice',
      });

      try {
        const evts = await collectEvents(handle, 1);
        expect(evts[0].event).toBe('connected');
        expect(evts[0].data.github_user_id).toBe(1001);
        expect(evts[0].data.github_login).toBe('alice');
        expect(handle.state).toBe('connected');
      } finally {
        handle.stop();
      }
    });

    it('receives live message events through remote watch', async () => {
      const handle = connectRemoteWatch({
        baseUrl: `http://127.0.0.1:${server.port}`,
        token: 'token-alice',
      });

      try {
        await collectEvents(handle, 1); // connected

        // Send a message to alice
        messageStore.send(1002, 'bob', {
          recipientId: 1001,
          body: 'Hello from remote watch test',
        });

        const evts = await collectEvents(handle, 2);
        const msgEvt = evts.find((e) => e.event === 'message_created');
        expect(msgEvt).toBeDefined();
        // SSE events contain metadata (not full body) per server event shape
        const msgData = (msgEvt as RemoteWatchEvent).data;
        expect(msgData.sender_id).toBe(1002);
        expect(msgData.recipient_id).toBe(1001);
        expect(msgData.message_id).toBeDefined();
        expect(msgData.thread_id).toBeDefined();
        expect((msgEvt as RemoteWatchEvent).id).toBeDefined();
      } finally {
        handle.stop();
      }
    });

    it('reports auth failure state for invalid token', async () => {
      const handle = connectRemoteWatch({
        baseUrl: `http://127.0.0.1:${server.port}`,
        token: 'token-invalid',
      });

      try {
        // Should enter fallback mode due to auth failure
        await waitForFallback(handle);
        expect(handle.state).toBe('fallback');
        expect(handle.fallbackReason).toMatch(/auth|401|unauthorized/i);
      } finally {
        handle.stop();
      }
    });
  });

  // ── VAL-STREAM-003: Reconnect with cursor/Last-Event-ID ─────────

  describe('reconnect with cursor resume (VAL-STREAM-003)', () => {
    let server: RelayServer;
    let messageStore: RelayMessageStore;

    beforeEach(async () => {
      messageStore = new RelayMessageStore();
      const opts: RelayServerOptions = {
        logger: () => {},
        tokenVerifier: stubTokenVerifier(),
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

    it('reconnects with Last-Event-ID to resume from cursor', async () => {
      // First connection
      const handle1 = connectRemoteWatch({
        baseUrl: `http://127.0.0.1:${server.port}`,
        token: 'token-alice',
      });

      try {
        await collectEvents(handle1, 1); // connected

        // Send a message
        messageStore.send(1002, 'bob', {
          recipientId: 1001,
          body: 'Before disconnect',
        });
        await collectEvents(handle1, 2);
        const lastEventId = handle1.lastEventId;
        expect(lastEventId).toBeDefined();

        handle1.stop();

        // Send another message while disconnected
        messageStore.send(1002, 'bob', {
          recipientId: 1001,
          body: 'During disconnect',
        });

        // Reconnect with cursor from last seen event
        const handle2 = connectRemoteWatch({
          baseUrl: `http://127.0.0.1:${server.port}`,
          token: 'token-alice',
          lastEventId: lastEventId as string,
        });

        try {
          // Should get: connected + replayed "During disconnect" event
          // "Before disconnect" was already seen — cursor resumes AFTER lastEventId
          const evts = await collectEvents(handle2, 2, 5000);
          expect(evts[0].event).toBe('connected');
          const msgEvents = evts.filter((e) => e.event === 'message_created');
          // Should have only the event sent during disconnect (missed events since cursor)
          expect(msgEvents.length).toBe(1);
        } finally {
          handle2.stop();
        }
      } finally {
        handle1.stop();
      }
    });

    it('tracks lastEventId as events are received', async () => {
      const handle = connectRemoteWatch({
        baseUrl: `http://127.0.0.1:${server.port}`,
        token: 'token-alice',
      });

      try {
        await collectEvents(handle, 1); // connected
        const connectedId = handle.lastEventId;
        expect(connectedId).toBeDefined();

        // Send a message
        messageStore.send(1002, 'bob', {
          recipientId: 1001,
          body: 'Track event ID',
        });
        await collectEvents(handle, 2);

        // lastEventId should have advanced
        expect(handle.lastEventId).toBeDefined();
        expect(handle.lastEventId).not.toBe(connectedId);
      } finally {
        handle.stop();
      }
    });
  });

  // ── VAL-STREAM-007: Fallback/degraded mode ──────────────────────

  describe('fallback mode when SSE unavailable (VAL-STREAM-007)', () => {
    it('enters fallback mode with explicit reason when connection is refused', async () => {
      // Use a port with no server
      const handle = connectRemoteWatch({
        baseUrl: 'http://127.0.0.1:59998',
        token: 'token-alice',
      });

      try {
        await waitForFallback(handle);
        expect(handle.state).toBe('fallback');
        expect(handle.fallbackReason).toBeDefined();
        expect(handle.fallbackReason).toMatch(/connect|refused|unavailable/i);
      } finally {
        handle.stop();
      }
    });

    it('enters fallback mode when relay returns 503', async () => {
      // Create a mock server that returns 503
      const mockServer = http.createServer((_req, res) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'service_unavailable' }));
      });

      const port = await new Promise<number>((resolve) => {
        mockServer.listen(0, '127.0.0.1', () => {
          const addr = mockServer.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });

      try {
        const handle = connectRemoteWatch({
          baseUrl: `http://127.0.0.1:${port}`,
          token: 'token-alice',
        });

        try {
          await waitForFallback(handle);
          expect(handle.state).toBe('fallback');
          expect(handle.fallbackReason).toMatch(/503|unavailable/i);
        } finally {
          handle.stop();
        }
      } finally {
        await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      }
    });

    it('enters fallback mode when auth fails on initial SSE connect', async () => {
      const messageStore = new RelayMessageStore();
      const tokenControl = controllableTokenVerifier();

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
      const server = createRelayServer(testConfig(), opts);
      await server.start();

      try {
        // Expire token before connect
        tokenControl.expireToken('token-alice');

        const handle = connectRemoteWatch({
          baseUrl: `http://127.0.0.1:${server.port}`,
          token: 'token-alice',
        });

        try {
          await waitForFallback(handle);
          expect(handle.state).toBe('fallback');
          expect(handle.fallbackReason).toMatch(/auth|401|unauthorized|login/i);
        } finally {
          handle.stop();
        }
      } finally {
        await server.close();
      }
    });

    it('fallback state includes degraded mode indication in events', async () => {
      const handle = connectRemoteWatch({
        baseUrl: 'http://127.0.0.1:59998',
        token: 'token-alice',
      });

      try {
        await waitForFallback(handle);
        // The fallback event should have been emitted
        const fallbackEvt = handle.events.find((e) => e.event === 'fallback');
        expect(fallbackEvt).toBeDefined();
        const fbData = (fallbackEvt as RemoteWatchEvent).data;
        expect(fbData.mode).toBe('degraded');
        expect(fbData.reason).toBeDefined();
      } finally {
        handle.stop();
      }
    });

    it('provides explicit degraded mode output for CLI formatting', async () => {
      const handle = connectRemoteWatch({
        baseUrl: 'http://127.0.0.1:59998',
        token: 'token-alice',
      });

      try {
        await waitForFallback(handle);
        // Verify the state and reason are available for CLI display
        expect(handle.state).toBe('fallback');
        expect(typeof handle.fallbackReason).toBe('string');
        expect((handle.fallbackReason as string).length).toBeGreaterThan(0);
      } finally {
        handle.stop();
      }
    });
  });

  // ── Mid-stream auth expiry triggers fallback/reconnect ──────────

  describe('mid-stream auth expiry recovery', () => {
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
        sseAuthRevalidateMs: 200,
      };
      server = createRelayServer(testConfig(), opts);
      await server.start();
    });

    afterEach(async () => {
      await server.close();
    });

    it('detects auth_expired event and updates state', async () => {
      const handle = connectRemoteWatch({
        baseUrl: `http://127.0.0.1:${server.port}`,
        token: 'token-alice',
      });

      try {
        await collectEvents(handle, 1); // connected
        expect(handle.state).toBe('connected');

        // Expire token mid-stream
        tokenControl.expireToken('token-alice');

        // Should receive auth_expired and update state
        await waitForEventType(handle, 'auth_expired', 3000);
        // After auth_expired, the handle should report the expiry
        expect(handle.events.some((e) => e.event === 'auth_expired')).toBe(true);
      } finally {
        handle.stop();
      }
    });
  });
});

/** Helper: wait for handle to enter fallback state. */
async function waitForFallback(handle: RemoteWatchHandle, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (handle.state !== 'fallback') {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for fallback state (current: ${handle.state}) within ${timeoutMs}ms. ` +
          `Events: ${JSON.stringify(handle.events)}`
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
