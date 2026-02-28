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
/**
 * Encrypted message payload suitable for relay wire transport.
 *
 * All fields are base64-encoded for safe JSON serialization.
 * This is the structure that appears on the wire instead of plaintext body.
 */
export interface EncryptedPayload {
    /** Base64-encoded ciphertext. */
    ciphertext: string;
    /** Base64-encoded initialization vector (12 bytes). */
    iv: string;
    /** Base64-encoded GCM authentication tag (16 bytes). */
    authTag: string;
}
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
export declare function encryptMessage(sharedSecret: Buffer, plaintext: string): EncryptedPayload;
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
export declare function decryptMessage(sharedSecret: Buffer, payload: EncryptedPayload): string;
//# sourceMappingURL=cipher.d.ts.map