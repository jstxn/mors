/**
 * E2EE device key management for mors.
 *
 * Handles generation, persistence, loading, and validation of per-device
 * encryption key bundles used for 1:1 end-to-end encrypted messaging.
 *
 * Each device maintains:
 * - X25519 keypair for Diffie-Hellman key exchange
 * - Ed25519 keypair for message signing/authentication
 *
 * Key artifacts:
 * - `device-keys.json` — public metadata (public keys hex, fingerprint, deviceId, createdAt)
 * - `x25519.key` — X25519 private key (32 bytes, 0o600 permissions)
 * - `ed25519.key` — Ed25519 private key seed (32 bytes, 0o600 permissions)
 *
 * Security invariants:
 * - Private key material is never stored in the metadata JSON file.
 * - Private key files use owner-only permissions (0o600).
 * - Keys directory uses owner-only permissions (0o700).
 * - Key fingerprint is a SHA-256 hash of concatenated public keys (safe to display).
 * - No private key material is printed to stdout/stderr.
 */
/**
 * Public metadata for a device key bundle.
 * Safe to share — contains no private key material.
 */
export interface DeviceKeyMetadata {
    /** Unique device identifier. */
    deviceId: string;
    /** Hex-encoded X25519 public key. */
    x25519PublicKey: string;
    /** Hex-encoded Ed25519 public key. */
    ed25519PublicKey: string;
    /** SHA-256 fingerprint of concatenated public keys (hex). */
    fingerprint: string;
    /** ISO-8601 timestamp of creation. */
    createdAt: string;
}
/**
 * Complete device key bundle including private keys.
 * Private keys must never leave the local device or be logged.
 */
export interface DeviceKeyBundle {
    /** Unique device identifier. */
    deviceId: string;
    /** X25519 public key (32 bytes). */
    x25519PublicKey: Buffer;
    /** X25519 private key (32 bytes). */
    x25519PrivateKey: Buffer;
    /** Ed25519 public key (32 bytes). */
    ed25519PublicKey: Buffer;
    /** Ed25519 private key seed (32 bytes). */
    ed25519PrivateKey: Buffer;
    /** SHA-256 fingerprint of concatenated public keys (hex). */
    fingerprint: string;
}
/**
 * Compute the fingerprint of a device key bundle.
 * The fingerprint is a SHA-256 hash of the concatenation of X25519 and Ed25519 public keys.
 *
 * @param x25519PublicKey - X25519 public key buffer.
 * @param ed25519PublicKey - Ed25519 public key buffer.
 * @returns Hex-encoded SHA-256 fingerprint.
 */
export declare function computeDeviceFingerprint(x25519PublicKey: Buffer, ed25519PublicKey: Buffer): string;
/**
 * Generate a new device key bundle with X25519 and Ed25519 keypairs.
 *
 * X25519 is used for Diffie-Hellman key exchange (establishing shared secrets).
 * Ed25519 is used for digital signatures (message authentication).
 *
 * @returns A complete DeviceKeyBundle with fresh keypairs.
 */
export declare function generateDeviceKeys(): DeviceKeyBundle;
/**
 * Persist a device key bundle to disk with hardened permissions.
 *
 * Creates the keys directory with 0o700 permissions.
 * Writes public metadata to `device-keys.json` (0o644).
 * Writes private keys to separate files with 0o600 permissions.
 *
 * @param keysDir - Directory path for key storage.
 * @param bundle - The device key bundle to persist.
 * @throws DeviceKeyError if persistence fails.
 */
export declare function persistDeviceKeys(keysDir: string, bundle: DeviceKeyBundle): void;
/**
 * Load a device key bundle from disk.
 *
 * Validates:
 * - All required files exist
 * - Private key files have owner-only permissions (0o600)
 * - Private key sizes are correct (32 bytes each)
 * - Metadata JSON is valid and complete
 * - Fingerprint matches the stored public keys
 *
 * @param keysDir - Directory containing the key files.
 * @returns The loaded DeviceKeyBundle.
 * @throws DeviceKeyError if any validation fails.
 */
export declare function loadDeviceKeys(keysDir: string): DeviceKeyBundle;
/**
 * Check whether device E2EE keys have been bootstrapped in the given directory.
 *
 * @param keysDir - Directory to check for key artifacts.
 * @returns true if all required key files exist.
 */
export declare function isDeviceBootstrapped(keysDir: string): boolean;
/**
 * Get the default E2EE keys directory for a given config directory.
 *
 * @param configDir - The mors config directory.
 * @returns Path to the e2ee subdirectory.
 */
export declare function getDeviceKeysDir(configDir: string): string;
//# sourceMappingURL=device-keys.d.ts.map