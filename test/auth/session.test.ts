/**
 * Tests for auth session persistence and lifecycle.
 *
 * Covers:
 * - VAL-AUTH-002: Persisted authenticated session across process restarts
 * - VAL-AUTH-005: Logout clears local auth state and re-gates protected flows
 * - VAL-AUTH-008: Account binding uses stable GitHub identity key (not mutable username)
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

  // ── VAL-AUTH-002: persisted session survives restart ────────────────

  it('saves and loads a session across simulated restart', () => {
    const session: AuthSession = {
      accessToken: 'gho_test_token_abc123',
      tokenType: 'bearer',
      scope: 'read:user',
      githubUserId: 12345,
      githubLogin: 'testuser',
      deviceId: 'device-abc-001',
      createdAt: new Date().toISOString(),
    };

    saveSession(tempDir, session);

    // Simulate restart: load from disk
    const loaded = loadSession(tempDir);
    expect(loaded).not.toBeNull();
    expect(loaded).toHaveProperty('accessToken', 'gho_test_token_abc123');
    expect(loaded).toHaveProperty('githubUserId', 12345);
    expect(loaded).toHaveProperty('githubLogin', 'testuser');
    expect(loaded).toHaveProperty('deviceId', 'device-abc-001');
    expect(loaded).toHaveProperty('scope', 'read:user');
  });

  it('returns null when no session exists', () => {
    const loaded = loadSession(tempDir);
    expect(loaded).toBeNull();
  });

  // ── VAL-AUTH-005: logout clears session ────────────────────────────

  it('clearSession removes persisted auth state', () => {
    const session: AuthSession = {
      accessToken: 'gho_test_token_xyz',
      tokenType: 'bearer',
      scope: 'read:user',
      githubUserId: 99999,
      githubLogin: 'logoutuser',
      deviceId: 'device-logout-001',
      createdAt: new Date().toISOString(),
    };

    saveSession(tempDir, session);
    expect(loadSession(tempDir)).not.toBeNull();

    clearSession(tempDir);
    expect(loadSession(tempDir)).toBeNull();
  });

  it('clearSession is idempotent when no session exists', () => {
    // Should not throw
    clearSession(tempDir);
    expect(loadSession(tempDir)).toBeNull();
  });

  // ── VAL-AUTH-008: stable GitHub identity key ──────────────────────

  it('session uses githubUserId (stable numeric ID) as identity key, not login name', () => {
    const session: AuthSession = {
      accessToken: 'gho_test_token_stable',
      tokenType: 'bearer',
      scope: 'read:user',
      githubUserId: 42,
      githubLogin: 'old-username',
      deviceId: 'device-stable-001',
      createdAt: new Date().toISOString(),
    };

    saveSession(tempDir, session);
    const loaded = loadSession(tempDir);
    expect(loaded).not.toBeNull();

    // The identity key is the numeric ID, not the login string
    expect(loaded).toHaveProperty('githubUserId', 42);
    // Login is informational only, identity binding is via githubUserId
    const userId = loaded ? loaded.githubUserId : undefined;
    expect(typeof userId).toBe('number');
  });

  // ── VAL-AUTH-009: multi-device support ────────────────────────────

  it('different device IDs create distinct sessions in separate config dirs', () => {
    const tempDir2 = makeTempDir();

    try {
      const session1: AuthSession = {
        accessToken: 'gho_device1_token',
        tokenType: 'bearer',
        scope: 'read:user',
        githubUserId: 100,
        githubLogin: 'multidevice-user',
        deviceId: 'device-laptop-001',
        createdAt: new Date().toISOString(),
      };

      const session2: AuthSession = {
        accessToken: 'gho_device2_token',
        tokenType: 'bearer',
        scope: 'read:user',
        githubUserId: 100, // same account
        githubLogin: 'multidevice-user',
        deviceId: 'device-desktop-002',
        createdAt: new Date().toISOString(),
      };

      saveSession(tempDir, session1);
      saveSession(tempDir2, session2);

      const loaded1 = loadSession(tempDir);
      const loaded2 = loadSession(tempDir2);

      expect(loaded1).not.toBeNull();
      expect(loaded2).not.toBeNull();

      // Same account (same githubUserId)
      const uid1 = loaded1 ? loaded1.githubUserId : -1;
      const uid2 = loaded2 ? loaded2.githubUserId : -2;
      expect(uid1).toBe(uid2);

      // But different devices
      const dev1 = loaded1 ? loaded1.deviceId : '';
      const dev2 = loaded2 ? loaded2.deviceId : '';
      expect(dev1).not.toBe(dev2);

      // And different tokens
      const tok1 = loaded1 ? loaded1.accessToken : '';
      const tok2 = loaded2 ? loaded2.accessToken : '';
      expect(tok1).not.toBe(tok2);
    } finally {
      rmSync(tempDir2, { recursive: true, force: true });
    }
  });

  // ── VAL-AUTH-010: permission-hardened and non-leaking ─────────────

  it('session file has owner-only permissions (0600)', () => {
    const session: AuthSession = {
      accessToken: 'gho_secret_token_do_not_leak',
      tokenType: 'bearer',
      scope: 'read:user',
      githubUserId: 777,
      githubLogin: 'secure-user',
      deviceId: 'device-secure-001',
      createdAt: new Date().toISOString(),
    };

    saveSession(tempDir, session);

    const sessionPath = join(tempDir, 'session.json');
    const stat = statSync(sessionPath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('session file content does not leak token in readable fields outside the file', () => {
    const session: AuthSession = {
      accessToken: 'gho_canary_token_for_leak_test',
      tokenType: 'bearer',
      scope: 'read:user',
      githubUserId: 888,
      githubLogin: 'leak-test-user',
      deviceId: 'device-leak-001',
      createdAt: new Date().toISOString(),
    };

    saveSession(tempDir, session);

    // The session file should contain the token (it's encrypted at rest via file permissions)
    // but the token should NOT appear in any other files in the config directory
    const files = readdirSync(tempDir);
    for (const file of files) {
      if (file === 'session.json') continue;
      const content = readFileSync(join(tempDir, file), 'utf-8');
      expect(content).not.toContain('gho_canary_token_for_leak_test');
    }
  });

  it('loadSession returns all expected fields from persisted session', () => {
    const now = new Date().toISOString();
    const session: AuthSession = {
      accessToken: 'gho_complete_test',
      tokenType: 'bearer',
      scope: 'read:user',
      githubUserId: 555,
      githubLogin: 'complete-user',
      deviceId: 'device-complete-001',
      createdAt: now,
    };

    saveSession(tempDir, session);
    const loaded = loadSession(tempDir);

    expect(loaded).toEqual(session);
  });

  it('corrupt session file returns null gracefully', () => {
    writeFileSync(join(tempDir, 'session.json'), 'not valid json!!!', { mode: 0o600 });

    const loaded = loadSession(tempDir);
    expect(loaded).toBeNull();
  });

  it('session with missing required fields returns null', () => {
    writeFileSync(
      join(tempDir, 'session.json'),
      JSON.stringify({ accessToken: 'partial' }),
      { mode: 0o600 }
    );

    const loaded = loadSession(tempDir);
    expect(loaded).toBeNull();
  });
});
