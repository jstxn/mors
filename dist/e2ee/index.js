/**
 * E2EE module barrel exports.
 *
 * Re-exports device key management, bootstrap guard, and key exchange
 * primitives for the mors end-to-end encryption subsystem.
 */
export { generateDeviceKeys, persistDeviceKeys, loadDeviceKeys, isDeviceBootstrapped, getDeviceKeysDir, computeDeviceFingerprint, } from './device-keys.js';
export { requireDeviceBootstrap, assertDeviceBootstrapped } from './bootstrap-guard.js';
export { performKeyExchange, loadKeyExchangeSession, isKeyExchangeComplete, listKeyExchangeSessions, requireKeyExchange, validateConversationType, } from './key-exchange.js';
export { encryptMessage, decryptMessage } from './cipher.js';
//# sourceMappingURL=index.js.map