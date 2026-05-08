import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MaildirSpool } from '../../src/spool/maildir.js';
import { processSpoolOnce } from '../../src/spool/bridge.js';
import { SPOOL_SCHEMA, type SpoolRelayClient } from '../../src/spool/types.js';
import { RelayMessageStore } from '../../src/relay/message-store.js';
import type {
  AckResult,
  ReadResult,
  RelayMessageResponse,
  SendResult,
} from '../../src/relay/client.js';

class StoreBackedClient implements SpoolRelayClient {
  constructor(
    private readonly store: RelayMessageStore,
    private readonly accountId: string,
    private readonly login: string
  ) {}

  async send(options: {
    recipientId: string;
    body: string;
    subject?: string;
    inReplyTo?: string;
    dedupeKey?: string;
  }): Promise<SendResult> {
    const result = this.store.send(this.accountId, this.login, {
      recipientId: options.recipientId,
      body: options.body,
      subject: options.subject,
      inReplyTo: options.inReplyTo,
      dedupeKey: options.dedupeKey,
      senderDeviceId: `${this.login}-device`,
    });

    return {
      queued: false,
      dedupeKey: options.dedupeKey ?? 'dup_store-backed',
      message: result.message,
    };
  }

  async read(messageId: string): Promise<ReadResult> {
    const result = this.store.read(messageId, this.accountId);
    return { message: result.message, firstRead: result.firstRead };
  }

  async ack(messageId: string): Promise<AckResult> {
    const result = this.store.ack(messageId, this.accountId);
    return { message: result.message, firstAck: result.firstAck };
  }

  async get(messageId: string): Promise<RelayMessageResponse> {
    const message = this.store.get(messageId);
    if (!message) throw new Error(`Message not found: ${messageId}`);
    return message;
  }

  async inbox(options?: { unreadOnly?: boolean }): Promise<{
    count: number;
    messages: RelayMessageResponse[];
  }> {
    const messages = this.store.inbox(this.accountId, options);
    return { count: messages.length, messages };
  }
}

