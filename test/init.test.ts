/**
 * Tests for `mors init` command and related identity/init functionality.
 *
 * Covers:
 * - VAL-INIT-001: Fresh init provisions identity and encrypted store
 * - VAL-INIT-002: Re-running init is safe and non-destructive
 * - VAL-INIT-003: SQLCipher prerequisite failures are actionable
 * - VAL-INIT-004: Init output never leaks sensitive key material
 * - VAL-INIT-005: Commands fail clearly before initialization
 * - VAL-INIT-006: Init failure is atomic
 * - VAL-INIT-007: Concurrent init attempts converge safely
 * - VAL-SEC-002: Encrypted store reopens using persisted identity/key material
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { initCommand, requireInit, getDbPath, getDbKeyPath } from '../src/init.js';
import {
  generateIdentity,
  persistIdentity,
  loadIdentity,
  isInitialized,
  computeFingerprint,
} from '../src/identity.js';
import { loadKey } from '../src/key-management.js';
import { openEncryptedDb } from '../src/store.js';
import { MorsError, SqlCipherUnavailableError, NotInitializedError } from '../src/errors.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'mors-init-test-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Identity Module Tests
// ---------------------------------------------------------------------------

describe('identity module', () => {
  it('generates a valid Ed25519 identity with 32-byte keys', () => {
    const identity = generateIdentity();
    expect(identity.publicKey).toBeInstanceOf(Buffer);
    expect(identity.publicKey.length).toBe(32);
    expect(identity.privateKey).toBeInstanceOf(Buffer);
    expect(identity.privateKey.length).toBe(32);
    expect(typeof identity.fingerprint).toBe('string');
    expect(identity.fingerprint.length).toBe(64); // SHA-256 hex
  });

  it('generates unique identities', () => {
    const id1 = generateIdentity();
    const id2 = generateIdentity();
    expect(id1.publicKey.equals(id2.publicKey)).toBe(false);
    expect(id1.fingerprint).not.toBe(id2.fingerprint);
  });

  it('fingerprint is SHA-256 of public key', () => {
    const identity = generateIdentity();
    const expected = computeFingerprint(identity.publicKey);
    expect(identity.fingerprint).toBe(expected);
  });

  it('persists and loads identity correctly', () => {
    const configDir = join(testDir, 'id-roundtrip');
    const identity = generateIdentity();
    persistIdentity(configDir, identity);

    const loaded = loadIdentity(configDir);
    expect(loaded.publicKey.equals(identity.publicKey)).toBe(true);
    expect(loaded.privateKey.equals(identity.privateKey)).toBe(true);
    expect(loaded.fingerprint).toBe(identity.fingerprint);
  });

  it('persists private key with owner-only permissions', () => {
    const configDir = join(testDir, 'id-perms');
    const identity = generateIdentity();
    persistIdentity(configDir, identity);

    const keyPath = join(configDir, 'identity.key');
    const stat = statSync(keyPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('identity.json does not contain private key material', () => {
    const configDir = join(testDir, 'id-no-leak');
    const identity = generateIdentity();
    persistIdentity(configDir, identity);

    const metadata = readFileSync(join(configDir, 'identity.json'), 'utf-8');
    const privateKeyHex = identity.privateKey.toString('hex');
    expect(metadata).not.toContain(privateKeyHex);
  });

  it('isInitialized returns false for empty directory', () => {
    expect(isInitialized(testDir)).toBe(false);
  });

  it('isInitialized returns true after persist', () => {
    const identity = generateIdentity();
    persistIdentity(testDir, identity);
    expect(isInitialized(testDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VAL-INIT-001: Fresh init provisions identity and encrypted store
// ---------------------------------------------------------------------------

describe('VAL-INIT-001: fresh init provisions identity and encrypted store', () => {
  it('creates identity files and encrypted database', async () => {
    const configDir = join(testDir, 'fresh-init');
    const result = await initCommand({ configDir });

    expect(result.alreadyInitialized).toBe(false);
    expect(typeof result.fingerprint).toBe('string');
    expect(result.fingerprint.length).toBe(64);
    expect(result.configDir).toBe(configDir);

    // Verify identity files exist.
    expect(existsSync(join(configDir, 'identity.json'))).toBe(true);
    expect(existsSync(join(configDir, 'identity.key'))).toBe(true);

    // Verify DB key file exists.
    expect(existsSync(join(configDir, 'db.key'))).toBe(true);

    // Verify encrypted database exists.
    expect(existsSync(join(configDir, 'mors.db'))).toBe(true);

    // Verify sentinel file exists.
    expect(existsSync(join(configDir, '.initialized'))).toBe(true);
  });

  it('encrypted store can be opened with persisted key', async () => {
    const configDir = join(testDir, 'store-check');
    await initCommand({ configDir });

    const dbPath = getDbPath(configDir);
    const dbKeyPath = getDbKeyPath(configDir);
    const key = loadKey(dbKeyPath);

    const db = openEncryptedDb({ dbPath, key });
    // Verify schema was created.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
      .all() as Array<{ name: string }>;
    expect(tables.length).toBe(1);
    db.close();
  });

  it('init result fingerprint matches persisted identity', async () => {
    const configDir = join(testDir, 'fp-match');
    const result = await initCommand({ configDir });

    const identity = loadIdentity(configDir);
    expect(result.fingerprint).toBe(identity.fingerprint);
  });
});

// ---------------------------------------------------------------------------
// VAL-INIT-002: Re-running init is safe and non-destructive
// ---------------------------------------------------------------------------

describe('VAL-INIT-002: re-running init is safe and non-destructive', () => {
  it('second init returns alreadyInitialized=true', async () => {
    const configDir = join(testDir, 'rerun');
    const first = await initCommand({ configDir });
    const second = await initCommand({ configDir });

    expect(first.alreadyInitialized).toBe(false);
    expect(second.alreadyInitialized).toBe(true);
  });

  it('second init preserves original identity', async () => {
    const configDir = join(testDir, 'rerun-identity');
    const first = await initCommand({ configDir });

    // Capture identity artifacts before second init.
    const identityBefore = readFileSync(join(configDir, 'identity.json'), 'utf-8');
    const keyBefore = readFileSync(join(configDir, 'identity.key'));

    const second = await initCommand({ configDir });

    // Identity files should not have changed.
    const identityAfter = readFileSync(join(configDir, 'identity.json'), 'utf-8');
    const keyAfter = readFileSync(join(configDir, 'identity.key'));

    expect(identityAfter).toBe(identityBefore);
    expect(keyAfter.equals(keyBefore)).toBe(true);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('second init preserves database file', async () => {
    const configDir = join(testDir, 'rerun-db');
    await initCommand({ configDir });

    // Insert a row into the database to verify it isn't recreated.
    const dbPath = getDbPath(configDir);
    const dbKeyPath = getDbKeyPath(configDir);
    const key = loadKey(dbKeyPath);
    const db = openEncryptedDb({ dbPath, key });
    db.prepare(
      'INSERT INTO messages (id, thread_id, sender, recipient, body, state) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('test-msg', 'thread-1', 'alice', 'bob', 'test body', 'delivered');
    db.close();

    // Re-run init.
    await initCommand({ configDir });

    // Verify the row is still there.
    const db2 = openEncryptedDb({ dbPath, key });
    const row = db2.prepare('SELECT body FROM messages WHERE id = ?').get('test-msg') as
      | { body: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.body).toBe('test body');
    db2.close();
  });
});

// ---------------------------------------------------------------------------
// VAL-INIT-003: SQLCipher prerequisite failures are actionable
// ---------------------------------------------------------------------------

describe('VAL-INIT-003: SQLCipher prerequisite failures are actionable', () => {
  it('fails with SqlCipherUnavailableError when simulated', async () => {
    const configDir = join(testDir, 'sqlcipher-fail');
    await expect(initCommand({ configDir, simulateSqlCipherUnavailable: true })).rejects.toThrow(
      SqlCipherUnavailableError
    );
  });

  it('error message contains remediation guidance', async () => {
    const configDir = join(testDir, 'sqlcipher-guidance');
    try {
      await initCommand({ configDir, simulateSqlCipherUnavailable: true });
      expect.unreachable('Should have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(SqlCipherUnavailableError);
      const msg = (err as Error).message;
      expect(msg).toContain('not available');
    }
  });

  it('does not create any artifacts on SQLCipher failure', async () => {
    const configDir = join(testDir, 'sqlcipher-no-artifacts');
    try {
      await initCommand({ configDir, simulateSqlCipherUnavailable: true });
    } catch {
      // Expected.
    }

    // Config dir may have been created, but should contain no identity/db artifacts.
    if (existsSync(configDir)) {
      const files = readdirSync(configDir);
      expect(files).not.toContain('identity.json');
      expect(files).not.toContain('identity.key');
      expect(files).not.toContain('db.key');
      expect(files).not.toContain('mors.db');
      expect(files).not.toContain('.initialized');
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-INIT-004: Init output never leaks sensitive key material
// ---------------------------------------------------------------------------

describe('VAL-INIT-004: init output never leaks sensitive key material', () => {
  it('stdout does not contain private key or DB key material', async () => {
    const configDir = join(testDir, 'no-leak');

    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    console.error = (...args: unknown[]) => errors.push(args.join(' '));

    try {
      await initCommand({ configDir });
    } finally {
      console.log = origLog;
      console.error = origError;
    }

    // Load the actual key material to check it's not in output.
    const identityKey = readFileSync(join(configDir, 'identity.key'));
    const dbKey = readFileSync(join(configDir, 'db.key'));

    const allOutput = [...logs, ...errors].join('\n');

    // Check hex and base64 representations of key material.
    expect(allOutput).not.toContain(identityKey.toString('hex'));
    expect(allOutput).not.toContain(identityKey.toString('base64'));
    expect(allOutput).not.toContain(dbKey.toString('hex'));
    expect(allOutput).not.toContain(dbKey.toString('base64'));
  });

  it('identity.json does not contain private key or DB key', async () => {
    const configDir = join(testDir, 'no-leak-files');
    await initCommand({ configDir });

    const metadata = readFileSync(join(configDir, 'identity.json'), 'utf-8');
    const identityKey = readFileSync(join(configDir, 'identity.key'));
    const dbKey = readFileSync(join(configDir, 'db.key'));

    expect(metadata).not.toContain(identityKey.toString('hex'));
    expect(metadata).not.toContain(dbKey.toString('hex'));
  });
});

// ---------------------------------------------------------------------------
// VAL-INIT-005: Commands fail clearly before initialization
// ---------------------------------------------------------------------------

describe('VAL-INIT-005: commands fail clearly before initialization', () => {
  it('requireInit throws NotInitializedError for empty dir', () => {
    const configDir = join(testDir, 'uninit');
    expect(() => requireInit(configDir)).toThrow(NotInitializedError);
  });

  it('requireInit error message suggests running mors init', () => {
    const configDir = join(testDir, 'uninit-msg');
    try {
      requireInit(configDir);
      expect.unreachable('Should have thrown');
    } catch (err: unknown) {
      expect((err as Error).message).toContain('mors init');
    }
  });

  it('requireInit succeeds after init', async () => {
    const configDir = join(testDir, 'init-then-gate');
    await initCommand({ configDir });
    expect(() => requireInit(configDir)).not.toThrow();
  });

  it('gated CLI commands fail before init', async () => {
    // Test the CLI dispatcher gating by setting MORS_CONFIG_DIR to an empty dir.
    const configDir = join(testDir, 'cli-gate');
    const origEnv = process.env['MORS_CONFIG_DIR'];
    const origExitCode = process.exitCode;

    process.env['MORS_CONFIG_DIR'] = configDir;

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(' '));

    try {
      const { run } = await import('../src/cli.js');

      for (const cmd of ['send', 'inbox', 'read', 'reply', 'ack', 'watch']) {
        errors.length = 0;
        process.exitCode = undefined;
        run([cmd]);
        expect(process.exitCode).toBe(1);
        expect(errors.some((e) => e.includes('mors init'))).toBe(true);
      }
    } finally {
      console.error = origError;
      process.env['MORS_CONFIG_DIR'] = origEnv;
      process.exitCode = origExitCode;
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-INIT-006: Init failure is atomic
// ---------------------------------------------------------------------------

describe('VAL-INIT-006: init failure is atomic', () => {
  it('failure after identity creation cleans up all artifacts', async () => {
    const configDir = join(testDir, 'atomic-fail');
    try {
      await initCommand({
        configDir,
        simulateFailureAfterIdentity: true,
      });
      expect.unreachable('Should have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MorsError);
    }

    // No identity or sentinel files should remain.
    if (existsSync(configDir)) {
      const files = readdirSync(configDir);
      expect(files).not.toContain('identity.json');
      expect(files).not.toContain('identity.key');
      expect(files).not.toContain('db.key');
      expect(files).not.toContain('mors.db');
      expect(files).not.toContain('.initialized');
    }
  });

  it('workspace is not considered initialized after failure', async () => {
    const configDir = join(testDir, 'atomic-not-init');
    try {
      await initCommand({
        configDir,
        simulateFailureAfterIdentity: true,
      });
    } catch {
      // Expected.
    }

    // requireInit should still fail.
    expect(() => requireInit(configDir)).toThrow(NotInitializedError);
  });

  it('successful init is possible after a failed attempt', async () => {
    const configDir = join(testDir, 'retry-after-fail');

    // First attempt fails.
    try {
      await initCommand({
        configDir,
        simulateFailureAfterIdentity: true,
      });
    } catch {
      // Expected.
    }

    // Second attempt succeeds.
    const result = await initCommand({ configDir });
    expect(result.alreadyInitialized).toBe(false);
    expect(existsSync(join(configDir, '.initialized'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VAL-INIT-007: Concurrent init attempts converge safely
// ---------------------------------------------------------------------------

describe('VAL-INIT-007: concurrent init attempts converge safely', () => {
  it('two sequential inits converge to one identity', async () => {
    const configDir = join(testDir, 'concurrent');

    const result1 = await initCommand({ configDir });
    const result2 = await initCommand({ configDir });

    // Both should agree on fingerprint.
    expect(result2.fingerprint).toBe(result1.fingerprint);
    // Second should detect already initialized.
    expect(result2.alreadyInitialized).toBe(true);
  });

  it('parallel inits both succeed or one detects already initialized', async () => {
    const configDir = join(testDir, 'parallel');

    // Run two init commands concurrently.
    const results = await Promise.allSettled([
      initCommand({ configDir }),
      initCommand({ configDir }),
    ]);

    // At least one should succeed.
    const successes = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof initCommand>>
    >[];
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // All successful results should agree on fingerprint.
    if (successes.length >= 2) {
      expect(successes[1].value.fingerprint).toBe(successes[0].value.fingerprint);
    }

    // Verify exactly one coherent initialized state.
    expect(isInitialized(configDir)).toBe(true);
    const identity = loadIdentity(configDir);
    expect(typeof identity.fingerprint).toBe('string');
    expect(identity.fingerprint.length).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// VAL-SEC-002: Encrypted store reopens using persisted identity/key material
// ---------------------------------------------------------------------------

describe('VAL-SEC-002: encrypted store reopens with persisted key', () => {
  it('data persists across init and reopen', async () => {
    const configDir = join(testDir, 'reopen-test');
    await initCommand({ configDir });

    // Write a message.
    const dbPath = getDbPath(configDir);
    const dbKeyPath = getDbKeyPath(configDir);
    const key = loadKey(dbKeyPath);

    const db1 = openEncryptedDb({ dbPath, key });
    db1
      .prepare(
        'INSERT INTO messages (id, thread_id, sender, recipient, body, state) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('msg-1', 'thread-1', 'alice', 'bob', 'Hello after init', 'delivered');
    db1.close();

    // Simulate restart: reload key from disk and reopen.
    const key2 = loadKey(dbKeyPath);
    const db2 = openEncryptedDb({ dbPath, key: key2 });
    const row = db2.prepare('SELECT body FROM messages WHERE id = ?').get('msg-1') as
      | { body: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.body).toBe('Hello after init');
    db2.close();
  });

  it('identity persists across init and reload', async () => {
    const configDir = join(testDir, 'identity-persist');
    const result = await initCommand({ configDir });

    // Reload identity from disk.
    const identity = loadIdentity(configDir);
    expect(identity.fingerprint).toBe(result.fingerprint);
  });
});

// ---------------------------------------------------------------------------
// VAL-INIT-006 Regression: Multi-file partial-write rollback
// ---------------------------------------------------------------------------

describe('VAL-INIT-006 regression: partial-write rollback at each init step', () => {
  it('failure after db key creation cleans up identity and key artifacts', async () => {
    const configDir = join(testDir, 'partial-dbkey');
    try {
      await initCommand({
        configDir,
        simulateFailureAfterDbKey: true,
      });
      expect.unreachable('Should have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MorsError);
    }

    // All artifacts including db.key should be cleaned up.
    if (existsSync(configDir)) {
      const files = readdirSync(configDir);
      expect(files).not.toContain('identity.json');
      expect(files).not.toContain('identity.key');
      expect(files).not.toContain('db.key');
      expect(files).not.toContain('mors.db');
      expect(files).not.toContain('mors.db-wal');
      expect(files).not.toContain('mors.db-shm');
      expect(files).not.toContain('.initialized');
    }
  });

  it('failure after db creation cleans up all artifacts including db file', async () => {
    const configDir = join(testDir, 'partial-db');
    try {
      await initCommand({
        configDir,
        simulateFailureAfterDbCreate: true,
      });
      expect.unreachable('Should have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MorsError);
    }

    // All artifacts including mors.db should be cleaned up.
    if (existsSync(configDir)) {
      const files = readdirSync(configDir);
      expect(files).not.toContain('identity.json');
      expect(files).not.toContain('identity.key');
      expect(files).not.toContain('db.key');
      expect(files).not.toContain('mors.db');
      expect(files).not.toContain('mors.db-wal');
      expect(files).not.toContain('mors.db-shm');
      expect(files).not.toContain('.initialized');
    }
  });

  it('workspace is not considered initialized after db key failure', async () => {
    const configDir = join(testDir, 'partial-dbkey-notinit');
    try {
      await initCommand({ configDir, simulateFailureAfterDbKey: true });
    } catch {
      // Expected.
    }
    expect(() => requireInit(configDir)).toThrow(NotInitializedError);
  });

  it('workspace is not considered initialized after db creation failure', async () => {
    const configDir = join(testDir, 'partial-db-notinit');
    try {
      await initCommand({ configDir, simulateFailureAfterDbCreate: true });
    } catch {
      // Expected.
    }
    expect(() => requireInit(configDir)).toThrow(NotInitializedError);
  });

  it('successful init after db key failure', async () => {
    const configDir = join(testDir, 'retry-after-dbkey-fail');
    try {
      await initCommand({ configDir, simulateFailureAfterDbKey: true });
    } catch {
      // Expected.
    }
    const result = await initCommand({ configDir });
    expect(result.alreadyInitialized).toBe(false);
    expect(existsSync(join(configDir, '.initialized'))).toBe(true);
  });

  it('successful init after db creation failure', async () => {
    const configDir = join(testDir, 'retry-after-db-fail');
    try {
      await initCommand({ configDir, simulateFailureAfterDbCreate: true });
    } catch {
      // Expected.
    }
    const result = await initCommand({ configDir });
    expect(result.alreadyInitialized).toBe(false);
    expect(existsSync(join(configDir, '.initialized'))).toBe(true);
  });

  it('pre-registered artifact paths ensure cleanup even if file creation is partial', async () => {
    // This test verifies that the fix pre-registers ALL artifact paths
    // upfront so cleanup covers files not yet tracked at failure time.
    // We run each failure mode and verify zero artifacts remain.
    const failureModes: Array<Record<string, boolean>> = [
      { simulateFailureAfterIdentity: true },
      { simulateFailureAfterDbKey: true },
      { simulateFailureAfterDbCreate: true },
    ];

    for (const mode of failureModes) {
      const configDir = join(testDir, `pre-reg-${Object.keys(mode)[0]}`);
      try {
        await initCommand({ configDir, ...mode });
      } catch {
        // Expected.
      }

      // Verify no init artifacts remain.
      if (existsSync(configDir)) {
        const files = readdirSync(configDir);
        const initArtifacts = files.filter(
          (f) =>
            f === 'identity.json' ||
            f === 'identity.key' ||
            f === 'db.key' ||
            f === 'mors.db' ||
            f === 'mors.db-wal' ||
            f === 'mors.db-shm' ||
            f === '.initialized'
        );
        expect(initArtifacts).toEqual([]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

describe('init edge cases', () => {
  it('sentinel file contains version and fingerprint', async () => {
    const configDir = join(testDir, 'sentinel-content');
    const result = await initCommand({ configDir });

    const sentinel = JSON.parse(readFileSync(join(configDir, '.initialized'), 'utf-8')) as {
      version: string;
      fingerprint: string;
      initializedAt: string;
    };

    expect(sentinel.version).toBe('0.1.0');
    expect(sentinel.fingerprint).toBe(result.fingerprint);
    expect(typeof sentinel.initializedAt).toBe('string');
  });

  it('config dir has restricted permissions', async () => {
    const configDir = join(testDir, 'dir-perms');
    await initCommand({ configDir });

    const stat = statSync(configDir);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('db key has owner-only permissions', async () => {
    const configDir = join(testDir, 'dbkey-perms');
    await initCommand({ configDir });

    const stat = statSync(join(configDir, 'db.key'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('encrypted database does not start with plaintext SQLite header', async () => {
    const configDir = join(testDir, 'no-plaintext-header');
    await initCommand({ configDir });

    const dbBytes = readFileSync(join(configDir, 'mors.db'));
    const header = dbBytes.subarray(0, 16).toString('utf8');
    expect(header).not.toBe('SQLite format 3\0');
  });
});
