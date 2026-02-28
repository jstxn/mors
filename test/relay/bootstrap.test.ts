/**
 * Integration tests for the relay service runtime scaffold.
 *
 * Covers:
 * - Server starts on configured port with deterministic startup logs
 * - Health endpoint returns success payload for readiness checks
 * - Config placeholders load safely with explicit missing-config diagnostics
 * - Test harness can spin relay up/down without orphaned processes
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { loadRelayConfig, type RelayConfig } from '../../src/relay/config.js';

/** Helper to make HTTP requests to the relay server. */
async function fetchRelay(port: number, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.text();
  return { status: res.status, body };
}

/** Find a random available port for test isolation. */
function getTestPort(): number {
  // Use a random port in ephemeral range for test isolation
  return 30000 + Math.floor(Math.random() * 10000);
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
      const port = getTestPort();
      const config: RelayConfig = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      server = createRelayServer(config);
      await server.start();
      expect(server.listening).toBe(true);
      expect(server.port).toBe(port);
    });

    it('emits deterministic startup log', async () => {
      const port = getTestPort();
      const logs: string[] = [];
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      server = createRelayServer(config, { logger: (msg: string) => logs.push(msg) });
      await server.start();
      expect(logs.some((l) => l.includes('listening') && l.includes(String(port)))).toBe(true);
    });

    it('close resolves cleanly and port is freed', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      server = createRelayServer(config);
      await server.start();
      await server.close();
      expect(server.listening).toBe(false);
      server = null;

      // Verify port is freed by starting a new server on the same port
      const server2 = createRelayServer(config);
      await server2.start();
      expect(server2.listening).toBe(true);
      await server2.close();
    });

    it('double-close is idempotent', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      server = createRelayServer(config);
      await server.start();
      await server.close();
      // Second close should not throw
      await server.close();
      expect(server.listening).toBe(false);
      server = null;
    });

    it('close terminates in-flight connections without hanging', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      server = createRelayServer(config);
      await server.start();

      // Start a request but close server during it
      const fetchPromise = fetch(`http://127.0.0.1:${port}/health`);
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
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      server = createRelayServer(config);
      await server.start();

      const { status, body } = await fetchRelay(port, '/health');
      expect(status).toBe(200);
      const payload = JSON.parse(body);
      expect(payload.status).toBe('ok');
      expect(payload.service).toBe('mors-relay');
    });

    it('health response includes uptime field', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      server = createRelayServer(config);
      await server.start();

      const { body } = await fetchRelay(port, '/health');
      const payload = JSON.parse(body);
      expect(typeof payload.uptime).toBe('number');
      expect(payload.uptime).toBeGreaterThanOrEqual(0);
    });

    it('health response includes config diagnostics count', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      server = createRelayServer(config);
      await server.start();

      const { body } = await fetchRelay(port, '/health');
      const payload = JSON.parse(body);
      expect(typeof payload.configWarnings).toBe('number');
    });

    it('returns 404 for unknown routes', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      server = createRelayServer(config);
      await server.start();

      const { status, body } = await fetchRelay(port, '/nonexistent');
      expect(status).toBe(404);
      const payload = JSON.parse(body);
      expect(payload.error).toBe('not_found');
    });

    it('returns 405 for non-GET methods on /health', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      server = createRelayServer(config);
      await server.start();

      const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST' });
      expect(res.status).toBe(405);
    });
  });

  // --- SSE baseline tests ---

  describe('SSE baseline', () => {
    it('GET /events returns SSE content type headers', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      server = createRelayServer(config);
      await server.start();

      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/events`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('connection')).toBe('keep-alive');
      controller.abort();
    });

    it('SSE stream sends initial heartbeat comment', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      server = createRelayServer(config);
      await server.start();

      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/events`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
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
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });

      for (let i = 0; i < 3; i++) {
        const srv = createRelayServer(config);
        await srv.start();
        expect(srv.listening).toBe(true);
        const { status } = await fetchRelay(port, '/health');
        expect(status).toBe(200);
        await srv.close();
        expect(srv.listening).toBe(false);
      }
    });

    it('parallel server instances on different ports', async () => {
      const port1 = getTestPort();
      const port2 = port1 + 1;
      const config1 = loadRelayConfig({ MORS_RELAY_PORT: String(port1) });
      const config2 = loadRelayConfig({ MORS_RELAY_PORT: String(port2) });

      const srv1 = createRelayServer(config1);
      const srv2 = createRelayServer(config2);

      await Promise.all([srv1.start(), srv2.start()]);

      const [res1, res2] = await Promise.all([
        fetchRelay(port1, '/health'),
        fetchRelay(port2, '/health'),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      await Promise.all([srv1.close(), srv2.close()]);
    });

    it('server.close() resolves even when active SSE connections exist', async () => {
      const port = getTestPort();
      const config = loadRelayConfig({ MORS_RELAY_PORT: String(port) });
      server = createRelayServer(config);
      await server.start();

      // Open an SSE connection
      const controller = new AbortController();
      const ssePromise = fetch(`http://127.0.0.1:${port}/events`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
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
});
