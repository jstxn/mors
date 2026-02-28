import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

describe('distribution metadata', () => {
  it('package is not marked private', () => {
    expect(pkg.private).not.toBe(true);
  });

  it('package has bin entry pointing to dist/index.js', () => {
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin.mors).toBe('./dist/index.js');
  });

  it('package has files field including dist', () => {
    expect(pkg.files).toBeDefined();
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).toContain('dist');
  });

  it('package has prepare script that builds', () => {
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts.prepare).toBeDefined();
    expect(pkg.scripts.prepare).toContain('build');
  });

  it('package has engines constraint for node >=20', () => {
    expect(pkg.engines).toBeDefined();
    expect(pkg.engines.node).toBe('>=20');
  });

  it('package type is module', () => {
    expect(pkg.type).toBe('module');
  });
});

describe('build output', () => {
  it('dist/index.js exists after build', () => {
    // Ensure build has been run
    execSync('npm run build', { cwd: ROOT, stdio: 'pipe' });
    expect(existsSync(join(ROOT, 'dist', 'index.js'))).toBe(true);
  });

  it('dist/index.js starts with shebang', () => {
    const content = readFileSync(join(ROOT, 'dist', 'index.js'), 'utf8');
    expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('dist/index.js is executable', () => {
    const stat = statSync(join(ROOT, 'dist', 'index.js'));
    // Check owner execute bit (0o100)
    const ownerExec = (stat.mode & 0o100) !== 0;
    expect(ownerExec).toBe(true);
  });

  it('dist/cli.js exists after build', () => {
    expect(existsSync(join(ROOT, 'dist', 'cli.js'))).toBe(true);
  });
});

describe('npm pack includes correct files', () => {
  it('npm pack --dry-run lists dist files and package.json', () => {
    const output = execSync('npm pack --dry-run --json 2>/dev/null', {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const packInfo = JSON.parse(output);
    expect(Array.isArray(packInfo)).toBe(true);
    const files = packInfo[0].files.map((f: { path: string }) => f.path);

    // Must include key distribution files
    expect(files).toContain('package.json');
    expect(files.some((f: string) => f.startsWith('dist/'))).toBe(true);
    expect(files.some((f: string) => f === 'dist/index.js')).toBe(true);
    expect(files.some((f: string) => f === 'dist/cli.js')).toBe(true);

    // Must NOT include source or test files
    expect(files.some((f: string) => f.startsWith('src/'))).toBe(false);
    expect(files.some((f: string) => f.startsWith('test/'))).toBe(false);
    expect(files.some((f: string) => f === 'tsconfig.json')).toBe(false);
  });
});

describe('homebrew formula', () => {
  const formulaPath = join(ROOT, 'Formula', 'mors.rb');

  it('Formula/mors.rb exists in the repository', () => {
    expect(existsSync(formulaPath)).toBe(true);
  });

  it('formula is valid Ruby with class Mors < Formula', () => {
    const content = readFileSync(formulaPath, 'utf8');
    expect(content).toMatch(/class\s+Mors\s+<\s+Formula/);
  });

  it('formula has desc, homepage, url, and sha256 metadata', () => {
    const content = readFileSync(formulaPath, 'utf8');
    expect(content).toMatch(/desc\s+"/);
    expect(content).toMatch(/homepage\s+"/);
    expect(content).toMatch(/url\s+"/);
    expect(content).toMatch(/sha256\s+"/);
  });

  it('formula depends on node', () => {
    const content = readFileSync(formulaPath, 'utf8');
    expect(content).toMatch(/depends_on\s+"node"/);
  });

  it('formula depends on python for build (native addon)', () => {
    const content = readFileSync(formulaPath, 'utf8');
    expect(content).toMatch(/depends_on\s+"python".*=>.*:build/);
  });

  it('formula depends on sqlcipher', () => {
    const content = readFileSync(formulaPath, 'utf8');
    expect(content).toMatch(/depends_on\s+"sqlcipher"/);
  });

  it('formula has install stanza using npm install with std_npm_args', () => {
    const content = readFileSync(formulaPath, 'utf8');
    expect(content).toMatch(/def\s+install/);
    expect(content).toMatch(/system\s+"npm",\s*"install"/);
    expect(content).toMatch(/std_npm_args/);
    expect(content).toMatch(/bin\.install_symlink/);
  });

  it('formula has test stanza that invokes mors', () => {
    const content = readFileSync(formulaPath, 'utf8');
    expect(content).toMatch(/test\s+do/);
    expect(content).toMatch(/mors/);
  });

  it('formula references npm registry tarball URL', () => {
    const content = readFileSync(formulaPath, 'utf8');
    expect(content).toMatch(/registry\.npmjs\.org\/mors\/-\/mors-/);
  });

  it('formula version aligns with package.json', () => {
    const content = readFileSync(formulaPath, 'utf8');
    // The formula URL should reference the current package version
    expect(content).toContain(`mors-${pkg.version}.tgz`);
  });
});

describe('prepare script lifecycle', () => {
  it('prepare script produces runnable dist/index.js', () => {
    // Running prepare should build the project
    execSync('npm run prepare', { cwd: ROOT, stdio: 'pipe' });
    expect(existsSync(join(ROOT, 'dist', 'index.js'))).toBe(true);

    // The built entry should be runnable and output version info
    const result = execSync('node dist/index.js --version', {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, MORS_CONFIG_DIR: '/tmp/mors-install-test-noop' },
    });
    // Should output the version from package.json
    expect(result.trim()).toContain(pkg.version);
  });
});

describe('GitHub shortcut install without build deps (VAL-INSTALL-001)', () => {
  it('prepare script uses conditional tsc check', () => {
    // The prepare script must guard against missing tsc (npm bug #8440:
    // global git installs don't install devDependencies before prepare).
    // It should check for tsc availability and succeed gracefully if absent.
    expect(pkg.scripts.prepare).toMatch(/tsc/);
    expect(pkg.scripts.prepare).toMatch(/\|\|/);
    // Must not be a bare `npm run build` which would fail without tsc
    expect(pkg.scripts.prepare).not.toBe('npm run build');
  });

  it('prepare script logic succeeds when node_modules/.bin/tsc is absent', () => {
    // Directly test the shell logic the prepare script uses.
    // Simulate the scenario where tsc is not installed (no devDependencies).
    // The `test -x` check should fail, `|| true` should succeed.
    const prepareCmd = pkg.scripts.prepare as string;

    // Run the exact prepare script in a simulated environment where
    // node_modules/.bin/tsc does not exist by using a renamed path
    execSync(
      `bash -c 'TSC_ORIG="node_modules/.bin/tsc"; ` +
        `TSC_BAK="node_modules/.bin/tsc.bak"; ` +
        `mv "$TSC_ORIG" "$TSC_BAK" 2>/dev/null; ` +
        `(${prepareCmd}); EXIT=$?; ` +
        `mv "$TSC_BAK" "$TSC_ORIG" 2>/dev/null; ` +
        `exit $EXIT'`,
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    // If we got here without throwing, the prepare script succeeded
    expect(existsSync(join(ROOT, 'dist', 'index.js'))).toBe(true);
  });

  it('dist/index.js remains runnable after prepare without tsc', () => {
    // After a prepare that skips build (no tsc), the pre-built dist should still work
    const result = execSync('node dist/index.js --version', {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, MORS_CONFIG_DIR: '/tmp/mors-install-test-noop' },
    });
    expect(result.trim()).toContain(pkg.version);
  });

  it('dist/ is tracked in git (not gitignored)', () => {
    // dist/ must be committed so GitHub shortcut install has pre-built files
    const gitStatus = execSync('git ls-files dist/index.js', {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(gitStatus.trim()).toBe('dist/index.js');
  });

  it('dist/ is not listed in .gitignore', () => {
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    // dist/ must NOT appear as a gitignore pattern
    expect(gitignore).not.toMatch(/^dist\/?$/m);
  });

  it('prepare script still builds when tsc IS available', () => {
    // Normal development flow: prepare should actually compile
    execSync('npm run prepare', { cwd: ROOT, stdio: 'pipe' });
    expect(existsSync(join(ROOT, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(ROOT, 'dist', 'cli.js'))).toBe(true);

    // Verify the build output is fresh and runnable
    const result = execSync('node dist/index.js --version', {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, MORS_CONFIG_DIR: '/tmp/mors-install-test-noop' },
    });
    expect(result.trim()).toContain(pkg.version);
  });

  it('first-run flow works with pre-built dist (simulates GitHub install)', () => {
    // Simulate the user experience after `npm i -g github:jstxn/mors`
    // The dist/ is pre-built and committed, so no build step needed
    const tmpDir = execSync('mktemp -d', { encoding: 'utf8' }).trim();
    try {
      const env = { ...process.env, MORS_CONFIG_DIR: join(tmpDir, 'mors-cfg') };

      // Version check (no init required)
      const versionResult = execSync('node dist/index.js --version', {
        cwd: ROOT,
        encoding: 'utf8',
        env,
      });
      expect(versionResult.trim()).toContain(pkg.version);

      // Init
      const initResult = execSync('node dist/index.js init --json', {
        cwd: ROOT,
        encoding: 'utf8',
        env,
      });
      const initParsed = JSON.parse(initResult.trim());
      expect(initParsed.status).toBe('initialized');

      // Inbox
      const inboxResult = execSync('node dist/index.js inbox --json', {
        cwd: ROOT,
        encoding: 'utf8',
        env,
      });
      const inboxParsed = JSON.parse(inboxResult.trim());
      expect(inboxParsed.status).toBe('ok');
    } finally {
      execSync(`rm -rf "${tmpDir}"`, { stdio: 'pipe' });
    }
  });
});
