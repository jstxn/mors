/**
 * Tests for E2EE device key bootstrap and secure local keystore persistence.
 *
 * Covers:
 * - VAL-E2EE-001: Device keypair bootstrap is required for secure messaging
 *   Each device creates/persists encryption identity before secure send/receive is enabled.
 *
 * Also supports:
 * - VAL-AUTH-010: Auth/session artifacts are permission-hardened and non-leaking
 * - VAL-E2EE-005: Stale/wrong key failure is explicit with rekey guidance
 * - VAL-E2EE-006: Device rotation/revocation enforces new trust boundary
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  statSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

import {
  generateDeviceKeys,
  persistDeviceKeys,
  loadDeviceKeys,
  isDeviceBootstrapped,
  getDeviceKeysDir,
  type DeviceKeyMetadata,
} from '../../src/e2ee/device-keys.js';

import {
  requireDeviceBootstrap,
  assertDeviceBootstrapped,
} from '../../src/e2ee/bootstrap-guard.js';

import { initCommand } from '../../src/init.js';

import { DeviceKeyError, DeviceNotBootstrappedError } from '../../src/errors.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mors-e2ee-test-'));
}

describe('E2EE device key bootstrap', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Key generation ─────────────────────────────────────────────────

  describe('key generation', () => {
    it('generates a device key bundle with X25519 and Ed25519 keypairs', () => {
      const bundle = generateDeviceKeys();

      // X25519 key exchange keys
      expect(bundle.x25519PublicKey).toBeInstanceOf(Buffer);
      expect(bundle.x25519PrivateKey).toBeInstanceOf(Buffer);
      expect(bundle.x25519PublicKey.length).toBe(32);
      expect(bundle.x25519PrivateKey.length).toBe(32);

      // Ed25519 signing keys
      expect(bundle.ed25519PublicKey).toBeInstanceOf(Buffer);
      expect(bundle.ed25519PrivateKey).toBeInstanceOf(Buffer);
      expect(bundle.ed25519PublicKey.length).toBe(32);
      expect(bundle.ed25519PrivateKey.length).toBe(32);

      // Device ID
      expect(bundle.deviceId).toMatch(/^device_/);

      // Fingerprint (SHA-256 hex of concatenated public keys)
      expect(bundle.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it('generates unique key bundles on each call', () => {
      const bundle1 = generateDeviceKeys();
      const bundle2 = generateDeviceKeys();

      expect(bundle1.deviceId).not.toBe(bundle2.deviceId);
      expect(bundle1.fingerprint).not.toBe(bundle2.fingerprint);
      expect(Buffer.compare(bundle1.x25519PublicKey, bundle2.x25519PublicKey)).not.toBe(0);
      expect(Buffer.compare(bundle1.ed25519PublicKey, bundle2.ed25519PublicKey)).not.toBe(0);
    });

    it('generates keys with deterministic fingerprint for same public keys', () => {
      const bundle = generateDeviceKeys();
      // Fingerprint should be reproducible from the public keys
      const expected = createHash('sha256')
        .update(bundle.x25519PublicKey)
        .update(bundle.ed25519PublicKey)
        .digest('hex');
      expect(bundle.fingerprint).toBe(expected);
    });
  });

  // ── Key persistence ────────────────────────────────────────────────

  describe('key persistence', () => {
    it('persists device keys and creates expected files', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      // Metadata file should exist
      expect(existsSync(join(keysDir, 'device-keys.json'))).toBe(true);
      // Private key files should exist
      expect(existsSync(join(keysDir, 'x25519.key'))).toBe(true);
      expect(existsSync(join(keysDir, 'ed25519.key'))).toBe(true);
    });

    it('stores metadata with public keys, fingerprint, and deviceId', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      const raw = readFileSync(join(keysDir, 'device-keys.json'), 'utf-8');
      const metadata: DeviceKeyMetadata = JSON.parse(raw);

      expect(metadata.deviceId).toBe(bundle.deviceId);
      expect(metadata.fingerprint).toBe(bundle.fingerprint);
      expect(metadata.x25519PublicKey).toBe(bundle.x25519PublicKey.toString('hex'));
      expect(metadata.ed25519PublicKey).toBe(bundle.ed25519PublicKey.toString('hex'));
      expect(metadata.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('does not store private key material in metadata JSON', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      const raw = readFileSync(join(keysDir, 'device-keys.json'), 'utf-8');
      // Private keys must NOT appear in the metadata file
      expect(raw).not.toContain(bundle.x25519PrivateKey.toString('hex'));
      expect(raw).not.toContain(bundle.ed25519PrivateKey.toString('hex'));
    });

    // ── VAL-AUTH-010: File permissions ──────────────────────────────

    it('private key files have owner-only permissions (0o600)', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      const x25519Stat = statSync(join(keysDir, 'x25519.key'));
      const ed25519Stat = statSync(join(keysDir, 'ed25519.key'));

      expect(x25519Stat.mode & 0o777).toBe(0o600);
      expect(ed25519Stat.mode & 0o777).toBe(0o600);
    });

    it('keys directory has owner-only permissions (0o700)', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      const dirStat = statSync(keysDir);
      expect(dirStat.mode & 0o777).toBe(0o700);
    });

    it('metadata file has 0o644 permissions (public info only)', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      const metaStat = statSync(join(keysDir, 'device-keys.json'));
      expect(metaStat.mode & 0o777).toBe(0o644);
    });
  });

  // ── Key loading ────────────────────────────────────────────────────

  describe('key loading', () => {
    it('loads persisted keys and round-trips correctly', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      const loaded = loadDeviceKeys(keysDir);
      expect(loaded.deviceId).toBe(bundle.deviceId);
      expect(loaded.fingerprint).toBe(bundle.fingerprint);
      expect(Buffer.compare(loaded.x25519PublicKey, bundle.x25519PublicKey)).toBe(0);
      expect(Buffer.compare(loaded.x25519PrivateKey, bundle.x25519PrivateKey)).toBe(0);
      expect(Buffer.compare(loaded.ed25519PublicKey, bundle.ed25519PublicKey)).toBe(0);
      expect(Buffer.compare(loaded.ed25519PrivateKey, bundle.ed25519PrivateKey)).toBe(0);
    });

    it('throws DeviceKeyError when keys directory does not exist', () => {
      expect(() => loadDeviceKeys(join(tempDir, 'nonexistent'))).toThrow(DeviceKeyError);
      expect(() => loadDeviceKeys(join(tempDir, 'nonexistent'))).toThrow(/not found/);
    });

    it('throws DeviceKeyError when metadata file is missing', () => {
      const keysDir = join(tempDir, 'e2ee');
      // Create dir but no files
      mkdirSync(keysDir, { recursive: true });
      writeFileSync(join(keysDir, 'x25519.key'), Buffer.alloc(32));
      writeFileSync(join(keysDir, 'ed25519.key'), Buffer.alloc(32));

      expect(() => loadDeviceKeys(keysDir)).toThrow(DeviceKeyError);
      expect(() => loadDeviceKeys(keysDir)).toThrow(/metadata/i);
    });

    it('throws DeviceKeyError when private key file is missing', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      // Remove one private key file
      rmSync(join(keysDir, 'x25519.key'));

      expect(() => loadDeviceKeys(keysDir)).toThrow(DeviceKeyError);
      expect(() => loadDeviceKeys(keysDir)).toThrow(/x25519/i);
    });

    it('throws DeviceKeyError when private key has wrong size', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      // Corrupt x25519 private key with wrong size
      writeFileSync(join(keysDir, 'x25519.key'), Buffer.alloc(16));

      expect(() => loadDeviceKeys(keysDir)).toThrow(DeviceKeyError);
      expect(() => loadDeviceKeys(keysDir)).toThrow(/invalid size/i);
    });

    it('throws DeviceKeyError when metadata JSON is corrupt', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      // Corrupt metadata
      writeFileSync(join(keysDir, 'device-keys.json'), 'not json at all');

      expect(() => loadDeviceKeys(keysDir)).toThrow(DeviceKeyError);
      expect(() => loadDeviceKeys(keysDir)).toThrow(/corrupted/i);
    });

    it('throws DeviceKeyError when fingerprint does not match public keys', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      // Tamper with fingerprint in metadata
      const metaPath = join(keysDir, 'device-keys.json');
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      meta.fingerprint = 'a'.repeat(64);
      writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');

      expect(() => loadDeviceKeys(keysDir)).toThrow(DeviceKeyError);
      expect(() => loadDeviceKeys(keysDir)).toThrow(/fingerprint mismatch/i);
    });

    // ── VAL-AUTH-010: insecure permissions detection ────────────────

    it('throws DeviceKeyError when private key has insecure permissions', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      // Make key world-readable
      chmodSync(join(keysDir, 'x25519.key'), 0o644);

      expect(() => loadDeviceKeys(keysDir)).toThrow(DeviceKeyError);
      expect(() => loadDeviceKeys(keysDir)).toThrow(/insecure permissions/i);
    });
  });

  // ── Bootstrap state detection ──────────────────────────────────────

  describe('bootstrap state detection', () => {
    it('returns false when no keys exist', () => {
      expect(isDeviceBootstrapped(tempDir)).toBe(false);
    });

    it('returns true after keys are generated and persisted', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      expect(isDeviceBootstrapped(keysDir)).toBe(true);
    });

    it('returns false when metadata exists but private keys are missing', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      // Remove private keys
      rmSync(join(keysDir, 'x25519.key'));

      expect(isDeviceBootstrapped(keysDir)).toBe(false);
    });

    it('returns false when only some files exist', () => {
      const keysDir = join(tempDir, 'e2ee');
      mkdirSync(keysDir, { recursive: true });
      writeFileSync(join(keysDir, 'device-keys.json'), '{}');

      expect(isDeviceBootstrapped(keysDir)).toBe(false);
    });
  });

  // ── Keys directory resolution ──────────────────────────────────────

  describe('getDeviceKeysDir', () => {
    it('returns e2ee subdirectory under config dir', () => {
      const keysDir = getDeviceKeysDir('/tmp/mors-test');
      expect(keysDir).toBe('/tmp/mors-test/e2ee');
    });
  });

  // ── Bootstrap guard ────────────────────────────────────────────────

  describe('bootstrap guard', () => {
    // ── VAL-E2EE-001: block secure messaging pre-bootstrap ──────────

    it('requireDeviceBootstrap returns key bundle when bootstrapped', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      const loaded = requireDeviceBootstrap(keysDir);
      expect(loaded.deviceId).toBe(bundle.deviceId);
      expect(loaded.fingerprint).toBe(bundle.fingerprint);
    });

    it('requireDeviceBootstrap throws DeviceNotBootstrappedError when not bootstrapped', () => {
      const keysDir = join(tempDir, 'nonexistent-e2ee');

      expect(() => requireDeviceBootstrap(keysDir)).toThrow(DeviceNotBootstrappedError);
    });

    it('DeviceNotBootstrappedError includes actionable bootstrap guidance', () => {
      const keysDir = join(tempDir, 'nonexistent-e2ee');

      try {
        requireDeviceBootstrap(keysDir);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceNotBootstrappedError);
        const msg = (err as Error).message;
        expect(msg).toMatch(/bootstrap|init/i);
        expect(msg).toMatch(/device/i);
      }
    });

    it('assertDeviceBootstrapped does not throw when bootstrapped', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      expect(() => assertDeviceBootstrapped(keysDir)).not.toThrow();
    });

    it('assertDeviceBootstrapped throws when not bootstrapped', () => {
      const keysDir = join(tempDir, 'nonexistent-e2ee');

      expect(() => assertDeviceBootstrapped(keysDir)).toThrow(DeviceNotBootstrappedError);
    });
  });

  // ── Multi-device support ───────────────────────────────────────────

  describe('multi-device support', () => {
    it('two devices generate distinct key bundles with unique device IDs', () => {
      const bundle1 = generateDeviceKeys();
      const bundle2 = generateDeviceKeys();

      const dir1 = join(tempDir, 'device1', 'e2ee');
      const dir2 = join(tempDir, 'device2', 'e2ee');

      persistDeviceKeys(dir1, bundle1);
      persistDeviceKeys(dir2, bundle2);

      const loaded1 = loadDeviceKeys(dir1);
      const loaded2 = loadDeviceKeys(dir2);

      expect(loaded1.deviceId).not.toBe(loaded2.deviceId);
      expect(loaded1.fingerprint).not.toBe(loaded2.fingerprint);
      expect(Buffer.compare(loaded1.x25519PublicKey, loaded2.x25519PublicKey)).not.toBe(0);
    });
  });

  // ── Key rotation/revocation foundation ────────────────────────────

  describe('key rotation foundation', () => {
    it('overwriting keys with new bundle updates stored state', () => {
      const keysDir = join(tempDir, 'e2ee');

      const original = generateDeviceKeys();
      persistDeviceKeys(keysDir, original);

      const rotated = generateDeviceKeys();
      persistDeviceKeys(keysDir, rotated);

      const loaded = loadDeviceKeys(keysDir);
      expect(loaded.deviceId).toBe(rotated.deviceId);
      expect(loaded.fingerprint).toBe(rotated.fingerprint);
      expect(Buffer.compare(loaded.x25519PublicKey, rotated.x25519PublicKey)).toBe(0);
      // Old keys are no longer loadable
      expect(loaded.fingerprint).not.toBe(original.fingerprint);
    });
  });

  // ── Security: no secret leakage ───────────────────────────────────

  describe('no secret leakage', () => {
    it('private keys are not included in metadata file content', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      const metaContent = readFileSync(join(keysDir, 'device-keys.json'), 'utf-8');
      const x25519PrivHex = bundle.x25519PrivateKey.toString('hex');
      const ed25519PrivHex = bundle.ed25519PrivateKey.toString('hex');

      expect(metaContent).not.toContain(x25519PrivHex);
      expect(metaContent).not.toContain(ed25519PrivHex);
    });

    it('private key files contain only raw 32-byte key material', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      const x25519Key = readFileSync(join(keysDir, 'x25519.key'));
      const ed25519Key = readFileSync(join(keysDir, 'ed25519.key'));

      expect(x25519Key.length).toBe(32);
      expect(ed25519Key.length).toBe(32);
    });

    it('all files in keys directory are accounted for', () => {
      const bundle = generateDeviceKeys();
      const keysDir = join(tempDir, 'e2ee');
      persistDeviceKeys(keysDir, bundle);

      const files = readdirSync(keysDir).sort();
      expect(files).toEqual(['device-keys.json', 'ed25519.key', 'x25519.key']);
    });
  });

  // ── Init runtime integration (VAL-E2EE-001) ──────────────────────

  describe('mors init provisions E2EE device keys', () => {
    it('mors init creates E2EE key material in config directory', async () => {
      const configDir = join(tempDir, 'init-e2ee');
      await initCommand({ configDir });

      const keysDir = getDeviceKeysDir(configDir);
      expect(isDeviceBootstrapped(keysDir)).toBe(true);

      // Key files should exist
      expect(existsSync(join(keysDir, 'device-keys.json'))).toBe(true);
      expect(existsSync(join(keysDir, 'x25519.key'))).toBe(true);
      expect(existsSync(join(keysDir, 'ed25519.key'))).toBe(true);
    });

    it('mors init creates loadable device key bundle', async () => {
      const configDir = join(tempDir, 'init-e2ee-load');
      await initCommand({ configDir });

      const keysDir = getDeviceKeysDir(configDir);
      const bundle = loadDeviceKeys(keysDir);
      expect(bundle.deviceId).toMatch(/^device_/);
      expect(bundle.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(bundle.x25519PublicKey.length).toBe(32);
      expect(bundle.ed25519PublicKey.length).toBe(32);
    });

    it('re-running init preserves existing device keys', async () => {
      const configDir = join(tempDir, 'init-e2ee-rerun');
      await initCommand({ configDir });

      const keysDir = getDeviceKeysDir(configDir);
      const firstBundle = loadDeviceKeys(keysDir);

      // Re-run init
      await initCommand({ configDir });

      const secondBundle = loadDeviceKeys(keysDir);
      expect(secondBundle.deviceId).toBe(firstBundle.deviceId);
      expect(secondBundle.fingerprint).toBe(firstBundle.fingerprint);
    });

    it('E2EE key files have hardened permissions after init', async () => {
      const configDir = join(tempDir, 'init-e2ee-perms');
      await initCommand({ configDir });

      const keysDir = getDeviceKeysDir(configDir);
      const x25519Stat = statSync(join(keysDir, 'x25519.key'));
      const ed25519Stat = statSync(join(keysDir, 'ed25519.key'));

      expect(x25519Stat.mode & 0o777).toBe(0o600);
      expect(ed25519Stat.mode & 0o777).toBe(0o600);
    });

    it('bootstrap guard passes after mors init', async () => {
      const configDir = join(tempDir, 'init-e2ee-guard');
      await initCommand({ configDir });

      const keysDir = getDeviceKeysDir(configDir);
      expect(() => assertDeviceBootstrapped(keysDir)).not.toThrow();

      const bundle = requireDeviceBootstrap(keysDir);
      expect(bundle.deviceId).toMatch(/^device_/);
    });

    it('E2EE private keys are not leaked in init result metadata', async () => {
      const configDir = join(tempDir, 'init-e2ee-noleak');
      const result = await initCommand({ configDir });

      // The result should not contain private key data
      const resultStr = JSON.stringify(result);
      const keysDir = getDeviceKeysDir(configDir);
      const bundle = loadDeviceKeys(keysDir);

      expect(resultStr).not.toContain(bundle.x25519PrivateKey.toString('hex'));
      expect(resultStr).not.toContain(bundle.ed25519PrivateKey.toString('hex'));
    });

    it('E2EE key artifacts are cleaned up on init failure', async () => {
      const configDir = join(tempDir, 'init-e2ee-failure');

      // Use simulation hook that fails after identity creation but before sentinel
      await expect(
        initCommand({ configDir, simulateFailureAfterIdentity: true })
      ).rejects.toThrow();

      const keysDir = getDeviceKeysDir(configDir);
      expect(isDeviceBootstrapped(keysDir)).toBe(false);
    });
  });

  // ── Secure command bootstrap guard integration ────────────────────

  describe('bootstrap guard blocks secure operations without keys', () => {
    it('requireDeviceBootstrap fails when init has not been run', () => {
      const configDir = join(tempDir, 'no-init');
      const keysDir = getDeviceKeysDir(configDir);

      expect(() => requireDeviceBootstrap(keysDir)).toThrow(DeviceNotBootstrappedError);
    });

    it('DeviceNotBootstrappedError message provides bootstrap guidance', () => {
      const configDir = join(tempDir, 'no-init-msg');
      const keysDir = getDeviceKeysDir(configDir);

      try {
        requireDeviceBootstrap(keysDir);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceNotBootstrappedError);
        const msg = (err as Error).message;
        // Must mention init or bootstrap
        expect(msg).toMatch(/mors init/i);
        // Must mention device
        expect(msg).toMatch(/device/i);
      }
    });

    it('assertDeviceBootstrapped fails when E2EE keys removed after init', async () => {
      const configDir = join(tempDir, 'init-then-remove');
      await initCommand({ configDir });

      const keysDir = getDeviceKeysDir(configDir);
      expect(() => assertDeviceBootstrapped(keysDir)).not.toThrow();

      // Simulate key removal (e.g. accidental deletion)
      rmSync(keysDir, { recursive: true, force: true });

      expect(() => assertDeviceBootstrapped(keysDir)).toThrow(DeviceNotBootstrappedError);
    });
  });
});

// ── CLI-level bootstrap guard integration ─────────────────────────────

describe('CLI bootstrap guard on real command paths', () => {
  const ROOT = resolve(import.meta.dirname, '../..');
  const CLI = join(ROOT, 'dist', 'index.js');

  let cliTempDir: string;

  beforeEach(() => {
    cliTempDir = mkdtempSync(join(tmpdir(), 'mors-cli-e2ee-test-'));
  });

  afterEach(() => {
    rmSync(cliTempDir, { recursive: true, force: true });
  });

  /**
   * Simulate a minimally-initialized mors config directory WITHOUT E2EE keys.
   * This creates identity/sentinel files so init gate passes, but omits E2EE
   * keys to exercise the bootstrap guard.
   */
  function simulateInitWithoutE2EE(configDir: string): void {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'identity.json'),
      JSON.stringify({
        publicKey: 'a'.repeat(64),
        fingerprint: 'b'.repeat(64),
        createdAt: new Date().toISOString(),
      })
    );
    writeFileSync(join(configDir, 'identity.key'), Buffer.alloc(32, 0xaa), { mode: 0o600 });
    writeFileSync(join(configDir, '.initialized'), '');
    // Also create auth session so auth gate passes
    const authDir = join(configDir, 'auth');
    mkdirSync(authDir, { recursive: true });
    writeFileSync(
      join(authDir, 'session.json'),
      JSON.stringify({
        accessToken: 'gho_test_token',
        tokenType: 'bearer',
        scope: 'read:user',
        accountId: "acct_12345",
        deviceId: 'device-001',
        createdAt: new Date().toISOString(),
      })
    );
    writeFileSync(join(authDir, '.auth-enabled'), '');
  }

  function runCli(
    args: string,
    opts?: { configDir?: string; expectFailure?: boolean }
  ): { stdout: string; exitCode: number } {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
    };
    if (opts?.configDir) {
      env['MORS_CONFIG_DIR'] = opts.configDir;
    }
    try {
      const stdout = execSync(`node ${CLI} ${args}`, {
        cwd: ROOT,
        encoding: 'utf8',
        env,
        timeout: 15_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { stdout, exitCode: 0 };
    } catch (err: unknown) {
      if (opts?.expectFailure) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        return {
          stdout: (e.stdout ?? '') + (e.stderr ?? ''),
          exitCode: e.status ?? 1,
        };
      }
      throw err;
    }
  }

  it('send --secure fails with bootstrap guidance when E2EE keys are absent', () => {
    simulateInitWithoutE2EE(cliTempDir);

    const result = runCli('send --to agent-b --body "hello" --secure --json', {
      configDir: cliTempDir,
      expectFailure: true,
    });

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout.trim());
    expect(output.status).toBe('error');
    expect(output.error).toBe('device_not_bootstrapped');
    expect(output.message).toMatch(/mors init/i);
    expect(output.message).toMatch(/device/i);
  });

  it('reply --secure fails with bootstrap guidance when E2EE keys are absent', () => {
    simulateInitWithoutE2EE(cliTempDir);

    const result = runCli('reply msg_fake --body "reply" --secure --json', {
      configDir: cliTempDir,
      expectFailure: true,
    });

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout.trim());
    expect(output.status).toBe('error');
    expect(output.error).toBe('device_not_bootstrapped');
    expect(output.message).toMatch(/mors init/i);
  });

  it('send --secure succeeds (passes bootstrap guard) after mors init', () => {
    // Run full init which provisions E2EE keys
    runCli('init --json', { configDir: cliTempDir });

    // Simulate auth session
    const authDir = join(cliTempDir, 'auth');
    mkdirSync(authDir, { recursive: true });
    writeFileSync(
      join(authDir, 'session.json'),
      JSON.stringify({
        accessToken: 'gho_test_token',
        tokenType: 'bearer',
        scope: 'read:user',
        accountId: "acct_12345",
        deviceId: 'device-001',
        createdAt: new Date().toISOString(),
      })
    );
    writeFileSync(join(authDir, '.auth-enabled'), '');

    // send --secure should pass bootstrap guard and proceed (DB open will work since init ran)
    const result = runCli('send --to agent-b --body "secure hello" --secure --json', {
      configDir: cliTempDir,
    });

    const output = JSON.parse(result.stdout.trim());
    expect(output.status).toBe('sent');
    expect(output.id).toMatch(/^msg_/);
  });

  it('send without --secure does NOT require E2EE keys (no guard)', () => {
    simulateInitWithoutE2EE(cliTempDir);

    // Without --secure, the bootstrap guard should not be triggered.
    // It will fail for other reasons (no DB) but not with bootstrap error.
    const result = runCli('send --to agent-b --body "hello" --json', {
      configDir: cliTempDir,
      expectFailure: true,
    });

    // Should NOT get bootstrap error
    const output = result.stdout.trim();
    expect(output).not.toContain('device_not_bootstrapped');
  });

  it('send --secure fails with text error when --json not used', () => {
    simulateInitWithoutE2EE(cliTempDir);

    const result = runCli('send --to agent-b --body "hello" --secure', {
      configDir: cliTempDir,
      expectFailure: true,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/mors init/i);
    expect(result.stdout).toMatch(/device/i);
  });
});
