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
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
/** Options for opening the encrypted store. */
export interface StoreOptions {
    /** Path to the SQLCipher database file. */
    dbPath: string;
    /** Encryption key as a 32-byte Buffer. */
    key: Buffer;
}
/**
 * Verify that the loaded SQLite library supports SQLCipher encryption.
 * Fails closed if cipher support is unavailable.
 * @param simulateUnavailable - Internal testing hook: if true, simulates SQLCipher being unavailable.
 * @throws SqlCipherUnavailableError if SQLCipher is not functional.
 */
export declare function verifySqlCipherAvailable(simulateUnavailable?: boolean): void;
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
export declare function openEncryptedDb(options: StoreOptions): BetterSqlite3.Database;
/**
 * Initialize a new encrypted database with the required schema.
 * This creates the messages table and any indexes needed.
 *
 * @param db - An open, authenticated Database instance.
 */
export declare function initializeSchema(db: BetterSqlite3.Database): void;
/**
 * The main Store class that encapsulates all encrypted database operations.
 * Ensures fail-closed behavior and no plaintext fallback.
 */
export declare class Store {
    private db;
    private readonly dbPath;
    constructor(dbPath: string);
    /**
     * Open the store with the given encryption key.
     * @param key - 32-byte encryption key buffer.
     * @throws StoreEncryptionError on decryption failure.
     * @throws KeyError on invalid key.
     */
    open(key: Buffer): void;
    /**
     * Get the underlying database instance.
     * @throws StoreEncryptionError if the store is not open.
     */
    getDb(): BetterSqlite3.Database;
    /** Whether the store is currently open. */
    get isOpen(): boolean;
    /**
     * Close the store.
     */
    close(): void;
    /**
     * Initialize the database schema (creates tables if they don't exist).
     */
    initialize(): void;
}
//# sourceMappingURL=store.d.ts.map