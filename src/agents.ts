/** Session addressing over the existing local message store, for trusted local agents. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import { initCommand, getDbPath, getDbKeyPath } from './init.js';
import { loadKey } from './key-management.js';
import { openEncryptedDb } from './store.js';
import {
  sendMessage, replyMessage, listInbox, readMessage, ackMessage, listThread,
  type InboxEntry,
} from './message.js';

type Database = BetterSqlite3.Database;
export type AgentRuntime = 'codex' | 'claude' | 'other';
export interface Agent {
  id: string;
  name: string;
  runtime: AgentRuntime;
  session_id: string;
  project: string;
  role: string;
  last_seen: string;
  stopped_at: string | null;
}
export interface RegisterAgentOptions {
  runtime: AgentRuntime;
  sessionId: string;
  name?: string;
  role?: string;
  project?: string;
}
export interface AgentMessageOptions {
  body: string;
  subject?: string;
  dedupeKey?: string;
  traceId?: string;
}

type ActivityMessage = Pick<InboxEntry, 'sender' | 'recipient' | 'subject'>;

export function formatAgentActivity(senderName: string, recipientName: string, subject?: string | null): string {
  const normalized = subject?.replace(/\s+/g, ' ').trim() || 'sent a message';
  const summary = normalized.length > 160 ? `${normalized.slice(0, 159)}…` : normalized;
  return `${senderName} → ${recipientName}: ${summary}`;
}

export function agentActivity(db: Database, message: ActivityMessage): string {
  return formatAgentActivity(getAgent(db, message.sender).name, getAgent(db, message.recipient).name, message.subject);
}

export function getAgentConfigDir(): string {
  return resolve(process.env['MORS_AGENT_DIR'] || join(homedir(), '.local', 'share', 'mors', 'agents'));
}

export async function openAgentStore(configDir = getAgentConfigDir()): Promise<Database> {
  // Serialize first-use key creation; normal commands only open the existing database.
  const lock = join(configDir, '.agents-bootstrap.lock');
  const deadline = Date.now() + 10_000;
  while (!existsSync(join(configDir, '.initialized'))) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    let fd: number;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // ponytail: crashed first-use initialization needs manual lock recovery; use
      // OS advisory locking if unattended bootstrap recovery becomes necessary.
      if (Date.now() >= deadline) throw new Error(`Agent store initialization is busy. If no initializer is running, remove ${lock} and retry. Existing hub files will be preserved.`, { cause: error });
      await sleep(50);
      continue;
    }
    try {
      if (!existsSync(join(configDir, '.initialized'))) {
        const artifacts = ['mors.db', 'mors.db-wal', 'mors.db-shm', 'db.key', 'identity.key', 'identity.json', 'e2ee', '.init.lock'];
        if (artifacts.some(name => existsSync(join(configDir, name)))) {
          throw new Error('Agent hub contains existing or incomplete state without its initialization marker. Restore the hub from backup or select a new MORS_AGENT_DIR; existing files were preserved.');
        }
        await initCommand({ configDir });
      }
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
  if (![getDbPath(configDir), getDbKeyPath(configDir)].every(path => existsSync(path))) {
    throw new Error('Agent hub database or encryption key is missing. Restore the hub from backup; refusing to recreate existing state.');
  }
  const db = openEncryptedDb({ dbPath: getDbPath(configDir), key: loadKey(getDbKeyPath(configDir)) });
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
        runtime TEXT NOT NULL, session_id TEXT NOT NULL,
        project TEXT NOT NULL, role TEXT NOT NULL,
        last_seen TEXT NOT NULL, stopped_at TEXT,
        UNIQUE(runtime, session_id)
      );
      CREATE TABLE IF NOT EXISTS agent_notifications (
        agent_id TEXT NOT NULL, message_id TEXT NOT NULL,
        notified_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(agent_id, message_id)
      );
    `);
    const hasNotificationTime = () => (db.pragma('table_info(agent_notifications)') as Array<{ name: string }>)
      .some(column => column.name === 'notified_at');
    if (!hasNotificationTime()) {
      // Recheck under the write lock: another worker may migrate the shared hub.
      db.transaction(() => {
        if (!hasNotificationTime()) db.exec('ALTER TABLE agent_notifications ADD COLUMN notified_at INTEGER NOT NULL DEFAULT 0');
      }).immediate();
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function requiredText(value: string, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new Error(`${label} must be non-empty text of at most ${max} characters.`);
  }
  return value;
}

export function registerAgent(db: Database, options: RegisterAgentOptions): Agent {
  if (!['codex', 'claude', 'other'].includes(options.runtime)) throw new Error('Unknown agent runtime.');
  requiredText(options.sessionId, 'Session ID', 512);
  if (options.name !== undefined && (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(options.name) || options.name.startsWith('agt_'))) {
    throw new Error('Agent name must be 1–64 letters, digits, dots, dashes or underscores, and cannot start with agt_.');
  }
  if (options.role !== undefined) requiredText(options.role, 'Role', 500);
  if (options.project !== undefined) requiredText(options.project, 'Project', 4096);
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM agents WHERE runtime = ? AND session_id = ?')
      .get(options.runtime, options.sessionId) as Agent | undefined;
    const id = existing?.id ?? `agt_${randomUUID()}`;
    const name = options.name ?? existing?.name ?? `${options.runtime}-${createHash('sha256').update(options.sessionId).digest('hex').slice(0, 12)}`;
    const named = db.prepare('SELECT id FROM agents WHERE name = ?').get(name) as { id: string } | undefined;
    if (named && named.id !== id) throw new Error(`Agent name "${name}" belongs to another session. Choose a different name.`);
    db.prepare(`INSERT INTO agents (id, name, runtime, session_id, project, role, last_seen, stopped_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, project=excluded.project,
        role=excluded.role, last_seen=excluded.last_seen, stopped_at=NULL`)
      .run(id, name, options.runtime, options.sessionId,
        options.project ? resolve(options.project) : existing?.project ?? process.cwd(),
        options.role ?? existing?.role ?? '', new Date().toISOString());
    return getAgent(db, id);
  }).immediate();
}

export function getAgent(db: Database, reference: string): Agent {
  requiredText(reference, 'Agent ID or name', 512);
  const agent = db.prepare('SELECT * FROM agents WHERE id = ? OR name = ?').get(reference, reference) as Agent | undefined;
  if (!agent) throw new Error(`Unknown agent "${reference}". Use "mors agent list --all --json".`);
  return agent;
}

export function findSessionAgent(db: Database, runtime: string, sessionId: string): Agent {
  const agent = db.prepare('SELECT * FROM agents WHERE runtime = ? AND session_id = ?').get(runtime, sessionId) as Agent | undefined;
  if (!agent) throw new Error('This session is not registered. Run "mors agent register" or use the --agent address supplied by the session hook.');
  return agent;
}

export function listAgents(db: Database, options: { all?: boolean; project?: string; maxAgeMs?: number } = {}): Array<Agent & { status: string }> {
  const maxAge = options.maxAgeMs ?? 15 * 60_000;
  if (!Number.isFinite(maxAge) || maxAge <= 0) throw new Error('Agent maximum age must be positive.');
  const cutoff = new Date(Date.now() - maxAge).toISOString();
  const agents = db.prepare('SELECT * FROM agents ORDER BY name').all() as Agent[];
  return agents.map(agent => ({ ...agent, status: agent.stopped_at ? 'offline' : agent.last_seen < cutoff ? 'stale' : 'active' }))
    .filter(agent => (options.all || agent.status === 'active') && (!options.project || agent.project === resolve(options.project)));
}

export function heartbeatAgent(db: Database, id: string): void {
  const agent = getAgent(db, id);
  db.prepare('UPDATE agents SET last_seen = ?, stopped_at = NULL WHERE id = ?').run(new Date().toISOString(), agent.id);
}

export function stopAgent(db: Database, id: string): void {
  const agent = getAgent(db, id);
  db.prepare('UPDATE agents SET stopped_at = ? WHERE id = ?').run(new Date().toISOString(), agent.id);
}

function scopedDedupe(agentId: string, key?: string): string | undefined {
  if (key === undefined) return undefined;
  requiredText(key, 'Dedupe key', 512);
  return `dup_${createHash('sha256').update(JSON.stringify([agentId, key])).digest('hex')}`;
}

function checkReplay(db: Database, key: string | undefined, recipient: string, body: string, subject?: string, traceId?: string): void {
  if (!key) return;
  const old = db.prepare('SELECT recipient, body, subject, trace_id FROM messages WHERE dedupe_key = ?').get(key) as InboxEntry | undefined;
  if (old && (old.recipient !== recipient || old.body !== body || old.subject !== (subject ?? null) || old.trace_id !== (traceId ?? null))) {
    throw new Error('Dedupe key was already used for a different message.');
  }
}

function storedMessageActivity(db: Database, messageId: string): string {
  const message = db.prepare('SELECT sender, recipient, subject FROM messages WHERE id = ?').get(messageId) as ActivityMessage | undefined;
  if (!message) throw new Error(`Message ${messageId} was not found after saving.`);
  return agentActivity(db, message);
}

export function sendAgentMessage(db: Database, agentId: string, options: AgentMessageOptions & { to: string }) {
  const sender = getAgent(db, agentId).id;
  const recipient = getAgent(db, options.to).id;
  const dedupeKey = scopedDedupe(sender, options.dedupeKey);
  const sent = db.transaction(() => {
    checkReplay(db, dedupeKey, recipient, options.body, options.subject, options.traceId);
    return sendMessage(db, { ...options, sender, recipient, dedupeKey });
  }).immediate();
  return { ...sent, activity: storedMessageActivity(db, sent.id) };
}

function visibleMessage(db: Database, agentId: string, messageId: string, recipientOnly = false): InboxEntry {
  if (messageId.startsWith('thr_')) {
    throw new Error('Expected a message ID (msg_), not a thread ID (thr_). Use the original message\'s id for read, reply and ack; thread_id is only for the thread command.');
  }
  const actor = getAgent(db, agentId).id;
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as InboxEntry | undefined;
  if (!message || (message.recipient !== actor && (recipientOnly || message.sender !== actor))) {
    throw new Error('Message not found in this agent mailbox.');
  }
  return message;
}

export function replyAgentMessage(db: Database, agentId: string, parentId: string, options: AgentMessageOptions & { ack?: boolean }) {
  const sender = getAgent(db, agentId).id;
  const parent = visibleMessage(db, sender, parentId, options.ack);
  const recipient = parent.sender === sender ? parent.recipient : parent.sender;
  const dedupeKey = scopedDedupe(sender, options.dedupeKey);
  const traceId = options.traceId ?? parent.trace_id ?? undefined;
  const sent = db.transaction(() => {
    checkReplay(db, dedupeKey, recipient, options.body, options.subject, traceId);
    const reply = replyMessage(db, { ...options, parentMessageId: parentId, sender, recipient, dedupeKey, traceId });
    if (options.ack) ackMessage(db, parentId);
    return { ...reply, parent_acknowledged: options.ack === true };
  }).immediate();
  return { ...sent, activity: storedMessageActivity(db, sent.id) };
}

export function agentInbox(db: Database, agentId: string, options: { unreadOnly?: boolean; pendingOnly?: boolean } = {}): InboxEntry[] {
  return listInbox(db, { ...options, recipient: getAgent(db, agentId).id })
    .filter(message => !options.pendingOnly || message.state !== 'acked');
}

export function agentOutbox(db: Database, agentId: string): Array<InboxEntry & { reply_count: number }> {
  return db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM messages r
    WHERE r.thread_id = m.thread_id AND r.in_reply_to = m.id
      AND r.sender = m.recipient AND r.recipient = m.sender) AS reply_count
    FROM messages m WHERE m.sender = ? ORDER BY m.created_at DESC, m.id`)
    .all(getAgent(db, agentId).id) as Array<InboxEntry & { reply_count: number }>;
}

export function readAgentMessage(db: Database, agentId: string, messageId: string) {
  const message = visibleMessage(db, agentId, messageId);
  return message.recipient === getAgent(db, agentId).id ? readMessage(db, messageId) : message;
}

export function ackAgentMessage(db: Database, agentId: string, messageId: string) {
  visibleMessage(db, agentId, messageId, true);
  return ackMessage(db, messageId);
}

export function agentThread(db: Database, agentId: string, threadId: string): InboxEntry[] {
  const actor = getAgent(db, agentId).id;
  return listThread(db, threadId).filter(message => message.sender === actor || message.recipient === actor);
}

export function pollAgentMessages(db: Database, agentId: string, limit = 10): InboxEntry[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Poll limit must be between 1 and 100.');
  const actor = getAgent(db, agentId).id;
  return db.transaction(() => {
    const now = Date.now();
    const messages = db.prepare(`SELECT m.* FROM messages m
      LEFT JOIN agent_notifications n ON n.agent_id = ? AND n.message_id = m.id
      WHERE m.recipient = ? AND m.read_at IS NULL AND m.state != 'acked'
        AND (n.message_id IS NULL OR n.notified_at <= ?)
      ORDER BY n.message_id IS NOT NULL, n.notified_at, m.created_at, m.id LIMIT ?`)
      .all(actor, actor, now - 60_000, limit) as InboxEntry[];
    const claim = db.prepare(`INSERT INTO agent_notifications (agent_id, message_id, notified_at) VALUES (?, ?, ?)
      ON CONFLICT(agent_id, message_id) DO UPDATE SET notified_at = excluded.notified_at`);
    for (const message of messages) claim.run(actor, message.id, now);
    heartbeatAgent(db, actor);
    return messages;
  }).immediate();
}

/** Wait for work, independent of notification claims; returning a message never handles it. */
export async function waitForAgentMessages(db: Database, agentId: string, options: { timeoutMs?: number; limit?: number } = {}): Promise<InboxEntry[]> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const limit = options.limit ?? 10;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) {
    throw new Error('Wait timeout must be an integer between 0 and 30000 milliseconds.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Wait limit must be between 1 and 100.');
  const actor = getAgent(db, agentId).id;
  const deadline = performance.now() + timeoutMs;
  const pending = db.prepare(`SELECT * FROM messages WHERE recipient = ? AND state != 'acked'
    ORDER BY created_at, id LIMIT ?`);
  for (;;) {
    const messages = pending.all(actor, limit) as InboxEntry[];
    if (messages.length > 0) return messages;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return [];
    await sleep(Math.min(250, remaining));
  }
}
