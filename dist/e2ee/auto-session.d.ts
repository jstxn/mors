/**
 * Automatic E2EE session establishment from relay-published peer bundles.
 *
 * Bridges the relay device directory and the local key-exchange session store
 * so hosted flows can establish trust-on-first-use sessions without requiring
 * manual bundle exchange commands.
 */
import { type DeviceKeyBundle } from './device-keys.js';
import { type KeyExchangeSession } from './key-exchange.js';
/** Options controlling session establishment trust decisions. */
export interface EnsureSessionOptions {
    /**
     * Permit re-pinning when the peer's published key differs from the key pinned
     * on an existing session. Defaults to false, which refuses silent re-keying
     * (the key-continuity guard). Set true only after the new fingerprint has been
     * verified out of band.
     */
    allowKeyChange?: boolean;
}
/** Public peer bundle metadata required to establish a local session. */
export interface PeerDeviceBundle {
    accountId?: string;
    deviceId: string;
    fingerprint: string;
    x25519PublicKey: string;
    ed25519PublicKey?: string;
    createdAt?: string;
    publishedAt?: string;
}
/** Inbound message metadata needed to auto-resolve the sender device bundle. */
export interface InboundAutoSessionMessage {
    sender_id: string;
    sender_device_id: string | null;
}
/** Callback used to resolve a peer device bundle from relay-backed metadata. */
export type PeerBundleResolver = (accountId: string, deviceId: string) => Promise<PeerDeviceBundle | null>;
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
export declare function ensureSessionFromPeerBundle(keysDir: string, peerBundle: PeerDeviceBundle, localBundle?: DeviceKeyBundle, options?: EnsureSessionOptions): KeyExchangeSession;
/**
 * Resolve a sender's published peer bundle and establish a session if needed.
 *
 * Returns null when the message does not identify a sender device or when the
 * resolver cannot find a published bundle for that sender/device pair.
 */
export declare function ensureSessionForInboundMessage(options: {
    keysDir: string;
    message: InboundAutoSessionMessage;
    resolvePeerBundle: PeerBundleResolver;
    localBundle?: DeviceKeyBundle;
    /** Defaults to false: inbound messages never silently re-key a pinned peer. */
    allowKeyChange?: boolean;
}): Promise<KeyExchangeSession | null>;
//# sourceMappingURL=auto-session.d.ts.map