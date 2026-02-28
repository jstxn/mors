/**
 * E2EE bootstrap guard for mors.
 *
 * Provides guard functions that block secure messaging operations
 * until device key bootstrap is complete (VAL-E2EE-001).
 *
 * Secure send/receive paths must call requireDeviceBootstrap() or
 * assertDeviceBootstrapped() before proceeding with encrypted operations.
 * This ensures deterministic failure with actionable guidance when
 * device keys are not yet provisioned.
 */
import { type DeviceKeyBundle } from './device-keys.js';
/**
 * Require device key bootstrap and return the loaded key bundle.
 *
 * Use this when the caller needs the key bundle to proceed with
 * encryption/decryption operations.
 *
 * @param keysDir - Path to the E2EE keys directory.
 * @returns The loaded DeviceKeyBundle.
 * @throws DeviceNotBootstrappedError if keys are not bootstrapped.
 * @throws DeviceKeyError if keys exist but are invalid.
 */
export declare function requireDeviceBootstrap(keysDir: string): DeviceKeyBundle;
/**
 * Assert that device key bootstrap is complete.
 *
 * Use this for lightweight checks where the caller only needs to verify
 * bootstrap state without loading the full key bundle.
 *
 * @param keysDir - Path to the E2EE keys directory.
 * @throws DeviceNotBootstrappedError if keys are not bootstrapped.
 */
export declare function assertDeviceBootstrapped(keysDir: string): void;
//# sourceMappingURL=bootstrap-guard.d.ts.map