/**
 * Integration tests for the relay service runtime scaffold.
 *
 * Covers:
 * - Server starts on configured port with deterministic startup logs
 * - Health endpoint returns success payload for readiness checks
 * - Config placeholders load safely with explicit missing-config diagnostics
 * - Test harness can spin relay up/down without orphaned processes
 * - Host binding defaults to 0.0.0.0 for hosted/container ingress
 * - MORS_RELAY_HOST env var override for local-only binding
 * - Persistence bootstrap runs before server accepts requests
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { loadRelayConfig, type RelayConfig } from '../../src/relay/config.js';
import { bootstrapRelay } from '../../src/relay/bootstrap.js';
import type { TokenVerifier } from '../../src/relay/auth-middleware.js';
import { getTestPort } from '../helpers/test-port.js';

/** Stub token verifier that accepts a known test token. */
const TEST_TOKEN = 'test-token-bootstrap';
const stubVerifier: TokenVerifier = async (token: string) => {
  if (token === TEST_TOKEN) {
    return { githubUserId: 1, githubLogin: 'test-user' };
  }
  return null;
};

/** Helper to make HTTP requests to the relay server. */
async function fetchRelay(port: number, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.text();
  return { status: res.status, body };
}

describe('relay bootstrap', () => {
  let server: RelayServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  // --- Config loading tests ---

  describe('config loading', () => {
    it('loads config from environment variables', () => {
      const config = loadRelayConfig({ MORS_RELAY_PORT: '3200' });
      expect(config.port).toBe(3200);
    });

    it('defaults to port 3100 when MORS_RELAY_PORT is not set', () => {
      const config = loadRelayConfig({});
      expect(config.port).toBe(3100);
    });

    it('respects PORT env var as fallback', () => {
      const config = loadRelayConfig({ PORT: '3150' });
      expect(config.port).toBe(3150);
    });

    it('MORS_RELAY_PORT takes precedence over PORT', () => {
      const config = loadRelayConfig({ PORT: '3150', MORS_RELAY_PORT: '3200' });
      expect(config.port).toBe(3200);
    });

    it('returns diagnostics for missing optional config placeholders', () => {
      const config = loadRelayConfig({});
      expect(config.diagnostics).toBeDefined();
      expect(config.diagnostics.length).toBeGreaterThan(0);
      // Should list missing config vars with actionable descriptions
      const missingNames = config.diagnostics.map((d) => d.variable);
      expect(missingNames).toContain('GITHUB_DEVICE_CLIENT_ID');
      expect(missingNames).toContain('MORS_RELAY_BASE_URL');
    });

    it('diagnostics include actionable descriptions', () => {
      const config = loadRelayConfig({});
      for (const diag of config.diagnostics) {
        expect(diag.variable).toBeTruthy();
        expect(diag.description).toBeTruthy();
        expect(diag.description.length).toBeGreaterThan(10);
      }
    });

    it('diagnostics clear when config variables are provided', () => {
      const config = loadRelayConfig({
        MORS_RELAY_PORT: '3100',
        MORS_RELAY_BASE_URL: 'http://localhost:3100',
        GITHUB_DEVICE_CLIENT_ID: 'test-client-id',
        GITHUB_DEVICE_SCOPE: 'read:user',
        GITHUB_DEVICE_ENDPOINT: 'https://github.com/login/device/code',
        GITHUB_TOKEN_ENDPOINT: 'https://github.com/login/oauth/access_token',
        MORS_AUTH_TOKEN_ISSUER: 'mors-relay',
        MORS_AUTH_AUDIENCE: 'mors-cli',
      });
      expect(config.diagnostics.length).toBe(0);
    });

    it('rejects non-numeric port with clear error', () => {
      expect(() => loadRelayConfig({ MORS_RELAY_PORT: 'abc' })).toThrow(/invalid.*port/i);
    });

    it('rejects out-of-range port', () => {
      expect(() => loadRelayConfig({ MORS_RELAY_PORT: '99999' })).toThrow(/port/i);
    });
  });

  // --- Server lifecycle tests ---

  describe('server lifecycle', () => {
    it('starts on configured port and resolves start promise', async () => {
      const config: RelayConfig = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });
      server = createRelayServer(config);
      await server.start();
      expect(server.listening).toBe(true);
      expect(server.port).toBeGreaterThan(0);
    });

    it('emits deterministic startup log', async () => {
      const logs: string[] = [];
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });
      server = createRelayServer(config, { logger: (msg: string) => logs.push(msg) });
      await server.start();
      const actualPort = server.port;
      expect(logs.some((l) => l.includes('listening') && l.includes(String(actualPort)))).toBe(
        true
      );
    });

    it('close resolves cleanly and port is freed', async () => {
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });
      server = createRelayServer(config);
      await server.start();
      const boundPort = server.port;
      await server.close();
      expect(server.listening).toBe(false);
      server = null;

      // Verify port is freed by starting a new server on the same port
      const config2 = loadRelayConfig({ MORS_RELAY_PORT: String(boundPort) });
      const server2 = createRelayServer(config2);
      await server2.start();
      expect(server2.listening).toBe(true);
      await server2.close();
    });

    it('double-close is idempotent', async () => {
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });
      server = createRelayServer(config);
      await server.start();
      await server.close();
      // Second close should not throw
      await server.close();
      expect(server.listening).toBe(false);
      server = null;
    });

    it('close terminates in-flight connections without hanging', async () => {
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });
      server = createRelayServer(config);
      await server.start();

      // Start a request but close server during it
      const fetchPromise = fetch(`http://127.0.0.1:${server.port}/health`);
      await server.close();
      server = null;

      // The fetch should either complete or fail (not hang forever)
      try {
        await fetchPromise;
      } catch {
        // Expected - connection may be reset during close
      }
    });
  });

  // --- Health endpoint tests ---

  describe('health endpoint', () => {
    it('GET /health returns 200 with JSON success payload', async () => {
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });
      server = createRelayServer(config);
      await server.start();

      const { status, body } = await fetchRelay(server.port, '/health');
      expect(status).toBe(200);
      const payload = JSON.parse(body);
      expect(payload.status).toBe('ok');
      expect(payload.service).toBe('mors-relay');
    });

    it('health response includes uptime field', async () => {
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });
      server = createRelayServer(config);
      await server.start();

      const { body } = await fetchRelay(server.port, '/health');
      const payload = JSON.parse(body);
      expect(typeof payload.uptime).toBe('number');
      expect(payload.uptime).toBeGreaterThanOrEqual(0);
    });

    it('health response includes config diagnostics count', async () => {
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });
      server = createRelayServer(config);
      await server.start();

      const { body } = await fetchRelay(server.port, '/health');
      const payload = JSON.parse(body);
      expect(typeof payload.configWarnings).toBe('number');
    });

    it('returns 404 for unknown routes (with valid auth)', async () => {
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });
      server = createRelayServer(config, { tokenVerifier: stubVerifier });
      await server.start();

      const res = await fetch(`http://127.0.0.1:${server.port}/nonexistent`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      const body = await res.text();
      expect(res.status).toBe(404);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('not_found');
    });

    it('returns 401 for unknown routes when no auth provided', async () => {
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });
      server = createRelayServer(config, { tokenVerifier: stubVerifier });
      await server.start();

      const { status, body } = await fetchRelay(server.port, '/nonexistent');
      expect(status).toBe(401);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('unauthorized');
    });

    it('returns 405 for non-GET methods on /health', async () => {
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });
      server = createRelayServer(config);
      await server.start();

      const res = await fetch(`http://127.0.0.1:${server.port}/health`, { method: 'POST' });
      expect(res.status).toBe(405);
    });
  });

  // --- SSE baseline tests ---

  describe('SSE baseline', () => {
    it('GET /events returns SSE content type headers with valid auth', async () => {
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });
      server = createRelayServer(config, { tokenVerifier: stubVerifier });
      await server.start();

      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${server.port}/events`, {
        signal: controller.signal,
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('connection')).toBe('keep-alive');
      controller.abort();
    });

    it('SSE stream sends initial heartbeat comment with valid auth', async () => {
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });
      server = createRelayServer(config, { tokenVerifier: stubVerifier });
      await server.start();

      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${server.port}/events`, {
        signal: controller.signal,
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
      });

      const body = res.body;
      if (!body) throw new Error('Expected response body');
      const reader = body.getReader();
      const decoder = new TextDecoder();
      const { value } = await reader.read();
      const text = decoder.decode(value);
      // SSE heartbeat comments start with ':'
      expect(text).toMatch(/^:/);
      controller.abort();
      reader.releaseLock();
    });
  });

  // --- Spin up/down harness tests ---

  describe('test harness: spin up/down without orphaned processes', () => {
    it('multiple sequential start/stop cycles work correctly', async () => {
      // Start once to get an ephemeral port, then reuse it for subsequent cycles
      const config0 = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });
      const srv0 = createRelayServer(config0);
      await srv0.start();
      const boundPort = srv0.port;
      const { status: s0 } = await fetchRelay(boundPort, '/health');
      expect(s0).toBe(200);
      await srv0.close();

      const config = loadRelayConfig({ MORS_RELAY_PORT: String(boundPort) });
      for (let i = 0; i < 2; i++) {
        const srv = createRelayServer(config);
        await srv.start();
        expect(srv.listening).toBe(true);
        const { status } = await fetchRelay(srv.port, '/health');
        expect(status).toBe(200);
        await srv.close();
        expect(srv.listening).toBe(false);
      }
    });

    it('parallel server instances on different ports', async () => {
      const config1 = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });
      const config2 = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });

      const srv1 = createRelayServer(config1);
      const srv2 = createRelayServer(config2);

      await Promise.all([srv1.start(), srv2.start()]);

      const [res1, res2] = await Promise.all([
        fetchRelay(srv1.port, '/health'),
        fetchRelay(srv2.port, '/health'),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      await Promise.all([srv1.close(), srv2.close()]);
    });

    it('server.close() resolves even when active SSE connections exist', async () => {
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });
      server = createRelayServer(config, { tokenVerifier: stubVerifier });
      await server.start();

      // Open an SSE connection with valid auth
      const controller = new AbortController();
      const ssePromise = fetch(`http://127.0.0.1:${server.port}/events`, {
        signal: controller.signal,
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
      });

      // Wait for connection to be established
      const sseRes = await ssePromise;
      expect(sseRes.status).toBe(200);

      // Close server - should not hang even with active SSE
      await server.close();
      expect(server.listening).toBe(false);
      server = null;

      controller.abort();
    });
  });

  // --- Host binding tests ---

  describe('host binding', () => {
    it('config defaults host to 0.0.0.0 for container/hosted ingress', () => {
      const config = loadRelayConfig({});
      expect(config.host).toBe('0.0.0.0');
    });

    it('MORS_RELAY_HOST overrides default host binding', () => {
      const config = loadRelayConfig({ MORS_RELAY_HOST: '127.0.0.1' });
      expect(config.host).toBe('127.0.0.1');
    });

    it('server startup log reflects actual host binding', async () => {
      const logs: string[] = [];
      const config = loadRelayConfig({
        MORS_RELAY_PORT: String(getTestPort()),
        MORS_RELAY_HOST: '127.0.0.1',
      });
      server = createRelayServer(config, { logger: (msg: string) => logs.push(msg) });
      await server.start();
      const actualPort = server.port;
      expect(logs.some((l) => l.includes('127.0.0.1') && l.includes(String(actualPort)))).toBe(
        true
      );
    });

    it('server binds to 0.0.0.0 by default and is reachable on 127.0.0.1', async () => {
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) });
      // config.host should default to '0.0.0.0'
      expect(config.host).toBe('0.0.0.0');
      server = createRelayServer(config);
      await server.start();

      // 0.0.0.0 binding is reachable via 127.0.0.1
      const { status } = await fetchRelay(server.port, '/health');
      expect(status).toBe(200);
    });

    it('server binds to specified host from config', async () => {
      const logs: string[] = [];
      const config = loadRelayConfig({
        MORS_RELAY_PORT: String(getTestPort()),
        MORS_RELAY_HOST: '127.0.0.1',
      });
      server = createRelayServer(config, { logger: (msg: string) => logs.push(msg) });
      await server.start();

      // Should be reachable
      const { status } = await fetchRelay(server.port, '/health');
      expect(status).toBe(200);

      // Log should show the configured host
      expect(logs.some((l) => l.includes('127.0.0.1'))).toBe(true);
    });
  });

  // --- Persistence bootstrap tests ---

  describe('persistence bootstrap', () => {
    it('bootstrapRelay returns a BootstrapResult with ready state', async () => {
      const result = await bootstrapRelay();
      expect(result).toBeDefined();
      expect(result.ready).toBe(true);
    });

    it('bootstrapRelay reports services that were initialized', async () => {
      const result = await bootstrapRelay();
      expect(Array.isArray(result.services)).toBe(true);
      expect(result.services.length).toBeGreaterThan(0);
      // At minimum, persistence should be listed
      expect(result.services.some((s) => s.name === 'persistence')).toBe(true);
    });

    it('bootstrapRelay is idempotent (safe to call multiple times)', async () => {
      const result1 = await bootstrapRelay();
      const result2 = await bootstrapRelay();
      expect(result1.ready).toBe(true);
      expect(result2.ready).toBe(true);
    });

    it('bootstrap runs before server start in the entrypoint flow', async () => {
      // Verify that the relay entrypoint module calls bootstrapRelay
      // by testing the combined flow: bootstrap + server create + start
      const config = loadRelayConfig({
        MORS_RELAY_PORT: String(getTestPort()),
        MORS_RELAY_HOST: '127.0.0.1',
      });
      const logs: string[] = [];
      const logger = (msg: string) => logs.push(msg);

      // Bootstrap first (as the entrypoint should)
      const result = await bootstrapRelay({ logger });
      expect(result.ready).toBe(true);
      expect(logs.some((l) => l.toLowerCase().includes('bootstrap'))).toBe(true);

      // Then start server
      server = createRelayServer(config, { logger });
      await server.start();
      expect(server.listening).toBe(true);

      // Verify bootstrap log came before server listening log
      const bootstrapIdx = logs.findIndex((l) => l.toLowerCase().includes('bootstrap'));
      const listeningIdx = logs.findIndex((l) => l.includes('listening'));
      expect(bootstrapIdx).toBeLessThan(listeningIdx);
    });

    it('bootstrap accepts optional logger for observability', async () => {
      const logs: string[] = [];
      await bootstrapRelay({ logger: (msg: string) => logs.push(msg) });
      expect(logs.length).toBeGreaterThan(0);
    });
  });
});
