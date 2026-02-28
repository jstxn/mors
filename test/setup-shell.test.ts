/**
 * Tests for `mors setup-shell` interactive flow.
 *
 * Validates:
 * - VAL-INSTALL-002: Interactive prompt before shell RC edits
 * - VAL-INSTALL-003: Declining leaves RC files unchanged
 * - VAL-INSTALL-004: Confirming applies only approved edit and is idempotent
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import {
  detectShellProfile,
  buildPathLine,
  rcAlreadyContainsPathLine,
  applyRcEdit,
  formatPreview,
} from '../src/setup-shell.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mors-setup-shell-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('detectShellProfile', () => {
  it('detects .zshrc for zsh shell', () => {
    const result = detectShellProfile({ shell: '/bin/zsh', home: tempDir });
    expect(result.shellName).toBe('zsh');
    expect(result.rcFile).toBe(join(tempDir, '.zshrc'));
  });

  it('detects .bashrc for bash shell', () => {
    const result = detectShellProfile({ shell: '/bin/bash', home: tempDir });
    expect(result.shellName).toBe('bash');
    // On macOS bash may use .bash_profile if it exists, otherwise .bashrc
    expect(result.rcFile).toMatch(/\.bash(rc|_profile)$/);
  });

  it('prefers .bash_profile on macOS when it exists', () => {
    writeFileSync(join(tempDir, '.bash_profile'), '# existing profile\n');
    const result = detectShellProfile({
      shell: '/bin/bash',
      home: tempDir,
      platform: 'darwin',
    });
    expect(result.rcFile).toBe(join(tempDir, '.bash_profile'));
  });

  it('falls back to .bashrc when .bash_profile does not exist on macOS', () => {
    const result = detectShellProfile({
      shell: '/bin/bash',
      home: tempDir,
      platform: 'darwin',
    });
    expect(result.rcFile).toBe(join(tempDir, '.bashrc'));
  });

  it('uses .bashrc on linux', () => {
    const result = detectShellProfile({
      shell: '/bin/bash',
      home: tempDir,
      platform: 'linux',
    });
    expect(result.rcFile).toBe(join(tempDir, '.bashrc'));
  });

  it('defaults to zsh when SHELL is not set', () => {
    const result = detectShellProfile({ shell: undefined, home: tempDir });
    expect(result.shellName).toBe('zsh');
    expect(result.rcFile).toBe(join(tempDir, '.zshrc'));
  });

  it('handles /usr/local/bin/zsh path', () => {
    const result = detectShellProfile({ shell: '/usr/local/bin/zsh', home: tempDir });
    expect(result.shellName).toBe('zsh');
  });

  it('handles /usr/local/bin/bash path', () => {
    const result = detectShellProfile({ shell: '/usr/local/bin/bash', home: tempDir });
    expect(result.shellName).toBe('bash');
  });
});

describe('buildPathLine', () => {
  it('returns export PATH line with given bin directory', () => {
    const line = buildPathLine('/usr/local/lib/node_modules/.bin');
    expect(line).toContain('export PATH=');
    expect(line).toContain('/usr/local/lib/node_modules/.bin');
    expect(line).toContain('$PATH');
  });

  it('includes mors comment marker for idempotency detection', () => {
    const line = buildPathLine('/some/path');
    expect(line).toContain('# mors');
  });
});

describe('rcAlreadyContainsPathLine', () => {
  it('returns false for empty content', () => {
    expect(rcAlreadyContainsPathLine('', '/some/path')).toBe(false);
  });

  it('returns false when rc has no mors path line', () => {
    const content = 'export PATH="/other/thing:$PATH"\n';
    expect(rcAlreadyContainsPathLine(content, '/some/path')).toBe(false);
  });

  it('returns true when rc already has the exact mors path line', () => {
    const line = buildPathLine('/some/path');
    const content = `# existing stuff\n${line}\n`;
    expect(rcAlreadyContainsPathLine(content, '/some/path')).toBe(true);
  });

  it('returns true when mors comment marker is present even with different formatting', () => {
    const content = '# existing\nexport PATH="/some/path:$PATH" # mors\n';
    expect(rcAlreadyContainsPathLine(content, '/some/path')).toBe(true);
  });
});

describe('applyRcEdit', () => {
  it('creates new rc file with path line when file does not exist', () => {
    const rcPath = join(tempDir, '.zshrc');
    const binDir = '/usr/local/lib/node_modules/.bin';
    const result = applyRcEdit(rcPath, binDir);
    expect(result.applied).toBe(true);
    expect(result.alreadyPresent).toBe(false);
    expect(existsSync(rcPath)).toBe(true);
    const content = readFileSync(rcPath, 'utf-8');
    expect(content).toContain(binDir);
    expect(content).toContain('# mors');
  });

  it('appends path line to existing rc file', () => {
    const rcPath = join(tempDir, '.zshrc');
    writeFileSync(rcPath, '# existing content\nexport OTHER=1\n');
    const binDir = '/usr/local/lib/node_modules/.bin';
    const result = applyRcEdit(rcPath, binDir);
    expect(result.applied).toBe(true);
    expect(result.alreadyPresent).toBe(false);
    const content = readFileSync(rcPath, 'utf-8');
    expect(content).toContain('# existing content');
    expect(content).toContain(binDir);
  });

  it('is idempotent — does not duplicate line on repeated runs', () => {
    const rcPath = join(tempDir, '.zshrc');
    const binDir = '/usr/local/lib/node_modules/.bin';

    // First application
    applyRcEdit(rcPath, binDir);
    const contentAfterFirst = readFileSync(rcPath, 'utf-8');

    // Second application
    const result = applyRcEdit(rcPath, binDir);
    expect(result.applied).toBe(false);
    expect(result.alreadyPresent).toBe(true);

    const contentAfterSecond = readFileSync(rcPath, 'utf-8');
    expect(contentAfterSecond).toBe(contentAfterFirst);
  });

  it('preserves existing file content when appending', () => {
    const rcPath = join(tempDir, '.zshrc');
    const originalContent = '# My config\nexport FOO=bar\nalias ll="ls -la"\n';
    writeFileSync(rcPath, originalContent);
    const binDir = '/some/bin';

    applyRcEdit(rcPath, binDir);

    const content = readFileSync(rcPath, 'utf-8');
    expect(content.startsWith(originalContent)).toBe(true);
  });

  it('adds newline separator before path line if file does not end with newline', () => {
    const rcPath = join(tempDir, '.zshrc');
    writeFileSync(rcPath, '# config');
    const binDir = '/some/bin';

    applyRcEdit(rcPath, binDir);

    const content = readFileSync(rcPath, 'utf-8');
    // Should not have the path line immediately concatenated to "# config"
    const lines = content.split('\n');
    expect(lines[0]).toBe('# config');
    // There should be an empty line or the path line as a separate line
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});

describe('formatPreview', () => {
  it('includes the rc file path', () => {
    const preview = formatPreview('/home/user/.zshrc', '/some/bin');
    expect(preview).toContain('.zshrc');
  });

  it('includes the path line that will be added', () => {
    const preview = formatPreview('/home/user/.zshrc', '/some/bin');
    expect(preview).toContain('/some/bin');
  });

  it('includes clear description of the change', () => {
    const preview = formatPreview('/home/user/.zshrc', '/some/bin');
    expect(preview).toContain('PATH');
  });
});

describe('CLI integration (setup-shell via child_process)', () => {
  const ROOT = join(import.meta.dirname, '..');

  it('shows prompt and preview before any edit', () => {
    // Run setup-shell with stdin closed immediately (no input = decline)

    const fakeHome = mkdtempSync(join(tmpdir(), 'mors-cli-setup-'));

    try {
      const result = execSync(`echo "n" | node dist/index.js setup-shell`, {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: fakeHome,
          SHELL: '/bin/zsh',
          MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-npm-bin',
        },
        timeout: 10_000,
      });
      // Should show a preview of what will be added
      expect(result).toContain('PATH');
      // Should ask for confirmation
      expect(result).toMatch(/[Cc]onfirm|[Aa]pply|[Pp]roceed|[Yy]\/[Nn]/);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('decline leaves rc file unchanged (VAL-INSTALL-003)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mors-cli-setup-'));
    const rcPath = join(fakeHome, '.zshrc');
    const originalContent = '# existing zshrc\nexport EDITOR=vim\n';
    writeFileSync(rcPath, originalContent);

    try {
      const result = execSync(`echo "n" | node dist/index.js setup-shell`, {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: fakeHome,
          SHELL: '/bin/zsh',
          MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-npm-bin',
        },
        timeout: 10_000,
      });
      // RC file should be unchanged
      expect(readFileSync(rcPath, 'utf-8')).toBe(originalContent);
      // Should indicate no changes were applied
      expect(result).toMatch(/[Nn]o changes|[Cc]ancelled|[Dd]eclined|[Nn]ot applied/i);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('confirm applies minimal PATH update (VAL-INSTALL-004)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mors-cli-setup-'));
    const rcPath = join(fakeHome, '.zshrc');

    try {
      const result = execSync(`echo "y" | node dist/index.js setup-shell`, {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: fakeHome,
          SHELL: '/bin/zsh',
          MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-npm-bin',
        },
        timeout: 10_000,
      });
      // RC file should now contain the path line
      const content = readFileSync(rcPath, 'utf-8');
      expect(content).toContain('/tmp/fake-npm-bin');
      expect(content).toContain('# mors');
      // Should indicate success
      expect(result).toMatch(/[Aa]pplied|[Ss]uccess|[Uu]pdated|[Dd]one/i);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('repeated confirm is idempotent (VAL-INSTALL-004)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mors-cli-setup-'));
    const rcPath = join(fakeHome, '.zshrc');
    const env = {
      ...process.env,
      HOME: fakeHome,
      SHELL: '/bin/zsh',
      MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-npm-bin',
    };

    try {
      // First run — confirm
      execSync(`echo "y" | node dist/index.js setup-shell`, {
        cwd: ROOT,
        encoding: 'utf8',
        env,
        timeout: 10_000,
      });
      const contentAfterFirst = readFileSync(rcPath, 'utf-8');

      // Second run — also confirm
      const result2 = execSync(`echo "y" | node dist/index.js setup-shell`, {
        cwd: ROOT,
        encoding: 'utf8',
        env,
        timeout: 10_000,
      });
      const contentAfterSecond = readFileSync(rcPath, 'utf-8');

      // Content should not have duplicated path line
      expect(contentAfterSecond).toBe(contentAfterFirst);
      // Should indicate already configured
      expect(result2).toMatch(/[Aa]lready|[Nn]o changes needed|[Ii]dempotent/i);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('does not require init (setup-shell is an install-time command)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mors-cli-setup-'));

    try {
      // setup-shell should work without mors init
      const result = execSync(`echo "n" | node dist/index.js setup-shell`, {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: fakeHome,
          SHELL: '/bin/zsh',
          MORS_CONFIG_DIR: join(fakeHome, '.mors'),
          MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-npm-bin',
        },
        timeout: 10_000,
      });
      // Should not fail with "not initialized" error
      expect(result).not.toContain('not initialized');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('handles --json flag for machine-readable output', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mors-cli-setup-'));

    try {
      const result = execSync(`echo "y" | node dist/index.js setup-shell --json`, {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: fakeHome,
          SHELL: '/bin/zsh',
          MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-npm-bin',
        },
        timeout: 10_000,
      });
      const parsed = JSON.parse(result.trim());
      expect(parsed.status).toBeDefined();
      expect(parsed.shell).toBeDefined();
      expect(parsed.rcFile).toBeDefined();
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('--confirm flag skips interactive prompt for scripted use', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mors-cli-setup-'));
    const rcPath = join(fakeHome, '.zshrc');

    try {
      execSync(`node dist/index.js setup-shell --confirm`, {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: fakeHome,
          SHELL: '/bin/zsh',
          MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-npm-bin',
        },
        timeout: 10_000,
      });
      // Should apply without prompting
      const content = readFileSync(rcPath, 'utf-8');
      expect(content).toContain('/tmp/fake-npm-bin');
      expect(content).toContain('# mors');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('--decline flag skips interactive prompt and declines', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mors-cli-setup-'));
    const rcPath = join(fakeHome, '.zshrc');
    const originalContent = '# my config\n';
    writeFileSync(rcPath, originalContent);

    try {
      execSync(`node dist/index.js setup-shell --decline`, {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: fakeHome,
          SHELL: '/bin/zsh',
          MORS_SETUP_SHELL_BIN_DIR: '/tmp/fake-npm-bin',
        },
        timeout: 10_000,
      });
      expect(readFileSync(rcPath, 'utf-8')).toBe(originalContent);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