describe('spool bridge', () => {
  let tempRoot: string;
  let store: RelayMessageStore;
  let aliceSpool: MaildirSpool;
  let bobSpool: MaildirSpool;
  let aliceClient: StoreBackedClient;
  let bobClient: StoreBackedClient;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'mors-spool-bridge-'));
    store = new RelayMessageStore();
    aliceSpool = new MaildirSpool({ root: tempRoot, agentId: 'alice' });
    bobSpool = new MaildirSpool({ root: tempRoot, agentId: 'bob' });
    aliceClient = new StoreBackedClient(store, 'acct_alice', 'alice');
    bobClient = new StoreBackedClient(store, 'acct_bob', 'bob');
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('drains message commands into the relay and moves accepted files to cur', async () => {
    aliceSpool.writeJson('outbox', {
      schema: SPOOL_SCHEMA,
      kind: 'message',
      recipient_id: 'acct_bob',
      body: { format: 'text/markdown', content: 'inspect this failing test' },
      dedupe_key: 'dup_spool_1',
    });

    const result = await processSpoolOnce(aliceSpool, aliceClient);

    expect(result.sent).toBe(1);
    expect(aliceSpool.listNew('outbox')).toEqual([]);
    expect(readdirSync(aliceSpool.mailboxDir('outbox', 'cur'))).toHaveLength(1);
    expect(store.inbox('acct_bob')[0]).toMatchObject({
      sender_id: 'acct_alice',
      recipient_id: 'acct_bob',
      body: 'inspect this failing test',
    });
  });

  it('preserves spool dedupe keys across duplicate outbox files', async () => {
    for (const body of ['first copy', 'second copy']) {
      aliceSpool.writeJson('outbox', {
        schema: SPOOL_SCHEMA,
        kind: 'message',
        recipient_id: 'acct_bob',
        body,
        dedupe_key: 'dup_same_logical_message',
      });
    }

    const result = await processSpoolOnce(aliceSpool, aliceClient);

    expect(result.sent).toBe(2);
    expect(store.inbox('acct_bob')).toHaveLength(1);
    expect(store.inbox('acct_bob')[0].body).toBe('first copy');
  });

  it('rejects sender spoofing fields instead of trusting file content authority', async () => {
    aliceSpool.writeJson('outbox', {
      schema: SPOOL_SCHEMA,
      kind: 'message',
      sender_id: 'acct_eve',
      recipient_id: 'acct_bob',
      body: 'spoof attempt',
    });

    const result = await processSpoolOnce(aliceSpool, aliceClient);

    expect(result.failed).toBe(1);
    expect(store.inbox('acct_bob')).toEqual([]);
    expect(aliceSpool.listNew('failed').map((entry) => entry.name)).toHaveLength(2);
  });

  it('moves symlink entries to failed without following them', async () => {
    aliceSpool.init();
    const symlinkPath = join(aliceSpool.mailboxDir('outbox', 'new'), 'symlink.json');
    symlinkSync('/tmp/mors-spool-nonexistent-target', symlinkPath);

    const result = await processSpoolOnce(aliceSpool, aliceClient);

    expect(result.failed).toBe(1);
    expect(existsSync(symlinkPath)).toBe(false);
    expect(aliceSpool.listNew('failed').map((entry) => entry.name)).toContain(
      'outbox-symlink.json'
    );
  });

  it('processes ack commands through the recipient identity', async () => {
    const sent = store.send('acct_alice', 'alice', {
      recipientId: 'acct_bob',
      body: 'ack me',
    });
    bobSpool.writeJson('control', {
      schema: SPOOL_SCHEMA,
      kind: 'ack',
      message_id: sent.message.id,
    });

    const result = await processSpoolOnce(bobSpool, bobClient);

    expect(result.acked).toBe(1);
    expect(store.get(sent.message.id)?.state).toBe('acked');
  });

  it('materializes inbound messages and emits a host hook callback', async () => {
    const sent = store.send('acct_alice', 'alice', {
      recipientId: 'acct_bob',
      body: 'hook surface',
    });
    const hookEvents: string[] = [];

    const result = await processSpoolOnce(bobSpool, bobClient, {
      onInboxMessage: (message) => hookEvents.push(message.id),
    });

    expect(result.materialized).toBe(1);
    expect(hookEvents).toEqual([sent.message.id]);
    expect(bobSpool.listNew('inbox').map((entry) => entry.name)).toEqual([
      `${sent.message.id}.json`,
    ]);
  });

  it('runs a two-agent tempdir lifecycle through send, reply, materialize, and ack', async () => {
    aliceSpool.writeJson('outbox', {
      schema: SPOOL_SCHEMA,
      kind: 'message',
      recipient_id: 'acct_bob',
      body: { format: 'text/markdown', content: 'root task' },
      dedupe_key: 'dup_root_task',
    });
    await processSpoolOnce(aliceSpool, aliceClient);

    const root = store.inbox('acct_bob')[0];
    await processSpoolOnce(bobSpool, bobClient);
    expect(bobSpool.listNew('inbox').map((entry) => entry.name)).toEqual([`${root.id}.json`]);

    bobSpool.writeJson('outbox', {
      schema: SPOOL_SCHEMA,
      kind: 'message',
      recipient_id: 'acct_alice',
      body: { format: 'text/markdown', content: 'reply result' },
      in_reply_to: root.id,
      dedupe_key: 'dup_reply_result',
    });
    await processSpoolOnce(bobSpool, bobClient);
    await processSpoolOnce(aliceSpool, aliceClient);

    const aliceInbox = store.inbox('acct_alice');
    expect(aliceInbox).toHaveLength(1);
    expect(aliceInbox[0].thread_id).toBe(root.thread_id);
    expect(aliceInbox[0].in_reply_to).toBe(root.id);
    expect(aliceSpool.listNew('inbox').map((entry) => entry.name)).toEqual([
      `${aliceInbox[0].id}.json`,
    ]);

    bobSpool.writeJson('control', {
      schema: SPOOL_SCHEMA,
      kind: 'ack',
      message_id: root.id,
    });
    await processSpoolOnce(bobSpool, bobClient);

    expect(store.get(root.id)?.state).toBe('acked');
  });
});
