/**
 * Automatic E2EE session establishment from relay-published peer bundles.
 *
 * Bridges the relay device directory and the local key-exchange session store
 * so hosted flows can establish trust-on-first-use sessions without requiring
 * manual bundle exchange commands.
 */
import { loadDeviceKeys } from './device-keys.js';
import { loadKeyExchangeSession, performKeyExchange, } from './key-exchange.js';
function normalizeHexKey(hex) {
    return hex.trim().toLowerCase();
}
/**
 * Ensure a local key-exchange session exists for the supplied peer bundle.
 *
 * Reuses an existing session when it already matches the published peer
 * fingerprint/public key. Otherwise, a new shared secret is derived and
 * persisted locally for subsequent encrypted send/read flows.
 */
export function ensureSessionFromPeerBundle(keysDir, peerBundle, localBundle) {
    const normalizedPublicKey = normalizeHexKey(peerBundle.x25519PublicKey);
    const existing = loadKeyExchangeSession(keysDir, peerBundle.deviceId);
    if (existing &&
        existing.peerFingerprint === peerBundle.fingerprint &&
        existing.peerPublicKeyHex.toLowerCase() === normalizedPublicKey) {
        return existing;
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
    const { keysDir, message, resolvePeerBundle, localBundle } = options;
    if (!message.sender_device_id) {
        return null;
    }
    const peerBundle = await resolvePeerBundle(message.sender_id, message.sender_device_id);
    if (!peerBundle) {
        return null;
    }
    return ensureSessionFromPeerBundle(keysDir, peerBundle, localBundle);
}
//# sourceMappingURL=auto-session.js.map