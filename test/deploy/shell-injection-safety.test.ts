/**
 * Shell-injection safety tests for the deploy module.
 *
 * Verifies that deploy preflight and execution use argv-based
 * child-process APIs (execFileSync/spawnSync) instead of shell-string
 * execSync calls. Env-derived values (app name, region, flyctl path)
 * must be treated as plain arguments, not shell fragments.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runDeployPreflight } from '../../src/deploy.js';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..', '..');

describe('deploy shell-injection safety: static analysis', () => {
  it('src/deploy.ts does not import execSync', () => {
    const source = readFileSync(join(ROOT, 'src', 'deploy.ts'), 'utf8');
    // Must not import execSync from child_process
    expect(source).not.toMatch(
      /import\s+\{[^}]*\bexecSync\b[^}]*\}\s+from\s+['"]node:child_process['"]/
    );
  });

  it('src/deploy.ts uses only execFileSync or spawnSync for subprocess calls', () => {
    const source = readFileSync(join(ROOT, 'src', 'deploy.ts'), 'utf8');
    // Must not contain raw execSync calls
    expect(source).not.toMatch(/\bexecSync\s*\(/);
    // Must use execFileSync or spawnSync
    expect(source).toMatch(/\b(execFileSync|spawnSync)\s*\(/);
  });

  it('src/cli.ts deploy execution uses execFileSync or spawnSync, not execSync', () => {
    const source = readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8');
    // Find the deploy section — look for the flyctl deploy invocation
    // It should NOT use template literal interpolation into execSync
    expect(source).not.toMatch(/execSync(Import)?\s*\(\s*`\$\{[^}]*flyctlPath/);
    expect(source).not.toMatch(/execSync(Import)?\s*\(\s*`\$\{[^}]*appName/);
  });
});

describe('deploy shell-injection safety: env-derived values as plain arguments', () => {
  it('MORS_DEPLOY_FLYCTL_PATH with shell metacharacters does not cause injection', () => {
    // A malicious flyctl path with shell metacharacters should be treated
    // as a literal file path, not a shell command fragment
    const maliciousPath = '/tmp/fake; echo INJECTED; #';
    const result = runDeployPreflight({
      FLY_APP_NAME: 'test-app',
      FLY_ORG: 'test-org',
      FLY_PRIMARY_REGION: 'iad',
      MORS_DEPLOY_FLYCTL_PATH: maliciousPath,
    });

    // The preflight should either succeed (treating the path literally
    // and failing auth) or fail — but NOT execute the injected command.
    // The key assertion is that the flyctlPath in config (if present)
    // is the raw string, not a shell-expanded result.
    if (result.config) {
      expect(result.config.flyctlPath).toBe(maliciousPath);
    }
    // Whether ready or not, the test passes if we get here without
    // shell injection causing an error different from the expected flow.
  });

  it('MORS_DEPLOY_FLYCTL_PATH with backticks does not execute subshell', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mors-inject-'));
    const canaryFile = join(tmpDir, 'canary');

    // Attempt injection via backtick subshell
    const maliciousPath = `/tmp/fake\`touch ${canaryFile}\``;
    runDeployPreflight({
      FLY_APP_NAME: 'test-app',
      FLY_ORG: 'test-org',
      FLY_PRIMARY_REGION: 'iad',
      MORS_DEPLOY_FLYCTL_PATH: maliciousPath,
    });

    // The canary file must NOT have been created
    expect(existsSync(canaryFile)).toBe(false);
  });

  it('MORS_DEPLOY_FLYCTL_PATH with $() does not execute command substitution', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mors-inject-'));
    const canaryFile = join(tmpDir, 'canary');

    // Attempt injection via $() command substitution
    const maliciousPath = `/tmp/fake$(touch ${canaryFile})`;
    runDeployPreflight({
      FLY_APP_NAME: 'test-app',
      FLY_ORG: 'test-org',
      FLY_PRIMARY_REGION: 'iad',
      MORS_DEPLOY_FLYCTL_PATH: maliciousPath,
    });

    expect(existsSync(canaryFile)).toBe(false);
  });

  it('flyctl auth check with malicious path does not execute injected commands', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mors-inject-'));
    const canaryFile = join(tmpDir, 'canary');

    // Create a flyctl override that includes shell injection attempt
    // The auth check runs `flyctlPath auth whoami` — if using shell string,
    // this would execute the injection
    const maliciousPath = `touch ${canaryFile}; echo`;
    runDeployPreflight({
      FLY_APP_NAME: 'test-app',
      FLY_ORG: 'test-org',
      FLY_PRIMARY_REGION: 'iad',
      MORS_DEPLOY_FLYCTL_PATH: maliciousPath,
      FLY_ACCESS_TOKEN: '', // force auth check
    });

    expect(existsSync(canaryFile)).toBe(false);
  });
});

describe('deploy shell-injection safety: behavior and redaction preserved', () => {
  it('preflight still resolves valid flyctl override path', () => {
    const fakeFlyctl = join(tmpdir(), 'safe-flyctl-test');
    writeFileSync(fakeFlyctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const result = runDeployPreflight({
      FLY_APP_NAME: 'test-app',
      FLY_ORG: 'test-org',
      FLY_PRIMARY_REGION: 'iad',
      MORS_DEPLOY_FLYCTL_PATH: fakeFlyctl,
      FLY_ACCESS_TOKEN: 'test-token',
    });

    expect(result.ready).toBe(true);
    expect(result.config?.flyctlPath).toBe(fakeFlyctl);
  });

  it('preflight detects missing flyctl when not in PATH and no override', () => {
    const result = runDeployPreflight({
      FLY_APP_NAME: 'test-app',
      FLY_ORG: 'test-org',
      FLY_PRIMARY_REGION: 'iad',
      PATH: '/nonexistent',
    });

    expect(result.ready).toBe(false);
    expect(result.issues.some((i) => i.category === 'flyctl')).toBe(true);
  });

  it('preflight detects auth failure with fake flyctl that exits non-zero', () => {
    const fakeFlyctl = join(tmpdir(), 'noauth-flyctl-test');
    writeFileSync(fakeFlyctl, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const result = runDeployPreflight({
      FLY_APP_NAME: 'test-app',
      FLY_ORG: 'test-org',
      FLY_PRIMARY_REGION: 'iad',
      MORS_DEPLOY_FLYCTL_PATH: fakeFlyctl,
      FLY_ACCESS_TOKEN: '',
    });

    expect(result.ready).toBe(false);
    expect(result.issues.some((i) => i.category === 'auth')).toBe(true);
  });
});
