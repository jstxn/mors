/**
 * E2EE module barrel exports.
 *
 * Re-exports device key management, bootstrap guard, and key exchange
 * primitives for the mors end-to-end encryption subsystem.
 */
export { generateDeviceKeys, persistDeviceKeys, loadDeviceKeys, isDeviceBootstrapped, getDeviceKeysDir, computeDeviceFingerprint, type DeviceKeyBundle, type DeviceKeyMetadata, } from './device-keys.js';
export { requireDeviceBootstrap, assertDeviceBootstrapped } from './bootstrap-guard.js';
export { performKeyExchange, loadKeyExchangeSession, isKeyExchangeComplete, listKeyExchangeSessions, requireKeyExchange, validateConversationType, type KeyExchangeSession, type ConversationType, } from './key-exchange.js';
export { encryptMessage, decryptMessage, type EncryptedPayload } from './cipher.js';
//# sourceMappingURL=index.d.ts.map