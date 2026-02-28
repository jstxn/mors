/**
 * Tests for auth lifecycle gaps: re-gating after logout and token liveness.
 *
 * Covers:
 * - VAL-AUTH-005: Protected commands fail with login-required guidance after logout
 * - VAL-AUTH-006: Expired/revoked tokens are detected rather than reported as authenticated
 * - Recovery guidance points user to re-login path
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  saveSession,
  clearSession,
  markAuthEnabled,
  type AuthSession,
} from '../../src/auth/session.js';

import {
  requireAuth,
  verifyTokenLiveness,
  NotAuthenticatedError,
  TokenLivenessError,
} from '../../src/auth/guards.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mors-auth-lifecycle-test-'));
}

function makeSession(overrides?: Partial<AuthSession>): AuthSession {
  return {
    accessToken: 'gho_test_token_abc123',
    tokenType: 'bearer',
    scope: 'read:user',
    githubUserId: 12345,
    githubLogin: 'testuser',
    deviceId: 'device-abc-001',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('auth/guards', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── VAL-AUTH-005: requireAuth re-gates after logout ───────────────

  describe('requireAuth', () => {
    it('returns session when auth is enabled and valid session exists', () => {
      const session = makeSession();
      markAuthEnabled(tempDir);
      saveSession(tempDir, session);

      const result = requireAuth(tempDir);
      expect(result).not.toBeNull();
      expect(result).toHaveProperty('accessToken', session.accessToken);
      expect(result).toHaveProperty('githubUserId', session.githubUserId);
    });

    it('returns null when user has never logged in (no auth marker)', () => {
      // No auth marker, no session → local-only mode, no auth required
      const result = requireAuth(tempDir);
      expect(result).toBeNull();
    });

    it('throws NotAuthenticatedError after logout clears session (auth was enabled)', () => {
      const session = makeSession();
      // Simulate login: mark auth as enabled + save session
      markAuthEnabled(tempDir);
      saveSession(tempDir, session);

      // Verify session exists first
      const loaded = requireAuth(tempDir);
      expect(loaded).toHaveProperty('githubUserId', 12345);

      // Simulate logout: clear session but auth marker remains
      clearSession(tempDir);

      // Now protected commands should fail with re-auth guidance
      expect(() => requireAuth(tempDir)).toThrow(NotAuthenticatedError);
    });

    it('NotAuthenticatedError includes actionable login guidance', () => {
      // Enable auth so requireAuth actually enforces it
      markAuthEnabled(tempDir);

      try {
        requireAuth(tempDir);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NotAuthenticatedError);
        expect((err as NotAuthenticatedError).message).toContain('mors login');
      }
    });

    it('throws NotAuthenticatedError for corrupt session file when auth is enabled', () => {
      markAuthEnabled(tempDir);
      writeFileSync(join(tempDir, 'session.json'), 'not valid json!!!', { mode: 0o600 });
      expect(() => requireAuth(tempDir)).toThrow(NotAuthenticatedError);
    });

    it('throws NotAuthenticatedError for session with missing fields when auth is enabled', () => {
      markAuthEnabled(tempDir);
      writeFileSync(join(tempDir, 'session.json'), JSON.stringify({ accessToken: 'partial' }), {
        mode: 0o600,
      });
      expect(() => requireAuth(tempDir)).toThrow(NotAuthenticatedError);
    });
  });

  // ── VAL-AUTH-006: Token liveness validation ───────────────────────

  describe('verifyTokenLiveness', () => {
    it('resolves with principal for a valid token', async () => {
      const { createServer } = await import('node:http');

      const server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 12345, login: 'testuser' }));
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        const result = await verifyTokenLiveness('gho_valid_token', {
          apiBaseUrl: `http://127.0.0.1:${port}`,
        });

        expect(result).toHaveProperty('githubUserId', 12345);
        expect(result).toHaveProperty('githubLogin', 'testuser');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('throws TokenLivenessError for expired token (401)', async () => {
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
          verifyTokenLiveness('gho_expired_token', {
            apiBaseUrl: `http://127.0.0.1:${port}`,
          })
        ).rejects.toThrow(TokenLivenessError);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('TokenLivenessError includes actionable re-auth guidance', async () => {
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
        await verifyTokenLiveness('gho_expired_token', {
          apiBaseUrl: `http://127.0.0.1:${port}`,
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TokenLivenessError);
        const error = err as TokenLivenessError;
        expect(error.message).toContain('mors login');
        expect(error.message).toMatch(/expired|revoked/i);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('throws TokenLivenessError for revoked token (401)', async () => {
      const { createServer } = await import('node:http');

      const server = createServer((_req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'token revoked' }));
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        await expect(
          verifyTokenLiveness('gho_revoked_token', {
            apiBaseUrl: `http://127.0.0.1:${port}`,
          })
        ).rejects.toThrow(TokenLivenessError);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('throws TokenLivenessError for server error (5xx)', async () => {
      const { createServer } = await import('node:http');

      const server = createServer((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Internal Server Error' }));
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        await expect(
          verifyTokenLiveness('gho_valid_token', {
            apiBaseUrl: `http://127.0.0.1:${port}`,
          })
        ).rejects.toThrow(TokenLivenessError);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('throws TokenLivenessError when API returns invalid user data', async () => {
      const { createServer } = await import('node:http');

      const server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'test' })); // missing id and login
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        await expect(
          verifyTokenLiveness('gho_valid_token', {
            apiBaseUrl: `http://127.0.0.1:${port}`,
          })
        ).rejects.toThrow(TokenLivenessError);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('does not leak token value in error message', async () => {
      const { createServer } = await import('node:http');

      const tokenCanary = 'gho_secret_canary_do_not_leak_xyz';

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
        await verifyTokenLiveness(tokenCanary, {
          apiBaseUrl: `http://127.0.0.1:${port}`,
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TokenLivenessError);
        expect((err as TokenLivenessError).message).not.toContain(tokenCanary);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  // ── VAL-AUTH-006: Error types and recovery guidance ────────────────

  describe('error types', () => {
    it('NotAuthenticatedError has descriptive name', () => {
      const err = new NotAuthenticatedError();
      expect(err.name).toBe('NotAuthenticatedError');
    });

    it('NotAuthenticatedError includes login guidance', () => {
      const err = new NotAuthenticatedError();
      expect(err.message).toContain('mors login');
    });

    it('TokenLivenessError has descriptive name', () => {
      const err = new TokenLivenessError();
      expect(err.name).toBe('TokenLivenessError');
    });

    it('TokenLivenessError includes re-auth guidance', () => {
      const err = new TokenLivenessError();
      expect(err.message).toContain('mors login');
      expect(err.message).toMatch(/expired|revoked/i);
    });

    it('TokenLivenessError accepts optional detail', () => {
      const err = new TokenLivenessError('GitHub API returned 401');
      expect(err.message).toContain('mors login');
      expect(err.message).toContain('GitHub API returned 401');
    });
  });
});
