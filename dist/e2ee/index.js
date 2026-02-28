/**
 * E2EE module barrel exports.
 *
 * Re-exports device key management and bootstrap guard primitives
 * for the mors end-to-end encryption subsystem.
 */
export { generateDeviceKeys, persistDeviceKeys, loadDeviceKeys, isDeviceBootstrapped, getDeviceKeysDir, computeDeviceFingerprint, } from './device-keys.js';
export { requireDeviceBootstrap, assertDeviceBootstrapped, } from './bootstrap-guard.js';
//# sourceMappingURL=index.js.map