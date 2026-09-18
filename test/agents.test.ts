import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import { getDbKeyPath, getDbPath } from '../src/init.js';
import {
  ackAgentMessage,
  agentInbox,
  agentOutbox,
  agentThread,
  getAgent,
  getAgentConfigDir,
  heartbeatAgent,
  listAgents,
  openAgentStore,
  pollAgentMessages,
  readAgentMessage,
  registerAgent,
  replyAgentMessage,
  sendAgentMessage,
  stopAgent,
  waitForAgentMessages,
} from '../src/agents.js';

describe('local agent communication', () => {
  let configDir: string;
  let db: BetterSqlite3.Database;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), 'mors-agents-'));
    db = await openAgentStore(configDir);
  });

  afterEach(() => {
    db?.close();
    rmSync(configDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function team() {
    return ['alice', 'bob', 'carol'].map((name) =>
      registerAgent(db, { runtime: 'other', sessionId: name, name })
    );
  }

  it('uses a shared agent store separate from the ordinary profile', () => {
    vi.stubEnv('MORS_AGENT_DIR', '');
    vi.stubEnv('MORS_CONFIG_DIR', '/unrelated-profile');
    expect(getAgentConfigDir()).toBe(join(homedir(), '.local/share/mors/agents'));
    vi.stubEnv('MORS_AGENT_DIR', configDir);
    expect(getAgentConfigDir()).toBe(configDir);
  });

  it('refuses incomplete hubs without replacing keys or deleting stored messages', async () => {
    const [alice, bob] = team();
    sendAgentMessage(db, alice.id, { to: bob.id, body: 'Preserve this message' });
    db.close();
    const dbPath = getDbPath(configDir);
    const keyPath = getDbKeyPath(configDir);
    const database = readFileSync(dbPath);
    const key = readFileSync(keyPath);
    unlinkSync(join(configDir, '.initialized'));
    await expect(openAgentStore(configDir)).rejects.toThrow();
    expect(readFileSync(dbPath)).toEqual(database);
    expect(readFileSync(keyPath)).toEqual(key);
    expect(existsSync(join(configDir, '.initialized'))).toBe(false);
  });

  it('refuses a missing database in an initialized hub instead of creating an empty one', async () => {
    db.close();
    const dbPath = getDbPath(configDir);
    const keyPath = getDbKeyPath(configDir);
    const key = readFileSync(keyPath);
    unlinkSync(dbPath);
    await expect(openAgentStore(configDir)).rejects.toThrow();
    expect(existsSync(dbPath)).toBe(false);
    expect(readFileSync(keyPath)).toEqual(key);
  });

  it('resumes a stable session identity, rejects name collisions, and filters presence', () => {
    const alice = registerAgent(db, {
      runtime: 'codex', sessionId: 'session-a', name: 'alice', project: '/work/mors', role: 'reviewer',
    });
    expect(getAgent(db, 'alice')).toMatchObject({ id: alice.id, role: 'reviewer' });
    expect(() => registerAgent(db, { runtime: 'claude', sessionId: 'session-b', name: 'alice' })).toThrow();
    const otherRuntime = registerAgent(db, { runtime: 'claude', sessionId: 'session-a', project: '/work/other' });
    expect(otherRuntime.id).not.toBe(alice.id);
    expect(listAgents(db, { project: '/work/mors' }).map((agent) => agent.id)).toEqual([alice.id]);

    stopAgent(db, alice.id);
    expect(getAgent(db, alice.id).stopped_at).not.toBeNull();
    expect(listAgents(db, {}).map((agent) => agent.id)).not.toContain(alice.id);
    expect(listAgents(db, { all: true }).map((agent) => agent.id)).toContain(alice.id);
    const resumed = registerAgent(db, { runtime: 'codex', sessionId: 'session-a' });
    expect(resumed).toMatchObject({ id: alice.id, name: 'alice', role: 'reviewer', stopped_at: null });

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    expect(listAgents(db, { maxAgeMs: 1000 })).toEqual([]);
    heartbeatAgent(db, alice.id);
    expect(listAgents(db, { maxAgeMs: 1000 }).map((agent) => agent.id)).toEqual([alice.id]);
  });

  it('isolates inboxes and outboxes, reverses recipients on replies, and preserves the thread', () => {
    const [alice, bob, carol] = team();
    const question = sendAgentMessage(db, alice.id, { to: bob.name, body: 'Which file?', subject: 'Review', traceId: 'trc_review' });
    expect(question).toMatchObject({ sender: alice.id, recipient: bob.id });
    expect(agentInbox(db, alice.id, {})).toEqual([]);
    expect(agentInbox(db, carol.id, {})).toEqual([]);
    expect(agentInbox(db, bob.id, {})[0]).toMatchObject({ id: question.id, body: 'Which file?', read_at: null });
    expect(agentOutbox(db, alice.id).map((message) => message.id)).toEqual([question.id]);

    const answer = replyAgentMessage(db, bob.id, question.id, { body: 'src/agents.ts' });
    expect(answer).toMatchObject({ sender: bob.id, recipient: alice.id, thread_id: question.thread_id, in_reply_to: question.id });
    expect(agentInbox(db, alice.id, {})[0].id).toBe(answer.id);
    expect(agentThread(db, alice.id, question.thread_id).map((message) => message.id)).toEqual([question.id, answer.id]);
    expect(agentThread(db, bob.id, question.thread_id).map((message) => message.id)).toEqual([question.id, answer.id]);
  });

  it('returns one-line activity from stored subjects without leaking bodies', () => {
    const [alice, bob] = team();
    const body = 'private question body';
    const sent = sendAgentMessage(db, alice.id, {
      to: bob.id, body, subject: '  Which file?\nPlease check the parser.  ', dedupeKey: 'activity-send',
    });
    expect(sent.activity).toBe('alice → bob: Which file? Please check the parser.');
    expect(sent.activity).not.toContain(body);
    expect(agentInbox(db, bob.id)[0]).toMatchObject({ body, subject: '  Which file?\nPlease check the parser.  ' });

    const replay = sendAgentMessage(db, alice.id, {
      to: bob.id, body, subject: '  Which file?\nPlease check the parser.  ', dedupeKey: 'activity-send',
    });
    expect(replay).toMatchObject({ id: sent.id, dedupe_replay: true, activity: sent.activity });
    expect(agentInbox(db, bob.id)).toHaveLength(1);

    const replyBody = 'private answer body';
    const reply = replyAgentMessage(db, bob.id, sent.id, {
      body: replyBody, subject: '\nAnswer\twith the parser file.\n', dedupeKey: 'activity-reply',
    });
    expect(reply.activity).toBe('bob → alice: Answer with the parser file.');
    expect(reply.activity).not.toContain(replyBody);
    expect(agentInbox(db, alice.id)[0]).toMatchObject({ body: replyBody, subject: '\nAnswer\twith the parser file.\n' });

    const fallback = sendAgentMessage(db, alice.id, { to: bob.id, body: 'fallback body', subject: ' \n\t' });
    expect(fallback.activity).toBe('alice → bob: sent a message');
    const clipped = sendAgentMessage(db, alice.id, { to: bob.id, body: 'clipped body', subject: 'x'.repeat(161) });
    expect(clipped.activity).toBe(`alice → bob: ${'x'.repeat(159)}…`);
  });

  it('keeps notification, read, and acknowledgement separate and durable across handles', async () => {
    const [alice, bob] = team();
    const sent = sendAgentMessage(db, alice.id, { to: bob.id, body: 'Please review' });
    const secondHandle = await openAgentStore(configDir);
    try {
      expect(pollAgentMessages(db, bob.id).map((message) => message.id)).toEqual([sent.id]);
      expect(pollAgentMessages(secondHandle, bob.id)).toEqual([]);
      expect(agentInbox(secondHandle, bob.id, { unreadOnly: true })[0]).toMatchObject({ id: sent.id, read_at: null, state: 'delivered' });
      const read = readAgentMessage(secondHandle, bob.id, sent.id);
      expect(read.read_at).not.toBeNull();
      expect(read.state).toBe('delivered');
      expect(agentInbox(db, bob.id, { unreadOnly: true })).toEqual([]);
      expect(readAgentMessage(db, bob.id, sent.id).read_at).toBe(read.read_at);
      expect(ackAgentMessage(db, bob.id, sent.id).state).toBe('acked');
      expect(ackAgentMessage(secondHandle, bob.id, sent.id).state).toBe('acked');
    } finally {
      secondHandle.close();
    }
  });

  it('retries an unread notification after the retry window, with read and ack suppressing retries', () => {
    vi.useFakeTimers();
    const [alice, bob] = team();
    const sent = sendAgentMessage(db, alice.id, { to: bob.id, body: 'retry me' });

    expect(pollAgentMessages(db, bob.id).map((message) => message.id)).toEqual([sent.id]);
    vi.advanceTimersByTime(59_999);
    expect(pollAgentMessages(db, bob.id)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(pollAgentMessages(db, bob.id).map((message) => message.id)).toEqual([sent.id]);

    readAgentMessage(db, bob.id, sent.id);
    vi.advanceTimersByTime(60_000);
    expect(pollAgentMessages(db, bob.id)).toEqual([]);

    const acked = sendAgentMessage(db, alice.id, { to: bob.id, body: 'ack me' });
    expect(pollAgentMessages(db, bob.id).map((message) => message.id)).toEqual([acked.id]);
    ackAgentMessage(db, bob.id, acked.id);
    vi.advanceTimersByTime(60_000);
    expect(pollAgentMessages(db, bob.id)).toEqual([]);

    const old = sendAgentMessage(db, alice.id, { to: bob.id, body: 'old notification' });
    expect(pollAgentMessages(db, bob.id).map((message) => message.id)).toEqual([old.id]);
    vi.advanceTimersByTime(60_000);
    const fresh = sendAgentMessage(db, alice.id, { to: bob.id, body: 'fresh notification' });
    expect(pollAgentMessages(db, bob.id, 1).map((message) => message.id)).toEqual([fresh.id]);
  });

  it('atomically acknowledges a reply parent without reading it first', () => {
    const [alice, bob] = team();
    const question = sendAgentMessage(db, alice.id, { to: bob.id, body: 'answer this' });
    const reply = replyAgentMessage(db, bob.id, question.id, { body: 'done', ack: true, dedupeKey: 'answer' });

    expect(reply).toMatchObject({ sender: bob.id, recipient: alice.id, parent_acknowledged: true });
    expect(agentInbox(db, bob.id)[0]).toMatchObject({ state: 'acked', read_at: null });

    const second = sendAgentMessage(db, alice.id, { to: bob.id, body: 'keep delivered' });
    expect(() => replyAgentMessage(db, bob.id, second.id, { body: '', ack: true })).toThrow();
    expect(() => replyAgentMessage(db, bob.id, second.id, { body: 'done', ack: true, dedupeKey: 'answer' })).toThrow();
    expect(() => replyAgentMessage(db, alice.id, second.id, { body: 'followup', ack: true })).toThrow();
    expect(agentInbox(db, bob.id).find(message => message.id === second.id)).toMatchObject({ state: 'delivered', read_at: null });
    expect(agentOutbox(db, alice.id).find(message => message.id === second.id)?.reply_count).toBe(0);
  });

  it('filters pending inbox messages and counts direct peer replies in the outbox', () => {
    const [alice, bob] = team();
    const question = sendAgentMessage(db, alice.id, { to: bob.id, body: 'question' });
    const answer = replyAgentMessage(db, bob.id, question.id, { body: 'answer' });
    expect(agentOutbox(db, alice.id)[0]).toMatchObject({ id: question.id, reply_count: 1 });
    expect(agentOutbox(db, bob.id)[0]).toMatchObject({ id: answer.id, reply_count: 0 });

    ackAgentMessage(db, bob.id, question.id);
    expect(agentInbox(db, bob.id, { unreadOnly: true }).map((message) => message.id)).toContain(question.id);
    expect(agentInbox(db, bob.id, { pendingOnly: true }).map((message) => message.id)).not.toContain(question.id);
  });

  it('rejects thread IDs where message IDs are required and waits without consuming notifications', async () => {
    const [alice, bob] = team();
    expect(() => readAgentMessage(db, bob.id, 'thr_wrong')).toThrow(/msg_/);
    expect(() => ackAgentMessage(db, bob.id, 'thr_wrong')).toThrow(/msg_/);
    expect(() => replyAgentMessage(db, bob.id, 'thr_wrong', { body: 'reply' })).toThrow(/msg_/);

    expect(await waitForAgentMessages(db, bob.id, { timeoutMs: 0 })).toEqual([]);
    for (const timeoutMs of [-1, 0.5, 30_001, NaN]) {
      await expect(waitForAgentMessages(db, bob.id, { timeoutMs })).rejects.toThrow('timeout');
    }
    await expect(waitForAgentMessages(db, bob.id, { limit: 0 })).rejects.toThrow('limit');
    const sent = sendAgentMessage(db, alice.id, { to: bob.id, body: 'wait' });
    const waited = await waitForAgentMessages(db, bob.id, { timeoutMs: 0 });
    expect(waited.map((message) => message.id)).toEqual([sent.id]);
    expect(pollAgentMessages(db, bob.id).map((message) => message.id)).toEqual([sent.id]);
    readAgentMessage(db, bob.id, sent.id);
    expect(await waitForAgentMessages(db, bob.id, { timeoutMs: 0 })).toHaveLength(1);
    ackAgentMessage(db, bob.id, sent.id);
    expect(await waitForAgentMessages(db, bob.id, { timeoutMs: 0 })).toEqual([]);
  });

  it('upgrades legacy notification claims without losing messages or creating duplicate columns', async () => {
    const [alice, bob] = team();
    const sent = sendAgentMessage(db, alice.id, { to: bob.id, body: 'survives migration' });
    db.exec(`DROP TABLE agent_notifications;
      CREATE TABLE agent_notifications (agent_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(agent_id, message_id));`);
    db.prepare('INSERT INTO agent_notifications VALUES (?, ?)').run(bob.id, sent.id);
    db.close();
    db = await openAgentStore(configDir);
    const second = await openAgentStore(configDir);
    try {
      expect(pollAgentMessages(db, bob.id).map(message => message.id)).toEqual([sent.id]);
      expect(pollAgentMessages(second, bob.id)).toEqual([]);
      expect(agentInbox(second, bob.id)[0]).toMatchObject({ id: sent.id, body: 'survives migration', read_at: null });
    } finally {
      second.close();
    }
  });

  it('scopes retries to the sender and rejects conflicting idempotency payloads', () => {
    const [alice, bob, carol] = team();
    const payload = { to: bob.id, body: 'Check this', dedupeKey: 'dup_shared' };
    const first = sendAgentMessage(db, alice.id, payload);
    expect(sendAgentMessage(db, alice.id, payload)).toMatchObject({ id: first.id, dedupe_replay: true });
    const otherSender = sendAgentMessage(db, carol.id, payload);
    expect(otherSender.id).not.toBe(first.id);
    expect(agentInbox(db, bob.id, {})).toHaveLength(2);
    expect(() => sendAgentMessage(db, alice.id, { ...payload, to: carol.id })).toThrow();
    expect(() => sendAgentMessage(db, alice.id, { ...payload, body: 'Changed payload' })).toThrow();
    const reply = replyAgentMessage(db, bob.id, first.id, { body: 'Done', dedupeKey: 'dup_reply' });
    expect(replyAgentMessage(db, bob.id, first.id, { body: 'Done', dedupeKey: 'dup_reply' }).id).toBe(reply.id);
    expect(() => replyAgentMessage(db, bob.id, otherSender.id, { body: 'Done', dedupeKey: 'dup_reply' })).toThrow();
    const anotherQuestion = sendAgentMessage(db, alice.id, { to: bob.id, body: 'Another question' });
    expect(() => replyAgentMessage(db, bob.id, anotherQuestion.id, { body: 'Done', dedupeKey: 'dup_reply' })).toThrow();
  });

  it('rejects message operations by another recipient without changing read or ack state', () => {
    const [alice, bob, carol] = team();
    const sent = sendAgentMessage(db, alice.id, { to: bob.id, body: 'For Bob' });
    expect(readAgentMessage(db, alice.id, sent.id)).toMatchObject({ body: 'For Bob', read_at: null });
    expect(() => ackAgentMessage(db, alice.id, sent.id)).toThrow();
    expect(() => readAgentMessage(db, carol.id, sent.id)).toThrow();
    expect(() => ackAgentMessage(db, carol.id, sent.id)).toThrow();
    expect(() => replyAgentMessage(db, carol.id, sent.id, { body: 'Impersonation' })).toThrow();
    expect(agentThread(db, carol.id, sent.thread_id)).toEqual([]);
    expect(agentInbox(db, bob.id, {})[0]).toMatchObject({ state: 'delivered', read_at: null });
    expect(replyAgentMessage(db, alice.id, sent.id, { body: 'Followup' })).toMatchObject({ sender: alice.id, recipient: bob.id, thread_id: sent.thread_id });
    expect(agentOutbox(db, carol.id)).toEqual([]);
    expect(() => sendAgentMessage(db, alice.id, { to: 'missing-agent', body: 'No delivery' })).toThrow();
    expect(() => sendAgentMessage(db, alice.id, { to: bob.id, body: '' })).toThrow();
  });
});
