/**
 * Integration tests for cross-flow reliability scenarios.
 *
 * These tests verify end-to-end behavior across multiple CLI operations,
 * process restarts (simulated via DB close/reopen), concurrency, and
 * fault-injection paths.
 *
 * Covers:
 * - VAL-CROSS-001: First-run end-to-end messaging lifecycle
 * - VAL-CROSS-002: Read/ack separation persists across restart
 * - VAL-CROSS-003: Partial ack in a thread remains consistent
 * - VAL-CROSS-004: Retry/reconnect converges to one logical outcome
 * - VAL-CROSS-005: Dedupe guarantee survives process restart
 * - VAL-CROSS-006: Encryption fail-closed behavior after real usage
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { initCommand, getDbPath, getDbKeyPath } from '../src/init.js';
import { loadKey } from '../src/key-management.js';
import { openEncryptedDb } from '../src/store.js';
import {
  sendMessage,
  listInbox,
  readMessage,
  ackMessage,
  replyMessage,
  listThread,
} from '../src/message.js';
import { startWatch } from '../src/watch.js';
import type { WatchEvent } from '../src/watch.js';
import { StoreEncryptionError, KeyError } from '../src/errors.js';
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

let testDir: string;
let configDir: string;

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'mors-integration-test-'));
  configDir = join(testDir, '.mors');
  await initCommand({ configDir });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** Open the encrypted DB for a test config dir. */
function openDb(): BetterSqlite3.Database {
  const dbPath = getDbPath(configDir);
  const key = loadKey(getDbKeyPath(configDir));
  return openEncryptedDb({ dbPath, key });
}

/**
 * Simulate a process restart by closing and reopening the database.
 * This is the integration test equivalent of the CLI process exiting
 * and being restarted — a fresh database handle is created from disk.
 */
function simulateRestart(db: BetterSqlite3.Database): BetterSqlite3.Database {
  db.close();
  return openDb();
}

/**
 * Collect watch events for a given duration/count using a promise.
 * Returns the events collected during the window.
 */
function collectWatchEvents(
  db: BetterSqlite3.Database,
  opts: { maxEvents?: number; timeoutMs?: number; pollIntervalMs?: number } = {}
): {
  events: WatchEvent[];
  stop: () => void;
  done: Promise<void>;
} {
  const { maxEvents = 100, timeoutMs = 3000, pollIntervalMs = 50 } = opts;
  const events: WatchEvent[] = [];
  let stopFn: (() => void) | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const promise = new Promise<void>((resolve) => {
    const handle = startWatch(db, {
      pollIntervalMs,
      onEvent: (event) => {
        events.push(event);
        if (events.length >= maxEvents) {
          cleanup();
        }
      },
      onShutdown: () => {
        resolve();
      },
    });

    stopFn = handle.stop;

    timeoutHandle = setTimeout(() => {
      cleanup();
    }, timeoutMs);

    function cleanup(): void {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      handle.stop();
    }
  });

  return {
    events,
    stop: () => stopFn?.(),
    done: promise,
  };
}

// ---------------------------------------------------------------------------
// VAL-CROSS-001: First-run end-to-end messaging lifecycle
// ---------------------------------------------------------------------------

