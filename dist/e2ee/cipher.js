/**
 * E2EE cipher runtime for mors.
 *
 * Provides authenticated encryption/decryption for relay message payloads
 * using AES-256-GCM with HKDF-derived keys from the X25519 shared secret
 * established during key exchange.
 *
 * Encryption scheme:
 * 1. Derive a 256-bit AES key from the shared secret using HKDF-SHA256
 *    with a domain-specific info string.
 * 2. Generate a random 96-bit (12-byte) IV per message.
 * 3. Encrypt the plaintext with AES-256-GCM producing ciphertext + 128-bit auth tag.
 *
 * Security invariants:
 * - Every encryption uses a fresh random IV (never reuses IV+key).
 * - GCM auth tag provides integrity and authenticity checks.
 * - Tampered ciphertext, IV, or auth tag fail with a deterministic CipherError.
 * - The shared secret itself is never included in the encrypted payload.
 * - Plaintext is never present in the EncryptedPayload fields.
 *
 * Covers:
 * - VAL-E2EE-003: Relay/wire payloads contain ciphertext, not plaintext body
 * - VAL-E2EE-004: Intended recipient decrypts successfully with valid keys
 * - VAL-E2EE-009: Ciphertext tampering is detected and rejected
 */
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';
import { CipherError, StaleKeyError } from '../errors.js';
// ── Constants ────────────────────────────────────────────────────────
/** Expected shared secret length (32 bytes from X25519 ECDH). */
const SHARED_SECRET_SIZE = 32;
/** AES-256-GCM algorithm identifier. */
const ALGORITHM = 'aes-256-gcm';
/** IV size for AES-GCM (96 bits / 12 bytes, NIST recommended). */
const IV_SIZE = 12;
/** Auth tag size for AES-GCM (128 bits / 16 bytes). */
const AUTH_TAG_SIZE = 16;
/** HKDF info string for domain separation of the derived encryption key. */
const HKDF_INFO = 'mors-e2ee-message-v1';
/** HKDF salt — using a fixed domain-specific salt for deterministic derivation. */
const HKDF_SALT = Buffer.from('mors-e2ee-salt-v1', 'utf8');
// ── Internal helpers ─────────────────────────────────────────────────
/**
 * Derive a 256-bit AES key from the X25519 shared secret using HKDF-SHA256.
 *
 * @param sharedSecret - The raw shared secret from key exchange (32 bytes).
 * @returns A 32-byte derived key suitable for AES-256-GCM.
 */
function deriveKey(sharedSecret) {
    return Buffer.from(hkdfSync('sha256', sharedSecret, HKDF_SALT, HKDF_INFO, 32));
}
/**
 * Validate that a shared secret has the correct length.
 * @throws CipherError if the shared secret is invalid.
 */
function validateSharedSecret(sharedSecret) {
    if (!Buffer.isBuffer(sharedSecret) || sharedSecret.length !== SHARED_SECRET_SIZE) {
        throw new CipherError(`Invalid shared secret: expected ${SHARED_SECRET_SIZE} bytes, ` +
            `got ${Buffer.isBuffer(sharedSecret) ? sharedSecret.length : 0} bytes. ` +
            'Ensure key exchange has completed successfully.');
    }
}
/**
 * Validate an encrypted payload has all required fields.
 *
 * Note: ciphertext may be empty for zero-length plaintext (AES-GCM supports
 * encrypting empty messages), but iv and authTag must always be non-empty.
 * @throws CipherError if the payload is malformed.
 */
function validatePayload(payload) {
    if (payload.ciphertext === undefined ||
        payload.ciphertext === null ||
        typeof payload.ciphertext !== 'string') {
        throw new CipherError('Invalid encrypted payload: ciphertext is missing.');
    }
    if (!payload.iv || typeof payload.iv !== 'string') {
        throw new CipherError('Invalid encrypted payload: iv is missing or empty.');
    }
    if (!payload.authTag || typeof payload.authTag !== 'string') {
        throw new CipherError('Invalid encrypted payload: authTag is missing or empty.');
    }
}
// ── Public API ───────────────────────────────────────────────────────
/**
 * Encrypt a plaintext message using the shared secret from key exchange.
 *
 * Produces an EncryptedPayload containing base64-encoded ciphertext, IV,
 * and GCM authentication tag. A fresh random IV is generated per call
 * to ensure no IV+key reuse.
 *
 * @param sharedSecret - The shared secret from key exchange (32 bytes).
 * @param plaintext - The plaintext message to encrypt.
 * @returns An EncryptedPayload with base64-encoded fields.
 * @throws CipherError if the shared secret is invalid or encryption fails.
 */
