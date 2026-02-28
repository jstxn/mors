/**
 * SQLCipher-backed encrypted persistence layer for mors.
 *
 * Invariants:
 * - All data is encrypted at rest using SQLCipher (AES-256).
 * - Wrong/missing keys fail closed with non-zero errors — no data exposed.
 * - No plaintext fallback database is ever created or used.
 * - Key artifacts use owner-only permissions (0o600).
 *
 * This module provides the Store class that manages the encrypted database lifecycle.
 */
import Database from 'better-sqlite3-multiple-ciphers';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StoreEncryptionError, KeyError, SqlCipherUnavailableError } from './errors.js';
/**
 * Verify that the loaded SQLite library supports SQLCipher encryption.
 * Fails closed if cipher support is unavailable.
 * @param simulateUnavailable - Internal testing hook: if true, simulates SQLCipher being unavailable.
 * @throws SqlCipherUnavailableError if SQLCipher is not functional.
 */
export function verifySqlCipherAvailable(simulateUnavailable = false) {
    if (simulateUnavailable) {
        throw new SqlCipherUnavailableError('SQLCipher is not available. Install SQLCipher and rebuild native modules. ' +
            'See: https://github.com/m4heshd/better-sqlite3-multiple-ciphers#readme');
    }
    // Open a temp file database to check cipher support.
    // (In-memory databases do not support setting encryption keys.)
    let tempDir = null;
    let db = null;
    try {
        tempDir = mkdtempSync(join(tmpdir(), 'mors-cipher-check-'));
        const tempDbPath = join(tempDir, 'cipher-check.db');
        db = new Database(tempDbPath);
        // Set cipher to sqlcipher — if this pragma is not recognized, it throws.
        db.pragma("cipher='sqlcipher'");
        db.pragma('legacy=4');
        db.pragma("key='test-preflight-key'");
        // Attempt a basic operation to confirm encryption works.
        db.exec('CREATE TABLE __cipher_check (id INTEGER PRIMARY KEY)');
        db.exec('DROP TABLE __cipher_check');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new SqlCipherUnavailableError(`SQLCipher preflight check failed: ${msg}. ` +
            'Ensure SQLCipher is installed and the native module is properly built.');
    }
    finally {
        if (db) {
            try {
                db.close();
            }
            catch {
                // Ignore close errors during preflight.
            }
        }
        if (tempDir) {
            try {
                rmSync(tempDir, { recursive: true, force: true });
            }
            catch {
                // Best-effort cleanup of temp directory.
            }
        }
    }
}
/**
 * Open an encrypted SQLCipher database.
 * Applies the encryption key and verifies that the database is accessible.
 * Fails closed on wrong/missing key — no data is exposed, no plaintext fallback.
 *
 * @param options - Store options containing dbPath and key.
 * @returns An open, authenticated Database instance.
 * @throws StoreEncryptionError if the database cannot be opened or decrypted.
 * @throws KeyError if the key is invalid.
 */
export function openEncryptedDb(options) {
    const { dbPath, key } = options;
    if (!key || key.length !== 32) {
        throw new KeyError(`Invalid encryption key: expected 32-byte Buffer, got ${key ? `${key.length}-byte` : 'null'}.`);
    }
    let db = null;
    try {
        db = new Database(dbPath);
        // Configure for SQLCipher compatibility.
        db.pragma("cipher='sqlcipher'");
        db.pragma('legacy=4');
        // Apply the encryption key using the binary key API.
        db.key(key);
        // Verify the key is correct by reading from the database.
        // On a new database this will succeed; on an existing one with wrong key it will throw.
        db.pragma('cipher_integrity_check');
        // Force a read to trigger any deferred decryption errors.
        db.prepare('SELECT count(*) FROM sqlite_master').get();
        return db;
    }
    catch (err) {
        // Fail closed: close the database handle and throw.
        if (db) {
            try {
                db.close();
            }
            catch {
                // Ignore close errors on failure path.
            }
        }
        const msg = err instanceof Error ? err.message : String(err);
        // Detect common key-related errors and provide actionable messages.
        if (msg.includes('not a database') ||
            msg.includes('file is not a database') ||
            msg.includes('SQLITE_NOTADB') ||
            msg.includes('cipher_integrity_check')) {
            throw new StoreEncryptionError(`Failed to decrypt database at ${dbPath}: wrong encryption key or corrupted database. ` +
                'Verify that the correct key file is being used.');
        }
        throw new StoreEncryptionError(`Failed to open encrypted database at ${dbPath}: ${msg}`);
    }
}
/**
 * Initialize a new encrypted database with the required schema.
 * This creates the messages table and any indexes needed.
 *
 * @param db - An open, authenticated Database instance.
 */
export function initializeSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      in_reply_to TEXT,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT,
      body TEXT NOT NULL,
      dedupe_key TEXT,
      trace_id TEXT,
      state TEXT NOT NULL DEFAULT 'queued',
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient);
    CREATE INDEX IF NOT EXISTS idx_messages_state ON messages(state);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedupe ON messages(dedupe_key) WHERE dedupe_key IS NOT NULL;
  `);
}
/**
 * The main Store class that encapsulates all encrypted database operations.
 * Ensures fail-closed behavior and no plaintext fallback.
 */
export class Store {
    db = null;
    dbPath;
    constructor(dbPath) {
        this.dbPath = dbPath;
    }
    /**
     * Open the store with the given encryption key.
     * @param key - 32-byte encryption key buffer.
     * @throws StoreEncryptionError on decryption failure.
     * @throws KeyError on invalid key.
     */
    open(key) {
        if (this.db) {
            throw new StoreEncryptionError('Store is already open.');
        }
        this.db = openEncryptedDb({ dbPath: this.dbPath, key });
    }
    /**
     * Get the underlying database instance.
     * @throws StoreEncryptionError if the store is not open.
     */
    getDb() {
        if (!this.db) {
            throw new StoreEncryptionError('Store is not open. Call open() first.');
        }
        return this.db;
    }
    /** Whether the store is currently open. */
    get isOpen() {
        return this.db !== null && this.db.open;
    }
    /**
     * Close the store.
     */
    close() {
        if (this.db) {
            try {
                this.db.close();
            }
            finally {
                this.db = null;
            }
        }
    }
    /**
     * Initialize the database schema (creates tables if they don't exist).
     */
    initialize() {
        initializeSchema(this.getDb());
    }
}
//# sourceMappingURL=store.js.map