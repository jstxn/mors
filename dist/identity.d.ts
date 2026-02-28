/**
 * Identity management for mors.
 *
 * Handles Ed25519 keypair generation for local identity, public key fingerprinting,
 * and persistence of identity files with hardened permissions.
 *
 * Identity artifacts:
 * - `identity.json` — public identity metadata (public key hex, fingerprint, created timestamp)
 * - `identity.key` — private key (Ed25519 seed, 32 bytes, 0o600 permissions)
 *
 * Security invariants:
 * - Private key material is never printed to stdout/stderr.
 * - Private key file uses owner-only permissions (0o600).
 * - Fingerprint is a SHA-256 hash of the public key (safe to display).
 */
/** Public identity metadata persisted as JSON. */
export interface IdentityMetadata {
    /** Hex-encoded Ed25519 public key. */
    publicKey: string;
    /** SHA-256 fingerprint of the public key (hex). */
    fingerprint: string;
    /** ISO-8601 timestamp of creation. */
    createdAt: string;
}
/** In-memory representation of a full identity (includes private key). */
export interface Identity {
    /** Ed25519 public key buffer. */
    publicKey: Buffer;
    /** Ed25519 private key buffer (seed, 32 bytes). */
    privateKey: Buffer;
    /** SHA-256 fingerprint of the public key (hex). */
    fingerprint: string;
}
/**
 * Generate a new Ed25519 identity keypair.
 * @returns Identity with public key, private key seed, and fingerprint.
 */
export declare function generateIdentity(): Identity;
/**
 * Compute the SHA-256 fingerprint of a public key.
 * @param publicKey - Raw public key bytes.
 * @returns Hex-encoded SHA-256 hash.
 */
export declare function computeFingerprint(publicKey: Buffer): string;
/**
 * Persist identity files to disk.
 * Writes `identity.json` (public metadata) and `identity.key` (private key seed).
 *
 * @param configDir - Directory where identity files are stored.
 * @param identity - The identity to persist.
 */
export declare function persistIdentity(configDir: string, identity: Identity): void;
/**
 * Load identity from disk.
 *
 * @param configDir - Directory where identity files are stored.
 * @returns The loaded identity.
 * @throws KeyError if files are missing, invalid, or have insecure permissions.
 */
export declare function loadIdentity(configDir: string): Identity;
/**
 * Check whether an identity has been initialized in the given config directory.
 * @param configDir - Directory to check.
 * @returns true if both identity.json and identity.key exist.
 */
export declare function isInitialized(configDir: string): boolean;
/**
 * Get the default mors config directory.
 * Respects MORS_CONFIG_DIR environment variable for testing.
 * Defaults to `.mors` in the current working directory.
 */
export declare function getConfigDir(): string;
//# sourceMappingURL=identity.d.ts.map