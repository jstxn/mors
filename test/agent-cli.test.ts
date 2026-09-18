import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { openAgentStore, type Agent } from '../src/agents.js';
import type { InboxEntry, SendResult } from '../src/message.js';

const exec = promisify(execFile);
const cli = join(import.meta.dirname, '..', 'dist', 'index.js');

describe('agent CLI across concurrent processes', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'mors-agent-cli-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  async function run<T>(...args: string[]): Promise<T> {
    const { stdout } = await exec(process.execPath, [cli, 'agent', ...args, '--json'], {
      env: { ...process.env, MORS_AGENT_DIR: configDir, MORS_CONFIG_DIR: join(configDir, 'unused-profile') },
      timeout: 30_000,
    });
    return JSON.parse(stdout) as T;
  }

  it('initializes ten agents concurrently, exchanges threaded messages, and polls each message once', async () => {
    const agents = (await Promise.all(Array.from({ length: 10 }, (_, i) =>
      run<{ agent: Agent }>('register', '--runtime', i % 2 === 0 ? 'codex' : 'claude', '--session', `session-${i}`, '--name', `worker-${i}`, '--role', 'integration-test')
    ))).map((result) => result.agent);
    expect(new Set(agents.map((agent) => agent.id)).size).toBe(10);
    expect((await run<{ agents: Agent[] }>('list')).agents).toHaveLength(10);

    const sent = await Promise.all(agents.map((agent, i) =>
      run<SendResult>('send', '--agent', agent.id, '--to', agents[(i + 1) % agents.length].name, '--body', `Question from ${i}`, '--dedupe-key', 'dup_ring')
    ));
    expect(new Set(sent.map((message) => message.id)).size).toBe(10);

    await Promise.all(agents.map(async (agent, i) => {
      const incoming = sent[(i + agents.length - 1) % agents.length];
      const polls = await Promise.all([
        run<{ messages: InboxEntry[] }>('poll', '--agent', agent.id),
        run<{ messages: InboxEntry[] }>('poll', '--agent', agent.id),
      ]);
      expect(polls.flatMap((result) => result.messages).map((message) => message.id)).toEqual([incoming.id]);
      const inbox = await run<{ messages: InboxEntry[] }>('inbox', '--agent', agent.name, '--unread');
      expect(inbox.messages).toHaveLength(1);
      expect(inbox.messages[0]).toMatchObject({ id: incoming.id, recipient: agent.id, read_at: null });
    }));

    await Promise.all(agents.map(async (agent, i) => {
      const incoming = sent[(i + agents.length - 1) % agents.length];
      const read = await run<{ message: InboxEntry }>('read', incoming.id, '--agent', agent.id);
      expect(read.message.read_at).not.toBeNull();
      expect(read.message.state).toBe('delivered');
      const reply = await run<SendResult>('reply', incoming.id, '--agent', agent.id, '--body', `Answer from ${i}`);
      expect(reply).toMatchObject({ sender: agent.id, recipient: incoming.sender, thread_id: incoming.thread_id });
      const ack = await run<{ state: string }>('ack', incoming.id, '--agent', agent.id);
      expect(ack.state).toBe('acked');
    }));

    await Promise.all(agents.map(async (agent, i) => {
      const outbox = await run<{ messages: InboxEntry[] }>('outbox', '--agent', agent.id);
      expect(outbox.messages).toHaveLength(2);
      expect(outbox.messages.every((message) => message.sender === agent.id)).toBe(true);
      const thread = await run<{ messages: InboxEntry[] }>('thread', sent[i].thread_id, '--agent', agent.id);
      expect(thread.messages).toHaveLength(2);
      expect(thread.messages[0].id).toBe(sent[i].id);
      expect(thread.messages[1].in_reply_to).toBe(sent[i].id);
      expect(await run<{ status: string }>('leave', '--agent', agent.id)).toMatchObject({ status: 'offline' });
      const resumed = await run<{ agent: Agent }>('register', '--runtime', agent.runtime, '--session', agent.session_id);
      expect(resumed.agent).toMatchObject({ id: agent.id, name: agent.name });
    }));
  }, 120_000);

  it('waits for a new message across processes and reports bounded timeout', async () => {
    const alice = (await run<{ agent: Agent }>('register', '--runtime', 'other', '--session', 'waiter-a', '--name', 'waiter-a')).agent;
    const bob = (await run<{ agent: Agent }>('register', '--runtime', 'other', '--session', 'waiter-b', '--name', 'waiter-b')).agent;

    const waiting = run<{ status: string; count: number; messages: InboxEntry[] }>(
      'wait', '--agent', bob.id, '--timeout-ms', '3000', '--limit', '1'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await run<SendResult>('send', '--agent', alice.id, '--to', bob.id, '--body', 'arrived while waiting');
    await expect(waiting).resolves.toMatchObject({ status: 'messages', count: 1 });
    const first = (await waiting).messages[0];
    await expect(run('wait', '--agent', bob.id, '--timeout-ms', '0'))
      .resolves.toMatchObject({ status: 'messages', count: 1 });
    await expect(run('reply', first.thread_id, '--agent', bob.id, '--body', 'wrong ID', '--ack'))
      .rejects.toMatchObject({ stdout: expect.stringContaining('msg_') });
    await expect(run('reply', first.id, '--agent', bob.id, '--body', 'received', '--ack'))
      .resolves.toMatchObject({ status: 'sent', parent_acknowledged: true });
    await expect(run<{ status: string; count: number }>('wait', '--agent', bob.id, '--timeout-ms', '0'))
      .resolves.toMatchObject({ status: 'timeout', count: 0 });
    await expect(run('inbox', '--agent', bob.id, '--pending')).resolves.toMatchObject({ count: 0 });
    await expect(run('wait', '--agent', bob.id, '--timeout-ms', '30001'))
      .rejects.toMatchObject({ stdout: expect.stringContaining('30000') });
  }, 20_000);

  it('carries explicit summaries separately from exact structured message bodies', async () => {
    const alice = (await run<{ agent: Agent }>('register', '--runtime', 'other', '--session', 'summary-a', '--name', 'alice')).agent;
    const bob = (await run<{ agent: Agent }>('register', '--runtime', 'other', '--session', 'summary-b', '--name', 'bob')).agent;
    const body = JSON.stringify({ type: 'object', required: ['event_id'], properties: { event_id: { type: 'string' } } });
    const sent = await run<SendResult & { activity: string }>('send', '--agent', alice.id, '--to', bob.id,
      '--summary', 'Sent JSON Schema:\n event_id is required', '--body', body);
    expect(sent.activity).toBe('alice → bob: Sent JSON Schema: event_id is required');
    const incoming = await run<{ message: InboxEntry }>('read', sent.id, '--agent', bob.id);
    expect(incoming.message.body).toBe(body);
    expect(incoming.message.subject).toBe('Sent JSON Schema:\n event_id is required');
    await expect(run('reply', sent.id, '--agent', bob.id, '--summary', 'Confirmed event_id validation', '--body', 'The validator rejects a missing event_id.', '--ack'))
      .resolves.toMatchObject({ activity: 'bob → alice: Confirmed event_id validation', parent_acknowledged: true });
    await expect(run('send', '--agent', alice.id, '--to', bob.id, '--summary', 'Sent schema', '--subject', 'Schema', '--body', body))
      .rejects.toMatchObject({ stdout: expect.stringContaining('Use only --summary or --subject') });
    expect((await run<{ messages: InboxEntry[] }>('inbox', '--agent', bob.id)).messages).toHaveLength(1);
  }, 20_000);

  it('migrates legacy claims and reserves retries once across concurrent processes', async () => {
    const alice = (await run<{ agent: Agent }>('register', '--runtime', 'other', '--session', 'legacy-a')).agent;
    const bob = (await run<{ agent: Agent }>('register', '--runtime', 'other', '--session', 'legacy-b')).agent;
    const sent = await run<SendResult>('send', '--agent', alice.id, '--to', bob.id, '--body', 'legacy notification');
    const legacy = await openAgentStore(configDir);
    try {
      legacy.exec(`DROP TABLE agent_notifications;
        CREATE TABLE agent_notifications (agent_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(agent_id, message_id));`);
      legacy.prepare('INSERT INTO agent_notifications VALUES (?, ?)').run(bob.id, sent.id);
    } finally {
      legacy.close();
    }
    const race = () => Promise.all(Array.from({ length: 4 }, () =>
      run<{ messages: InboxEntry[] }>('poll', '--agent', bob.id)
    ));
    expect((await race()).flatMap(result => result.messages.map(message => message.id))).toEqual([sent.id]);
    const migrated = await openAgentStore(configDir);
    try {
      migrated.prepare('UPDATE agent_notifications SET notified_at = ?').run(Date.now() - 60_000);
    } finally {
      migrated.close();
    }
    expect((await race()).flatMap(result => result.messages.map(message => message.id))).toEqual([sent.id]);
  }, 20_000);
});
