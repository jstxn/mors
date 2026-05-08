import { describe, expect, it } from 'vitest';
import { generateSessionToken, verifySessionToken } from '../../src/auth/native.js';
import {
  createNativeTokenVerifier,
  principalHasScope,
  type AuthPrincipal,
} from '../../src/relay/auth-middleware.js';

describe('scoped native session tokens', () => {
  const signingKey = 'test-signing-key-for-scoped-token-tests';

  it('round-trips relay scopes through native session token verification', () => {
    const token = generateSessionToken({
      accountId: 'acct_agent',
      deviceId: 'sandbox-worker-a',
      signingKey,
      scopes: ['messages:read', 'events:read'],
    });

    const payload = verifySessionToken(token, signingKey);

    expect(payload).toMatchObject({
      accountId: 'acct_agent',
      deviceId: 'sandbox-worker-a',
      scopes: ['messages:read', 'events:read'],
    });
  });

  it('exposes scopes from the relay native token verifier', async () => {
    const token = generateSessionToken({
      accountId: 'acct_agent',
      deviceId: 'sandbox-worker-a',
      signingKey,
      scopes: ['messages:read'],
    });

    const verifier = createNativeTokenVerifier(signingKey);
    const principal = await verifier(token);

    expect(principal).toEqual({
      accountId: 'acct_agent',
      deviceId: 'sandbox-worker-a',
      scopes: ['messages:read'],
    });
  });

  it('treats unscoped principals as full-session principals for compatibility', () => {
    const principal: AuthPrincipal = {
      accountId: 'acct_full',
      deviceId: 'device-full',
    };

    expect(principalHasScope(principal, 'messages:write')).toBe(true);
    expect(principalHasScope(principal, 'contacts:write')).toBe(true);
  });

  it('treats empty scope arrays as no direct relay permissions', () => {
    const principal: AuthPrincipal = {
      accountId: 'acct_sandbox',
      deviceId: 'sandbox-empty',
      scopes: [],
    };

    expect(principalHasScope(principal, 'messages:read')).toBe(false);
    expect(principalHasScope(principal, 'messages:write')).toBe(false);
  });
});
