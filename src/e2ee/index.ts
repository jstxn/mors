/**
 * E2EE module barrel exports.
 *
 * Re-exports device key management, bootstrap guard, and key exchange
 * primitives for the mors end-to-end encryption subsystem.
 */

export {
  generateDeviceKeys,
  persistDeviceKeys,
  loadDeviceKeys,
  isDeviceBootstrapped,
  getDeviceKeysDir,
  computeDeviceFingerprint,
  type DeviceKeyBundle,
  type DeviceKeyMetadata,
} from './device-keys.js';

export { requireDeviceBootstrap, assertDeviceBootstrapped } from './bootstrap-guard.js';

export {
  performKeyExchange,
  loadKeyExchangeSession,
  isKeyExchangeComplete,
  listKeyExchangeSessions,
  requireKeyExchange,
  validateConversationType,
  revokeDevice,
  isDeviceRevoked,
  listRevokedDevices,
  rotateDeviceKeys,
  type KeyExchangeSession,
  type ConversationType,
  type RotationResult,
} from './key-exchange.js';

export {
  encryptMessage,
  decryptMessage,
  decryptMessageStrict,
  type EncryptedPayload,
} from './cipher.js';