export function encryptMessage(sharedSecret, plaintext) {
    validateSharedSecret(sharedSecret);
    const derivedKey = deriveKey(sharedSecret);
    const iv = randomBytes(IV_SIZE);
    try {
        const cipher = createCipheriv(ALGORITHM, derivedKey, iv, {
            authTagLength: AUTH_TAG_SIZE,
        });
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const authTag = cipher.getAuthTag();
        return {
            ciphertext: encrypted.toString('base64'),
            iv: iv.toString('base64'),
            authTag: authTag.toString('base64'),
        };
    }
    catch (err) {
        if (err instanceof CipherError)
            throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new CipherError(`Encryption failed: ${msg}`);
    }
}
/**
 * Decrypt an encrypted message payload using the shared secret from key exchange.
 *
 * Verifies the GCM authentication tag to ensure integrity and authenticity.
 * Any tampering with the ciphertext, IV, or auth tag will cause decryption
 * to fail with a deterministic CipherError.
 *
 * @param sharedSecret - The shared secret from key exchange (32 bytes).
 * @param payload - The encrypted payload to decrypt.
 * @returns The decrypted plaintext string.
 * @throws CipherError if the shared secret is wrong, payload is tampered, or decryption fails.
 */
export function decryptMessage(sharedSecret, payload) {
    validateSharedSecret(sharedSecret);
    validatePayload(payload);
    const derivedKey = deriveKey(sharedSecret);
    try {
        const ciphertext = Buffer.from(payload.ciphertext, 'base64');
        const iv = Buffer.from(payload.iv, 'base64');
        const authTag = Buffer.from(payload.authTag, 'base64');
        const decipher = createDecipheriv(ALGORITHM, derivedKey, iv, {
            authTagLength: AUTH_TAG_SIZE,
        });
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return decrypted.toString('utf8');
    }
    catch (err) {
        if (err instanceof CipherError)
            throw err;
        throw new CipherError('Decryption failed: message integrity or authentication check failed. ' +
            'The ciphertext may have been tampered with, or the shared secret may not match. ' +
            'If this persists, re-establish key exchange with the peer device and retry.');
    }
}
/**
 * Decrypt an encrypted message payload with strict stale-key error handling.
 *
 * Like decryptMessage, but throws a StaleKeyError (subclass of CipherError)
 * when decryption fails due to an integrity/authentication check failure,
 * providing explicit rekey guidance. This distinguishes key mismatch errors
 * from payload validation errors.
 *
 * Use this variant when the caller wants to present specific rekey guidance
 * to the user (e.g., CLI flows where the user needs to know to re-run
 * key exchange after device rotation).
 *
 * @param sharedSecret - The shared secret from key exchange (32 bytes).
 * @param payload - The encrypted payload to decrypt.
 * @returns The decrypted plaintext string.
 * @throws StaleKeyError if decryption fails due to wrong/stale shared secret.
 * @throws CipherError if the shared secret size is invalid or payload is malformed.
 */
export function decryptMessageStrict(sharedSecret, payload) {
    validateSharedSecret(sharedSecret);
    validatePayload(payload);
    const derivedKey = deriveKey(sharedSecret);
    try {
        const ciphertext = Buffer.from(payload.ciphertext, 'base64');
        const iv = Buffer.from(payload.iv, 'base64');
        const authTag = Buffer.from(payload.authTag, 'base64');
        const decipher = createDecipheriv(ALGORITHM, derivedKey, iv, {
            authTagLength: AUTH_TAG_SIZE,
        });
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return decrypted.toString('utf8');
    }
    catch (err) {
        if (err instanceof CipherError)
            throw err;
        throw new StaleKeyError('Decryption failed: the shared secret appears stale or mismatched. ' +
            'This typically occurs after a device rotation or when keys are out of sync. ' +
            'Re-establish key exchange with the peer device to create a fresh shared secret, then retry.');
    }
}
//# sourceMappingURL=cipher.js.map