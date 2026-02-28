/**
 * Tests for auth session persistence and lifecycle.
 *
 * Covers:
 * - VAL-AUTH-002: Persisted authenticated session across process restarts
 * - VAL-AUTH-005: Logout clears local auth state and re-gates protected flows
 * - VAL-AUTH-008: Account binding uses stable native account ID
 * - VAL-AUTH-009: Multi-device login creates distinct devices under one account
 * - VAL-AUTH-010: Auth/session artifacts are permission-hardened and non-leaking
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, statSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

import {
  saveSession,
  loadSession,
  clearSession,
  type AuthSession,
} from '../../src/auth/session.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mors-session-test-'));
}

describe('auth/session', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('saves and loads a session across simulated restart', () => {
    const session: AuthSession = {
      accessToken: 'mors-session.test-payload.test-sig',
      tokenType: 'bearer',
      accountId: 'acct_abc123def456',
      deviceId: 'device-abc-001',
      createdAt: new Date().toISOString(),
    };

    saveSession(tempDir, session);
    const loaded = loadSession(tempDir);
    expect(loaded).not.toBeNull();
    expect(loaded).toHaveProperty('accessToken', 'mors-session.test-payload.test-sig');
    expect(loaded).toHaveProperty('accountId', 'acct_abc123def456');
    expect(loaded).toHaveProperty('deviceId', 'device-abc-001');
  });

  it('returns null when no session exists', () => {
    expect(loadSession(tempDir)).toBeNull();
  });

  it('clearSession removes persisted auth state', () => {
    const session: AuthSession = {
      accessToken: 'mors-session.xyz.sig',
      tokenType: 'bearer',
      accountId: 'acct_99999',
      deviceId: 'device-logout-001',
      createdAt: new Date().toISOString(),
    };
    saveSession(tempDir, session);
    expect(loadSession(tempDir)).not.toBeNull();
    clearSession(tempDir);
    expect(loadSession(tempDir)).toBeNull();
  });

  it('clearSession is idempotent when no session exists', () => {
    clearSession(tempDir);
    expect(loadSession(tempDir)).toBeNull();
  });

  it('session uses accountId as stable identity key', () => {
    const session: AuthSession = {
      accessToken: 'mors-session.stable.sig',
      tokenType: 'bearer',
      accountId: 'acct_stable_42',
      deviceId: 'device-stable-001',
      createdAt: new Date().toISOString(),
    };
    saveSession(tempDir, session);
    const loaded = loadSession(tempDir);
    expect(loaded).toHaveProperty('accountId', 'acct_stable_42');
    expect(typeof loaded?.accountId).toBe('string');
  });

  it('different device IDs create distinct sessions in separate config dirs', () => {
    const tempDir2 = makeTempDir();
    try {
      const s1: AuthSession = {
        accessToken: 'mors-session.d1.sig1',
        tokenType: 'bearer',
        accountId: 'acct_multidevice',
        deviceId: 'device-laptop-001',
        createdAt: new Date().toISOString(),
      };
      const s2: AuthSession = {
        accessToken: 'mors-session.d2.sig2',
        tokenType: 'bearer',
        accountId: 'acct_multidevice',
        deviceId: 'device-desktop-002',
        createdAt: new Date().toISOString(),
      };
      saveSession(tempDir, s1);
      saveSession(tempDir2, s2);
      const l1 = loadSession(tempDir);
      const l2 = loadSession(tempDir2);
      expect(l1?.accountId).toBe(l2?.accountId);
      expect(l1?.deviceId).not.toBe(l2?.deviceId);
      expect(l1?.accessToken).not.toBe(l2?.accessToken);
    } finally {
      rmSync(tempDir2, { recursive: true, force: true });
    }
  });

  it('session file has owner-only permissions (0600)', () => {
    const session: AuthSession = {
      accessToken: 'mors-session.secret.sig',
      tokenType: 'bearer',
      accountId: 'acct_secure',
      deviceId: 'device-secure-001',
      createdAt: new Date().toISOString(),
    };
    saveSession(tempDir, session);
    const stat = statSync(join(tempDir, 'session.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('session file content does not leak token in other files', () => {
    const session: AuthSession = {
      accessToken: 'mors-session.canary.sig-leak',
      tokenType: 'bearer',
      accountId: 'acct_leak_test',
      deviceId: 'device-leak-001',
      createdAt: new Date().toISOString(),
    };
    saveSession(tempDir, session);
    const files = readdirSync(tempDir);
    for (const file of files) {
      if (file === 'session.json') continue;
      const content = readFileSync(join(tempDir, file), 'utf-8');
      expect(content).not.toContain('mors-session.canary.sig-leak');
    }
  });

  it('loadSession returns all expected fields', () => {
    const now = new Date().toISOString();
    const session: AuthSession = {
      accessToken: 'mors-session.complete.sig',
      tokenType: 'bearer',
      accountId: 'acct_complete_555',
      deviceId: 'device-complete-001',
      createdAt: now,
    };
    saveSession(tempDir, session);
    expect(loadSession(tempDir)).toEqual(session);
  });

  it('corrupt session file returns null gracefully', () => {
    writeFileSync(join(tempDir, 'session.json'), 'not valid json!!!', { mode: 0o600 });
    expect(loadSession(tempDir)).toBeNull();
  });

  it('session with missing required fields returns null', () => {
    writeFileSync(join(tempDir, 'session.json'), JSON.stringify({ accessToken: 'partial' }), { mode: 0o600 });
    expect(loadSession(tempDir)).toBeNull();
  });
});
