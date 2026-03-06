import { afterEach, describe, expect, it } from 'vitest';
import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { loadRelayConfig } from '../../src/relay/config.js';
import { AccountStore } from '../../src/relay/account-store.js';
import { ContactStore } from '../../src/relay/contact-store.js';
import { createProductionServerOptions } from '../../src/relay/index.js';
import { generateSigningKey } from '../../src/auth/native.js';
import type { TokenVerifier } from '../../src/relay/auth-middleware.js';
import { getTestPort } from '../helpers/test-port.js';

async function relayFetch(
  port: number,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
  } = {}
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

function createHostedVerifier(): TokenVerifier {
  return async (token: string) => {
    const parts = token.split(':');
    if (parts.length !== 3 || parts[0] !== 'hosted') return null;
    return {
      accountId: parts[1],
      deviceId: parts[2],
    };
  };
}

describe('relay hosted signup and contacts', () => {
  let server: RelayServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('creates an account via POST /auth/signup and returns a usable session token', async () => {
    let port = getTestPort();
    const config = loadRelayConfig({ MORS_RELAY_PORT: String(port), MORS_RELAY_HOST: '127.0.0.1' });

    server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: createHostedVerifier(),
      sessionTokenIssuer: (accountId, deviceId) => `hosted:${accountId}:${deviceId}`,
      accountStore: new AccountStore(),
      contactStore: new ContactStore(),
    });
    await server.start();
    port = server.port;

    const signup = await relayFetch(port, '/auth/signup', {
      method: 'POST',
      body: {
        handle: 'Alice_Agent',
        display_name: 'Alice Agent',
        device_id: 'device-alice',
      },
    });

    expect(signup.status).toBe(201);
    const payload = signup.body as Record<string, unknown>;
    expect(payload['token_type']).toBe('bearer');
    expect(payload['handle']).toBe('alice_agent');
    expect(payload['display_name']).toBe('Alice Agent');
    expect(payload['device_id']).toBe('device-alice');
    expect(typeof payload['access_token']).toBe('string');

    const me = await relayFetch(port, '/accounts/me', {
      token: payload['access_token'] as string,
    });

    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      account_id: payload['account_id'],
      handle: 'alice_agent',
      display_name: 'Alice Agent',
    });
  });

  it('rejects duplicate hosted handles and missing device ids', async () => {
    let port = getTestPort();
    const config = loadRelayConfig({ MORS_RELAY_PORT: String(port), MORS_RELAY_HOST: '127.0.0.1' });

    server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: createHostedVerifier(),
      sessionTokenIssuer: (accountId, deviceId) => `hosted:${accountId}:${deviceId}`,
      accountStore: new AccountStore(),
      contactStore: new ContactStore(),
    });
    await server.start();
    port = server.port;

    const first = await relayFetch(port, '/auth/signup', {
      method: 'POST',
      body: {
        handle: 'shared-handle',
        display_name: 'First User',
        device_id: 'device-1',
      },
    });
    expect(first.status).toBe(201);

    const duplicate = await relayFetch(port, '/auth/signup', {
      method: 'POST',
      body: {
        handle: 'Shared-Handle',
        display_name: 'Second User',
        device_id: 'device-2',
      },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({ error: 'duplicate_handle' });

    const missingDevice = await relayFetch(port, '/auth/signup', {
      method: 'POST',
      body: {
        handle: 'third-user',
        display_name: 'Third User',
      },
    });
    expect(missingDevice.status).toBe(400);
    expect(missingDevice.body).toMatchObject({ error: 'validation_error' });
  });

  it('adds contacts by handle and lists enriched contacts', async () => {
    let port = getTestPort();
    const accountStore = new AccountStore();
    const contactStore = new ContactStore();
    const config = loadRelayConfig({ MORS_RELAY_PORT: String(port), MORS_RELAY_HOST: '127.0.0.1' });

    server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: createHostedVerifier(),
      sessionTokenIssuer: (accountId, deviceId) => `hosted:${accountId}:${deviceId}`,
      accountStore,
      contactStore,
    });
    await server.start();
    port = server.port;

    const aliceSignup = await relayFetch(port, '/auth/signup', {
      method: 'POST',
      body: {
        handle: 'alice',
        display_name: 'Alice',
        device_id: 'device-a',
      },
    });
    const bobSignup = await relayFetch(port, '/auth/signup', {
      method: 'POST',
      body: {
        handle: 'bob',
        display_name: 'Bob',
        device_id: 'device-b',
      },
    });

    const aliceToken = (aliceSignup.body as Record<string, unknown>)['access_token'] as string;
    const aliceAccountId = (aliceSignup.body as Record<string, unknown>)['account_id'] as string;
    const bobAccountId = (bobSignup.body as Record<string, unknown>)['account_id'] as string;

    const add = await relayFetch(port, '/contacts/add', {
      method: 'POST',
      token: aliceToken,
      body: { handle: 'Bob' },
    });

    expect(add.status).toBe(200);
    expect(add.body).toMatchObject({
      owner_account_id: aliceAccountId,
      contact: {
        account_id: bobAccountId,
        handle: 'bob',
        display_name: 'Bob',
        status: 'approved',
      },
    });

    const contacts = await relayFetch(port, '/contacts', {
      token: aliceToken,
    });

    expect(contacts.status).toBe(200);
    expect(contacts.body).toMatchObject({
      owner_account_id: aliceAccountId,
      count: 1,
      contacts: [
        {
          account_id: bobAccountId,
          handle: 'bob',
          display_name: 'Bob',
          status: 'approved',
        },
      ],
    });

    const unknown = await relayFetch(port, '/contacts/add', {
      method: 'POST',
      token: aliceToken,
      body: { handle: 'charlie' },
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: 'not_found' });

    const self = await relayFetch(port, '/contacts/add', {
      method: 'POST',
      token: aliceToken,
      body: { handle: 'alice' },
    });
    expect(self.status).toBe(409);
    expect(self.body).toMatchObject({ error: 'self_contact' });
  });

  it('keeps GET /contacts/pending backward compatible alongside the new hosted routes', async () => {
    let port = getTestPort();
    const accountStore = new AccountStore();
    const contactStore = new ContactStore();
    const config = loadRelayConfig({ MORS_RELAY_PORT: String(port), MORS_RELAY_HOST: '127.0.0.1' });

    server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: createHostedVerifier(),
      sessionTokenIssuer: (accountId, deviceId) => `hosted:${accountId}:${deviceId}`,
      accountStore,
      contactStore,
    });
    await server.start();
    port = server.port;

    const aliceSignup = await relayFetch(port, '/auth/signup', {
      method: 'POST',
      body: {
        handle: 'alice-pending',
        display_name: 'Alice Pending',
        device_id: 'device-a',
      },
    });
    const bobSignup = await relayFetch(port, '/auth/signup', {
      method: 'POST',
      body: {
        handle: 'bob-pending',
        display_name: 'Bob Pending',
        device_id: 'device-b',
      },
    });

    const aliceToken = (aliceSignup.body as Record<string, unknown>)['access_token'] as string;
    const aliceAccountId = (aliceSignup.body as Record<string, unknown>)['account_id'] as string;
    const bobAccountId = (bobSignup.body as Record<string, unknown>)['account_id'] as string;

    contactStore.recordContact(aliceAccountId, bobAccountId);

    const pending = await relayFetch(port, '/contacts/pending', {
      token: aliceToken,
    });

    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({
      owner_account_id: aliceAccountId,
      pending: [bobAccountId],
      count: 1,
    });
    expect((pending.body as Record<string, unknown>)['pending_contacts']).toMatchObject([
      {
        account_id: bobAccountId,
        handle: 'bob-pending',
        display_name: 'Bob Pending',
        status: 'pending',
        autonomy_allowed: false,
      },
    ]);
  });

  it('production wiring issues relay-valid signup tokens', async () => {
    const originalSigningKey = process.env['MORS_RELAY_SIGNING_KEY'];
    process.env['MORS_RELAY_SIGNING_KEY'] = generateSigningKey();

    try {
      let port = getTestPort();
      const config = loadRelayConfig({
        MORS_RELAY_PORT: String(port),
        MORS_RELAY_HOST: '127.0.0.1',
      });

      server = createRelayServer(config, {
        ...createProductionServerOptions(),
        logger: () => {},
      });
      await server.start();
      port = server.port;

      const signup = await relayFetch(port, '/auth/signup', {
        method: 'POST',
        body: {
          handle: 'prod-signup-user',
          display_name: 'Prod Signup User',
          device_id: 'prod-device',
        },
      });

      expect(signup.status).toBe(201);
      const accessToken = (signup.body as Record<string, unknown>)['access_token'] as string;

      const me = await relayFetch(port, '/accounts/me', {
        token: accessToken,
      });

      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({
        handle: 'prod-signup-user',
        display_name: 'Prod Signup User',
      });
    } finally {
      if (originalSigningKey === undefined) {
        delete process.env['MORS_RELAY_SIGNING_KEY'];
      } else {
        process.env['MORS_RELAY_SIGNING_KEY'] = originalSigningKey;
      }
    }
  });
});
