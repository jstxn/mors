/**
 * `mors init` command implementation.
 *
 * Handles identity provisioning and encrypted store initialization with:
 * - SQLCipher preflight validation
 * - Ed25519 identity keypair generation
 * - Encrypted database creation
 * - E2EE device key bootstrap (X25519 + Ed25519 keypairs)
 * - Atomic failure handling (cleanup on partial failure)
 * - Safe re-run behavior (non-destructive)
 * - Concurrent init safety via lock file
 * - Output redaction of secret material
 *
 * Fulfills: VAL-INIT-001 through VAL-INIT-007, VAL-SEC-002, VAL-E2EE-001
 */
export interface InitResult {
    alreadyInitialized: boolean;
    fingerprint: string;
    configDir: string;
}
/**
 * Execute `mors init`.
 *
 * On fresh init:
 * 1. Run SQLCipher preflight check
 * 2. Generate identity keypair
 * 3. Generate DB encryption key
 * 4. Create encrypted database with schema
 * 5. Persist identity and key artifacts
 * 6. Write sentinel file
 *
 * On re-run: detect sentinel and return early with existing identity info.
 * On failure: clean up partial state (atomic behavior).
 *
 * @param options.configDir - Override the config directory (for testing).
 * @param options.simulateSqlCipherUnavailable - Testing hook for VAL-INIT-003.
 * @param options.simulateFailureAfterIdentity - Testing hook for VAL-INIT-006.
 * @param options.simulateFailureAfterDbKey - Testing hook for VAL-INIT-006 regression.
 * @param options.simulateFailureAfterDbCreate - Testing hook for VAL-INIT-006 regression.
 */
export declare function initCommand(options?: {
    configDir?: string;
    simulateSqlCipherUnavailable?: boolean;
    simulateFailureAfterIdentity?: boolean;
    simulateFailureAfterDbKey?: boolean;
    simulateFailureAfterDbCreate?: boolean;
}): Promise<InitResult>;
/**
 * Check that mors is initialized and return config dir.
 * Used by other commands to gate on init.
 *
 * @param configDir - Override config dir (for testing).
 * @throws NotInitializedError if not initialized.
 */
export declare function requireInit(configDir?: string): string;
/**
 * Get the database path for an initialized config directory.
 */
export declare function getDbPath(configDir: string): string;
/**
 * Get the database key path for an initialized config directory.
 */
export declare function getDbKeyPath(configDir: string): string;
//# sourceMappingURL=init.d.ts.map