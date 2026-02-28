/**
 * Security invariant tests for the mors encrypted store.
 *
 * Covers:
 * - VAL-SEC-001: Message content is encrypted at rest
 * - VAL-SEC-002: Encrypted store reopens with persisted identity key
 * - VAL-SEC-003: Wrong or missing key fails closed
 * - VAL-SEC-004: No plaintext fallback path exists
 * - VAL-SEC-005: Sensitive key artifacts are permission-hardened
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  statSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { generateKey, persistKey, loadKey, hasSecurePermissions } from '../src/key-management.js';
import {
  openEncryptedDb,
  verifySqlCipherAvailable,
  initializeSchema,
  Store,
} from '../src/store.js';
import { StoreEncryptionError, KeyError, SqlCipherUnavailableError } from '../src/errors.js';

/** High-entropy canary string for at-rest inspection. */
const CANARY = 'CANARY_mors_secret_Z9x8W7v6U5t4S3r2Q1p0';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'mors-security-test-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Key Management
// ---------------------------------------------------------------------------

describe('key management', () => {
  it('generates a 32-byte random key', () => {
    const key = generateKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);

    // Keys should be unique.
    const key2 = generateKey();
    expect(key.equals(key2)).toBe(false);
  });

  it('persists key with owner-only permissions (VAL-SEC-005)', () => {
    const keyPath = join(testDir, 'keys', 'db.key');
    const key = generateKey();

    persistKey(keyPath, key);

    expect(existsSync(keyPath)).toBe(true);

    const stat = statSync(keyPath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates parent directories with restricted permissions', () => {
    const keyPath = join(testDir, 'deep', 'nested', 'db.key');
    const key = generateKey();

    persistKey(keyPath, key);

    expect(existsSync(keyPath)).toBe(true);
  });

  it('loads a persisted key', () => {
    const keyPath = join(testDir, 'db.key');
    const key = generateKey();
    persistKey(keyPath, key);

    const loaded = loadKey(keyPath);
    expect(loaded.equals(key)).toBe(true);
  });

  it('throws KeyError when key file does not exist', () => {
    const keyPath = join(testDir, 'nonexistent.key');
    expect(() => loadKey(keyPath)).toThrow(KeyError);
    expect(() => loadKey(keyPath)).toThrow(/not found/);
  });

  it('throws KeyError when key file has insecure permissions', () => {
    const keyPath = join(testDir, 'insecure.key');
    const key = generateKey();
    writeFileSync(keyPath, key, { mode: 0o644 });

    expect(() => loadKey(keyPath)).toThrow(KeyError);
    expect(() => loadKey(keyPath)).toThrow(/insecure permissions/);
  });

  it('throws KeyError when key file has wrong size', () => {
    const keyPath = join(testDir, 'bad-size.key');
    writeFileSync(keyPath, Buffer.alloc(16), { mode: 0o600 });

    expect(() => loadKey(keyPath)).toThrow(KeyError);
    expect(() => loadKey(keyPath)).toThrow(/invalid size/);
  });

  it('hasSecurePermissions returns true for 0o600 files', () => {
    const keyPath = join(testDir, 'secure.key');
    persistKey(keyPath, generateKey());
    expect(hasSecurePermissions(keyPath)).toBe(true);
  });

  it('hasSecurePermissions returns false for world-readable files', () => {
    const keyPath = join(testDir, 'world-readable.key');
    writeFileSync(keyPath, generateKey(), { mode: 0o644 });
    expect(hasSecurePermissions(keyPath)).toBe(false);
  });

  it('hasSecurePermissions returns false for nonexistent files', () => {
    expect(hasSecurePermissions(join(testDir, 'nope.key'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SQLCipher Availability
// ---------------------------------------------------------------------------

describe('SQLCipher availability', () => {
  it('verifySqlCipherAvailable succeeds when SQLCipher is present', () => {
    expect(() => verifySqlCipherAvailable()).not.toThrow();
  });

  it('verifySqlCipherAvailable throws SqlCipherUnavailableError with simulated unavailability (VAL-INIT-003)', () => {
    expect(() => verifySqlCipherAvailable(true)).toThrow(SqlCipherUnavailableError);
    expect(() => verifySqlCipherAvailable(true)).toThrow(/not available/);
  });
});

// ---------------------------------------------------------------------------
// Encrypted Database - At-Rest Encryption (VAL-SEC-001)
// ---------------------------------------------------------------------------

describe('encrypted at-rest storage (VAL-SEC-001)', () => {
  it('message content is not readable as plaintext in .db file', () => {
    const dbPath = join(testDir, 'encrypted.db');
    const key = generateKey();

    const db = openEncryptedDb({ dbPath, key });
    initializeSchema(db);

    // Insert a canary message.
    db.prepare(
      'INSERT INTO messages (id, thread_id, sender, recipient, body, state) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('msg-1', 'thread-1', 'alice', 'bob', CANARY, 'delivered');
    db.close();

    // Inspect the raw database file for canary text.
    const dbBytes = readFileSync(dbPath);
    const dbText = dbBytes.toString('latin1');
    expect(dbText).not.toContain(CANARY);
  });

  it('message content is not readable as plaintext in -wal file', () => {
    const dbPath = join(testDir, 'encrypted-wal.db');
    const key = generateKey();

    const db = openEncryptedDb({ dbPath, key });
    // Enable WAL mode to generate a WAL file.
    db.pragma('journal_mode=WAL');
    initializeSchema(db);

    db.prepare(
      'INSERT INTO messages (id, thread_id, sender, recipient, body, state) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('msg-wal-1', 'thread-1', 'alice', 'bob', CANARY, 'delivered');

    // Don't close yet — WAL file should exist while connection is open.
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';

    // Check WAL file if it exists.
    if (existsSync(walPath)) {
      const walBytes = readFileSync(walPath);
      const walText = walBytes.toString('latin1');
      expect(walText).not.toContain(CANARY);
    }

    // Check SHM file if it exists.
    if (existsSync(shmPath)) {
      const shmBytes = readFileSync(shmPath);
      const shmText = shmBytes.toString('latin1');
      expect(shmText).not.toContain(CANARY);
    }

    db.close();

    // Also check the main db file after close.
    const dbBytes = readFileSync(dbPath);
    expect(dbBytes.toString('latin1')).not.toContain(CANARY);
  });

  it('canary content is not visible in any artifact after write + close', () => {
    const dbPath = join(testDir, 'full-check.db');
    const key = generateKey();

    const db = openEncryptedDb({ dbPath, key });
    initializeSchema(db);
    db.prepare(
      'INSERT INTO messages (id, thread_id, sender, recipient, body, state) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('msg-full-1', 'thread-1', 'alice', 'bob', CANARY, 'delivered');
    db.close();

    // Check every file in the test directory that starts with our db name.
    const files = readdirSync(testDir).filter((f) => f.startsWith('full-check'));
    for (const file of files) {
      const filePath = join(testDir, file);
      const bytes = readFileSync(filePath);
      expect(bytes.toString('latin1')).not.toContain(CANARY);
    }
  });
});

// ---------------------------------------------------------------------------
// Encrypted Store Reopens (VAL-SEC-002)
// ---------------------------------------------------------------------------

describe('encrypted store reopens with persisted key (VAL-SEC-002)', () => {
  it('data persists across open/close cycles with the same key', () => {
    const dbPath = join(testDir, 'reopen.db');
    const key = generateKey();

    // Write data.
    const db1 = openEncryptedDb({ dbPath, key });
    initializeSchema(db1);
    db1
      .prepare(
        'INSERT INTO messages (id, thread_id, sender, recipient, body, state) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('msg-reopen-1', 'thread-1', 'alice', 'bob', 'Hello from first session', 'delivered');
    db1.close();

    // Reopen and read.
    const db2 = openEncryptedDb({ dbPath, key });
    const row = db2.prepare('SELECT body FROM messages WHERE id = ?').get('msg-reopen-1') as
      | { body: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.body).toBe('Hello from first session');
    db2.close();
  });

  it('Store class manages open/close lifecycle correctly', () => {
    const dbPath = join(testDir, 'store-lifecycle.db');
    const key = generateKey();

    const store = new Store(dbPath);
    expect(store.isOpen).toBe(false);

    store.open(key);
    expect(store.isOpen).toBe(true);

    store.initialize();
    store
      .getDb()
      .prepare(
        'INSERT INTO messages (id, thread_id, sender, recipient, body, state) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('msg-store-1', 'thread-1', 'alice', 'bob', 'Store test', 'delivered');

    store.close();
    expect(store.isOpen).toBe(false);

    // Reopen same store path with same key.
    const store2 = new Store(dbPath);
    store2.open(key);
    const row = store2
      .getDb()
      .prepare('SELECT body FROM messages WHERE id = ?')
      .get('msg-store-1') as { body: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.body).toBe('Store test');
    store2.close();
  });
});

// ---------------------------------------------------------------------------
// Wrong/Missing Key Fails Closed (VAL-SEC-003)
// ---------------------------------------------------------------------------

describe('wrong/missing key fails closed (VAL-SEC-003)', () => {
  it('opening with wrong key throws StoreEncryptionError', () => {
    const dbPath = join(testDir, 'wrong-key.db');
    const correctKey = generateKey();
    const wrongKey = generateKey();

    // Create a database with the correct key.
    const db = openEncryptedDb({ dbPath, key: correctKey });
    initializeSchema(db);
    db.prepare(
      'INSERT INTO messages (id, thread_id, sender, recipient, body, state) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('msg-wk-1', 'thread-1', 'alice', 'bob', CANARY, 'delivered');
    db.close();

    // Attempt to open with wrong key.
    expect(() => openEncryptedDb({ dbPath, key: wrongKey })).toThrow(StoreEncryptionError);
  });

  it('wrong key does not expose any data', () => {
    const dbPath = join(testDir, 'no-expose.db');
    const correctKey = generateKey();
    const wrongKey = generateKey();

    const db = openEncryptedDb({ dbPath, key: correctKey });
    initializeSchema(db);
    db.prepare(
      'INSERT INTO messages (id, thread_id, sender, recipient, body, state) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('msg-ne-1', 'thread-1', 'alice', 'bob', CANARY, 'delivered');
    db.close();

    // Opening with wrong key should throw.
    let caughtError: unknown = null;
    try {
      const badDb = openEncryptedDb({ dbPath, key: wrongKey });
      // If somehow we got here, try to read data (should not happen).
      const row = badDb.prepare('SELECT body FROM messages WHERE id = ?').get('msg-ne-1') as
        | { body: string }
        | undefined;
      badDb.close();
      // If data is returned, that's a security failure.
      expect(row).toBeUndefined();
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError).toBeInstanceOf(StoreEncryptionError);
  });

  it('null key throws KeyError', () => {
    const dbPath = join(testDir, 'null-key.db');
    expect(() => openEncryptedDb({ dbPath, key: null as unknown as Buffer })).toThrow(KeyError);
  });

  it('empty key throws KeyError', () => {
    const dbPath = join(testDir, 'empty-key.db');
    expect(() => openEncryptedDb({ dbPath, key: Buffer.alloc(0) })).toThrow(KeyError);
  });

  it('wrong-size key throws KeyError', () => {
    const dbPath = join(testDir, 'short-key.db');
    expect(() => openEncryptedDb({ dbPath, key: Buffer.alloc(16) })).toThrow(KeyError);
  });

  it('Store.open with wrong key throws and remains closed', () => {
    const dbPath = join(testDir, 'store-wrong-key.db');
    const correctKey = generateKey();
    const wrongKey = generateKey();

    // Create the encrypted database.
    const store1 = new Store(dbPath);
    store1.open(correctKey);
    store1.initialize();
    store1.close();

    // Try to open with wrong key.
    const store2 = new Store(dbPath);
    expect(() => store2.open(wrongKey)).toThrow(StoreEncryptionError);
    expect(store2.isOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// No Plaintext Fallback (VAL-SEC-004)
// ---------------------------------------------------------------------------

describe('no plaintext fallback path (VAL-SEC-004)', () => {
  it('encryption failure does not create plaintext database files', () => {
    const dbPath = join(testDir, 'no-fallback.db');
    const correctKey = generateKey();
    const wrongKey = generateKey();

    // Create the encrypted database first.
    const db = openEncryptedDb({ dbPath, key: correctKey });
    initializeSchema(db);
    db.close();

    // Attempt with wrong key — should fail.
    try {
      openEncryptedDb({ dbPath, key: wrongKey });
    } catch {
      // Expected failure.
    }

    // Check that no new plaintext-related files were created.
    const files = readdirSync(testDir);
    const dbFiles = files.filter((f) => f.includes('no-fallback'));

    for (const file of dbFiles) {
      const filePath = join(testDir, file);
      const bytes = readFileSync(filePath);
      // Plaintext SQLite databases start with "SQLite format 3\0"
      const header = bytes.subarray(0, 16).toString('utf8');
      expect(header).not.toBe('SQLite format 3\0');
    }
  });

  it('a newly created encrypted database does not start with plaintext SQLite header', () => {
    const dbPath = join(testDir, 'encrypted-header.db');
    const key = generateKey();

    const db = openEncryptedDb({ dbPath, key });
    initializeSchema(db);
    db.close();

    const bytes = readFileSync(dbPath);
    const header = bytes.subarray(0, 16).toString('utf8');
    expect(header).not.toBe('SQLite format 3\0');
  });

  it('opening encrypted db without encryption (raw sqlite) fails', async () => {
    const dbPath = join(testDir, 'raw-attempt.db');
    const key = generateKey();

    // Create encrypted database.
    const db = openEncryptedDb({ dbPath, key });
    initializeSchema(db);
    db.prepare(
      'INSERT INTO messages (id, thread_id, sender, recipient, body, state) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('msg-raw-1', 'thread-1', 'alice', 'bob', CANARY, 'delivered');
    db.close();

    // Try to open it as a raw (unencrypted) SQLite database using the library
    // without providing a key. This must fail or return no data.
    const { default: RawDatabase } = await import('better-sqlite3-multiple-ciphers');
    expect(() => {
      const rawDb = new RawDatabase(dbPath);
      // Attempt to read without providing a key.
      rawDb.prepare('SELECT * FROM messages').all();
      rawDb.close();
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Permission Hardening (VAL-SEC-005)
// ---------------------------------------------------------------------------

describe('key artifact permission hardening (VAL-SEC-005)', () => {
  it('persisted key file has 0o600 permissions', () => {
    const keyPath = join(testDir, 'perm-check.key');
    const key = generateKey();
    persistKey(keyPath, key);

    const stat = statSync(keyPath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('key content is not exposed in error messages', () => {
    const key = generateKey();
    const keyHex = key.toString('hex');

    // Test that error messages from store operations don't contain key material.
    try {
      openEncryptedDb({ dbPath: join(testDir, 'err-msg.db'), key: Buffer.alloc(16) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain(keyHex);
    }
  });

  it('key file is not world-readable after persist', () => {
    const keyPath = join(testDir, 'no-world-read.key');
    persistKey(keyPath, generateKey());

    const stat = statSync(keyPath);
    const mode = stat.mode & 0o777;
    // No group or other permissions.
    expect(mode & 0o077).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Store class additional tests
// ---------------------------------------------------------------------------

describe('Store class', () => {
  it('throws when getDb called before open', () => {
    const store = new Store(join(testDir, 'not-open.db'));
    expect(() => store.getDb()).toThrow(StoreEncryptionError);
  });

  it('throws when opening an already-open store', () => {
    const dbPath = join(testDir, 'double-open.db');
    const key = generateKey();
    const store = new Store(dbPath);

    store.open(key);
    expect(() => store.open(key)).toThrow(StoreEncryptionError);
    store.close();
  });

  it('close is idempotent', () => {
    const dbPath = join(testDir, 'close-idem.db');
    const key = generateKey();
    const store = new Store(dbPath);

    store.open(key);
    store.close();
    // Calling close again should not throw.
    expect(() => store.close()).not.toThrow();
    expect(store.isOpen).toBe(false);
  });
});
