/**
 * Tests for relay auth guards and object-level authorization.
 *
 * Covers:
 * - VAL-AUTH-003: Relay and SSE reject missing/invalid/expired auth with 401
 * - VAL-AUTH-004: Relay enforces object-level authorization (403 for non-participants)
 * - Authorized participants retain normal access
 *
 * Test approach:
 * - Auth middleware is tested by hitting protected relay endpoints with various credential states.
 * - Token verification uses a pluggable verifier (GitHub API in production, stub in tests).
 * - Object authorization uses a participant store that maps conversation IDs to participant lists.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { loadRelayConfig } from '../../src/relay/config.js';
import type { TokenVerifier } from '../../src/relay/auth-middleware.js';

/** Find a random available port for test isolation. */
function getTestPort(): number {
  return 30000 + Math.floor(Math.random() * 10000);
}

/** Helper to make HTTP requests to the relay server. */
async function fetchRelay(
  port: number,
  path: string,
  options?: RequestInit
): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

/**
 * Create a stub token verifier for testing.
 * Maps access tokens to principal identities.
 */
function createStubVerifier(
  tokenMap: Record<string, { githubUserId: number; githubLogin: string }>
): TokenVerifier {
  return async (token: string) => {
    const user = tokenMap[token];
    if (!user) return null;
    return { githubUserId: user.githubUserId, githubLogin: user.githubLogin };
  };
}

