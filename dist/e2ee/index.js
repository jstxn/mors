/**
 * E2EE module barrel exports.
 *
 * Re-exports device key management, bootstrap guard, and key exchange
 * primitives for the mors end-to-end encryption subsystem.
 */
export { generateDeviceKeys, persistDeviceKeys, loadDeviceKeys, isDeviceBootstrapped, getDeviceKeysDir, computeDeviceFingerprint, } from './device-keys.js';
export { requireDeviceBootstrap, assertDeviceBootstrapped } from './bootstrap-guard.js';
export { performKeyExchange, loadKeyExchangeSession, isKeyExchangeComplete, listKeyExchangeSessions, requireKeyExchange, validateConversationType, revokeDevice, isDeviceRevoked, listRevokedDevices, rotateDeviceKeys, } from './key-exchange.js';
export { ensureSessionFromPeerBundle, ensureSessionForInboundMessage, } from './auto-session.js';
export { encryptMessage, decryptMessage, decryptMessageStrict, } from './cipher.js';
//# sourceMappingURL=index.js.map