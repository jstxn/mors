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
import type { TokenVerifier, AuthPrincipal } from '../../src/relay/auth-middleware.js';
import { getTestPort } from '../helpers/test-port.js';

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
  tokenMap: Record<string, { accountId: string; deviceId: string }>
): TokenVerifier {
  return async (token: string) => {
    const user = tokenMap[token];
    if (!user) return null;
    return { accountId: user.accountId, deviceId: user.deviceId };
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
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();
      port = server.port;

      const { status, body } = await fetchRelay(port, '/conversations/conv-1/messages');
      expect(status).toBe(401);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('unauthorized');
      expect(payload.detail).toMatch(/missing|required/i);
    });

    it('returns 401 for API endpoint with invalid token', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();
      port = server.port;

      const { status, body } = await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: 'Bearer invalid-token-xxx' },
      });
      expect(status).toBe(401);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('unauthorized');
      expect(payload.detail).toMatch(/invalid|expired/i);
    });

    it('returns 401 for API endpoint with expired token', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      // Token maps to nothing (simulates expired)
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();
      port = server.port;

      const { status, body } = await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: 'Bearer expired-token-yyy' },
      });
      expect(status).toBe(401);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('unauthorized');
    });

    it('returns 401 for SSE /events endpoint with no Authorization header', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();
      port = server.port;

      const { status, body } = await fetchRelay(port, '/events');
      expect(status).toBe(401);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('unauthorized');
    });

    it('returns 401 for SSE /events endpoint with invalid token', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();
      port = server.port;

      const { status, body } = await fetchRelay(port, '/events', {
        headers: { Authorization: 'Bearer bad-token-zzz' },
      });
      expect(status).toBe(401);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('unauthorized');
    });

    it('returns 401 for malformed Authorization header (not Bearer)', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();
      port = server.port;

      const { status, body } = await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      });
      expect(status).toBe(401);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('unauthorized');
    });

    it('returns 401 for empty Bearer token', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();
      port = server.port;

      const { status, body } = await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: 'Bearer ' },
      });
      expect(status).toBe(401);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('unauthorized');
    });

    it('health endpoint remains public (no auth required)', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();
      port = server.port;

      const { status, body } = await fetchRelay(port, '/health');
      expect(status).toBe(200);
      const payload = JSON.parse(body);
      expect(payload.status).toBe('ok');
    });

    it('401 response does not leak token details', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();
      port = server.port;

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
      [validToken]: { accountId: 'acct_100', deviceId: 'device-alice' },
      'valid-token-bob': { accountId: 'acct_200', deviceId: 'device-bob' },
    };

    it('returns 403 when authenticated user is not a participant of the conversation', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier(tokenMap);
      server = createRelayServer(config, {
        tokenVerifier: verifier,
        participantStore: {
          isParticipant: async (conversationId: string, accountId: string) => {
            // Only bob (200) is participant of conv-1
            return conversationId === 'conv-1' && accountId === 'acct_200';
          },
        },
      });
      await server.start();
      port = server.port;

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
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier(tokenMap);
      let mutationOccurred = false;
      server = createRelayServer(config, {
        tokenVerifier: verifier,
        participantStore: {
          isParticipant: async (conversationId: string, accountId: string) => {
            return conversationId === 'conv-1' && accountId === 'acct_200';
          },
        },
        onConversationAccess: () => {
          mutationOccurred = true;
        },
      });
      await server.start();
      port = server.port;

      // Alice attempts access — should be blocked before any mutation
      await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(mutationOccurred).toBe(false);
    });

    it('authorized participant gets 200 on conversation endpoint', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier(tokenMap);
      server = createRelayServer(config, {
        tokenVerifier: verifier,
        participantStore: {
          isParticipant: async (conversationId: string, accountId: string) => {
            return conversationId === 'conv-1' && accountId === 'acct_200';
          },
        },
      });
      await server.start();
      port = server.port;

      // Bob (200) is a participant of conv-1
      const { status, body } = await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: 'Bearer valid-token-bob' },
      });
      expect(status).toBe(200);
      const payload = JSON.parse(body);
      expect(payload.conversationId).toBe('conv-1');
    });

    it('returns 403 for different conversation where user has no access', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier(tokenMap);
      server = createRelayServer(config, {
        tokenVerifier: verifier,
        participantStore: {
          isParticipant: async (_conversationId: string, _accountId: string) => {
            // No one has access to conv-secret
            return false;
          },
        },
      });
      await server.start();
      port = server.port;

      const { status } = await fetchRelay(port, '/conversations/conv-secret/messages', {
        headers: { Authorization: 'Bearer valid-token-bob' },
      });
      expect(status).toBe(403);
    });

    it('SSE /events with valid auth succeeds', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier(tokenMap);
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();
      port = server.port;

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
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier(tokenMap);
      let capturedPrincipal: { accountId: string; deviceId: string } | null = null;
      server = createRelayServer(config, {
        tokenVerifier: verifier,
        participantStore: {
          isParticipant: async (_conversationId: string, accountId: string) => {
            return accountId === 'acct_200';
          },
        },
        onConversationAccess: (principal) => {
          capturedPrincipal = principal;
        },
      });
      await server.start();
      port = server.port;

      await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: 'Bearer valid-token-bob' },
      });
      expect(capturedPrincipal).not.toBeNull();
      const p = capturedPrincipal as unknown as AuthPrincipal;
      expect(p.accountId).toBe('acct_200');
      expect(p.deviceId).toBe('device-bob');
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('POST to conversation endpoint with valid auth and participant returns 200', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({
        'valid-token': { accountId: 'acct_300', deviceId: 'device-charlie' },
      });
      server = createRelayServer(config, {
        tokenVerifier: verifier,
        participantStore: {
          isParticipant: async () => true,
        },
      });
      await server.start();
      port = server.port;

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
      let port = getTestPort();
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
      port = server.port;

      const { status } = await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: 'Bearer bad-token' },
      });
      expect(status).toBe(401);
      // Participant check should NOT be called if auth fails
      expect(participantCheckCalled).toBe(false);
    });

    it('401 on /events does not start SSE connection', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier({});
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();
      port = server.port;

      const { status, headers } = await fetchRelay(port, '/events');
      expect(status).toBe(401);
      // Should NOT have SSE content-type
      expect(headers.get('content-type')).toBe('application/json');
    });
  });

  // ── Fail-closed: protected routes reject when auth dependencies are absent ──

  describe('fail-closed when tokenVerifier is absent', () => {
    it('returns 401 on conversation endpoint when no tokenVerifier is configured', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      // No tokenVerifier — must fail closed (not 200 open)
      server = createRelayServer(config, {});
      await server.start();
      port = server.port;

      const { status, body } = await fetchRelay(port, '/conversations/conv-1/messages');
      expect(status).toBe(401);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('unauthorized');
    });

    it('returns 401 on SSE /events when no tokenVerifier is configured', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      server = createRelayServer(config, {});
      await server.start();
      port = server.port;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/events`, {
          signal: controller.signal,
        });
        expect(res.status).toBe(401);
        const payload = (await res.json()) as Record<string, unknown>;
        expect(payload['error']).toBe('unauthorized');
      } finally {
        clearTimeout(timeout);
      }
    });

    it('returns 401 even with valid-looking Bearer header when no verifier', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      server = createRelayServer(config, {});
      await server.start();
      port = server.port;

      const { status, body } = await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: 'Bearer some-token' },
      });
      expect(status).toBe(401);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('unauthorized');
    });

    it('health endpoint remains accessible when no tokenVerifier is configured', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      server = createRelayServer(config, {});
      await server.start();
      port = server.port;

      const { status, body } = await fetchRelay(port, '/health');
      expect(status).toBe(200);
      const payload = JSON.parse(body);
      expect(payload.status).toBe('ok');
    });
  });

  describe('fail-closed when participantStore is absent', () => {
    const tokenMap = {
      'valid-token-alice': { accountId: 'acct_100', deviceId: 'device-alice' },
    };

    it('returns 403 on conversation endpoint when authenticated but no participantStore', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier(tokenMap);
      // tokenVerifier set, but no participantStore — must fail closed (not 200 open)
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();
      port = server.port;

      const { status, body } = await fetchRelay(port, '/conversations/conv-1/messages', {
        headers: { Authorization: 'Bearer valid-token-alice' },
      });
      expect(status).toBe(403);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('forbidden');
    });

    it('SSE /events with valid auth still succeeds without participantStore (non-conversation)', async () => {
      let port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      const verifier = createStubVerifier(tokenMap);
      server = createRelayServer(config, { tokenVerifier: verifier });
      await server.start();
      port = server.port;

      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/events`, {
        signal: controller.signal,
        headers: {
          Authorization: 'Bearer valid-token-alice',
          Accept: 'text/event-stream',
        },
      });
      expect(res.status).toBe(200);
      controller.abort();
    });
  });

  describe('production entry point wiring', () => {
    it('createGitHubTokenVerifier is exported and callable', async () => {
      const { createGitHubTokenVerifier } = await import('../../src/relay/auth-middleware.js');
      const verifier = createGitHubTokenVerifier();
      expect(typeof verifier).toBe('function');
    });
  });
});
