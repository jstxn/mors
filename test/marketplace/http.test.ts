import { afterEach, describe, expect, it } from 'vitest';
import { generateSessionToken, generateSigningKey } from '../../src/auth/native.js';
import { AccountStore } from '../../src/relay/account-store.js';
import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { loadRelayConfig } from '../../src/relay/config.js';
import { MarketplaceStore } from '../../src/marketplace/store.js';
import { PACKAGE_SCHEMA } from '../../src/marketplace/package.js';
import { getTestPort } from '../helpers/test-port.js';

describe('marketplace http', () => {
  let server: RelayServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('lists, publishes, and installs a public package', async () => {
    const signingKey = generateSigningKey();
    const store = new MarketplaceStore();
    const accounts = new AccountStore();
    accounts.register({ accountId: 'acct_1', handle: 'jstxn', displayName: 'Justen' });
    const token = generateSessionToken({ accountId: 'acct_1', deviceId: 'device-1', signingKey });
    const stolen = generateSessionToken({ accountId: 'acct_2', deviceId: 'device-2', signingKey });
    server = createRelayServer(loadRelayConfig({ MORS_RELAY_PORT: String(getTestPort()) }), {
      tokenVerifier: async (value) => {
        if (value === token) return { accountId: 'acct_1', deviceId: 'device-1' };
        if (value === stolen) return { accountId: 'acct_2', deviceId: 'device-2' };
        return null;
      },
      accountStore: accounts,
      marketplaceStore: store,
    });
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;

    const empty = await fetch(`${base}/marketplace.json`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ agents: [] });

    const home = await fetch(`${base}/marketplace`);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('Agent packages');

    const created = await fetch(`${base}/marketplace/packages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: {
          schema: PACKAGE_SCHEMA,
          slug: 'sqlcipher-reviewer',
          name: 'SQLCipher reviewer',
          summary: 'Reviews encrypted-store changes and key handling.',
          specialties: ['sqlcipher', 'review'],
          version: '1.0.0',
        },
        files: {
          'skills/sqlcipher-reviewer/SKILL.md': '---\nname: sqlcipher-reviewer\n---\n# Review SQLCipher diffs\n',
          'docs/README.md': 'Use for store encryption reviews.\n',
        },
      }),
    });
    expect(created.status).toBe(201);

    const listed = await fetch(`${base}/marketplace.json`);
    const catalog = (await listed.json()) as { agents: Array<{ slug: string }> };
    expect(catalog.agents.map((agent) => agent.slug)).toEqual(['sqlcipher-reviewer']);

    const page = await fetch(`${base}/marketplace/sqlcipher-reviewer`);
    const html = await page.text();
    expect(html).toContain('SQLCipher reviewer');
    expect(html).toContain('mors marketplace install sqlcipher-reviewer');

    const conflict = await fetch(`${base}/marketplace/packages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${stolen}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: {
          schema: PACKAGE_SCHEMA,
          slug: 'sqlcipher-reviewer',
          name: 'Hijack',
          summary: 'Should not overwrite another owner slug.',
          specialties: [],
          version: '1.0.0',
        },
        files: {},
      }),
    });
    expect(conflict.status).toBe(409);
  });
});
