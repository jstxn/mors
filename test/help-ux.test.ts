import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'index.js');

function runCli(
  args: string[],
  options?: {
    configDir?: string;
    env?: Record<string, string>;
  }
): { stdout: string; stderr: string; exitCode: number } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...options?.env,
  };
  if (options?.configDir) {
    env['MORS_CONFIG_DIR'] = options.configDir;
  }

  const result = spawnSync('node', [CLI, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('CLI help UX regressions', () => {
  let tempConfigDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), 'mors-help-ux-config-'));
    fakeHome = mkdtempSync(join(tmpdir(), 'mors-help-ux-home-'));
  });

  afterEach(() => {
    rmSync(tempConfigDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  const helpCommands: string[][] = [
    ['login', '--help'],
    ['send', '--help'],
    ['onboard', '--help'],
    ['status', '--help'],
    ['setup-shell', '--help'],
  ];

  for (const cmd of helpCommands) {
    const label = cmd.join(' ');

    it(`${label} shows help and bypasses init/auth/prereq checks`, () => {
      const result = runCli(cmd, {
        configDir: tempConfigDir,
        env: {
          HOME: fakeHome,
          SHELL: '/bin/zsh',
          MORS_SETUP_SHELL_BIN_DIR: '/tmp/mors-test-bin',
        },
      });

      const combined = `${result.stdout}\n${result.stderr}`;

      expect(result.exitCode).toBe(0);
      expect(combined).toContain('Usage:');
      expect(combined).not.toContain('not_initialized');
      expect(combined).not.toContain('not_authenticated');
      expect(combined).not.toContain('Missing required authentication prerequisites');
    });
  }

  it('--help login section documents invite-token auth input', () => {
    const result = runCli(['--help'], { configDir: tempConfigDir });
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).toBe(0);
    expect(combined).toContain('mors login --invite-token <token>');
    expect(combined).toContain('MORS_INVITE_TOKEN');
  });

  it('setup-shell --help --json does not prompt interactively', () => {
    const result = runCli(['setup-shell', '--help', '--json'], {
      configDir: tempConfigDir,
      env: {
        HOME: fakeHome,
        SHELL: '/bin/zsh',
        MORS_SETUP_SHELL_BIN_DIR: '/tmp/mors-test-bin',
      },
    });

    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).toBe(0);
    expect(combined).toContain('Usage:');
    expect(combined).not.toContain('Apply this change?');
    expect(existsSync(join(fakeHome, '.zshrc'))).toBe(false);
  });
});
