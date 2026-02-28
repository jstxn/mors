/**
 * Key management for mors encrypted store.
 * Handles generation, persistence, loading, and permission hardening of encryption keys.
 * Keys are stored with owner-only (0o600) permissions.
 * Key material is never printed to stdout/stderr or included in logs.
 */
/**
 * Generate a cryptographically secure random encryption key.
 * @returns A 32-byte Buffer containing the key.
 */
export declare function generateKey(): Buffer;
/**
 * Persist an encryption key to disk with hardened permissions.
 * Creates parent directories with restricted permissions if needed.
 * @param keyPath - Absolute path to the key file.
 * @param key - The key buffer to persist.
 * @throws KeyError if the write fails.
 */
export declare function persistKey(keyPath: string, key: Buffer): void;
/**
 * Load an encryption key from disk.
 * Validates that the key file exists, has correct size, and has owner-only permissions.
 * @param keyPath - Absolute path to the key file.
 * @returns The key as a Buffer.
 * @throws KeyError if the file is missing, wrong size, or has insecure permissions.
 */
export declare function loadKey(keyPath: string): Buffer;
/**
 * Check that a key file has owner-only permissions.
 * @param keyPath - Absolute path to the key file.
 * @returns true if the file has 0o600 permissions.
 */
export declare function hasSecurePermissions(keyPath: string): boolean;
//# sourceMappingURL=key-management.d.ts.map