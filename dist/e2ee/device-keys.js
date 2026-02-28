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
import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, statSync, } from 'node:fs';
import { join } from 'node:path';
import { DeviceKeyError } from '../errors.js';
/** Owner-only file permissions for private key files. */
const PRIVATE_KEY_MODE = 0o600;
/** Owner-only directory permissions. */
const DIR_MODE = 0o700;
/** Public metadata file permissions. */
const METADATA_MODE = 0o644;
/** File names for key artifacts. */
const METADATA_FILE = 'device-keys.json';
const X25519_KEY_FILE = 'x25519.key';
const ED25519_KEY_FILE = 'ed25519.key';
/** Expected size of private key material in bytes. */
const KEY_SIZE = 32;
/**
 * Generate a unique device identifier.
 * @returns A device ID string prefixed with "device_".
 */
function generateDeviceId() {
    return `device_${randomBytes(16).toString('hex')}`;
}
/**
 * Compute the fingerprint of a device key bundle.
 * The fingerprint is a SHA-256 hash of the concatenation of X25519 and Ed25519 public keys.
 *
 * @param x25519PublicKey - X25519 public key buffer.
 * @param ed25519PublicKey - Ed25519 public key buffer.
 * @returns Hex-encoded SHA-256 fingerprint.
 */
export function computeDeviceFingerprint(x25519PublicKey, ed25519PublicKey) {
    return createHash('sha256')
        .update(x25519PublicKey)
        .update(ed25519PublicKey)
        .digest('hex');
}
/**
 * Generate a new device key bundle with X25519 and Ed25519 keypairs.
 *
 * X25519 is used for Diffie-Hellman key exchange (establishing shared secrets).
 * Ed25519 is used for digital signatures (message authentication).
 *
 * @returns A complete DeviceKeyBundle with fresh keypairs.
 */
