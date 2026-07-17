/**
 * Automatic E2EE session establishment from relay-published peer bundles.
 *
 * Bridges the relay device directory and the local key-exchange session store
 * so hosted flows can establish trust-on-first-use sessions without requiring
 * manual bundle exchange commands.
 */
import { loadDeviceKeys, computeDeviceFingerprint, } from './device-keys.js';
import { loadKeyExchangeSession, performKeyExchange, } from './key-exchange.js';
import { PeerBundleIntegrityError, PeerIdentityChangedError } from '../errors.js';
/** Expected raw public key size in bytes for X25519/Ed25519. */
const PUBLIC_KEY_SIZE = 32;
function normalizeHexKey(hex) {
    return hex.trim().toLowerCase();
}
/**
 * Verify that a peer bundle's declared fingerprint is an honest SHA-256 hash of
 * its own public keys. This binds the human-verifiable fingerprint to the actual
 * key material, so a relay cannot present a fingerprint that a user has verified
 * out of band while serving a different key.
 *
 * Bundles that omit the Ed25519 key (legacy) are left unverified here; continuity
 * pinning still applies to them.
 */
function verifyBundleFingerprintIntegrity(peerBundle) {
    if (!peerBundle.ed25519PublicKey)
        return;
    const x25519 = Buffer.from(normalizeHexKey(peerBundle.x25519PublicKey), 'hex');
    const ed25519 = Buffer.from(normalizeHexKey(peerBundle.ed25519PublicKey), 'hex');
    if (x25519.length !== PUBLIC_KEY_SIZE || ed25519.length !== PUBLIC_KEY_SIZE) {
        throw new PeerBundleIntegrityError(`Peer device bundle for "${peerBundle.deviceId}" has malformed public keys.`);
    }
    const expected = computeDeviceFingerprint(x25519, ed25519);
    if (expected !== normalizeHexKey(peerBundle.fingerprint)) {
        throw new PeerBundleIntegrityError(`Peer device bundle fingerprint does not match its public keys for device ` +
            `"${peerBundle.deviceId}". The relay may have tampered with the bundle; ` +
            'refusing to establish a session.');
    }
}
/**
 * Ensure a local key-exchange session exists for the supplied peer bundle.
 *
 * Trust rules applied before deriving a shared secret:
 * 1. Integrity — the bundle's fingerprint must hash its own public keys.
 * 2. Continuity — if a session already exists for this device, the published key
 *    must match the pinned key; a changed key is refused unless
 *    {@link EnsureSessionOptions.allowKeyChange} is set (after out-of-band
 *    re-verification). This prevents a relay from silently swapping keys.
 *
 * On first contact (no existing session) the key is pinned (trust on first use).
 */
export function ensureSessionFromPeerBundle(keysDir, peerBundle, localBundle, options = {}) {
    verifyBundleFingerprintIntegrity(peerBundle);
    const normalizedPublicKey = normalizeHexKey(peerBundle.x25519PublicKey);
    const existing = loadKeyExchangeSession(keysDir, peerBundle.deviceId);
    if (existing) {
        const sameKey = existing.peerFingerprint === peerBundle.fingerprint &&
            existing.peerPublicKeyHex.toLowerCase() === normalizedPublicKey;
        if (sameKey) {
            return existing;
        }
        if (!options.allowKeyChange) {
            throw new PeerIdentityChangedError(peerBundle.deviceId, existing.peerFingerprint, peerBundle.fingerprint);
        }
    }
    const local = localBundle ?? loadDeviceKeys(keysDir);
    return performKeyExchange(keysDir, local, Buffer.from(normalizedPublicKey, 'hex'), peerBundle.deviceId, peerBundle.fingerprint);
}
/**
 * Resolve a sender's published peer bundle and establish a session if needed.
 *
 * Returns null when the message does not identify a sender device or when the
 * resolver cannot find a published bundle for that sender/device pair.
 */
export async function ensureSessionForInboundMessage(options) {
    const { keysDir, message, resolvePeerBundle, localBundle, allowKeyChange } = options;
    if (!message.sender_device_id) {
        return null;
    }
    const peerBundle = await resolvePeerBundle(message.sender_id, message.sender_device_id);
    if (!peerBundle) {
        return null;
    }
    return ensureSessionFromPeerBundle(keysDir, peerBundle, localBundle, {
        ...(allowKeyChange !== undefined ? { allowKeyChange } : {}),
    });
}
//# sourceMappingURL=auto-session.js.map