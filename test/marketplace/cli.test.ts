import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateSessionToken, generateSigningKey } from '../../src/auth/native.js';
import { saveSession } from '../../src/auth/session.js';
import { runMarketplaceCommand } from '../../src/marketplace/cli.js';
import { PACKAGE_SCHEMA } from '../../src/marketplace/package.js';
import { MarketplaceStore } from '../../src/marketplace/store.js';
import { AccountStore } from '../../src/relay/account-store.js';
import { loadRelayConfig } from '../../src/relay/config.js';
import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { getTestPort } from '../helpers/test-port.js';

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('marketplace cli', () => {
  let server: RelayServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('inits, publishes, and installs a package onto the local roster', async () => {
    const signingKey = generateSigningKey();
    const token = generateSessionToken({ accountId: 'acct_1', deviceId: 'dev-1', signingKey });
    const accounts = new AccountStore();
    accounts.register({ accountId: 'acct_1', handle: 'jstxn', displayName: 'Justen' });
    server = createRelayServer(loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) }), {
      tokenVerifier: async (value) => (value === token ? { accountId: 'acct_1', deviceId: 'dev-1' } : null),
      accountStore: accounts,
      marketplaceStore: new MarketplaceStore(),
    });
    await server.start();

    const configDir = mkdtempSync(join(tmpdir(), 'mors-cfg-'));
    const pkgDir = mkdtempSync(join(tmpdir(), 'mors-pkg-'));
    const project = mkdtempSync(join(tmpdir(), 'mors-proj-'));
    dirs.push(configDir, pkgDir, project);
    saveSession(configDir, {
      accessToken: token,
      tokenType: 'bearer',
      accountId: 'acct_1',
      deviceId: 'dev-1',
      createdAt: new Date().toISOString(),
    });

    const previous = process.env['MORS_CONFIG_DIR'];
    process.env['MORS_CONFIG_DIR'] = configDir;
    try {
      await runMarketplaceCommand(['init', pkgDir, 'contracts-reviewer', '--json']);
      const manifestPath = join(pkgDir, 'agent.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest['summary'] = 'Reviews contracts and schema handoffs.';
      manifest['specialties'] = ['contracts'];
      manifest['schema'] = PACKAGE_SCHEMA;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const logs: string[] = [];
      const orig = console.log;
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ''));
      };
      try {
        await runMarketplaceCommand(['publish', pkgDir, '--json', '--relay-url', `http://127.0.0.1:${server.port}`]);
        await runMarketplaceCommand([
          'install',
          'contracts-reviewer',
          '--json',
          '--project',
          project,
          '--relay-url',
          `http://127.0.0.1:${server.port}`,
        ]);
      } finally {
        console.log = orig;
      }
      expect(logs.some((line) => line.includes('"slug":"contracts-reviewer"'))).toBe(true);
      expect(readFileSync(join(project, '.mors', 'roster.json'), 'utf8')).toContain('contracts-reviewer');
      expect(readFileSync(join(project, '.agents', 'skills', 'contracts-reviewer', 'SKILL.md'), 'utf8')).toContain(
        'name: contracts-reviewer'
      );
    } finally {
      if (previous === undefined) delete process.env['MORS_CONFIG_DIR'];
      else process.env['MORS_CONFIG_DIR'] = previous;
    }
  });

  it('rejects unsafe or mismatched response slugs before writing anything', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mors-install-boundary-'));
    const project = join(root, 'project');
    dirs.push(root);
    const manifest = { schema: PACKAGE_SCHEMA, slug: 'safe-agent', name: 'Safe agent', summary: 'Checks package boundaries.', specialties: [], version: '1.0.0' };
    for (const [slug, packageSlug] of [['../../../escaped', 'safe-agent'], ['other-agent', 'safe-agent'], ['safe-agent', 'other-agent']]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ slug, package: { manifest: { ...manifest, slug: packageSlug }, files: {} } }))));
      await expect(runMarketplaceCommand(['install', 'safe-agent', '--project', project, '--relay-url', 'https://unused.test'])).rejects.toThrow(/slug/);
      expect(existsSync(project)).toBe(false);
      expect(existsSync(join(root, 'escaped'))).toBe(false);
    }
  });

  it('removes obsolete installed skills while preserving local edits and unrelated files', async () => {
    const project = mkdtempSync(join(tmpdir(), 'mors-install-update-'));
    dirs.push(project);
    const manifest = { schema: PACKAGE_SCHEMA, slug: 'safe-agent', name: 'Safe agent', summary: 'Checks package updates.', specialties: [], version: '1.0.0' };
    const files = { 'skills/safe-agent/SKILL.md': 'v1 skill', 'skills/safe-agent/local.md': 'original', 'docs/README.md': 'v1 docs' };
    const response = (content: Record<string, string>) => new Response(JSON.stringify({ slug: 'safe-agent', name: manifest.name, summary: manifest.summary, owner: 'owner', package: { manifest, files: content } }));
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(async () => response(files)).mockImplementationOnce(async () => response({ 'docs/README.md': 'v2 docs' })));
    const args = ['install', 'safe-agent', '--project', project, '--relay-url', 'https://unused.test'];
    await runMarketplaceCommand(args);
    const skills = join(project, '.agents/skills');
    writeFileSync(join(skills, 'safe-agent/local.md'), 'local changes');
    mkdirSync(join(skills, 'unrelated'));
    writeFileSync(join(skills, 'unrelated/SKILL.md'), 'unrelated skill');
    await runMarketplaceCommand(args);
    expect(existsSync(join(skills, 'safe-agent/SKILL.md'))).toBe(false);
    expect(readFileSync(join(skills, 'safe-agent/local.md'), 'utf8')).toBe('local changes');
    expect(readFileSync(join(skills, 'unrelated/SKILL.md'), 'utf8')).toBe('unrelated skill');
    expect(existsSync(join(project, '.mors/roster/safe-agent/skills/safe-agent/SKILL.md'))).toBe(false);
  });

  it.each(['.mors', '.agents/skills/safe-agent'])('rejects a linked installation path at %s', async (path) => {
    const root = mkdtempSync(join(tmpdir(), 'mors-install-link-'));
    dirs.push(root);
    const project = join(root, 'project');
    const outside = join(root, 'outside');
    mkdirSync(join(project, '.agents/skills'), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(project, path));
    const manifest = { schema: PACKAGE_SCHEMA, slug: 'safe-agent', name: 'Safe agent', summary: 'Checks installation paths.', specialties: [], version: '1.0.0' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ slug: 'safe-agent', package: { manifest, files: { 'skills/safe-agent/SKILL.md': 'skill' } } }))));
    await expect(runMarketplaceCommand(['install', 'safe-agent', '--project', project, '--relay-url', 'https://unused.test'])).rejects.toThrow(/symlinks are not allowed/);
    expect(existsSync(join(outside, 'SKILL.md'))).toBe(false);
    expect(existsSync(join(outside, 'roster'))).toBe(false);
  });
});
