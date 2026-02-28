/**
 * Developer Launch Path regression tests.
 *
 * Validates the VAL-LAUNCH assertions for the developer-launch-path milestone:
 * - VAL-LAUNCH-001: GitHub shortcut npm install works without global TypeScript
 * - VAL-LAUNCH-002: setup-shell prompts before shell RC mutation
 * - VAL-LAUNCH-003: Declining setup-shell leaves RC files unchanged
 * - VAL-LAUNCH-004: Confirmed setup-shell edit is minimal and idempotent
 * - VAL-LAUNCH-005: Installed-command first-run operational flow (login/init/inbox)
 *
 * These tests complement the existing install/setup-shell test files by providing
 * direct evidence for the validation contract assertions with the required
 * evidence patterns (checksums, transcripts, ordered flows).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const CLI = join(ROOT, 'dist', 'index.js');

/** Compute SHA-256 hash of file content for checksum verification. */
function fileChecksum(filePath: string): string {
  if (!existsSync(filePath)) return 'FILE_NOT_FOUND';
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/** Run the CLI and capture output. */
function runCli(
  args: string,
  options?: {
    configDir?: string;
    env?: Record<string, string>;
    input?: string;
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
    const stdout = execSync(
      options?.input ? `echo "${options.input}" | node ${CLI} ${args}` : `node ${CLI} ${args}`,
      {
        cwd: ROOT,
        encoding: 'utf8',
        env,
        timeout: 15_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
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

  it('dist/index.js is pre-built and committed (no build step needed for GitHub install)', () => {
    // Verify dist/ is tracked in git (essential for GitHub shortcut install)
    const gitTracked = execSync('git ls-files dist/index.js', {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    expect(gitTracked).toBe('dist/index.js');

    // Verify dist/ is not gitignored
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    expect(gitignore).not.toMatch(/^dist\/?$/m);
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
// VAL-LAUNCH-002: setup-shell prompts before shell RC mutation
// ═══════════════════════════════════════════════════════════════════════

describe('VAL-LAUNCH-002: setup-shell prompts before RC mutation', () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'mors-launch-002-'));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('shows preview of exact RC change before any prompt', () => {
    const result = runCli('setup-shell', {
      input: 'n',
      env: {
        HOME: fakeHome,
        SHELL: '/bin/zsh',
        MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-bin',
      },
    });

    // Must show PATH line preview
    expect(result.stdout).toContain('PATH');
    expect(result.stdout).toContain('/tmp/fake-bin');
    // Must show the target RC file
    expect(result.stdout).toContain('.zshrc');
  });

  it('asks for confirmation with y/N prompt', () => {
    const result = runCli('setup-shell', {
      input: 'n',
      env: {
        HOME: fakeHome,
        SHELL: '/bin/zsh',
        MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-bin',
      },
    });

    // Must ask for confirmation
    expect(result.stdout).toMatch(/[Yy]\/[Nn]/);
  });

  it('RC file checksum is unchanged after preview (before confirmation)', () => {
    const rcPath = join(fakeHome, '.zshrc');
    const originalContent = '# my shell config\nexport EDITOR=vim\n';
    writeFileSync(rcPath, originalContent);
    const checksumBefore = fileChecksum(rcPath);

    // Run with decline to verify prompt doesn't mutate
    runCli('setup-shell --decline', {
      env: {
        HOME: fakeHome,
        SHELL: '/bin/zsh',
        MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-bin',
      },
    });

    const checksumAfter = fileChecksum(rcPath);
    expect(checksumAfter).toBe(checksumBefore);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// VAL-LAUNCH-003: Declining setup-shell leaves RC files unchanged
// ═══════════════════════════════════════════════════════════════════════

describe('VAL-LAUNCH-003: decline path leaves RC files unchanged', () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'mors-launch-003-'));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('interactive decline (n) preserves RC checksum', () => {
    const rcPath = join(fakeHome, '.zshrc');
    const originalContent = '# existing zshrc\nexport PATH="/usr/local/bin:$PATH"\n';
    writeFileSync(rcPath, originalContent);
    const checksumBefore = fileChecksum(rcPath);

    runCli('setup-shell', {
      input: 'n',
      env: {
        HOME: fakeHome,
        SHELL: '/bin/zsh',
        MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-bin',
      },
    });

    expect(fileChecksum(rcPath)).toBe(checksumBefore);
    expect(readFileSync(rcPath, 'utf-8')).toBe(originalContent);
  });

  it('--decline flag preserves RC checksum', () => {
    const rcPath = join(fakeHome, '.zshrc');
    const originalContent = '# config\nalias g="git"\n';
    writeFileSync(rcPath, originalContent);
    const checksumBefore = fileChecksum(rcPath);

    const result = runCli('setup-shell --decline --json', {
      env: {
        HOME: fakeHome,
        SHELL: '/bin/zsh',
        MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-bin',
      },
    });

    expect(fileChecksum(rcPath)).toBe(checksumBefore);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.status).toBe('declined');
    expect(parsed.applied).toBe(false);
  });

  it('decline with bash shell also preserves RC', () => {
    const rcPath = join(fakeHome, '.bashrc');
    const originalContent = '# bashrc\n';
    writeFileSync(rcPath, originalContent);
    const checksumBefore = fileChecksum(rcPath);

    runCli('setup-shell --decline', {
      env: {
        HOME: fakeHome,
        SHELL: '/bin/bash',
        MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-bin',
      },
    });

    expect(fileChecksum(rcPath)).toBe(checksumBefore);
  });

  it('decline with no existing RC file creates no new file', () => {
    const rcPath = join(fakeHome, '.zshrc');
    expect(existsSync(rcPath)).toBe(false);

    runCli('setup-shell --decline', {
      env: {
        HOME: fakeHome,
        SHELL: '/bin/zsh',
        MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-bin',
      },
    });

    expect(existsSync(rcPath)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// VAL-LAUNCH-004: Confirmed setup-shell edit is minimal and idempotent
// ═══════════════════════════════════════════════════════════════════════

describe('VAL-LAUNCH-004: confirm path applies minimal idempotent change', () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'mors-launch-004-'));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('first run applies exactly one PATH line with mors marker', () => {
    const rcPath = join(fakeHome, '.zshrc');
    const originalContent = '# my config\nexport EDITOR=vim\n';
    writeFileSync(rcPath, originalContent);

    const result = runCli('setup-shell --confirm --json', {
      env: {
        HOME: fakeHome,
        SHELL: '/bin/zsh',
        MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-bin',
      },
    });

    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.status).toBe('applied');

    const newContent = readFileSync(rcPath, 'utf-8');
    // Original content preserved
    expect(newContent).toContain('# my config');
    expect(newContent).toContain('export EDITOR=vim');
    // Only one mors marker line added
    const morsLines = newContent.split('\n').filter((l) => l.includes('# mors'));
    expect(morsLines).toHaveLength(1);
    // PATH line contains the bin dir
    expect(newContent).toContain('/tmp/fake-bin');
    expect(newContent).toContain('export PATH=');
  });

  it('second run is idempotent — no content change, checksum stable', () => {
    const rcPath = join(fakeHome, '.zshrc');
    const env = {
      HOME: fakeHome,
      SHELL: '/bin/zsh',
      MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-bin',
    };

    // First run
    runCli('setup-shell --confirm', { env });
    const checksumAfterFirst = fileChecksum(rcPath);
    const contentAfterFirst = readFileSync(rcPath, 'utf-8');

    // Second run
    const result = runCli('setup-shell --confirm --json', { env });
    const checksumAfterSecond = fileChecksum(rcPath);
    const contentAfterSecond = readFileSync(rcPath, 'utf-8');

    // Checksum unchanged
    expect(checksumAfterSecond).toBe(checksumAfterFirst);
    // Content unchanged
    expect(contentAfterSecond).toBe(contentAfterFirst);
    // JSON reports already_configured
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.status).toBe('already_configured');
  });

  it('third run also produces no change (triple idempotency)', () => {
    const env = {
      HOME: fakeHome,
      SHELL: '/bin/zsh',
      MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-bin',
    };

    runCli('setup-shell --confirm', { env });
    runCli('setup-shell --confirm', { env });
    const checksumAfterSecond = fileChecksum(join(fakeHome, '.zshrc'));

    runCli('setup-shell --confirm', { env });
    const checksumAfterThird = fileChecksum(join(fakeHome, '.zshrc'));

    expect(checksumAfterThird).toBe(checksumAfterSecond);
  });

  it('diff between pre and post confirm is minimal (one line added)', () => {
    const rcPath = join(fakeHome, '.zshrc');
    const originalContent = '# line 1\n# line 2\n# line 3\n';
    writeFileSync(rcPath, originalContent);

    runCli('setup-shell --confirm', {
      env: {
        HOME: fakeHome,
        SHELL: '/bin/zsh',
        MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-bin',
      },
    });

    const newContent = readFileSync(rcPath, 'utf-8');
    const originalLines = originalContent.split('\n').filter(Boolean);
    const newLines = newContent.split('\n').filter(Boolean);
    const addedLines = newLines.length - originalLines.length;

    // Only one line was added
    expect(addedLines).toBe(1);
    // All original lines are preserved
    for (const line of originalLines) {
      expect(newContent).toContain(line);
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
    expect(help.stdout).toContain('setup-shell');
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

  it('setup-shell works as install-time command (no init required)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mors-launch-005-home-'));
    try {
      const result = runCli('setup-shell --decline --json', {
        configDir,
        env: {
          HOME: fakeHome,
          SHELL: '/bin/zsh',
          MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-bin',
        },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.status).toBe('declined');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