describe('VAL-CROSS-001: first-run end-to-end messaging lifecycle', () => {
  it('init → send → inbox → read → ack produces coherent state transitions', () => {
    // init already done in beforeEach
    const db = openDb();
    try {
      // 1. Send a message
      const sent = sendMessage(db, {
        sender: 'agent-a',
        recipient: 'agent-b',
        body: '# Hello\n\nThis is the first message.',
        subject: 'Greetings',
      });
      expect(sent.id).toMatch(/^msg_/);
      expect(sent.thread_id).toMatch(/^thr_/);
      expect(sent.state).toBe('delivered');
      expect(sent.dedupe_replay).toBe(false);

      // 2. Inbox shows the message as unread
      const inbox1 = listInbox(db, { recipient: 'agent-b' });
      expect(inbox1.length).toBe(1);
      expect(inbox1[0].id).toBe(sent.id);
      expect(inbox1[0].read_at).toBeNull();
      expect(inbox1[0].state).toBe('delivered');

      // 3. Read the message
      const readResult = readMessage(db, sent.id);
      expect(readResult.read_at).not.toBeNull();
      expect(readResult.state).toBe('delivered'); // read ≠ ack

      // 4. Inbox reflects read_at but state still delivered
      const inbox2 = listInbox(db, { recipient: 'agent-b' });
      expect(inbox2[0].read_at).not.toBeNull();
      expect(inbox2[0].state).toBe('delivered');

      // 5. Unread filter no longer shows this message
      const unread = listInbox(db, { recipient: 'agent-b', unreadOnly: true });
      expect(unread.length).toBe(0);

      // 6. Ack the message
      const ackResult = ackMessage(db, sent.id);
      expect(ackResult.state).toBe('acked');

      // 7. Inbox shows acked state
      const inbox3 = listInbox(db, { recipient: 'agent-b' });
      expect(inbox3[0].state).toBe('acked');
      expect(inbox3[0].read_at).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('init → send → watch detects new message event', async () => {
    const db = openDb();
    try {
      // Start watch first
      const { events, done, stop } = collectWatchEvents(db, {
        maxEvents: 1,
        timeoutMs: 2000,
        pollIntervalMs: 30,
      });

      // Small delay for watch to establish baseline
      await new Promise((r) => setTimeout(r, 50));

      // Send a message
      sendMessage(db, {
        sender: 'agent-a',
        recipient: 'agent-b',
        body: 'Watch test message',
      });

      await done;

      expect(events.length).toBeGreaterThanOrEqual(1);
      const createEvent = events.find((e) => e.event_type === 'message_created');
      expect(createEvent).toBeDefined();
      if (!createEvent) throw new Error('unreachable');
      expect(createEvent.sender).toBe('agent-a');
      expect(createEvent.recipient).toBe('agent-b');
      expect(createEvent.state).toBe('delivered');

      stop();
    } finally {
      db.close();
    }
  });

  it('full lifecycle with watch captures send, reply, and ack events', async () => {
    const db = openDb();
    try {
      const { events, done, stop } = collectWatchEvents(db, {
        maxEvents: 3,
        timeoutMs: 3000,
        pollIntervalMs: 30,
      });

      await new Promise((r) => setTimeout(r, 50));

      // Send
      const sent = sendMessage(db, {
        sender: 'agent-a',
        recipient: 'agent-b',
        body: 'Full lifecycle watch',
      });

      // Reply
      replyMessage(db, {
        parentMessageId: sent.id,
        sender: 'agent-b',
        recipient: 'agent-a',
        body: 'Reply to lifecycle',
      });

      // Ack the original
      ackMessage(db, sent.id);

      await done;

      const eventTypes = events.map((e) => e.event_type);
      expect(eventTypes).toContain('message_created');
      expect(eventTypes).toContain('reply_created');
      expect(eventTypes).toContain('message_acked');

      stop();
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-002: Read/ack separation persists across restart
// ---------------------------------------------------------------------------

describe('VAL-CROSS-002: read/ack separation persists across restart', () => {
  it('read-but-not-acked message stays delivered after restart', () => {
    let db = openDb();
    try {
      // Send and read (but don't ack)
      const sent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Read but not acked',
      });
      readMessage(db, sent.id);

      // Verify state before restart
      const inbox1 = listInbox(db, { recipient: 'bob' });
      expect(inbox1[0].state).toBe('delivered');
      expect(inbox1[0].read_at).not.toBeNull();
      const readAtBefore = inbox1[0].read_at;

      // Simulate restart
      db = simulateRestart(db);

      // After restart: state should still be delivered (not acked)
      const inbox2 = listInbox(db, { recipient: 'bob' });
      expect(inbox2[0].state).toBe('delivered');
      expect(inbox2[0].read_at).toBe(readAtBefore);

      // Unread filter should not include this message
      const unread = listInbox(db, { recipient: 'bob', unreadOnly: true });
      expect(unread.length).toBe(0);
    } finally {
      db.close();
    }
  });

  it('acked state persists across restart', () => {
    let db = openDb();
    try {
      const sent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Will be acked',
      });
      readMessage(db, sent.id);
      ackMessage(db, sent.id);

      // Verify acked before restart
      const inbox1 = listInbox(db, { recipient: 'bob' });
      expect(inbox1[0].state).toBe('acked');

      // Simulate restart
      db = simulateRestart(db);

      // After restart: acked state persists
      const inbox2 = listInbox(db, { recipient: 'bob' });
      expect(inbox2[0].state).toBe('acked');
    } finally {
      db.close();
    }
  });

  it('explicit ack after restart works for read-only message', () => {
    let db = openDb();
    try {
      const sent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Ack after restart',
      });
      readMessage(db, sent.id);

      // Restart before acking
      db = simulateRestart(db);

      // Now ack after restart
      const ackResult = ackMessage(db, sent.id);
      expect(ackResult.state).toBe('acked');

      // Verify persisted
      db = simulateRestart(db);
      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox[0].state).toBe('acked');
    } finally {
      db.close();
    }
  });

  it('multiple messages with mixed read/ack states persist across restart', () => {
    let db = openDb();
    try {
      // Send 3 messages
      const msg1 = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Message 1' });
      const msg2 = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Message 2' });
      const msg3 = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Message 3' });

      // msg1: read only, msg2: read + acked, msg3: unread
      readMessage(db, msg1.id);
      readMessage(db, msg2.id);
      ackMessage(db, msg2.id);

      // Restart
      db = simulateRestart(db);

      // Verify each message's state
      const readMsg1 = readMessage(db, msg1.id);
      expect(readMsg1.state).toBe('delivered');
      expect(readMsg1.read_at).not.toBeNull();

      const readMsg2 = readMessage(db, msg2.id);
      expect(readMsg2.state).toBe('acked');

      const readMsg3 = readMessage(db, msg3.id);
      // msg3 was unread before restart, reading it now sets read_at
      expect(readMsg3.state).toBe('delivered');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-003: Partial ack in a thread remains consistent
// ---------------------------------------------------------------------------

describe('VAL-CROSS-003: partial ack in a thread remains consistent', () => {
  it('mixed read-only and acked messages in a thread are correctly represented', () => {
    const db = openDb();
    try {
      // Create a thread: root → reply1 → reply2
      const root = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Thread root',
      });

      const reply1 = replyMessage(db, {
        parentMessageId: root.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'First reply',
      });

      const reply2 = replyMessage(db, {
        parentMessageId: reply1.id,
        sender: 'alice',
        recipient: 'bob',
        body: 'Second reply',
      });

      // Read all messages
      readMessage(db, root.id);
      readMessage(db, reply1.id);
      readMessage(db, reply2.id);

      // Ack only root and reply2, leave reply1 read-only
      ackMessage(db, root.id);
      ackMessage(db, reply2.id);

      // Verify thread listing shows mixed states
      const thread = listThread(db, root.thread_id);
      expect(thread.length).toBe(3);

      const rootEntry = thread.find((m) => m.id === root.id);
      const reply1Entry = thread.find((m) => m.id === reply1.id);
      const reply2Entry = thread.find((m) => m.id === reply2.id);
      if (!rootEntry || !reply1Entry || !reply2Entry) throw new Error('expected entries');

      expect(rootEntry.state).toBe('acked');
      expect(rootEntry.read_at).not.toBeNull();

      expect(reply1Entry.state).toBe('delivered');
      expect(reply1Entry.read_at).not.toBeNull();

      expect(reply2Entry.state).toBe('acked');
      expect(reply2Entry.read_at).not.toBeNull();

      // Inbox also reflects correct states
      const inbox = listInbox(db, {});
      const inboxRoot = inbox.find((m) => m.id === root.id);
      const inboxReply1 = inbox.find((m) => m.id === reply1.id);
      const inboxReply2 = inbox.find((m) => m.id === reply2.id);
      if (!inboxRoot || !inboxReply1 || !inboxReply2) throw new Error('expected entries');

      expect(inboxRoot.state).toBe('acked');
      expect(inboxReply1.state).toBe('delivered');
      expect(inboxReply2.state).toBe('acked');
    } finally {
      db.close();
    }
  });

  it('partial ack in thread persists across restart', () => {
    let db = openDb();
    try {
      // Create a thread
      const root = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Persistent thread root',
      });

      const reply1 = replyMessage(db, {
        parentMessageId: root.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Persistent reply 1',
      });

      const reply2 = replyMessage(db, {
        parentMessageId: root.id,
        sender: 'charlie',
        recipient: 'alice',
        body: 'Persistent reply 2',
      });

      // Read all, ack only root
      readMessage(db, root.id);
      readMessage(db, reply1.id);
      readMessage(db, reply2.id);
      ackMessage(db, root.id);

      const threadId = root.thread_id;

      // Restart
      db = simulateRestart(db);

      // Verify thread states after restart
      const thread = listThread(db, threadId);
      expect(thread.length).toBe(3);

      const rootEntry = thread.find((m) => m.id === root.id);
      const r1Entry = thread.find((m) => m.id === reply1.id);
      const r2Entry = thread.find((m) => m.id === reply2.id);
      if (!rootEntry || !r1Entry || !r2Entry) throw new Error('expected entries');

      expect(rootEntry.state).toBe('acked');
      expect(r1Entry.state).toBe('delivered');
      expect(r2Entry.state).toBe('delivered');

      // Ack reply1 after restart
      ackMessage(db, reply1.id);

      db = simulateRestart(db);

      const thread2 = listThread(db, threadId);
      const r1After = thread2.find((m) => m.id === reply1.id);
      const r2After = thread2.find((m) => m.id === reply2.id);
      if (!r1After || !r2After) throw new Error('expected entries');

      expect(r1After.state).toBe('acked');
      expect(r2After.state).toBe('delivered'); // still not acked
    } finally {
      db.close();
    }
  });

  it('thread causal order is preserved with partial ack states', () => {
    const db = openDb();
    try {
      const root = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root',
      });

      const r1 = replyMessage(db, {
        parentMessageId: root.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply 1',
      });

      const r2 = replyMessage(db, {
        parentMessageId: r1.id,
        sender: 'alice',
        recipient: 'bob',
        body: 'Nested reply',
      });

      // Read all, ack only nested reply
      readMessage(db, root.id);
      readMessage(db, r1.id);
      readMessage(db, r2.id);
      ackMessage(db, r2.id);

      const thread = listThread(db, root.thread_id);

      // Causal order: root → r1 → r2
      expect(thread[0].id).toBe(root.id);
      expect(thread[1].id).toBe(r1.id);
      expect(thread[2].id).toBe(r2.id);

      // States mixed correctly
      expect(thread[0].state).toBe('delivered');
      expect(thread[1].state).toBe('delivered');
      expect(thread[2].state).toBe('acked');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-004: Retry/reconnect converges to one logical outcome
// ---------------------------------------------------------------------------

describe('VAL-CROSS-004: retry converges to one logical outcome', () => {
  it('retry with dedupe key converges to single delivered message', () => {
    const db = openDb();
    try {
      const dedupeKey = 'dup_retry-converge-001';

      // Simulate transient interruption: first send "succeeds" (or was interrupted)
      const first = sendMessage(db, {
        sender: 'agent-a',
        recipient: 'agent-b',
        body: 'Retry convergence test',
        dedupeKey,
      });

      // Retry same send (simulating client didn't see first response)
      const retry1 = sendMessage(db, {
        sender: 'agent-a',
        recipient: 'agent-b',
        body: 'Retry convergence test',
        dedupeKey,
      });

      const retry2 = sendMessage(db, {
        sender: 'agent-a',
        recipient: 'agent-b',
        body: 'Retry convergence test',
        dedupeKey,
      });

      // All retries converge to same message ID
      expect(retry1.id).toBe(first.id);
      expect(retry2.id).toBe(first.id);
      expect(retry1.dedupe_replay).toBe(true);
      expect(retry2.dedupe_replay).toBe(true);

      // Only one message in inbox
      const inbox = listInbox(db, { recipient: 'agent-b' });
      expect(inbox.length).toBe(1);
      expect(inbox[0].id).toBe(first.id);
    } finally {
      db.close();
    }
  });

  it('retry with dedupe key on reply also converges', () => {
    const db = openDb();
    try {
      const root = sendMessage(db, {
        sender: 'agent-a',
        recipient: 'agent-b',
        body: 'Root message',
      });

      const dedupeKey = 'dup_retry-reply-converge';

      const firstReply = replyMessage(db, {
        parentMessageId: root.id,
        sender: 'agent-b',
        recipient: 'agent-a',
        body: 'Retry reply',
        dedupeKey,
      });

      const retryReply = replyMessage(db, {
        parentMessageId: root.id,
        sender: 'agent-b',
        recipient: 'agent-a',
        body: 'Retry reply',
        dedupeKey,
      });

      expect(retryReply.id).toBe(firstReply.id);
      expect(retryReply.dedupe_replay).toBe(true);

      // Thread should have exactly 2 messages
      const thread = listThread(db, root.thread_id);
      expect(thread.length).toBe(2);
    } finally {
      db.close();
    }
  });

  it('retry convergence produces consistent watch events', async () => {
    const db = openDb();
    try {
      const { events, done, stop } = collectWatchEvents(db, {
        maxEvents: 1,
        timeoutMs: 2000,
        pollIntervalMs: 30,
      });

      await new Promise((r) => setTimeout(r, 50));

      const dedupeKey = 'dup_watch-retry-converge';

      // Send with dedupe key
      sendMessage(db, {
        sender: 'agent-a',
        recipient: 'agent-b',
        body: 'Watch retry test',
        dedupeKey,
      });

      // Retry
      sendMessage(db, {
        sender: 'agent-a',
        recipient: 'agent-b',
        body: 'Watch retry test',
        dedupeKey,
      });

      await done;

      // Should see exactly one message_created event (not two)
      const createEvents = events.filter((e) => e.event_type === 'message_created');
      expect(createEvents.length).toBe(1);

      stop();
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-005: Dedupe guarantee survives process restart
// ---------------------------------------------------------------------------

describe('VAL-CROSS-005: dedupe guarantee survives process restart', () => {
  it('replaying send with same dedupe key after restart converges to one message', () => {
    let db = openDb();
    try {
      const dedupeKey = 'dup_restart-dedupe-001';

      // First send
      const first = sendMessage(db, {
        sender: 'agent-a',
        recipient: 'agent-b',
        body: 'Dedupe across restart',
        dedupeKey,
      });

      expect(first.dedupe_replay).toBe(false);
      const firstId = first.id;

      // Simulate restart
      db = simulateRestart(db);

      // Replay with same dedupe key
      const replay = sendMessage(db, {
        sender: 'agent-a',
        recipient: 'agent-b',
        body: 'Dedupe across restart',
        dedupeKey,
      });

      expect(replay.id).toBe(firstId);
      expect(replay.dedupe_replay).toBe(true);

      // Only one message in inbox
      const inbox = listInbox(db, { recipient: 'agent-b' });
      expect(inbox.length).toBe(1);
      expect(inbox[0].id).toBe(firstId);
    } finally {
      db.close();
    }
  });

  it('dedupe survives multiple restarts', () => {
    let db = openDb();
    try {
      const dedupeKey = 'dup_multi-restart-dedupe';

      const first = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Multi-restart dedupe',
        dedupeKey,
      });
      const canonicalId = first.id;

      // Multiple restarts with replay
      for (let i = 0; i < 3; i++) {
        db = simulateRestart(db);

        const replay = sendMessage(db, {
          sender: 'alice',
          recipient: 'bob',
          body: 'Multi-restart dedupe',
          dedupeKey,
        });

        expect(replay.id).toBe(canonicalId);
        expect(replay.dedupe_replay).toBe(true);
      }

      // Final check: still one message
      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox.length).toBe(1);
      expect(inbox[0].id).toBe(canonicalId);
    } finally {
      db.close();
    }
  });

  it('dedupe for replies also survives restart', () => {
    let db = openDb();
    try {
      const root = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root for reply dedupe restart',
      });

      const dedupeKey = 'dup_reply-restart-dedupe';
      const firstReply = replyMessage(db, {
        parentMessageId: root.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply for dedupe restart',
        dedupeKey,
      });

      const replyId = firstReply.id;

      // Restart
      db = simulateRestart(db);

      // Replay reply
      const replay = replyMessage(db, {
        parentMessageId: root.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply for dedupe restart',
        dedupeKey,
      });

      expect(replay.id).toBe(replyId);
      expect(replay.dedupe_replay).toBe(true);

      // Thread should have exactly 2 messages
      const thread = listThread(db, root.thread_id);
      expect(thread.length).toBe(2);
    } finally {
      db.close();
    }
  });

  it('different dedupe keys after restart create separate messages', () => {
    let db = openDb();
    try {
      sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'First dedupe',
        dedupeKey: 'dup_first-key',
      });

      db = simulateRestart(db);

      sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Second dedupe',
        dedupeKey: 'dup_second-key',
      });

      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox.length).toBe(2);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-006: Encryption fail-closed after real usage
// ---------------------------------------------------------------------------

describe('VAL-CROSS-006: encryption fail-closed after real usage', () => {
  it('wrong key after real usage fails closed', () => {
    const db = openDb();
    try {
      // Real usage: send and read messages
      const sent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'CANARY_secret_message_for_encryption_test_Z9x8W7',
      });
      readMessage(db, sent.id);
      ackMessage(db, sent.id);

      // Add replies too
      replyMessage(db, {
        parentMessageId: sent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply with more secret data',
      });
    } finally {
      db.close();
    }

    // Try to open with wrong key
    const dbPath = getDbPath(configDir);
    const wrongKey = randomBytes(32);

    expect(() => openEncryptedDb({ dbPath, key: wrongKey })).toThrow(StoreEncryptionError);
  });

  it('missing key file after real usage fails closed', () => {
    const db = openDb();
    try {
      sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Secret message for missing key test',
      });
    } finally {
      db.close();
    }

    // Try to load from a nonexistent key path
    const fakeKeyPath = join(testDir, 'nonexistent.key');
    expect(() => loadKey(fakeKeyPath)).toThrow(KeyError);
  });

  it('no plaintext fallback artifact is created after wrong key attempt', () => {
    const db = openDb();
    try {
      sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'CANARY_no_plaintext_fallback_test',
      });
    } finally {
      db.close();
    }

    const dbPath = getDbPath(configDir);
    const wrongKey = randomBytes(32);

    // Attempt with wrong key should fail
    try {
      openEncryptedDb({ dbPath, key: wrongKey });
    } catch {
      // Expected to throw
    }

    // Verify no plaintext fallback was created
    const configFiles = readdirSync(configDir);
    const dbFiles = configFiles.filter(
      (f) => f.endsWith('.db') || f.endsWith('.sqlite') || f.endsWith('.sqlite3')
    );

    // Should only have the original mors.db, no plaintext fallback
    expect(dbFiles).toEqual(['mors.db']);

    // Verify the canary is not readable as plaintext in the db file
    const dbBytes = readFileSync(dbPath);
    const dbContent = dbBytes.toString('utf-8');
    expect(dbContent).not.toContain('CANARY_no_plaintext_fallback_test');
  });

  it('correct key still works after failed wrong-key attempt', () => {
    let db = openDb();
    try {
      const sent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Correct key after wrong key test',
      });
      const sentId = sent.id;
      db.close();

      // Try wrong key first
      const dbPath = getDbPath(configDir);
      const wrongKey = randomBytes(32);
      try {
        openEncryptedDb({ dbPath, key: wrongKey });
      } catch {
        // Expected
      }

      // Now open with correct key
      db = openDb();
      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox.length).toBe(1);
      expect(inbox[0].id).toBe(sentId);
      expect(inbox[0].body).toBe('Correct key after wrong key test');
    } finally {
      db.close();
    }
  });

  it('canary message is encrypted at rest after full usage', () => {
    const canary = 'CANARY_integration_e2e_' + randomBytes(16).toString('hex');

    const db = openDb();
    try {
      const sent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: canary,
        subject: canary,
      });

      readMessage(db, sent.id);

      replyMessage(db, {
        parentMessageId: sent.id,
        sender: 'bob',
        recipient: 'alice',
        body: `Reply containing ${canary}`,
      });
    } finally {
      db.close();
    }

    // Check all database files for plaintext canary
    const dbPath = getDbPath(configDir);
    const filesToCheck = [dbPath];

    // Also check WAL and SHM files if they exist
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    if (existsSync(walPath)) filesToCheck.push(walPath);
    if (existsSync(shmPath)) filesToCheck.push(shmPath);

    for (const filePath of filesToCheck) {
      const bytes = readFileSync(filePath);
      const content = bytes.toString('utf-8');
      expect(content).not.toContain(canary);
    }
  });

  it('encryption fail-closed after send+read+reply+ack lifecycle', () => {
    const db = openDb();
    try {
      // Full lifecycle
      const sent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Full lifecycle encryption test',
      });

      readMessage(db, sent.id);

      const reply = replyMessage(db, {
        parentMessageId: sent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply in lifecycle',
      });

      ackMessage(db, sent.id);
      readMessage(db, reply.id);
      ackMessage(db, reply.id);

      // Verify everything worked
      const thread = listThread(db, sent.thread_id);
      expect(thread.length).toBe(2);
      expect(thread[0].state).toBe('acked');
      expect(thread[1].state).toBe('acked');
    } finally {
      db.close();
    }

    // Now try wrong key — must fail closed
    const dbPath = getDbPath(configDir);
    const wrongKey = randomBytes(32);

    expect(() => openEncryptedDb({ dbPath, key: wrongKey })).toThrow(StoreEncryptionError);

    // Verify correct key still recovers data
    const db2 = openDb();
    try {
      const inbox = listInbox(db2, {});
      expect(inbox.length).toBe(2);
    } finally {
      db2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Additional cross-flow integration scenarios
// ---------------------------------------------------------------------------

describe('cross-flow: concurrent operations', () => {
  it('concurrent sends with different dedupe keys produce distinct messages', () => {
    const db = openDb();
    try {
      // Simulate concurrent sends (same DB handle, sequential but distinct)
      const results = Array.from({ length: 5 }, (_, i) =>
        sendMessage(db, {
          sender: 'agent-a',
          recipient: 'agent-b',
          body: `Concurrent message ${i}`,
          dedupeKey: `dup_concurrent-${i}`,
        })
      );

      const uniqueIds = new Set(results.map((r) => r.id));
      expect(uniqueIds.size).toBe(5);

      const inbox = listInbox(db, { recipient: 'agent-b' });
      expect(inbox.length).toBe(5);
    } finally {
      db.close();
    }
  });

  it('concurrent replies to the same parent are all preserved', () => {
    const db = openDb();
    try {
      const root = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root for concurrent replies',
      });

      const replies = Array.from({ length: 3 }, (_, i) =>
        replyMessage(db, {
          parentMessageId: root.id,
          sender: `agent-${i}`,
          recipient: 'alice',
          body: `Concurrent reply ${i}`,
        })
      );

      const uniqueReplyIds = new Set(replies.map((r) => r.id));
      expect(uniqueReplyIds.size).toBe(3);

      // All replies share the same thread_id
      for (const reply of replies) {
        expect(reply.thread_id).toBe(root.thread_id);
        expect(reply.in_reply_to).toBe(root.id);
      }

      const thread = listThread(db, root.thread_id);
      expect(thread.length).toBe(4); // root + 3 replies
    } finally {
      db.close();
    }
  });
});

