/**
 * Tests for fail-closed relay signing key enforcement.
 *
 * Covers:
 * - Relay startup fails clearly if MORS_RELAY_SIGNING_KEY is unset or empty
 * - Token verification never defaults to an empty signing key
 * - Error output includes remediation for configuring signing key
 * - Empty-key token forgery is eliminated
 *
 * Feature: native-identity-core-fix-relay-signing-key-fail-closed
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createNativeTokenVerifier } from '../../src/relay/auth-middleware.js';
import { generateSigningKey, generateSessionToken } from '../../src/auth/native.js';

describe('relay signing key fail-closed', () => {
  // Save original env and restore after each test
  let originalSigningKey: string | undefined;

  beforeEach(() => {
    originalSigningKey = process.env['MORS_RELAY_SIGNING_KEY'];
  });

  afterEach(() => {
    if (originalSigningKey === undefined) {
      delete process.env['MORS_RELAY_SIGNING_KEY'];
    } else {
      process.env['MORS_RELAY_SIGNING_KEY'] = originalSigningKey;
    }
  });

  describe('createProductionServerOptions fail-closed startup', () => {
    it('throws when MORS_RELAY_SIGNING_KEY is unset', async () => {
      delete process.env['MORS_RELAY_SIGNING_KEY'];

      // Dynamic import to get the real module which reads process.env at call time
      const { createProductionServerOptions } = await import('../../src/relay/index.js');

      expect(() => createProductionServerOptions()).toThrow(/MORS_RELAY_SIGNING_KEY/);
    });

    it('throws when MORS_RELAY_SIGNING_KEY is empty string', async () => {
      process.env['MORS_RELAY_SIGNING_KEY'] = '';

      const { createProductionServerOptions } = await import('../../src/relay/index.js');

      expect(() => createProductionServerOptions()).toThrow(/MORS_RELAY_SIGNING_KEY/);
    });

    it('throws when MORS_RELAY_SIGNING_KEY is whitespace only', async () => {
      process.env['MORS_RELAY_SIGNING_KEY'] = '   ';

      const { createProductionServerOptions } = await import('../../src/relay/index.js');

      expect(() => createProductionServerOptions()).toThrow(/MORS_RELAY_SIGNING_KEY/);
    });

    it('error message includes remediation guidance', async () => {
      delete process.env['MORS_RELAY_SIGNING_KEY'];

      const { createProductionServerOptions } = await import('../../src/relay/index.js');

      try {
        createProductionServerOptions();
        expect.unreachable('should have thrown');
      } catch (err) {
        const msg = (err as Error).message;
        // Should mention the env var name
        expect(msg).toContain('MORS_RELAY_SIGNING_KEY');
        // Should include actionable remediation guidance
        expect(msg).toMatch(/set|configure|generate|export/i);
      }
    });

    it('succeeds when MORS_RELAY_SIGNING_KEY is a valid non-empty key', async () => {
      process.env['MORS_RELAY_SIGNING_KEY'] = generateSigningKey();

      const { createProductionServerOptions } = await import('../../src/relay/index.js');

      const opts = createProductionServerOptions();
      expect(opts.tokenVerifier).toBeDefined();
      expect(opts.messageStore).toBeDefined();
      expect(opts.participantStore).toBeDefined();
    });
  });

  describe('createNativeTokenVerifier rejects empty signing key', () => {
    it('rejects token verification when signing key is empty', async () => {
      const verifier = createNativeTokenVerifier('');

      // Create a token signed with empty key (the attack scenario)
      const token = generateSessionToken({
        accountId: 'acct_attacker',
        deviceId: 'device-evil',
        signingKey: '',
      });

      const result = await verifier(token);
      expect(result).toBeNull();
    });

    it('rejects token verification when signing key is whitespace', async () => {
      const verifier = createNativeTokenVerifier('   ');

      const token = generateSessionToken({
        accountId: 'acct_attacker',
        deviceId: 'device-evil',
        signingKey: '   ',
      });

      const result = await verifier(token);
      expect(result).toBeNull();
    });

    it('accepts token with valid non-empty signing key', async () => {
      const key = generateSigningKey();
      const verifier = createNativeTokenVerifier(key);

      const token = generateSessionToken({
        accountId: 'acct_legit',
        deviceId: 'device-good',
        signingKey: key,
      });

      const result = await verifier(token);
      expect(result).not.toBeNull();
      expect(result?.accountId).toBe('acct_legit');
      expect(result?.deviceId).toBe('device-good');
    });

    it('rejects forged token signed with empty key against real key verifier', async () => {
      const realKey = generateSigningKey();
      const verifier = createNativeTokenVerifier(realKey);

      // Attacker forges a token using empty signing key
      const forgedToken = generateSessionToken({
        accountId: 'acct_forged',
        deviceId: 'device-forged',
        signingKey: '',
      });

      const result = await verifier(forgedToken);
      expect(result).toBeNull();
    });
  });

  describe('empty-key token forgery prevention', () => {
    it('token signed with empty key is not verifiable with empty key verifier', async () => {
      // This test demonstrates the forgery risk that fail-closed eliminates:
      // If the verifier accepted an empty key, an attacker could forge tokens.
      const verifier = createNativeTokenVerifier('');

      const forgedToken = generateSessionToken({
        accountId: 'acct_forged_admin',
        deviceId: 'device-admin-spoof',
        signingKey: '',
      });

      // The verifier must reject this — fail-closed means empty key = no verification
      const result = await verifier(forgedToken);
      expect(result).toBeNull();
    });
  });
});
