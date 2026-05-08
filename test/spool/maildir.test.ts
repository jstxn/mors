import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MaildirSpool } from '../../src/spool/maildir.js';
import { SPOOL_SCHEMA } from '../../src/spool/types.js';
import type { RelayMessageResponse } from '../../src/relay/client.js';

function makeMessage(overrides: Partial<RelayMessageResponse> = {}): RelayMessageResponse {
  const now = new Date().toISOString();
  return {
    id: 'msg_test',
    thread_id: 'thr_test',
    in_reply_to: null,
    sender_id: 'acct_alice',
    sender_device_id: 'device-alice',
    sender_login: 'alice',
    recipient_id: 'acct_bob',
    body: 'hello',
    subject: null,
    state: 'delivered',
    read_at: null,
    acked_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('MaildirSpool', () => {
  let tempRoot: string;
  let spool: MaildirSpool;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'mors-spool-maildir-'));
    spool = new MaildirSpool({ root: tempRoot, agentId: 'agent-a' });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('creates per-agent Maildir folders for all spool mailboxes', () => {
    spool.init();

    for (const mailbox of ['outbox', 'inbox', 'control', 'failed']) {
      for (const zone of ['tmp', 'new', 'cur']) {
        expect(existsSync(join(tempRoot, 'agents', 'agent-a', mailbox, zone))).toBe(true);
      }
    }
  });

  it('writes JSON through tmp and atomically publishes into new', () => {
    const entry = spool.writeJson('outbox', {
      schema: SPOOL_SCHEMA,
      kind: 'message',
      recipient_id: 'acct_bob',
      body: { format: 'text/markdown', content: 'hello' },
    });

    expect(entry.mailbox).toBe('outbox');
    expect(existsSync(entry.path)).toBe(true);
    expect(readdirSync(spool.mailboxDir('outbox', 'tmp'))).toEqual([]);
    expect(spool.listNew('outbox').map((item) => item.name)).toEqual([entry.name]);
    expect(spool.readJson(entry)).toMatchObject({
      schema: SPOOL_SCHEMA,
      kind: 'message',
      recipient_id: 'acct_bob',
    });
  });

  it('moves processed entries to cur', () => {
    const entry = spool.writeJson('control', {
      schema: SPOOL_SCHEMA,
      kind: 'ack',
      message_id: 'msg_test',
    });

    const moved = spool.moveToCur(entry);

    expect(moved.zone).toBe('cur');
    expect(existsSync(moved.path)).toBe(true);
    expect(spool.listNew('control')).toEqual([]);
  });

  it('materializes relay messages into inbox and dedupes by message ID', () => {
    const first = spool.materializeInboxMessage(makeMessage({ id: 'msg_one' }));
    const second = spool.materializeInboxMessage(makeMessage({ id: 'msg_one' }));

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(spool.listNew('inbox').map((entry) => entry.name)).toEqual(['msg_one.json']);

    const materialized = JSON.parse(
      readFileSync(join(spool.mailboxDir('inbox', 'new'), 'msg_one.json'), 'utf8')
    );
    expect(materialized).toMatchObject({
      schema: SPOOL_SCHEMA,
      kind: 'relay_message',
      id: 'msg_one',
      recipient_id: 'acct_bob',
    });
  });

  it('rejects unsafe Maildir entry names', () => {
    expect(() =>
      spool.writeJson('outbox', { schema: SPOOL_SCHEMA }, { name: '../escape.json' })
    ).toThrow(/Invalid Maildir entry name/);
    expect(() => spool.writeJson('outbox', { schema: SPOOL_SCHEMA }, { name: '..' })).toThrow(
      /Invalid Maildir entry name/
    );
  });

  it('rejects unsafe agent IDs', () => {
    expect(() => new MaildirSpool({ root: tempRoot, agentId: '../agent-b' })).toThrow(
      /Invalid spool agent ID/
    );
    expect(() => new MaildirSpool({ root: tempRoot, agentId: '..' })).toThrow(
      /Invalid spool agent ID/
    );
  });

  it('does not chmod an existing caller-owned spool root', () => {
    chmodSync(tempRoot, 0o755);

    spool.init();

    expect(statSync(tempRoot).mode & 0o777).toBe(0o755);
    expect(statSync(join(tempRoot, 'agents')).mode & 0o777).toBe(0o700);
  });
});
