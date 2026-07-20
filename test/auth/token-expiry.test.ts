/**
 * Session-token expiry (H2).
 *
 * Tokens must carry an expiry and stop verifying once it lapses, so a captured
 * bearer token cannot be replayed forever. Also asserts constant-time
 * verification still accepts freshly issued tokens.
 */

import { describe, it, expect } from 'vitest';

import {
  generateSessionToken,
  verifySessionToken,
  generateSigningKey,
  DEFAULT_SESSION_TTL_SECONDS,
  type SessionTokenPayload,
} from '../../src/auth/native.js';

/** Verify a token and fail the test if it does not decode to a payload. */
function verifyOrThrow(token: string, key: string, now?: number): SessionTokenPayload {
  const payload = verifySessionToken(token, key, now !== undefined ? { now } : {});
  if (!payload) throw new Error('expected a valid token payload');
  return payload;
}

describe('session token expiry (H2)', () => {
  const signingKey = generateSigningKey();

  it('issued tokens carry an expiresAt in the future', () => {
    const token = generateSessionToken({ accountId: 'acct_a', deviceId: 'dev_a', signingKey });
    const payload = verifyOrThrow(token, signingKey);
    expect(payload.expiresAt).toBeTruthy();
    expect(Date.parse(payload.expiresAt ?? '')).toBeGreaterThan(Date.now());
  });

  it('defaults to the documented TTL window', () => {
    const token = generateSessionToken({ accountId: 'acct_a', deviceId: 'dev_a', signingKey });
    const payload = verifyOrThrow(token, signingKey);
    const issuedMs = Date.parse(payload.issuedAt);
    const expMs = Date.parse(payload.expiresAt ?? '');
    expect(Math.round((expMs - issuedMs) / 1000)).toBe(DEFAULT_SESSION_TTL_SECONDS);
  });

  it('rejects a token whose expiry has passed', () => {
    const token = generateSessionToken({
      accountId: 'acct_a',
      deviceId: 'dev_a',
      signingKey,
      expiresInSeconds: 60,
    });
    // Valid now…
    expect(verifySessionToken(token, signingKey)).not.toBeNull();
    // …but not two minutes from now.
    const future = Date.now() + 120_000;
    expect(verifySessionToken(token, signingKey, { now: future })).toBeNull();
  });

  it('honors a custom short TTL', () => {
    const token = generateSessionToken({
      accountId: 'acct_a',
      deviceId: 'dev_a',
      signingKey,
      expiresInSeconds: 3600,
    });
    const payload = verifyOrThrow(token, signingKey);
    const issuedMs = Date.parse(payload.issuedAt);
    const expMs = Date.parse(payload.expiresAt ?? '');
    expect(Math.round((expMs - issuedMs) / 1000)).toBe(3600);
  });

  it('does not accept a token forged with the wrong key regardless of clock', () => {
    const token = generateSessionToken({ accountId: 'acct_a', deviceId: 'dev_a', signingKey });
    expect(verifySessionToken(token, generateSigningKey())).toBeNull();
  });
});
