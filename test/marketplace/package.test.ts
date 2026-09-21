import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readPackageDir,
  sanitizePackagePath,
  scaffoldPackageDir,
  validateManifest,
  validateSlug,
  writePackageDir,
} from '../../src/marketplace/package.js';
import { MarketplaceStore } from '../../src/marketplace/store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('agent packages', () => {
  it('rejects path traversal and illegal roots', () => {
    expect(() => sanitizePackagePath('../secret.md')).toThrow(/illegal/);
    expect(() => sanitizePackagePath('skills/../../etc/passwd')).toThrow(/illegal/);
    expect(() => sanitizePackagePath('agent.json')).toThrow(/must live under/);
    expect(() => sanitizePackagePath('skills/run.sh')).toThrow(/not allowed/);
  });

  it('scaffolds and re-reads a package directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mors-pkg-'));
    dirs.push(dir);
    scaffoldPackageDir(dir, 'sqlcipher-reviewer');
    const packed = readPackageDir(dir);
    expect(packed.manifest.slug).toBe('sqlcipher-reviewer');
    expect(packed.files['docs/README.md']).toContain('sqlcipher');
    expect(packed.files['skills/sqlcipher-reviewer/SKILL.md']).toContain('name: sqlcipher-reviewer');
    expect(JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')).schema).toBe('mors.agent-package.v1');
  });

  it('validates slugs and summaries', () => {
    expect(() => validateSlug('A')).toThrow();
    expect(validateSlug('ok-agent')).toBe('ok-agent');
    expect(() =>
      validateManifest({
        schema: 'mors.agent-package.v1',
        slug: 'ok-agent',
        name: 'x',
        summary: 'short',
      })
    ).toThrow(/name/);
  });

  it.each(['agent.json', 'context', 'context/nested', 'context/outside.md'])('rejects a symlink at %s', (path) => {
    const root = mkdtempSync(join(tmpdir(), 'mors-pkg-link-'));
    dirs.push(root);
    const pkg = join(root, 'package');
    scaffoldPackageDir(pkg, 'linked-reviewer');
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.md'), 'private sentinel');
    writeFileSync(join(outside, 'agent.json'), readFileSync(join(pkg, 'agent.json')));
    rmSync(join(pkg, path), { force: true, recursive: true });
    symlinkSync(path.endsWith('.json') ? join(outside, 'agent.json') : path.endsWith('.md') ? join(outside, 'secret.md') : outside, join(pkg, path));
    expect(() => readPackageDir(pkg)).toThrow(/symlinks are not allowed/);
  });

  it('replaces deleted files without losing metadata or the old package on staging failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'mors-pkg-update-'));
    dirs.push(root);
    const original = scaffoldPackageDir(root, 'updated-reviewer');
    writeFileSync(join(root, 'meta.json'), 'owner metadata');
    expect(() => scaffoldPackageDir(root, 'updated-reviewer')).toThrow(/refusing to overwrite/);
    expect(() => writePackageDir(root, { ...original, files: { 'docs/a.md': 'file', 'docs/a.md/b.md': 'conflict' } })).toThrow();
    expect(readPackageDir(root)).toEqual(original);
    const next = { manifest: { ...original.manifest, version: '2.0.0' }, files: { 'docs/README.md': 'v2 only' } };
    writePackageDir(root, next);
    expect(readPackageDir(root)).toEqual(next);
    expect(existsSync(join(root, 'skills/updated-reviewer/SKILL.md'))).toBe(false);
    expect(readFileSync(join(root, 'meta.json'), 'utf8')).toBe('owner metadata');

    const store = new MarketplaceStore(join(root, 'catalog'));
    const owner = { accountId: 'owner', handle: 'owner' };
    store.publish(original, owner);
    const first = store.get(original.manifest.slug);
    store.publish(next, owner);
    expect(new MarketplaceStore(join(root, 'catalog')).get(original.manifest.slug)).toMatchObject({
      ...next, ownerAccountId: 'owner', publishedAt: first?.publishedAt,
    });
  });
});
