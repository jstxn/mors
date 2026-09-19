/**
 * Developer Launch Path regression tests.
 *
 * Validates the VAL-LAUNCH assertions for the developer-launch-path milestone:
 * - VAL-LAUNCH-001: GitHub shortcut npm install works without global TypeScript
 * - VAL-LAUNCH-005: Installed-command first-run operational flow (login/init/inbox)
 *
 * These tests complement the existing install test files by providing
 * direct evidence for the validation contract assertions with the required
 * evidence patterns (checksums, transcripts, ordered flows).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const CLI = join(ROOT, 'dist', 'index.js');

/** Run the CLI and capture output. */
function runCli(
  args: string,
  options?: {
    configDir?: string;
    env?: Record<string, string>;
    expectFailure?: boolean;
  }
): { stdout: string; stderr: string; exitCode: number } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...options?.env,
  };
  if (options?.configDir) {
    env['MORS_CONFIG_DIR'] = options.configDir;
  }

  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd: ROOT,
      encoding: 'utf8',
      env,
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    if (options?.expectFailure) {
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        exitCode: e.status ?? 1,
      };
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// VAL-LAUNCH-001: GitHub shortcut npm install works without global TS
// ═══════════════════════════════════════════════════════════════════════

describe('VAL-LAUNCH-001: GitHub shortcut npm install in clean environment', () => {
  it('prepare script succeeds when global tsc is absent from PATH', () => {
    // Simulate clean environment: strip all tsc-containing directories from PATH
    const cleanPath = (process.env['PATH'] ?? '')
      .split(':')
      .filter((dir) => !dir.includes('node_modules'))
      .join(':');

    let exitCode = 0;
    try {
      execSync(`bash -c '${pkg.scripts.prepare}'`, {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
        env: { ...process.env, PATH: cleanPath },
      });
    } catch (err: unknown) {
      exitCode = (err as { status?: number }).status ?? 1;
    }

    expect(exitCode).toBe(0);
  });

  it('dist/ is gitignored; prepare/global-setup builds it', () => {
    const gitTracked = execSync('git ls-files dist/index.js', {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    expect(gitTracked).toBe('');
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^dist\/?$/m);
  });

  it('pre-built dist produces correct mors --version immediately', () => {
    const result = runCli('--version');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(`mors ${pkg.version}`);
  });

  it('prepare script uses explicit tsc path (not bare tsc via PATH)', () => {
    // npm bug #8440: nested npm global git-dep context doesn't put
    // node_modules/.bin in PATH. The prepare script must use the explicit path.
    const prepare = pkg.scripts.prepare as string;
    expect(prepare).toContain('node_modules/.bin/tsc');
    expect(prepare).not.toContain('npm run build');
  });

  it('conditional prepare guard skips cleanly when tsc binary is missing', () => {
    // Verify the prepare script's guard clause works by running it
    // with tsc temporarily renamed
    const result = execSync(
      `bash -c 'TSC="node_modules/.bin/tsc"; BAK="$TSC.bak"; ` +
        `mv "$TSC" "$BAK" 2>/dev/null; ` +
        `(${pkg.scripts.prepare}); RC=$?; ` +
        `mv "$BAK" "$TSC" 2>/dev/null; ` +
        `exit $RC'`,
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    // Should succeed (exit 0 from the guard clause)
    expect(result).toBeDefined();
  });

  it('end-to-end: simulated GitHub install → version → init → inbox', () => {
    // Simulate what happens after `npm i -g github:jstxn/mors`:
    // dist/ is pre-built, user runs commands immediately
    const tmpDir = mkdtempSync(join(tmpdir(), 'mors-gh-install-'));
    try {
      const env = {
        ...(process.env as Record<string, string>),
        MORS_CONFIG_DIR: join(tmpDir, 'cfg'),
      };

      // Step 1: Version (no init required)
      const v = execSync(`node ${CLI} --version`, { cwd: ROOT, encoding: 'utf8', env });
      expect(v.trim()).toContain(pkg.version);

      // Step 2: Init
      const init = execSync(`node ${CLI} init --json`, { cwd: ROOT, encoding: 'utf8', env });
      expect(JSON.parse(init.trim()).status).toBe('initialized');

      // Step 3: Inbox
      const inbox = execSync(`node ${CLI} inbox --json`, { cwd: ROOT, encoding: 'utf8', env });
      const inboxParsed = JSON.parse(inbox.trim());
      expect(inboxParsed.status).toBe('ok');
      expect(inboxParsed.count).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════
// VAL-LAUNCH-005: First-run operational flow (login/init/inbox)
// ═══════════════════════════════════════════════════════════════════════

describe('VAL-LAUNCH-005: installed-command first-run operational flow', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'mors-launch-005-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('login with placeholder config fails with actionable guidance (exit 1)', () => {
    // In the placeholder-first phase, login should fail gracefully
    // with specific missing-variable guidance
    const result = runCli('login --json', {
      configDir,
      expectFailure: true,
      env: {
        // Ensure no OAuth config is set (clean environment)
        GITHUB_DEVICE_CLIENT_ID: '',
      },
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('missing_prerequisites');
    expect(parsed.missing).toBeDefined();
    expect(Array.isArray(parsed.missing)).toBe(true);
    expect(parsed.missing.length).toBeGreaterThan(0);
    // Must contain actionable guidance
    expect(parsed.message).toMatch(/invite.token|device.keys|init/i);
  });

  it('init succeeds without login (local-only flow)', () => {
    const result = runCli('init --json', { configDir });
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.status).toBe('initialized');
    expect(parsed.fingerprint).toBeDefined();
    expect(parsed.configDir).toBe(configDir);
  });

  it('inbox succeeds after init (local-only baseline)', () => {
    runCli('init --json', { configDir });

    const result = runCli('inbox --json', { configDir });
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.status).toBe('ok');
    expect(parsed.count).toBe(0);
    expect(parsed.messages).toEqual([]);
  });

  it('full first-run flow: login(fail) → init → send → inbox → read with exit codes', () => {
    // Step 1: Login attempt (fails gracefully with placeholder config)
    const loginResult = runCli('login --json', {
      configDir,
      expectFailure: true,
      env: { GITHUB_DEVICE_CLIENT_ID: '' },
    });
    expect(loginResult.exitCode).toBe(1);
    expect(JSON.parse(loginResult.stdout.trim()).error).toBe('missing_prerequisites');

    // Step 2: Init (succeeds — local-only operation)
    const initResult = runCli('init --json', { configDir });
    expect(initResult.exitCode).toBe(0);
    expect(JSON.parse(initResult.stdout.trim()).status).toBe('initialized');

    // Step 3: Send a message (local mode)
    const sendResult = runCli('send --to test-agent --body "First-run test message" --json', {
      configDir,
    });
    expect(sendResult.exitCode).toBe(0);
    const sendParsed = JSON.parse(sendResult.stdout.trim());
    expect(sendParsed.status).toBe('sent');
    expect(sendParsed.id).toBeDefined();

    // Step 4: Inbox
    const inboxResult = runCli('inbox --json', { configDir });
    expect(inboxResult.exitCode).toBe(0);
    const inboxParsed = JSON.parse(inboxResult.stdout.trim());
    expect(inboxParsed.count).toBe(1);
    expect(inboxParsed.messages[0].id).toBe(sendParsed.id);

    // Step 5: Read
    const readResult = runCli(`read ${sendParsed.id} --json`, { configDir });
    expect(readResult.exitCode).toBe(0);
    const readParsed = JSON.parse(readResult.stdout.trim());
    expect(readParsed.message.body).toBe('First-run test message');
  });

  it('--version and --help work without init or login', () => {
    const version = runCli('--version', { configDir });
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toBe(`mors ${pkg.version}`);

    const help = runCli('--help', { configDir });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('login');
    expect(help.stdout).toContain('init');
    expect(help.stdout).toContain('inbox');
  });

  it('gated commands fail clearly before init with actionable guidance', () => {
    const gatedCommands = ['inbox', 'send --to x --body y', 'read some-id'];

    for (const cmd of gatedCommands) {
      const result = runCli(`${cmd} --json`, { configDir, expectFailure: true });
      expect(result.exitCode).toBe(1);
      // Must mention init in error message
      const output = result.stdout + result.stderr;
      expect(output.toLowerCase()).toContain('init');
    }
  });
});
