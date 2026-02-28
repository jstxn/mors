/**
 * `mors init` command implementation.
 *
 * Handles identity provisioning and encrypted store initialization with:
 * - SQLCipher preflight validation
 * - Ed25519 identity keypair generation
 * - Encrypted database creation
 * - Atomic failure handling (cleanup on partial failure)
 * - Safe re-run behavior (non-destructive)
 * - Concurrent init safety via lock file
 * - Output redaction of secret material
 *
 * Fulfills: VAL-INIT-001 through VAL-INIT-007, VAL-SEC-002
 */
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, unlinkSync, chmodSync, } from 'node:fs';
import { generateIdentity, persistIdentity, isInitialized, loadIdentity, getConfigDir, } from './identity.js';
import { generateKey, persistKey } from './key-management.js';
import { openEncryptedDb, verifySqlCipherAvailable, initializeSchema } from './store.js';
import { MorsError, NotInitializedError } from './errors.js';
/** Sentinel file name that marks successful initialization. */
const INIT_SENTINEL = '.initialized';
/** Lock file name for concurrent init protection. */
const INIT_LOCK = '.init.lock';
/** DB key file name within the config directory. */
const DB_KEY_FILE = 'db.key';
/** Database file name within the config directory. */
const DB_FILE = 'mors.db';
/** Owner-only directory permissions. */
const DIR_MODE = 0o700;
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
export async function initCommand(options) {
    const configDir = options?.configDir ?? getConfigDir();
    const sentinelPath = join(configDir, INIT_SENTINEL);
    const lockPath = join(configDir, INIT_LOCK);
    // ── Re-run detection (VAL-INIT-002) ──────────────────────────────
    if (existsSync(sentinelPath) && isInitialized(configDir)) {
        // Harden directory permissions on every re-run in case external
        // processes or umask changes have broadened them since the first init.
        chmodSync(configDir, DIR_MODE);
        const identity = loadIdentity(configDir);
        return {
            alreadyInitialized: true,
            fingerprint: identity.fingerprint,
            configDir,
        };
    }
    // ── Concurrent init protection (VAL-INIT-007) ────────────────────
    mkdirSync(configDir, { recursive: true, mode: DIR_MODE });
    // Explicitly chmod in case umask altered the effective permissions.
    chmodSync(configDir, DIR_MODE);
    if (!acquireLock(lockPath)) {
        throw new MorsError('Another init process appears to be running. ' +
            `If this is incorrect, remove the lock file: ${lockPath}`);
    }
    // ── Pre-register ALL expected artifact paths for atomic cleanup ──
    // This ensures that even if a failure occurs mid-creation of any
    // artifact, the cleanup function covers all possible partial writes.
    // This includes SQLite WAL/SHM journal files that may be created
    // alongside the database file.
    const dbKeyPath = join(configDir, DB_KEY_FILE);
    const dbPath = join(configDir, DB_FILE);
    const expectedArtifacts = [
        join(configDir, 'identity.json'),
        join(configDir, 'identity.key'),
        dbKeyPath,
        dbPath,
        `${dbPath}-wal`,
        `${dbPath}-shm`,
        sentinelPath,
    ];
    try {
        // ── SQLCipher preflight (VAL-INIT-003) ──────────────────────────
        verifySqlCipherAvailable(options?.simulateSqlCipherUnavailable ?? false);
        // ── Identity generation ─────────────────────────────────────────
        const identity = generateIdentity();
        persistIdentity(configDir, identity);
        // ── Simulated failure for atomicity testing (VAL-INIT-006) ──────
        if (options?.simulateFailureAfterIdentity) {
            throw new MorsError('Simulated init failure after identity creation.');
        }
        // ── DB key generation & persistence ─────────────────────────────
        const dbKey = generateKey();
        persistKey(dbKeyPath, dbKey);
        // ── Simulated failure for atomicity regression testing ──────────
        if (options?.simulateFailureAfterDbKey) {
            throw new MorsError('Simulated init failure after DB key creation.');
        }
        // ── Encrypted database creation ─────────────────────────────────
        const db = openEncryptedDb({ dbPath, key: dbKey });
        try {
            // ── Simulated failure for atomicity regression testing ────────
            if (options?.simulateFailureAfterDbCreate) {
                throw new MorsError('Simulated init failure after DB creation.');
            }
            initializeSchema(db);
        }
        finally {
            db.close();
        }
        // ── Write sentinel (marks successful init) ──────────────────────
        writeSentinel(sentinelPath, identity.fingerprint);
        return {
            alreadyInitialized: false,
            fingerprint: identity.fingerprint,
            configDir,
        };
    }
    catch (err) {
        // ── Atomic cleanup (VAL-INIT-006) ───────────────────────────────
        // Remove all pre-registered artifacts so the workspace isn't
        // left in a half-initialized state. Pre-registration ensures
        // coverage even for partially written files.
        cleanupArtifacts(expectedArtifacts);
        // Re-throw with original error context.
        throw err;
    }
    finally {
        releaseLock(lockPath);
    }
}
/**
 * Check that mors is initialized and return config dir.
 * Used by other commands to gate on init.
 *
 * @param configDir - Override config dir (for testing).
 * @throws NotInitializedError if not initialized.
 */
export function requireInit(configDir) {
    const dir = configDir ?? getConfigDir();
    const sentinelPath = join(dir, INIT_SENTINEL);
    if (!existsSync(sentinelPath) || !isInitialized(dir)) {
        throw new NotInitializedError('mors is not initialized. Run "mors init" to set up identity and encrypted store.');
    }
    return dir;
}
/**
 * Get the database path for an initialized config directory.
 */
export function getDbPath(configDir) {
    return join(configDir, DB_FILE);
}
/**
 * Get the database key path for an initialized config directory.
 */
export function getDbKeyPath(configDir) {
    return join(configDir, DB_KEY_FILE);
}
// ── Internal helpers ──────────────────────────────────────────────────
function writeSentinel(sentinelPath, fingerprint) {
    const sentinelData = {
        version: '0.1.0',
        fingerprint,
        initializedAt: new Date().toISOString(),
    };
    writeFileSync(sentinelPath, JSON.stringify(sentinelData, null, 2) + '\n', {
        mode: 0o644,
    });
}
/**
 * Attempt to acquire a lock file for init.
 * Uses a simple PID-based lock.
 * Returns true if lock was acquired, false if another process holds it.
 */
function acquireLock(lockPath) {
    if (existsSync(lockPath)) {
        // Check if the lock holder is still alive.
        try {
            const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
            try {
                // Signal 0 does not kill the process, just checks if it exists.
                process.kill(lockData.pid, 0);
                // Process is still alive — lock is held.
                return false;
            }
            catch {
                // Process is dead — stale lock, remove it.
                unlinkSync(lockPath);
            }
        }
        catch {
            // Lock file is corrupt — remove it.
            try {
                unlinkSync(lockPath);
            }
            catch {
                // Best effort.
            }
        }
    }
    try {
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
        return true;
    }
    catch {
        // Another process beat us to it.
        return false;
    }
}
function releaseLock(lockPath) {
    try {
        if (existsSync(lockPath)) {
            const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
            // Only remove if we own the lock.
            if (lockData.pid === process.pid) {
                unlinkSync(lockPath);
            }
        }
    }
    catch {
        // Best-effort cleanup.
    }
}
function cleanupArtifacts(artifacts) {
    for (const artifact of artifacts) {
        try {
            if (existsSync(artifact)) {
                rmSync(artifact, { force: true });
            }
        }
        catch {
            // Best-effort cleanup — don't mask the original error.
        }
    }
}
//# sourceMappingURL=init.js.map