describe('relay auth guards', () => {
  let server: RelayServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  // ── VAL-AUTH-003: Missing, invalid, and expired credentials return 401 ──

  describe('401 for missing/invalid/expired auth', () => {
    it('returns 401 for API endpoint with no Authorization header', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();

      const { status, body } = await fetchRelay(port, '/conversations/conv-1/messages');
      expect(status).toBe(401);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('unauthorized');
      expect(payload.detail).toMatch(/missing|required/i);
    });

    it('returns 401 for API endpoint with invalid token', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();

      const { status, body } = await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: 'Bearer invalid-token-xxx' },
      });
      expect(status).toBe(401);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('unauthorized');
      expect(payload.detail).toMatch(/invalid|expired/i);
    });

    it('returns 401 for API endpoint with expired token', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      // Token maps to nothing (simulates expired)
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();

      const { status, body } = await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: 'Bearer expired-token-yyy' },
      });
      expect(status).toBe(401);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('unauthorized');
    });

    it('returns 401 for SSE /events endpoint with no Authorization header', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();

      const { status, body } = await fetchRelay(port, '/events');
      expect(status).toBe(401);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('unauthorized');
    });

    it('returns 401 for SSE /events endpoint with invalid token', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();

      const { status, body } = await fetchRelay(port, '/events', {
        headers: { Authorization: 'Bearer bad-token-zzz' },
      });
      expect(status).toBe(401);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('unauthorized');
    });

    it('returns 401 for malformed Authorization header (not Bearer)', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();

      const { status, body } = await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      });
      expect(status).toBe(401);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('unauthorized');
    });

    it('returns 401 for empty Bearer token', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();

      const { status, body } = await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: 'Bearer ' },
      });
      expect(status).toBe(401);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('unauthorized');
    });

    it('health endpoint remains public (no auth required)', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();

      const { status, body } = await fetchRelay(port, '/health');
      expect(status).toBe(200);
      const payload = JSON.parse(body);
      expect(payload.status).toBe('ok');
    });

    it('401 response does not leak token details', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();

      const { body } = await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: 'Bearer my-secret-token-value' },
      });
      expect(body).not.toContain('my-secret-token-value');
    });
  });

  // ── VAL-AUTH-004: Object-level authorization (403 for non-participants) ──

  describe('403 for non-participant access', () => {
    const validToken = 'valid-token-alice';
    const tokenMap = {
      [validToken]: { githubUserId: 100, githubLogin: 'alice' },
      'valid-token-bob': { githubUserId: 200, githubLogin: 'bob' },
    };

    it('returns 403 when authenticated user is not a participant of the conversation', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier(tokenMap);
      server = createRelayServer(config, {
        tokenVerifier: verifier,
        participantStore: {
          isParticipant: async (conversationId: string, githubUserId: number) => {
            // Only bob (200) is participant of conv-1
            return conversationId === 'conv-1' && githubUserId === 200;
          },
        },
      });
      await server.start();

      // Alice (100) tries to access conv-1 where only bob is a participant
      const { status, body } = await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(status).toBe(403);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('forbidden');
      expect(payload.detail).toMatch(/not a participant/i);
    });

    it('403 does not mutate conversation state', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier(tokenMap);
      let mutationOccurred = false;
      server = createRelayServer(config, {
        tokenVerifier: verifier,
        participantStore: {
          isParticipant: async (conversationId: string, githubUserId: number) => {
            return conversationId === 'conv-1' && githubUserId === 200;
          },
        },
        onConversationAccess: () => {
          mutationOccurred = true;
        },
      });
      await server.start();

      // Alice attempts access — should be blocked before any mutation
      await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(mutationOccurred).toBe(false);
    });

    it('authorized participant gets 200 on conversation endpoint', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier(tokenMap);
      server = createRelayServer(config, {
        tokenVerifier: verifier,
        participantStore: {
          isParticipant: async (conversationId: string, githubUserId: number) => {
            return conversationId === 'conv-1' && githubUserId === 200;
          },
        },
      });
      await server.start();

      // Bob (200) is a participant of conv-1
      const { status, body } = await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: 'Bearer valid-token-bob' },
      });
      expect(status).toBe(200);
      const payload = JSON.parse(body);
      expect(payload.conversationId).toBe('conv-1');
    });

    it('returns 403 for different conversation where user has no access', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier(tokenMap);
      server = createRelayServer(config, {
        tokenVerifier: verifier,
        participantStore: {
          isParticipant: async (_conversationId: string, _githubUserId: number) => {
            // No one has access to conv-secret
            return false;
          },
        },
      });
      await server.start();

      const { status } = await fetchRelay(port, '/conversations/conv-secret/messages', {
        headers: { Authorization: 'Bearer valid-token-bob' },
      });
      expect(status).toBe(403);
    });

    it('SSE /events with valid auth succeeds', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier(tokenMap);
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();

      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/events`, {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${validToken}`,
          Accept: 'text/event-stream',
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      controller.abort();
    });

    it('authenticated user gets correct principal identity from token', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier(tokenMap);
      let capturedPrincipal: { githubUserId: number; githubLogin: string } | null = null;
      server = createRelayServer(config, {
        tokenVerifier: verifier,
        participantStore: {
          isParticipant: async (_conversationId: string, githubUserId: number) => {
            return githubUserId === 200;
          },
        },
        onConversationAccess: (principal) => {
          capturedPrincipal = principal;
        },
      });
      await server.start();

      await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: 'Bearer valid-token-bob' },
      });
      expect(capturedPrincipal).not.toBeNull();
      const p = capturedPrincipal as { githubUserId: number; githubLogin: string };
      expect(p.githubUserId).toBe(200);
      expect(p.githubLogin).toBe('bob');
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('POST to conversation endpoint with valid auth and participant returns 200', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({
        'valid-token': { githubUserId: 300, githubLogin: 'charlie' },
      });
      server = createRelayServer(config, {
        tokenVerifier: verifier,
        participantStore: {
          isParticipant: async () => true,
        },
      });
      await server.start();

      const { status, body } = await fetchRelay(port, '/conversations/conv-1/messages', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: 'test message' }),
      });
      expect(status).toBe(200);
      const payload = JSON.parse(body);
      expect(payload.conversationId).toBe('conv-1');
    });

    it('auth check happens before object-level authorization', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      let participantCheckCalled = false;
      const verifier = createStubVerifier({});
      server = createRelayServer(config, {
        tokenVerifier: verifier,
        participantStore: {
          isParticipant: async () => {
            participantCheckCalled = true;
            return false;
          },
        },
      });
      await server.start();

      const { status } = await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: 'Bearer bad-token' },
      });
      expect(status).toBe(401);
      // Participant check should NOT be called if auth fails
      expect(participantCheckCalled).toBe(false);
    });

    it('401 on /events does not start SSE connection', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();

      const { status, headers } = await fetchRelay(port, '/events');
      expect(status).toBe(401);
      // Should NOT have SSE content-type
      expect(headers.get('content-type')).toBe('application/json');
    });
  });
});
