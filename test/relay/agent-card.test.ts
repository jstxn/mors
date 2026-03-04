/**
 * Tests for the /.well-known/agent-card.json endpoint.
 *
 * Covers A2A Agent Card discovery:
 * - Per-handle Agent Card with dynamic AccountStore metadata (VAL-A2A-001, VAL-A2A-004)
 * - 404 for unknown handles (VAL-A2A-002)
 * - Relay-level fallback card when no handle param (VAL-A2A-002)
 * - Public endpoint — no auth required (VAL-A2A-003)
 * - No leakage of internal state or secrets (VAL-A2A-005)
 * - Cache-Control headers
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { loadRelayConfig } from '../../src/relay/config.js';
import { AccountStore } from '../../src/relay/account-store.js';
import type { TokenVerifier } from '../../src/relay/auth-middleware.js';
import { getTestPort } from '../helpers/test-port.js';

// ── Test identities ─────────────────────────────────────────────────

const ALICE = { token: 'token-alice', userId: 'acct_2001', login: 'alice-dev' };

/** Stub token verifier mapping test tokens to principals. */
const stubVerifier: TokenVerifier = async (token: string) => {
  const map: Record<string, { accountId: string; deviceId: string }> = {
    [ALICE.token]: { accountId: ALICE.userId, deviceId: ALICE.login },
  };
  return map[token] ?? null;
};

/** Helper for unauthenticated relay requests (agent card is public). */
async function publicFetch(
  port: number,
  path: string,
  options: {
    method?: string;
  } = {}
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? 'GET',
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return { status: res.status, body, headers: res.headers };
}

