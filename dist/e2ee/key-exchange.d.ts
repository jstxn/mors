/**
 * E2EE 1:1 key exchange for mors.
 *
 * Implements the Diffie-Hellman key exchange handshake using X25519 keypairs
 * established during device bootstrap. This module:
 *
 * 1. Performs ECDH key agreement between local and peer X25519 keys
 * 2. Derives a shared secret for later encrypt/decrypt operations
 * 3. Persists key exchange session metadata (shared secret + peer info)
 * 4. Enforces 1:1-only scope — rejects group/channel E2EE attempts
 *
 * Security invariants:
 * - Shared secrets are persisted with owner-only permissions (0o600)
 * - Sessions directory uses owner-only permissions (0o700)
 * - Local private key material is never stored in session files
 * - Self-exchange is explicitly rejected
 * - All-zeros peer public key is rejected (invalid X25519 point)
 *
 * Covers:
 * - VAL-E2EE-002: 1:1 key exchange completes before encrypted send
 * - VAL-E2EE-008: Group/channel E2EE attempts return explicit unsupported response
 */
import type { DeviceKeyBundle } from './device-keys.js';
/** Conversation types for E2EE scope enforcement. */
export type ConversationType = 'direct' | 'group' | 'channel';
/**
 * Key exchange session metadata persisted for later encrypt/decrypt.
 * Contains the derived shared secret and peer identification info.
 */
export interface KeyExchangeSession {
    /** Local device ID that performed the exchange. */
    localDeviceId: string;
    /** Peer device ID. */
    peerDeviceId: string;
    /** Peer device fingerprint (for display/verification). */
    peerFingerprint: string;
    /** Hex-encoded peer X25519 public key (for reference/audit). */
    peerPublicKeyHex: string;
    /** Derived shared secret from ECDH. */
    sharedSecret: Buffer;
    /** ISO-8601 timestamp of when the exchange completed. */
    completedAt: string;
}
/**
 * Perform a 1:1 key exchange with a peer device.
 *
 * Uses X25519 Diffie-Hellman to derive a shared secret from the local
 * device's private key and the peer's public key.
 *
 * The resulting session (including derived shared secret) is persisted
 * to disk for later encrypt/decrypt operations.
 *
 * @param keysDir - Local E2EE keys directory (contains device keys + sessions).
 * @param localBundle - Local device key bundle.
 * @param peerPublicKey - Peer's raw X25519 public key (32 bytes).
 * @param peerDeviceId - Peer's device identifier.
 * @param peerFingerprint - Peer's device key fingerprint.
 * @returns The completed KeyExchangeSession.
 * @throws KeyExchangeError if the exchange fails (invalid key, self-exchange, etc.).
 */
export declare function performKeyExchange(keysDir: string, localBundle: DeviceKeyBundle, peerPublicKey: Buffer, peerDeviceId: string, peerFingerprint: string): KeyExchangeSession;
/**
 * Load a key exchange session for a specific peer device.
 *
 * @param keysDir - E2EE keys directory.
 * @param peerDeviceId - The peer device ID to look up.
 * @returns The loaded KeyExchangeSession, or null if not found.
 */
export declare function loadKeyExchangeSession(keysDir: string, peerDeviceId: string): KeyExchangeSession | null;
/**
 * Check whether a key exchange has been completed with a specific peer.
 *
 * @param keysDir - E2EE keys directory.
 * @param peerDeviceId - The peer device ID to check.
 * @returns true if a key exchange session exists for this peer.
 */
export declare function isKeyExchangeComplete(keysDir: string, peerDeviceId: string): boolean;
/**
 * List all completed key exchange sessions.
 *
 * @param keysDir - E2EE keys directory.
 * @returns Array of loaded KeyExchangeSession objects.
 */
export declare function listKeyExchangeSessions(keysDir: string): KeyExchangeSession[];
/**
 * Require a completed key exchange with a peer device.
 *
 * Use this as a guard before encrypted send/receive operations.
 * Returns the session if exchange is complete; throws if not.
 *
 * @param keysDir - E2EE keys directory.
 * @param peerDeviceId - The peer device ID to check.
 * @returns The loaded KeyExchangeSession.
 * @throws KeyExchangeNotCompleteError if no exchange exists for this peer.
 */
export declare function requireKeyExchange(keysDir: string, peerDeviceId: string): KeyExchangeSession;
/**
 * Validate that a conversation type supports E2EE.
 *
 * Only 'direct' (1:1) conversations support end-to-end encryption.
 * Group and channel E2EE is explicitly deferred/unsupported per mission scope.
 *
 * @param type - The conversation type to validate.
 * @throws GroupE2EEUnsupportedError if the type is not 'direct'.
 */
export declare function validateConversationType(type: ConversationType | string): void;
//# sourceMappingURL=key-exchange.d.ts.map