export function generateDeviceKeys() {
    // Generate X25519 keypair for key exchange
    const x25519Pair = generateKeyPairSync('x25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    // Extract raw 32-byte X25519 public key from DER-encoded SPKI
    // X25519 SPKI DER: 12-byte header + 32-byte key
    const x25519PublicKey = Buffer.from(x25519Pair.publicKey.subarray(x25519Pair.publicKey.length - KEY_SIZE));
    // Extract raw 32-byte X25519 private key from DER-encoded PKCS#8
    // X25519 PKCS#8 DER: 16-byte header + 2-byte ASN.1 wrapper + 32-byte key
    const x25519PrivateKey = Buffer.from(x25519Pair.privateKey.subarray(x25519Pair.privateKey.length - KEY_SIZE));
    // Generate Ed25519 keypair for signing
    const ed25519Pair = generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    // Extract raw 32-byte Ed25519 public key from DER-encoded SPKI
    const ed25519PublicKey = Buffer.from(ed25519Pair.publicKey.subarray(ed25519Pair.publicKey.length - KEY_SIZE));
    // Extract raw 32-byte Ed25519 private key seed from DER-encoded PKCS#8
    const ed25519PrivateKey = Buffer.from(ed25519Pair.privateKey.subarray(ed25519Pair.privateKey.length - KEY_SIZE));
    const deviceId = generateDeviceId();
    const fingerprint = computeDeviceFingerprint(x25519PublicKey, ed25519PublicKey);
    return {
        deviceId,
        x25519PublicKey,
        x25519PrivateKey,
        ed25519PublicKey,
        ed25519PrivateKey,
        fingerprint,
    };
}
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
export function persistDeviceKeys(keysDir, bundle) {
    try {
        // Create directory with restricted permissions
        mkdirSync(keysDir, { recursive: true, mode: DIR_MODE });
        chmodSync(keysDir, DIR_MODE);
        // Write public metadata (no private key material)
        const metadata = {
            deviceId: bundle.deviceId,
            x25519PublicKey: bundle.x25519PublicKey.toString('hex'),
            ed25519PublicKey: bundle.ed25519PublicKey.toString('hex'),
            fingerprint: bundle.fingerprint,
            createdAt: new Date().toISOString(),
        };
        const metadataPath = join(keysDir, METADATA_FILE);
        writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n', {
            mode: METADATA_MODE,
        });
        // Write X25519 private key with owner-only permissions
        const x25519Path = join(keysDir, X25519_KEY_FILE);
        writeFileSync(x25519Path, bundle.x25519PrivateKey, { mode: PRIVATE_KEY_MODE });
        chmodSync(x25519Path, PRIVATE_KEY_MODE);
        // Write Ed25519 private key with owner-only permissions
        const ed25519Path = join(keysDir, ED25519_KEY_FILE);
        writeFileSync(ed25519Path, bundle.ed25519PrivateKey, { mode: PRIVATE_KEY_MODE });
        chmodSync(ed25519Path, PRIVATE_KEY_MODE);
    }
    catch (err) {
        if (err instanceof DeviceKeyError)
            throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new DeviceKeyError(`Failed to persist device keys: ${msg}`);
    }
}
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
export function loadDeviceKeys(keysDir) {
    const metadataPath = join(keysDir, METADATA_FILE);
    const x25519Path = join(keysDir, X25519_KEY_FILE);
    const ed25519Path = join(keysDir, ED25519_KEY_FILE);
    // Check metadata file
    if (!existsSync(metadataPath)) {
        throw new DeviceKeyError(`Device key metadata not found at ${metadataPath}. ` +
            'Run "mors init" to bootstrap device encryption keys.');
    }
    // Check X25519 private key
    if (!existsSync(x25519Path)) {
        throw new DeviceKeyError(`X25519 private key not found at ${x25519Path}. ` +
            'Device keys may be corrupted. Run "mors init" to re-bootstrap.');
    }
    // Check Ed25519 private key
    if (!existsSync(ed25519Path)) {
        throw new DeviceKeyError(`Ed25519 private key not found at ${ed25519Path}. ` +
            'Device keys may be corrupted. Run "mors init" to re-bootstrap.');
    }
    // Validate X25519 private key permissions
    const x25519Stat = statSync(x25519Path);
    const x25519Mode = x25519Stat.mode & 0o777;
    if (x25519Mode !== PRIVATE_KEY_MODE) {
        throw new DeviceKeyError(`X25519 private key at ${x25519Path} has insecure permissions (${x25519Mode.toString(8)}). ` +
            `Expected owner-only (${PRIVATE_KEY_MODE.toString(8)}). Fix with: chmod 600 ${x25519Path}`);
    }
    // Validate Ed25519 private key permissions
    const ed25519Stat = statSync(ed25519Path);
    const ed25519Mode = ed25519Stat.mode & 0o777;
    if (ed25519Mode !== PRIVATE_KEY_MODE) {
        throw new DeviceKeyError(`Ed25519 private key at ${ed25519Path} has insecure permissions (${ed25519Mode.toString(8)}). ` +
            `Expected owner-only (${PRIVATE_KEY_MODE.toString(8)}). Fix with: chmod 600 ${ed25519Path}`);
    }
    // Load and validate private keys
    const x25519PrivateKey = readFileSync(x25519Path);
    if (x25519PrivateKey.length !== KEY_SIZE) {
        throw new DeviceKeyError(`X25519 private key has invalid size (${x25519PrivateKey.length} bytes, expected ${KEY_SIZE}).`);
    }
    const ed25519PrivateKey = readFileSync(ed25519Path);
    if (ed25519PrivateKey.length !== KEY_SIZE) {
        throw new DeviceKeyError(`Ed25519 private key has invalid size (${ed25519PrivateKey.length} bytes, expected ${KEY_SIZE}).`);
    }
    // Parse metadata
    let metadata;
    try {
        const raw = readFileSync(metadataPath, 'utf-8');
        metadata = JSON.parse(raw);
    }
    catch {
        throw new DeviceKeyError(`Failed to parse device key metadata at ${metadataPath}. File may be corrupted.`);
    }
    // Validate metadata fields
    if (!metadata.deviceId || !metadata.fingerprint || !metadata.x25519PublicKey || !metadata.ed25519PublicKey) {
        throw new DeviceKeyError(`Invalid device key metadata at ${metadataPath}. Missing required fields.`);
    }
    // Decode public keys from metadata
    const x25519PublicKey = Buffer.from(metadata.x25519PublicKey, 'hex');
    const ed25519PublicKey = Buffer.from(metadata.ed25519PublicKey, 'hex');
    if (x25519PublicKey.length !== KEY_SIZE) {
        throw new DeviceKeyError(`Invalid X25519 public key in metadata (${x25519PublicKey.length} bytes, expected ${KEY_SIZE}).`);
    }
    if (ed25519PublicKey.length !== KEY_SIZE) {
        throw new DeviceKeyError(`Invalid Ed25519 public key in metadata (${ed25519PublicKey.length} bytes, expected ${KEY_SIZE}).`);
    }
    // Verify fingerprint integrity
    const expectedFingerprint = computeDeviceFingerprint(x25519PublicKey, ed25519PublicKey);
    if (metadata.fingerprint !== expectedFingerprint) {
        throw new DeviceKeyError('Device key fingerprint mismatch. Key files may be corrupted or tampered with. ' +
            'Run "mors init" to re-bootstrap device encryption keys.');
    }
    return {
        deviceId: metadata.deviceId,
        x25519PublicKey,
        x25519PrivateKey,
        ed25519PublicKey,
        ed25519PrivateKey,
        fingerprint: metadata.fingerprint,
    };
}
/**
 * Check whether device E2EE keys have been bootstrapped in the given directory.
 *
 * @param keysDir - Directory to check for key artifacts.
 * @returns true if all required key files exist.
 */
export function isDeviceBootstrapped(keysDir) {
    return (existsSync(join(keysDir, METADATA_FILE)) &&
        existsSync(join(keysDir, X25519_KEY_FILE)) &&
        existsSync(join(keysDir, ED25519_KEY_FILE)));
}
/**
 * Get the default E2EE keys directory for a given config directory.
 *
 * @param configDir - The mors config directory.
 * @returns Path to the e2ee subdirectory.
 */
export function getDeviceKeysDir(configDir) {
    return join(configDir, 'e2ee');
}
//# sourceMappingURL=device-keys.js.map