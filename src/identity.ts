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

import { generateKeyPairSync, createHash } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { KeyError } from './errors.js';

/** Owner-only file permissions. */
const PRIVATE_KEY_MODE = 0o600;
/** Owner-only directory permissions. */
const DIR_MODE = 0o700;

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
export function generateIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  // Extract the raw 32-byte public key from the DER-encoded SPKI structure.
  // Ed25519 SPKI DER: 12-byte header + 32-byte key.
  const rawPublicKey = Buffer.from(publicKey.subarray(publicKey.length - 32));

  // Extract the raw 32-byte private key seed from the DER-encoded PKCS#8 structure.
  // Ed25519 PKCS#8 DER: 16-byte header + 2-byte ASN.1 wrapper + 32-byte seed.
  const rawPrivateKey = Buffer.from(privateKey.subarray(privateKey.length - 32));

  const fingerprint = computeFingerprint(rawPublicKey);

  return {
    publicKey: rawPublicKey,
    privateKey: rawPrivateKey,
    fingerprint,
  };
}

/**
 * Compute the SHA-256 fingerprint of a public key.
 * @param publicKey - Raw public key bytes.
 * @returns Hex-encoded SHA-256 hash.
 */
export function computeFingerprint(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest('hex');
}

/**
 * Persist identity files to disk.
 * Writes `identity.json` (public metadata) and `identity.key` (private key seed).
 *
 * @param configDir - Directory where identity files are stored.
 * @param identity - The identity to persist.
 */
export function persistIdentity(configDir: string, identity: Identity): void {
  mkdirSync(configDir, { recursive: true, mode: DIR_MODE });

  const metadata: IdentityMetadata = {
    publicKey: identity.publicKey.toString('hex'),
    fingerprint: identity.fingerprint,
    createdAt: new Date().toISOString(),
  };

  const metadataPath = join(configDir, 'identity.json');
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n', {
    mode: 0o644,
  });

  const privateKeyPath = join(configDir, 'identity.key');
  writeFileSync(privateKeyPath, identity.privateKey, {
    mode: PRIVATE_KEY_MODE,
  });
  // Explicitly chmod in case umask altered the effective permissions.
  chmodSync(privateKeyPath, PRIVATE_KEY_MODE);
}

/**
 * Load identity from disk.
 *
 * @param configDir - Directory where identity files are stored.
 * @returns The loaded identity.
 * @throws KeyError if files are missing, invalid, or have insecure permissions.
 */
export function loadIdentity(configDir: string): Identity {
  const metadataPath = join(configDir, 'identity.json');
  const privateKeyPath = join(configDir, 'identity.key');

  if (!existsSync(metadataPath)) {
    throw new KeyError(
      `Identity metadata not found at ${metadataPath}. Run "mors init" to create one.`
    );
  }

  if (!existsSync(privateKeyPath)) {
    throw new KeyError(
      `Identity private key not found at ${privateKeyPath}. Run "mors init" to create one.`
    );
  }

  // Check private key permissions.
  const stat = statSync(privateKeyPath);
  const mode = stat.mode & 0o777;
  if (mode !== PRIVATE_KEY_MODE) {
    throw new KeyError(
      `Identity private key at ${privateKeyPath} has insecure permissions (${mode.toString(8)}). ` +
        `Expected owner-only (${PRIVATE_KEY_MODE.toString(8)}). Fix with: chmod 600 ${privateKeyPath}`
    );
  }

  const privateKey = readFileSync(privateKeyPath);
  if (privateKey.length !== 32) {
    throw new KeyError(
      `Identity private key at ${privateKeyPath} has invalid size (${privateKey.length} bytes, expected 32).`
    );
  }

  const metadataRaw = readFileSync(metadataPath, 'utf-8');
  let metadata: IdentityMetadata;
  try {
    metadata = JSON.parse(metadataRaw) as IdentityMetadata;
  } catch {
    throw new KeyError(
      `Failed to parse identity metadata at ${metadataPath}. File may be corrupted.`
    );
  }

  if (!metadata.publicKey || !metadata.fingerprint) {
    throw new KeyError(
      `Invalid identity metadata at ${metadataPath}. Missing publicKey or fingerprint.`
    );
  }

  const publicKey = Buffer.from(metadata.publicKey, 'hex');
  if (publicKey.length !== 32) {
    throw new KeyError(
      `Invalid public key in identity metadata (${publicKey.length} bytes, expected 32).`
    );
  }

  // Verify fingerprint matches the public key.
  const expectedFingerprint = computeFingerprint(publicKey);
  if (metadata.fingerprint !== expectedFingerprint) {
    throw new KeyError('Identity fingerprint mismatch. Identity files may be corrupted.');
  }

  return {
    publicKey,
    privateKey,
    fingerprint: metadata.fingerprint,
  };
}

/**
 * Check whether an identity has been initialized in the given config directory.
 * @param configDir - Directory to check.
 * @returns true if both identity.json and identity.key exist.
 */
export function isInitialized(configDir: string): boolean {
  return (
    existsSync(join(configDir, 'identity.json')) && existsSync(join(configDir, 'identity.key'))
  );
}

/**
 * Get the default mors config directory.
 * Respects MORS_CONFIG_DIR environment variable for testing.
 * Defaults to `.mors` in the current working directory.
 */
export function getConfigDir(): string {
  return process.env['MORS_CONFIG_DIR'] || join(process.cwd(), '.mors');
}
