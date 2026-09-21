import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'mors-cli-errors-'));
const cli = join(import.meta.dirname, '..', 'dist', 'index.js');
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const invalidArgs = [
  ['login', '--invite-token'],
  ['login', '--unknown-option'],
  ['status', '--peer-device'],
  ['status', '--unknown-option'],
  ['spool', 'status', '--root'],
  ['spool', 'status', '--unknown-option'],
  ['sandbox', 'status', '--root'],
  ['sandbox', 'status', '--unknown-option'],
  ['logout', '--unknown-option'],
  ['onboard', '--handle'],
  ['deploy', '--unknown-option'],
  ['key-exchange', 'accept', '--bundle'],
];

describe('CLI argument errors', () => {
  it.each(invalidArgs.map(args => [args]))('returns JSON for %j', (args) => {
    const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, MORS_CONFIG_DIR: directory, MORS_AGENT_DIR: join(directory, 'hub') },
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'error', error: 'invalid_arguments', message: expect.stringContaining(args[args.length - 1]),
    });
  });

  it('prints a concise error without JSON', () => {
    const result = spawnSync(process.execPath, [cli, 'login', '--invite-token'], {
      encoding: 'utf8', env: { ...process.env, MORS_CONFIG_DIR: directory }, timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^Error: .*--invite-token/);
    expect(result.stderr).not.toContain('\n    at ');
  });
});
