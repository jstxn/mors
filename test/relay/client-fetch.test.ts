import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createRelayServer, type RelayServer } from '../../src/relay/server.js';
import { loadRelayConfig } from '../../src/relay/config.js';
import type { ParticipantStore, TokenVerifier } from '../../src/relay/auth-middleware.js';
import { RelayMessageStore } from '../../src/relay/message-store.js';
import { RelayClient } from '../../src/relay/client.js';
import { getTestPort } from '../helpers/test-port.js';

const ALICE = { token: 'token-alice', userId: 'acct_1001', login: 'alice' };
const BOB = { token: 'token-bob', userId: 'acct_1002', login: 'bob' };

const stubVerifier: TokenVerifier = async (token: string) => {
  const map: Record<string, { accountId: string; deviceId: string }> = {
    [ALICE.token]: { accountId: ALICE.userId, deviceId: ALICE.login },
    [BOB.token]: { accountId: BOB.userId, deviceId: BOB.login },
  };
  return map[token] ?? null;
};

describe('RelayClient fetch helpers', () => {
  let server: RelayServer | null = null;
  let port: number;
  let messageStore: RelayMessageStore;

  beforeEach(async () => {
    port = getTestPort();
    messageStore = new RelayMessageStore();
    const config = loadRelayConfig({ MORS_RELAY_PORT: String(port), MORS_RELAY_HOST: '127.0.0.1' });
    const participantStore: ParticipantStore = {
      async isParticipant(conversationId: string, accountId: string): Promise<boolean> {
        return messageStore.isParticipant(conversationId, accountId);
      },
    };

    server = createRelayServer(config, {
      logger: () => {},
      tokenVerifier: stubVerifier,
      participantStore,
      messageStore,
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('lists inbox and fetches one message using the authenticated client', async () => {
    const alice = new RelayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: ALICE.token,
      maxRetries: 0,
      initialRetryDelayMs: 1,
    });
    const bob = new RelayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: BOB.token,
      maxRetries: 0,
      initialRetryDelayMs: 1,
    });

    const sent = await alice.send({
      recipientId: BOB.userId,
      body: 'client fetch helper',
      dedupeKey: 'dup_client_fetch',
    });
    const retry = await alice.send({
      recipientId: BOB.userId,
      body: 'client fetch helper',
      dedupeKey: 'dup_client_fetch',
    });

    expect(sent.queued).toBe(false);
    expect(retry.queued).toBe(false);
    expect(retry.message?.id).toBe(sent.message?.id);

    const inbox = await bob.inbox();
    expect(inbox.count).toBe(1);
    expect(inbox.messages[0].body).toBe('client fetch helper');

    const fetched = await bob.get(inbox.messages[0].id);
    expect(fetched).toMatchObject({
      id: inbox.messages[0].id,
      sender_id: ALICE.userId,
      recipient_id: BOB.userId,
    });
  });
});
