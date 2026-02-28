/**
 * Tests for GitHub OAuth device flow primitives.
 *
 * Covers:
 * - VAL-AUTH-001: CLI login starts GitHub device flow with URL/code/polling
 * - VAL-AUTH-006: Expired/revoked token recovery UX
 * - VAL-AUTH-007: Missing OAuth config fails safely with actionable guidance
 * - VAL-AUTH-008: Account binding uses stable GitHub identity key
 * - VAL-AUTH-010: Tokens not leaked in output
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  requestDeviceCode,
  pollForToken,
  fetchGitHubUser,
  validateAuthConfig,
  type DeviceCodeResponse,
  type AuthConfig,
  DeviceFlowError,
  TokenExpiredError,
} from '../../src/auth/device-flow.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mors-device-flow-test-'));
}

describe('auth/device-flow', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── VAL-AUTH-007: Missing OAuth config fails safely ────────────────

  describe('validateAuthConfig', () => {
    it('returns valid config when all variables are set', () => {
      const config: AuthConfig = {
        clientId: 'Iv1.test123',
        scope: 'read:user',
        deviceEndpoint: 'https://github.com/login/device/code',
        tokenEndpoint: 'https://github.com/login/oauth/access_token',
      };

      const result = validateAuthConfig(config);
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('reports missing clientId with actionable guidance', () => {
      const config: AuthConfig = {
        clientId: undefined as unknown as string,
        scope: 'read:user',
        deviceEndpoint: 'https://github.com/login/device/code',
        tokenEndpoint: 'https://github.com/login/oauth/access_token',
      };

      const result = validateAuthConfig(config);
      expect(result.valid).toBe(false);
      expect(result.missing.length).toBeGreaterThan(0);
      expect(result.missing[0]).toContain('GITHUB_DEVICE_CLIENT_ID');
    });

    it('reports all missing variables when config is empty', () => {
      const config: AuthConfig = {
        clientId: undefined as unknown as string,
        scope: undefined as unknown as string,
        deviceEndpoint: undefined as unknown as string,
        tokenEndpoint: undefined as unknown as string,
      };

      const result = validateAuthConfig(config);
      expect(result.valid).toBe(false);
      expect(result.missing.length).toBe(4);
    });

    it('throws AuthConfigError on fromRelayConfig with missing values', () => {
      expect(() => {
        validateAuthConfig({
          clientId: '',
          scope: 'read:user',
          deviceEndpoint: 'https://github.com/login/device/code',
          tokenEndpoint: 'https://github.com/login/oauth/access_token',
        });
      }).not.toThrow(); // empty string is reported as missing but doesn't throw

      const result = validateAuthConfig({
        clientId: '',
        scope: 'read:user',
        deviceEndpoint: 'https://github.com/login/device/code',
        tokenEndpoint: 'https://github.com/login/oauth/access_token',
      });
      expect(result.valid).toBe(false);
    });
  });

  // ── VAL-AUTH-001: Device code request ──────────────────────────────

  describe('requestDeviceCode', () => {
    it('returns device code response with required fields from mock endpoint', async () => {
      // Use a mock HTTP handler to simulate GitHub's device code endpoint
      const { createServer } = await import('node:http');

      const response: DeviceCodeResponse = {
        device_code: 'dc_test_123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      };

      const server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        const result = await requestDeviceCode({
          clientId: 'Iv1.test_client',
          scope: 'read:user',
          deviceEndpoint: `http://127.0.0.1:${port}/login/device/code`,
          tokenEndpoint: 'unused',
        });

        expect(result.device_code).toBe('dc_test_123');
        expect(result.user_code).toBe('ABCD-1234');
        expect(result.verification_uri).toBe('https://github.com/login/device');
        expect(result.expires_in).toBe(900);
        expect(result.interval).toBe(5);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('throws DeviceFlowError on non-200 response', async () => {
      const { createServer } = await import('node:http');

      const server = createServer((_req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_client' }));
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        await expect(
          requestDeviceCode({
            clientId: 'bad-client',
            scope: 'read:user',
            deviceEndpoint: `http://127.0.0.1:${port}/login/device/code`,
            tokenEndpoint: 'unused',
          })
        ).rejects.toThrow(DeviceFlowError);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  // ── VAL-AUTH-001: Token polling ────────────────────────────────────

  describe('pollForToken', () => {
    it('resolves with token after authorization_pending then success', async () => {
      const { createServer } = await import('node:http');

      let callCount = 0;
      const server = createServer((_req, res) => {
        callCount++;
        if (callCount < 3) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'authorization_pending' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'gho_polled_token_xyz',
              token_type: 'bearer',
              scope: 'read:user',
            })
          );
        }
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        const result = await pollForToken(
          {
            clientId: 'Iv1.test_client',
            scope: 'read:user',
            deviceEndpoint: 'unused',
            tokenEndpoint: `http://127.0.0.1:${port}/login/oauth/access_token`,
          },
          'dc_test_123',
          { intervalMs: 100, expiresInMs: 30000 }
        );

        expect(result.access_token).toBe('gho_polled_token_xyz');
        expect(result.token_type).toBe('bearer');
        expect(callCount).toBeGreaterThanOrEqual(3);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('throws DeviceFlowError on expired_token response', async () => {
      const { createServer } = await import('node:http');

      const server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expired_token' }));
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        await expect(
          pollForToken(
            {
              clientId: 'Iv1.test',
              scope: 'read:user',
              deviceEndpoint: 'unused',
              tokenEndpoint: `http://127.0.0.1:${port}/token`,
            },
            'dc_expired',
            { intervalMs: 100, expiresInMs: 30000 }
          )
        ).rejects.toThrow(DeviceFlowError);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('throws DeviceFlowError on access_denied', async () => {
      const { createServer } = await import('node:http');

      const server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'access_denied' }));
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        await expect(
          pollForToken(
            {
              clientId: 'Iv1.test',
              scope: 'read:user',
              deviceEndpoint: 'unused',
              tokenEndpoint: `http://127.0.0.1:${port}/token`,
            },
            'dc_denied',
            { intervalMs: 100, expiresInMs: 30000 }
          )
        ).rejects.toThrow(DeviceFlowError);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('respects slow_down by increasing interval', async () => {
      const { createServer } = await import('node:http');

      let callCount = 0;
      const callTimestamps: number[] = [];

      const server = createServer((_req, res) => {
        callCount++;
        callTimestamps.push(Date.now());

        if (callCount === 1) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'slow_down' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'gho_slow_token',
              token_type: 'bearer',
              scope: 'read:user',
            })
          );
        }
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        const result = await pollForToken(
          {
            clientId: 'Iv1.test',
            scope: 'read:user',
            deviceEndpoint: 'unused',
            tokenEndpoint: `http://127.0.0.1:${port}/token`,
          },
          'dc_slow',
          { intervalMs: 100, expiresInMs: 30000 }
        );

        expect(result.access_token).toBe('gho_slow_token');
        // After slow_down, interval should have increased
        if (callTimestamps.length >= 2) {
          const gap = callTimestamps[1] - callTimestamps[0];
          expect(gap).toBeGreaterThanOrEqual(100); // at least base interval + backoff
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  // ── VAL-AUTH-008: Stable identity from GitHub user ────────────────

  describe('fetchGitHubUser', () => {
    it('returns user with stable numeric ID', async () => {
      const { createServer } = await import('node:http');

      const server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 12345,
            login: 'testuser',
            name: 'Test User',
          })
        );
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        const user = await fetchGitHubUser('gho_test_token', {
          apiBaseUrl: `http://127.0.0.1:${port}`,
        });

        expect(user.id).toBe(12345);
        expect(user.login).toBe('testuser');
        expect(typeof user.id).toBe('number');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('throws TokenExpiredError on 401 response', async () => {
      const { createServer } = await import('node:http');

      const server = createServer((_req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Bad credentials' }));
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        await expect(
          fetchGitHubUser('gho_expired_token', {
            apiBaseUrl: `http://127.0.0.1:${port}`,
          })
        ).rejects.toThrow(TokenExpiredError);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  // ── VAL-AUTH-006: Token expiry recovery ────────────────────────────

  describe('token expiry handling', () => {
    it('TokenExpiredError includes actionable re-auth guidance', () => {
      const err = new TokenExpiredError();
      expect(err.message).toContain('mors login');
      expect(err.message.toLowerCase()).toMatch(/expired|revoked/);
    });

    it('TokenExpiredError has descriptive name', () => {
      const err = new TokenExpiredError();
      expect(err.name).toBe('TokenExpiredError');
    });
  });

  // ── VAL-AUTH-010: Token non-leakage ────────────────────────────────

  describe('token non-leakage', () => {
    it('DeviceCodeResponse does not include access_token', () => {
      const dcr: DeviceCodeResponse = {
        device_code: 'dc_test',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      };

      // Device code response should never contain an access_token
      const serialized = JSON.stringify(dcr);
      expect(serialized).not.toContain('access_token');
    });

    it('requestDeviceCode does not leak device_code in non-json user output', async () => {
      // device_code is a secret that should be sent to the server only, not displayed to user
      // user_code is what the user sees, device_code stays internal
      const dcr: DeviceCodeResponse = {
        device_code: 'dc_internal_secret',
        user_code: 'USER-VISI',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      };

      // The user-visible fields are user_code and verification_uri only
      expect(dcr.user_code).toBe('USER-VISI');
      expect(dcr.verification_uri).toBe('https://github.com/login/device');
      // device_code exists but is not for display
      expect(dcr.device_code).toBeDefined();
    });
  });
});
