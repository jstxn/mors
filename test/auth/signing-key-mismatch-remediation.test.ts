/**
 * Tests for signing-key mismatch remediation guidance.
 *
 * When CLI and relay use different signing keys, token verification
 * failures must surface explicit signing-key mismatch remediation
 * instead of generic "expired/revoked" wording.
 *
 * Feature: native-identity-core-fix-signing-key-mismatch-remediation
 *
 * Covers:
 * - Key-mismatch paths produce explicit remediation guidance to align MORS_RELAY_SIGNING_KEY
 * - Generic token-expired wording is not used for signing-key mismatch failures
 * - Auth guard tests assert remediation text for mismatch scenarios
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { generateSessionToken, generateSigningKey } from '../../src/auth/native.js';

import {
  verifyTokenLiveness,
  TokenLivenessError,
  SigningKeyMismatchError,
} from '../../src/auth/guards.js';

import { saveSigningKey } from '../../src/auth/session.js';

import { extractAndVerify, createNativeTokenVerifier } from '../../src/relay/auth-middleware.js';

import type { IncomingMessage } from 'node:http';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mors-keymismatch-test-'));
}

// ── Guards: verifyTokenLiveness ──────────────────────────────────────

describe('signing-key mismatch remediation in guards', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('throws SigningKeyMismatchError (not generic TokenLivenessError) when token is well-formed but signed with a different key', async () => {
    const keyA = generateSigningKey();
    const keyB = generateSigningKey();

    // Generate a valid token with key A
    const token = generateSessionToken({
      accountId: 'acct_mismatch_test',
      deviceId: 'device-001',
      signingKey: keyA,
    });

    // Verify with key B — a different key
    saveSigningKey(tempDir, keyB);

    await expect(verifyTokenLiveness(token, { configDir: tempDir })).rejects.toThrow(
      SigningKeyMismatchError
    );
  });

  it('SigningKeyMismatchError includes MORS_RELAY_SIGNING_KEY remediation guidance', async () => {
    const keyA = generateSigningKey();
    const keyB = generateSigningKey();

    const token = generateSessionToken({
      accountId: 'acct_mismatch_test',
      deviceId: 'device-001',
      signingKey: keyA,
    });

    saveSigningKey(tempDir, keyB);

    try {
      await verifyTokenLiveness(token, { configDir: tempDir });
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SigningKeyMismatchError);
      const msg = (err as SigningKeyMismatchError).message;
      // Must mention MORS_RELAY_SIGNING_KEY
      expect(msg).toContain('MORS_RELAY_SIGNING_KEY');
      // Must include actionable guidance
      expect(msg).toMatch(/mors login/i);
    }
  });

  it('SigningKeyMismatchError does NOT use generic expired/revoked wording', async () => {
    const keyA = generateSigningKey();
    const keyB = generateSigningKey();

    const token = generateSessionToken({
      accountId: 'acct_mismatch_no_expired',
      deviceId: 'device-002',
      signingKey: keyA,
    });

    saveSigningKey(tempDir, keyB);

    try {
      await verifyTokenLiveness(token, { configDir: tempDir });
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SigningKeyMismatchError);
      const msg = (err as SigningKeyMismatchError).message;
      // Must NOT contain generic expired/revoked wording as the primary message
      expect(msg).not.toMatch(/^Your access token has expired or been revoked/);
    }
  });

  it('SigningKeyMismatchError extends TokenLivenessError for backward compatibility', async () => {
    const keyA = generateSigningKey();
    const keyB = generateSigningKey();

    const token = generateSessionToken({
      accountId: 'acct_compat_test',
      deviceId: 'device-003',
      signingKey: keyA,
    });

    saveSigningKey(tempDir, keyB);

    try {
      await verifyTokenLiveness(token, { configDir: tempDir });
      expect.unreachable('Should have thrown');
    } catch (err) {
      // Should be catchable as TokenLivenessError too
      expect(err).toBeInstanceOf(TokenLivenessError);
      expect(err).toBeInstanceOf(SigningKeyMismatchError);
    }
  });

  it('truly malformed tokens still throw generic TokenLivenessError (not mismatch)', async () => {
    const signingKey = generateSigningKey();
    saveSigningKey(tempDir, signingKey);

    // Completely malformed token — not a signing-key issue
    await expect(
      verifyTokenLiveness('not-a-valid-token-at-all', { configDir: tempDir })
    ).rejects.toThrow(TokenLivenessError);

    try {
      await verifyTokenLiveness('not-a-valid-token-at-all', { configDir: tempDir });
    } catch (err) {
      // Should NOT be a SigningKeyMismatchError
      expect(err).not.toBeInstanceOf(SigningKeyMismatchError);
    }
  });

  it('tampered payload (corrupted base64) throws generic TokenLivenessError', async () => {
    const signingKey = generateSigningKey();
    const token = generateSessionToken({
      accountId: 'acct_tamper',
      deviceId: 'device-004',
      signingKey,
    });

    saveSigningKey(tempDir, signingKey);

    // Corrupt the payload portion (not just the signature)
    const parts = token.split('.');
    const tampered = `${parts[0]}.AAAA_corrupted_payload.${parts[2]}`;

    try {
      await verifyTokenLiveness(tampered, { configDir: tempDir });
    } catch (err) {
      // Corrupted payload = not clearly a key mismatch
      expect(err).toBeInstanceOf(TokenLivenessError);
      expect(err).not.toBeInstanceOf(SigningKeyMismatchError);
    }
  });

  it('does not leak token value in SigningKeyMismatchError message', async () => {
    const keyA = generateSigningKey();
    const keyB = generateSigningKey();

    const token = generateSessionToken({
      accountId: 'acct_noleak',
      deviceId: 'device-005',
      signingKey: keyA,
    });

    saveSigningKey(tempDir, keyB);

    try {
      await verifyTokenLiveness(token, { configDir: tempDir });
      expect.unreachable('Should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(token);
      // Also ensure signing keys aren't leaked
      expect(msg).not.toContain(keyA);
      expect(msg).not.toContain(keyB);
    }
  });

  it('SigningKeyMismatchError has descriptive name', () => {
    const err = new SigningKeyMismatchError();
    expect(err.name).toBe('SigningKeyMismatchError');
  });

  it('SigningKeyMismatchError includes key alignment remediation in default message', () => {
    const err = new SigningKeyMismatchError();
    expect(err.message).toContain('MORS_RELAY_SIGNING_KEY');
    expect(err.message).toMatch(/mors login/i);
    // Should NOT use the generic expired/revoked wording
    expect(err.message).not.toMatch(/^Your access token has expired or been revoked/);
  });
});

// ── Relay auth middleware: mismatch detection ────────────────────────

describe('signing-key mismatch remediation in relay auth middleware', () => {
  it('extractAndVerify returns mismatch-specific detail for well-formed token with wrong key', async () => {
    const keyA = generateSigningKey();
    const keyB = generateSigningKey();

    const token = generateSessionToken({
      accountId: 'acct_relay_mismatch',
      deviceId: 'device-relay-001',
      signingKey: keyA,
    });

    // Create a verifier that uses keyB (different from token's key)
    const verifier = createNativeTokenVerifier(keyB);

    // Simulate a request with the mismatched token
    const req = {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as IncomingMessage;

    const result = await extractAndVerify(req, verifier);

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      // The detail should mention signing key mismatch, not generic expired wording
      expect(result.detail).toContain('MORS_RELAY_SIGNING_KEY');
      expect(result.detail).not.toMatch(/^Invalid or expired token/);
    }
  });

  it('extractAndVerify returns generic detail for completely malformed token', async () => {
    const signingKey = generateSigningKey();
    const verifier = createNativeTokenVerifier(signingKey);

    const req = {
      headers: { authorization: 'Bearer totally-not-a-mors-token' },
    } as unknown as IncomingMessage;

    const result = await extractAndVerify(req, verifier);

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      // Generic tokens should get generic messaging
      expect(result.detail).not.toContain('MORS_RELAY_SIGNING_KEY');
    }
  });
});
