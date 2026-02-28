/**
 * Key management for mors encrypted store.
 * Handles generation, persistence, loading, and permission hardening of encryption keys.
 * Keys are stored with owner-only (0o600) permissions.
 * Key material is never printed to stdout/stderr or included in logs.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { KeyError } from "./errors.js";

/** Length of the encryption key in bytes (256-bit). */
const KEY_LENGTH = 32;

/** Owner-only file permissions (read/write for owner, nothing for group/others). */
const KEY_FILE_MODE = 0o600;

/** Owner-only directory permissions. */
const KEY_DIR_MODE = 0o700;

/**
 * Generate a cryptographically secure random encryption key.
 * @returns A 32-byte Buffer containing the key.
 */
export function generateKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

/**
 * Persist an encryption key to disk with hardened permissions.
 * Creates parent directories with restricted permissions if needed.
 * @param keyPath - Absolute path to the key file.
 * @param key - The key buffer to persist.
 * @throws KeyError if the write fails.
 */
export function persistKey(keyPath: string, key: Buffer): void {
  try {
    const dir = dirname(keyPath);
    mkdirSync(dir, { recursive: true, mode: KEY_DIR_MODE });
    writeFileSync(keyPath, key, { mode: KEY_FILE_MODE });
    // Explicitly chmod in case umask altered the effective permissions.
    chmodSync(keyPath, KEY_FILE_MODE);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new KeyError(`Failed to persist encryption key: ${msg}`);
  }
}

/**
 * Load an encryption key from disk.
 * Validates that the key file exists, has correct size, and has owner-only permissions.
 * @param keyPath - Absolute path to the key file.
 * @returns The key as a Buffer.
 * @throws KeyError if the file is missing, wrong size, or has insecure permissions.
 */
export function loadKey(keyPath: string): Buffer {
  if (!existsSync(keyPath)) {
    throw new KeyError(
      `Encryption key not found at ${keyPath}. Run "mors init" to create one.`
    );
  }

  const stat = statSync(keyPath);
  const mode = stat.mode & 0o777;

  if (mode !== KEY_FILE_MODE) {
    throw new KeyError(
      `Encryption key at ${keyPath} has insecure permissions (${mode.toString(8)}). Expected owner-only (${KEY_FILE_MODE.toString(8)}). Fix with: chmod 600 ${keyPath}`
    );
  }

  const key = readFileSync(keyPath);

  if (key.length !== KEY_LENGTH) {
    throw new KeyError(
      `Encryption key at ${keyPath} has invalid size (${key.length} bytes, expected ${KEY_LENGTH}).`
    );
  }

  return key;
}

/**
 * Check that a key file has owner-only permissions.
 * @param keyPath - Absolute path to the key file.
 * @returns true if the file has 0o600 permissions.
 */
export function hasSecurePermissions(keyPath: string): boolean {
  if (!existsSync(keyPath)) return false;
  const stat = statSync(keyPath);
  return (stat.mode & 0o777) === KEY_FILE_MODE;
}