describe('cross-flow: state consistency edge cases', () => {
  it('reading a message, restarting, then re-reading is idempotent', () => {
    let db = openDb();
    try {
      const sent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Idempotent read across restart',
      });

      const read1 = readMessage(db, sent.id);
      const readAt1 = read1.read_at;

      db = simulateRestart(db);

      const read2 = readMessage(db, sent.id);
      expect(read2.read_at).toBe(readAt1); // Same read_at timestamp
      expect(read2.state).toBe('delivered');
    } finally {
      db.close();
    }
  });

  it('acking a message, restarting, then re-acking is idempotent', () => {
    let db = openDb();
    try {
      const sent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Idempotent ack across restart',
      });

      readMessage(db, sent.id);
      const ack1 = ackMessage(db, sent.id);

      db = simulateRestart(db);

      const ack2 = ackMessage(db, sent.id);
      expect(ack2.state).toBe('acked');
      expect(ack2.updated_at).toBe(ack1.updated_at);
    } finally {
      db.close();
    }
  });

  it('thread navigation works correctly after restart', () => {
    let db = openDb();
    try {
      const root = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Thread root for restart nav',
      });

      const reply = replyMessage(db, {
        parentMessageId: root.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply for restart nav',
      });

      const threadId = root.thread_id;

      db = simulateRestart(db);

      const thread = listThread(db, threadId);
      expect(thread.length).toBe(2);
      expect(thread[0].id).toBe(root.id);
      expect(thread[1].id).toBe(reply.id);
      expect(thread[1].in_reply_to).toBe(root.id);
      expect(thread[1].thread_id).toBe(threadId);
    } finally {
      db.close();
    }
  });
});
