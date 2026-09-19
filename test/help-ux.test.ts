import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), 'mors-help-ux-config-'));
  });

  afterEach(() => {
    rmSync(tempConfigDir, { recursive: true, force: true });
  });

  const helpCommands: string[][] = [
    ['key-exchange', '--help'],
    ['login', '--help'],
    ['setup', '--help'],
    ['send', '--help'],
    ['spool', '--help'],
    ['onboard', '--help'],
    ['status', '--help'],
  ];

  for (const cmd of helpCommands) {
    const label = cmd.join(' ');

    it(`${label} shows help and bypasses init/auth/prereq checks`, () => {
      const result = runCli(cmd, {
        configDir: tempConfigDir,
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

  it('--help documents the key-exchange command family', () => {
    const result = runCli(['--help'], { configDir: tempConfigDir });
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).toBe(0);
    expect(combined).toContain('Key Exchange:');
    expect(combined).toContain('mors key-exchange offer [--json]');
    expect(combined).toContain('mors key-exchange accept --bundle <json|-> [--json]');
    expect(combined).toContain('mors key-exchange list [--json]');
  });
});