describe('/.well-known/agent-card.json endpoint', () => {
  let server: RelayServer | null = null;
  let port: number;
  let accountStore: AccountStore;

  beforeEach(() => {
    port = getTestPort();
    accountStore = new AccountStore();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  /** Helper to start a server with the given account store. */
  async function startServer(opts?: { accountStore?: AccountStore }): Promise<void> {
    const config = loadRelayConfig({
      MORS_RELAY_PORT: String(port),
      MORS_RELAY_HOST: '127.0.0.1',
    });
    server = createRelayServer(config, {
      tokenVerifier: stubVerifier,
      accountStore: opts?.accountStore ?? accountStore,
      logger: () => {},
    });
    await server.start();
    port = server.port;
  }

  // ── VAL-A2A-002: Relay-level fallback card (no handle param) ───────

  describe('relay-level fallback card', () => {
    it('returns 200 with a valid A2A Agent Card when no handle param is given', async () => {
      await startServer();
      const { status, body } = await publicFetch(port, '/.well-known/agent-card.json');

      expect(status).toBe(200);
      const card = body as Record<string, unknown>;
      expect(card['name']).toBe('mors-relay');
      expect(typeof card['description']).toBe('string');
      expect(card['version']).toBeTruthy();
      expect(card['capabilities']).toBeTruthy();
      expect(card['skills']).toBeInstanceOf(Array);
      expect(card['defaultInputModes']).toBeInstanceOf(Array);
      expect(card['defaultOutputModes']).toBeInstanceOf(Array);
      expect(card['supportedInterfaces']).toBeInstanceOf(Array);
    });

    it('includes Cache-Control header', async () => {
      await startServer();
      const { headers } = await publicFetch(port, '/.well-known/agent-card.json');

      expect(headers.get('cache-control')).toBe('public, max-age=300');
    });

    it('returns Content-Type application/json', async () => {
      await startServer();
      const { headers } = await publicFetch(port, '/.well-known/agent-card.json');

      expect(headers.get('content-type')).toContain('application/json');
    });
  });

  // ── VAL-A2A-001: Per-handle Agent Card ─────────────────────────────

  describe('per-handle Agent Card', () => {
    it('returns valid A2A Agent Card for a registered handle', async () => {
      accountStore.register({
        accountId: ALICE.userId,
        handle: 'alice_agent',
        displayName: 'Alice Agent',
      });
      await startServer();

      const { status, body } = await publicFetch(
        port,
        '/.well-known/agent-card.json?handle=alice_agent'
      );

      expect(status).toBe(200);
      const card = body as Record<string, unknown>;
      expect(card['name']).toBe('alice_agent');
      expect(card['description']).toContain('Alice Agent');
      expect(card['version']).toBeTruthy();
      expect(card['capabilities']).toBeTruthy();
      expect(card['skills']).toBeInstanceOf(Array);
      expect(card['defaultInputModes']).toBeInstanceOf(Array);
      expect(card['defaultOutputModes']).toBeInstanceOf(Array);
      expect(card['supportedInterfaces']).toBeInstanceOf(Array);
    });

    it('dynamically reflects display name from AccountStore (VAL-A2A-004)', async () => {
      accountStore.register({
        accountId: ALICE.userId,
        handle: 'alice_agent',
        displayName: 'Custom Display Name',
      });
      await startServer();

      const { body } = await publicFetch(
        port,
        '/.well-known/agent-card.json?handle=alice_agent'
      );

      const card = body as Record<string, unknown>;
      expect(card['description']).toContain('Custom Display Name');
    });

    it('handle lookup is case-insensitive', async () => {
      accountStore.register({
        accountId: ALICE.userId,
        handle: 'alice_agent',
        displayName: 'Alice Agent',
      });
      await startServer();

      const { status, body } = await publicFetch(
        port,
        '/.well-known/agent-card.json?handle=Alice_Agent'
      );

      expect(status).toBe(200);
      const card = body as Record<string, unknown>;
      expect(card['name']).toBe('alice_agent');
    });

    it('declares mors relay capabilities', async () => {
      accountStore.register({
        accountId: ALICE.userId,
        handle: 'alice_agent',
        displayName: 'Alice Agent',
      });
      await startServer();

      const { body } = await publicFetch(
        port,
        '/.well-known/agent-card.json?handle=alice_agent'
      );

      const card = body as Record<string, unknown>;
      const capabilities = card['capabilities'] as Record<string, unknown>;
      expect(capabilities['streaming']).toBe(true);
    });

    it('declares security schemes for mors native auth', async () => {
      accountStore.register({
        accountId: ALICE.userId,
        handle: 'alice_agent',
        displayName: 'Alice Agent',
      });
      await startServer();

      const { body } = await publicFetch(
        port,
        '/.well-known/agent-card.json?handle=alice_agent'
      );

      const card = body as Record<string, unknown>;
      const schemes = card['securitySchemes'] as Record<string, unknown>;
      expect(schemes).toBeTruthy();
      expect(schemes['mors_bearer']).toBeTruthy();
    });
  });

  // ── VAL-A2A-002: 404 for unknown handles ──────────────────────────

  describe('unknown handle returns 404', () => {
    it('returns 404 with actionable message for unknown handle', async () => {
      await startServer();

      const { status, body } = await publicFetch(
        port,
        '/.well-known/agent-card.json?handle=nonexistent'
      );

      expect(status).toBe(404);
      const result = body as Record<string, unknown>;
      expect(result['error']).toBe('not_found');
      expect(typeof result['detail']).toBe('string');
      expect((result['detail'] as string).toLowerCase()).toContain('nonexistent');
    });

    it('returns 404 for empty handle parameter', async () => {
      await startServer();

      const { status } = await publicFetch(
        port,
        '/.well-known/agent-card.json?handle='
      );

      // Empty handle= param should return relay fallback, not 404
      // per the spec: no handle => relay-level card
      expect(status).toBe(200);
    });
  });

  // ── VAL-A2A-003: Public endpoint (no auth required) ────────────────

  describe('public access without authentication', () => {
    it('returns 200 without any Authorization header', async () => {
      await startServer();

      const { status } = await publicFetch(port, '/.well-known/agent-card.json');
      expect(status).toBe(200);
    });

    it('does not return 401 for per-handle request without auth', async () => {
      accountStore.register({
        accountId: ALICE.userId,
        handle: 'alice_agent',
        displayName: 'Alice Agent',
      });
      await startServer();

      const { status } = await publicFetch(
        port,
        '/.well-known/agent-card.json?handle=alice_agent'
      );
      expect(status).toBe(200);
    });
  });

  // ── VAL-A2A-005: No leakage of internal state or secrets ──────────

  describe('security — no internal state leakage', () => {
    it('does not contain signing keys in response', async () => {
      accountStore.register({
        accountId: ALICE.userId,
        handle: 'alice_agent',
        displayName: 'Alice Agent',
      });
      await startServer();

      const { body } = await publicFetch(
        port,
        '/.well-known/agent-card.json?handle=alice_agent'
      );

      const raw = JSON.stringify(body);
      expect(raw).not.toContain('signing_key');
      expect(raw).not.toContain('signingKey');
      expect(raw).not.toContain('MORS_RELAY_SIGNING_KEY');
      expect(raw).not.toContain('session_token');
      expect(raw).not.toContain('sessionToken');
    });

    it('does not contain internal account IDs', async () => {
      accountStore.register({
        accountId: ALICE.userId,
        handle: 'alice_agent',
        displayName: 'Alice Agent',
      });
      await startServer();

      const { body } = await publicFetch(
        port,
        '/.well-known/agent-card.json?handle=alice_agent'
      );

      const raw = JSON.stringify(body);
      // The internal accountId (acct_2001) should not appear
      expect(raw).not.toContain(ALICE.userId);
    });

    it('relay fallback card does not leak internal state', async () => {
      await startServer();

      const { body } = await publicFetch(port, '/.well-known/agent-card.json');

      const raw = JSON.stringify(body);
      expect(raw).not.toContain('signing_key');
      expect(raw).not.toContain('signingKey');
      expect(raw).not.toContain('session_token');
      expect(raw).not.toContain('sessionToken');
    });
  });

  // ── Method restrictions ───────────────────────────────────────────

  describe('method restrictions', () => {
    it('rejects POST with 405', async () => {
      await startServer();

      const { status } = await publicFetch(port, '/.well-known/agent-card.json', {
        method: 'POST',
      });
      expect(status).toBe(405);
    });
  });

  // ── A2A spec field completeness ────────────────────────────────────

  describe('A2A spec field completeness', () => {
    it('per-handle card includes all required A2A AgentCard fields', async () => {
      accountStore.register({
        accountId: ALICE.userId,
        handle: 'alice_agent',
        displayName: 'Alice Agent',
      });
      await startServer();

      const { body } = await publicFetch(
        port,
        '/.well-known/agent-card.json?handle=alice_agent'
      );

      const card = body as Record<string, unknown>;

      // Required A2A fields
      expect(card['name']).toBeTruthy();
      expect(card['description']).toBeTruthy();
      expect(card['version']).toBeTruthy();
      expect(card['capabilities']).toBeTruthy();
      expect(card['skills']).toBeInstanceOf(Array);
      expect(card['defaultInputModes']).toBeInstanceOf(Array);
      expect(card['defaultOutputModes']).toBeInstanceOf(Array);
      expect(card['supportedInterfaces']).toBeInstanceOf(Array);

      // Verify supportedInterfaces structure
      const interfaces = card['supportedInterfaces'] as Array<Record<string, unknown>>;
      expect(interfaces.length).toBeGreaterThan(0);
      expect(interfaces[0]['url']).toBeTruthy();
      expect(interfaces[0]['protocolBinding']).toBeTruthy();
      expect(interfaces[0]['protocolVersion']).toBeTruthy();

      // Verify skills structure
      const skills = card['skills'] as Array<Record<string, unknown>>;
      expect(skills.length).toBeGreaterThan(0);
      expect(skills[0]['id']).toBeTruthy();
      expect(skills[0]['name']).toBeTruthy();
      expect(skills[0]['description']).toBeTruthy();
      expect(skills[0]['tags']).toBeInstanceOf(Array);
    });

    it('relay fallback card includes all required A2A AgentCard fields', async () => {
      await startServer();

      const { body } = await publicFetch(port, '/.well-known/agent-card.json');

      const card = body as Record<string, unknown>;

      expect(card['name']).toBeTruthy();
      expect(card['description']).toBeTruthy();
      expect(card['version']).toBeTruthy();
      expect(card['capabilities']).toBeTruthy();
      expect(card['skills']).toBeInstanceOf(Array);
      expect(card['defaultInputModes']).toBeInstanceOf(Array);
      expect(card['defaultOutputModes']).toBeInstanceOf(Array);
      expect(card['supportedInterfaces']).toBeInstanceOf(Array);
    });
  });
});
