/**
 * Tests for auth lifecycle: re-gating after logout and token liveness.
 *
 * Covers:
 * - VAL-AUTH-005: Protected commands fail with login-required guidance after logout
 * - VAL-AUTH-006: Expired/revoked tokens are detected
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
  saveSigningKey,
  type AuthSession,
} from '../../src/auth/session.js';

import {
  requireAuth,
  verifyTokenLiveness,
  NotAuthenticatedError,
  TokenLivenessError,
} from '../../src/auth/guards.js';

import {
  generateSessionToken,
  generateSigningKey,
} from '../../src/auth/native.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mors-auth-lifecycle-test-'));
}

function makeSession(overrides?: Partial<AuthSession>): AuthSession {
  return {
    accessToken: 'mors-session.test-payload.test-sig',
    tokenType: 'bearer',
    accountId: 'acct_test_12345',
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

  describe('requireAuth', () => {
    it('returns session when auth is enabled and valid session exists', () => {
      const session = makeSession();
      markAuthEnabled(tempDir);
      saveSession(tempDir, session);
      const result = requireAuth(tempDir);
      expect(result).not.toBeNull();
      expect(result).toHaveProperty('accountId', session.accountId);
    });

    it('returns null when user has never logged in', () => {
      expect(requireAuth(tempDir)).toBeNull();
    });

    it('throws NotAuthenticatedError after logout', () => {
      const session = makeSession();
      markAuthEnabled(tempDir);
      saveSession(tempDir, session);
      expect(requireAuth(tempDir)).toHaveProperty('accountId', 'acct_test_12345');
      clearSession(tempDir);
      expect(() => requireAuth(tempDir)).toThrow(NotAuthenticatedError);
    });

    it('NotAuthenticatedError includes actionable login guidance', () => {
      markAuthEnabled(tempDir);
      try {
        requireAuth(tempDir);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NotAuthenticatedError);
        expect((err as NotAuthenticatedError).message).toContain('mors login');
      }
    });

    it('throws for corrupt session file when auth is enabled', () => {
      markAuthEnabled(tempDir);
      writeFileSync(join(tempDir, 'session.json'), 'not valid json!!!', { mode: 0o600 });
      expect(() => requireAuth(tempDir)).toThrow(NotAuthenticatedError);
    });

    it('throws for session with missing fields when auth is enabled', () => {
      markAuthEnabled(tempDir);
      writeFileSync(join(tempDir, 'session.json'), JSON.stringify({ accessToken: 'partial' }), { mode: 0o600 });
      expect(() => requireAuth(tempDir)).toThrow(NotAuthenticatedError);
    });
  });

  describe('verifyTokenLiveness', () => {
    it('resolves with principal for a valid native session token', async () => {
      const signingKey = generateSigningKey();
      const token = generateSessionToken({ accountId: 'acct_valid_123', deviceId: 'device-test-001', signingKey });
      saveSigningKey(tempDir, signingKey);
      const result = await verifyTokenLiveness(token, { configDir: tempDir });
      expect(result).toHaveProperty('accountId', 'acct_valid_123');
      expect(result).toHaveProperty('deviceId', 'device-test-001');
    });

    it('throws TokenLivenessError for tampered token', async () => {
      const signingKey = generateSigningKey();
      const token = generateSessionToken({ accountId: 'acct_tamper', deviceId: 'device-002', signingKey });
      saveSigningKey(tempDir, signingKey);
      const tampered = token.replace(/.$/, 'X');
      await expect(verifyTokenLiveness(tampered, { configDir: tempDir })).rejects.toThrow(TokenLivenessError);
    });

    it('throws TokenLivenessError for wrong signing key', async () => {
      const key1 = generateSigningKey();
      const key2 = generateSigningKey();
      const token = generateSessionToken({ accountId: 'acct_wrong_key', deviceId: 'device-003', signingKey: key1 });
      saveSigningKey(tempDir, key2);
      await expect(verifyTokenLiveness(token, { configDir: tempDir })).rejects.toThrow(TokenLivenessError);
    });

    it('TokenLivenessError includes re-auth guidance', async () => {
      const signingKey = generateSigningKey();
      saveSigningKey(tempDir, signingKey);
      try {
        await verifyTokenLiveness('invalid-token', { configDir: tempDir });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TokenLivenessError);
        expect((err as TokenLivenessError).message).toContain('mors login');
        expect((err as TokenLivenessError).message).toMatch(/expired|revoked/i);
      }
    });

    it('throws when no signing key is available', async () => {
      await expect(verifyTokenLiveness('some-token', { configDir: tempDir })).rejects.toThrow(TokenLivenessError);
    });

    it('does not leak token value in error message', async () => {
      const canary = 'mors-session.secret_canary_do_not_leak.fake';
      const signingKey = generateSigningKey();
      saveSigningKey(tempDir, signingKey);
      try {
        await verifyTokenLiveness(canary, { configDir: tempDir });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TokenLivenessError);
        expect((err as TokenLivenessError).message).not.toContain(canary);
      }
    });
  });

  describe('error types', () => {
    it('NotAuthenticatedError has descriptive name', () => {
      expect(new NotAuthenticatedError().name).toBe('NotAuthenticatedError');
    });
    it('NotAuthenticatedError includes login guidance', () => {
      expect(new NotAuthenticatedError().message).toContain('mors login');
    });
    it('TokenLivenessError has descriptive name', () => {
      expect(new TokenLivenessError().name).toBe('TokenLivenessError');
    });
    it('TokenLivenessError includes re-auth guidance', () => {
      const err = new TokenLivenessError();
      expect(err.message).toContain('mors login');
      expect(err.message).toMatch(/expired|revoked/i);
    });
    it('TokenLivenessError accepts optional detail', () => {
      const err = new TokenLivenessError('signing key invalid');
      expect(err.message).toContain('mors login');
      expect(err.message).toContain('signing key invalid');
    });
  });
});
