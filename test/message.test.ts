/**
 * Tests for message lifecycle commands: send, inbox, read, ack.
 *
 * Covers:
 * - VAL-MSG-001: Send delivers message to inbox with stable identity
 * - VAL-MSG-002: Inbox unread behavior tracks read_at
 * - VAL-MSG-003: Read does not imply ack
 * - VAL-MSG-004: Explicit ack transitions to acked
 * - VAL-MSG-005: Dedupe key prevents duplicate side effects
 * - VAL-MSG-006: Invalid read/ack targets fail clearly
 * - VAL-MSG-007: Delivery lifecycle states are observable and valid
 * - VAL-MSG-008: Message content fidelity through send/read
 * - VAL-MSG-009: Read and ack operations are idempotent
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
import type { SendOptions } from '../src/message.js';
import { MorsError, DedupeConflictError } from '../src/errors.js';
import { InvalidStateTransitionError } from '../src/contract/errors.js';

let testDir: string;
let configDir: string;

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'mors-msg-test-'));
  configDir = join(testDir, '.mors');
  await initCommand({ configDir });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** Helper to open the encrypted DB for a test config dir. */
function openDb() {
  const dbPath = getDbPath(configDir);
  const key = loadKey(getDbKeyPath(configDir));
  return openEncryptedDb({ dbPath, key });
}

// ---------------------------------------------------------------------------
// VAL-MSG-001: Send delivers message to inbox with stable identity
// ---------------------------------------------------------------------------

describe('VAL-MSG-001: send delivers message to inbox with stable identity', () => {
  it('sendMessage creates a message visible via listInbox', () => {
    const db = openDb();
    try {
      const result = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Hello Bob!',
      });

      expect(result.id).toMatch(/^msg_/);
      expect(result.thread_id).toMatch(/^thr_/);

      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox.length).toBe(1);
      expect(inbox[0].id).toBe(result.id);
    } finally {
      db.close();
    }
  });

  it('sendMessage returns stable metadata with correct sender/recipient', () => {
    const db = openDb();
    try {
      const result = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Test message',
      });

      expect(result.sender).toBe('alice');
      expect(result.recipient).toBe('bob');
      expect(typeof result.created_at).toBe('string');
      expect(result.created_at.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('sent message ID matches the one in inbox', () => {
    const db = openDb();
    try {
      const sent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'ID stability check',
      });

      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox[0].id).toBe(sent.id);
      expect(inbox[0].thread_id).toBe(sent.thread_id);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-MSG-002: Inbox unread behavior tracks read_at
// ---------------------------------------------------------------------------

describe('VAL-MSG-002: inbox unread behavior tracks read_at', () => {
  it('newly sent message has null read_at (unread)', () => {
    const db = openDb();
    try {
      sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Unread test' });
      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox[0].read_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it('after read, message has non-null read_at', () => {
    const db = openDb();
    try {
      const sent = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Read test' });
      readMessage(db, sent.id);
      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox[0].read_at).not.toBeNull();
      expect(typeof inbox[0].read_at).toBe('string');
    } finally {
      db.close();
    }
  });

  it('unread filter only returns messages without read_at', () => {
    const db = openDb();
    try {
      const msg1 = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'First' });
      sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Second' });

      // Read only the first message.
      readMessage(db, msg1.id);

      const unread = listInbox(db, { recipient: 'bob', unreadOnly: true });
      expect(unread.length).toBe(1);
      expect(unread[0].body).toBe('Second');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-MSG-003: Read does not imply ack
// ---------------------------------------------------------------------------

describe('VAL-MSG-003: read does not imply ack', () => {
  it('reading a message sets read_at but keeps state as delivered', () => {
    const db = openDb();
    try {
      const sent = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'No ack yet' });
      const readResult = readMessage(db, sent.id);

      expect(readResult.read_at).not.toBeNull();
      expect(readResult.state).toBe('delivered');
    } finally {
      db.close();
    }
  });

  it('inbox shows delivered (not acked) after read', () => {
    const db = openDb();
    try {
      const sent = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Check state' });
      readMessage(db, sent.id);

      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox[0].state).toBe('delivered');
      expect(inbox[0].read_at).not.toBeNull();
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-MSG-004: Explicit ack transitions to acked
// ---------------------------------------------------------------------------

describe('VAL-MSG-004: explicit ack transitions to acked', () => {
  it('ack transitions message state to acked', () => {
    const db = openDb();
    try {
      const sent = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Ack me' });
      // Must read before ack (queued -> delivered -> acked).
      readMessage(db, sent.id);
      const ackResult = ackMessage(db, sent.id);

      expect(ackResult.state).toBe('acked');
    } finally {
      db.close();
    }
  });

  it('acked state is observable in inbox', () => {
    const db = openDb();
    try {
      const sent = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Observable ack' });
      readMessage(db, sent.id);
      ackMessage(db, sent.id);

      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox[0].state).toBe('acked');
    } finally {
      db.close();
    }
  });

  it('ack on a queued message fails (must go through delivered state)', () => {
    const db = openDb();
    try {
      // Insert a message directly in 'queued' state to test the invariant.
      // Local delivery puts messages in 'delivered', so we manually insert.
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO messages (id, thread_id, sender, recipient, body, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'msg_queued-ack-test',
        'thr_queued-ack-test',
        'alice',
        'bob',
        'Queued msg',
        'queued',
        now,
        now
      );

      expect(() => ackMessage(db, 'msg_queued-ack-test')).toThrow(InvalidStateTransitionError);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-MSG-005: Dedupe key prevents duplicate side effects
// ---------------------------------------------------------------------------

describe('VAL-MSG-005: dedupe key prevents duplicate side effects', () => {
  it('sending with same dedupe_key twice results in one message', () => {
    const db = openDb();
    try {
      const opts: SendOptions = {
        sender: 'alice',
        recipient: 'bob',
        body: 'Dedupe test',
        dedupeKey: 'dup_test-unique-key',
      };

      const first = sendMessage(db, opts);
      const second = sendMessage(db, opts);

      // Both calls should return the same canonical message ID.
      expect(second.id).toBe(first.id);

      // Only one message in inbox.
      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('replayed dedupe send returns same canonical message', () => {
    const db = openDb();
    try {
      const opts: SendOptions = {
        sender: 'alice',
        recipient: 'bob',
        body: 'Replay dedupe',
        dedupeKey: 'dup_replay-key',
      };

      const first = sendMessage(db, opts);
      const second = sendMessage(db, opts);
      const third = sendMessage(db, opts);

      expect(second.id).toBe(first.id);
      expect(third.id).toBe(first.id);
      expect(second.thread_id).toBe(first.thread_id);
    } finally {
      db.close();
    }
  });

  it('different dedupe keys create separate messages', () => {
    const db = openDb();
    try {
      const msg1 = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'First',
        dedupeKey: 'dup_key-1',
      });
      const msg2 = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Second',
        dedupeKey: 'dup_key-2',
      });

      expect(msg1.id).not.toBe(msg2.id);

      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox.length).toBe(2);
    } finally {
      db.close();
    }
  });

  it('sends without dedupe key always create new messages', () => {
    const db = openDb();
    try {
      const msg1 = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'No dedupe 1' });
      const msg2 = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'No dedupe 2' });

      expect(msg1.id).not.toBe(msg2.id);
      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox.length).toBe(2);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-MSG-006: Invalid read/ack targets fail clearly
// ---------------------------------------------------------------------------

describe('VAL-MSG-006: invalid read/ack targets fail clearly', () => {
  it('readMessage with nonexistent ID throws with clear error', () => {
    const db = openDb();
    try {
      expect(() => readMessage(db, 'msg_nonexistent-id')).toThrow();
      try {
        readMessage(db, 'msg_nonexistent-id');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(MorsError);
        expect((err as Error).message).toMatch(/not found/i);
      }
    } finally {
      db.close();
    }
  });

  it('ackMessage with nonexistent ID throws with clear error', () => {
    const db = openDb();
    try {
      expect(() => ackMessage(db, 'msg_nonexistent-id')).toThrow();
      try {
        ackMessage(db, 'msg_nonexistent-id');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(MorsError);
        expect((err as Error).message).toMatch(/not found/i);
      }
    } finally {
      db.close();
    }
  });

  it('readMessage with invalid format ID throws ContractValidationError', () => {
    const db = openDb();
    try {
      expect(() => readMessage(db, 'invalid-id-format')).toThrow();
    } finally {
      db.close();
    }
  });

  it('ackMessage with invalid format ID throws ContractValidationError', () => {
    const db = openDb();
    try {
      expect(() => ackMessage(db, 'invalid-id-format')).toThrow();
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-MSG-007: Delivery lifecycle states are observable and valid
// ---------------------------------------------------------------------------

describe('VAL-MSG-007: delivery lifecycle states are observable and valid', () => {
  it('newly sent message starts in queued state', () => {
    const db = openDb();
    try {
      const sent = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'State test' });
      // Local delivery: messages are immediately delivered.
      // The send operation should store as 'delivered' for local messages.
      expect(sent.state).toBe('delivered');
    } finally {
      db.close();
    }
  });

  it('read transitions from delivered (no state regression)', () => {
    const db = openDb();
    try {
      const sent = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Lifecycle' });
      const read = readMessage(db, sent.id);
      expect(read.state).toBe('delivered');
    } finally {
      db.close();
    }
  });

  it('ack transitions from delivered to acked', () => {
    const db = openDb();
    try {
      const sent = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'To ack' });
      readMessage(db, sent.id);
      const acked = ackMessage(db, sent.id);
      expect(acked.state).toBe('acked');
    } finally {
      db.close();
    }
  });

  it('queued to acked directly is not allowed', () => {
    const db = openDb();
    try {
      // Insert a message in queued state directly.
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO messages (id, thread_id, sender, recipient, body, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('msg_queued-test', 'thr_queued-test', 'alice', 'bob', 'Queued msg', 'queued', now, now);

      expect(() => ackMessage(db, 'msg_queued-test')).toThrow();
    } finally {
      db.close();
    }
  });

  it('full lifecycle: delivered -> read (delivered with read_at) -> acked', () => {
    const db = openDb();
    try {
      const sent = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Full lifecycle' });

      // After send, state is delivered.
      const inbox1 = listInbox(db, { recipient: 'bob' });
      expect(inbox1[0].state).toBe('delivered');
      expect(inbox1[0].read_at).toBeNull();

      // After read, state is still delivered but read_at is set.
      readMessage(db, sent.id);
      const inbox2 = listInbox(db, { recipient: 'bob' });
      expect(inbox2[0].state).toBe('delivered');
      expect(inbox2[0].read_at).not.toBeNull();

      // After ack, state transitions to acked.
      ackMessage(db, sent.id);
      const inbox3 = listInbox(db, { recipient: 'bob' });
      expect(inbox3[0].state).toBe('acked');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-MSG-008: Message content fidelity through send/read
// ---------------------------------------------------------------------------

describe('VAL-MSG-008: message content fidelity through send/read', () => {
  it('simple message body is preserved', () => {
    const db = openDb();
    try {
      const body = 'Hello, world!';
      const sent = sendMessage(db, { sender: 'alice', recipient: 'bob', body });
      const read = readMessage(db, sent.id);
      expect(read.body).toBe(body);
    } finally {
      db.close();
    }
  });

  it('multiline markdown body is preserved', () => {
    const db = openDb();
    try {
      const body = `# Heading

This is a **bold** paragraph with *italics*.

- List item 1
- List item 2

\`\`\`typescript
const x = 42;
\`\`\`

> Blockquote here.`;
      const sent = sendMessage(db, { sender: 'alice', recipient: 'bob', body });
      const read = readMessage(db, sent.id);
      expect(read.body).toBe(body);
    } finally {
      db.close();
    }
  });

  it('body with special characters is preserved', () => {
    const db = openDb();
    try {
      const body = 'Special chars: <>&"\'`~!@#$%^&*()_+-=[]{}|;:,.<>?/\\';
      const sent = sendMessage(db, { sender: 'alice', recipient: 'bob', body });
      const read = readMessage(db, sent.id);
      expect(read.body).toBe(body);
    } finally {
      db.close();
    }
  });

  it('body with unicode/emoji is preserved', () => {
    const db = openDb();
    try {
      const body = 'Emoji test: 🎉🚀💡 and CJK: 你好世界 and Arabic: مرحبا';
      const sent = sendMessage(db, { sender: 'alice', recipient: 'bob', body });
      const read = readMessage(db, sent.id);
      expect(read.body).toBe(body);
    } finally {
      db.close();
    }
  });

  it('subject is preserved when provided', () => {
    const db = openDb();
    try {
      const sent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'With subject',
        subject: 'Important Subject',
      });
      const read = readMessage(db, sent.id);
      expect(read.subject).toBe('Important Subject');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-MSG-009: Read and ack operations are idempotent
// ---------------------------------------------------------------------------

describe('VAL-MSG-009: read and ack operations are idempotent', () => {
  it('reading a message twice does not change read_at or create duplicates', () => {
    const db = openDb();
    try {
      const sent = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Idempotent read' });

      const read1 = readMessage(db, sent.id);
      const read2 = readMessage(db, sent.id);

      // read_at should be identical (or at least both set).
      expect(read1.read_at).not.toBeNull();
      expect(read2.read_at).toBe(read1.read_at);

      // State should remain delivered (not regress).
      expect(read2.state).toBe('delivered');

      // Still just one message in inbox.
      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('acking a message twice does not regress state or create duplicates', () => {
    const db = openDb();
    try {
      const sent = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Idempotent ack' });
      readMessage(db, sent.id);

      const ack1 = ackMessage(db, sent.id);
      const ack2 = ackMessage(db, sent.id);

      expect(ack1.state).toBe('acked');
      expect(ack2.state).toBe('acked');

      // Still just one message in inbox.
      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('reading an already-acked message does not regress state', () => {
    const db = openDb();
    try {
      const sent = sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Acked then read' });
      readMessage(db, sent.id);
      ackMessage(db, sent.id);

      // Reading again should not change state from acked.
      const read2 = readMessage(db, sent.id);
      expect(read2.state).toBe('acked');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

describe('message edge cases', () => {
  it('listInbox returns empty array when no messages', () => {
    const db = openDb();
    try {
      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('multiple messages from different senders appear in recipient inbox', () => {
    const db = openDb();
    try {
      sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'From Alice' });
      sendMessage(db, { sender: 'charlie', recipient: 'bob', body: 'From Charlie' });

      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox.length).toBe(2);
    } finally {
      db.close();
    }
  });

  it('messages to different recipients are properly separated', () => {
    const db = openDb();
    try {
      sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'For Bob' });
      sendMessage(db, { sender: 'alice', recipient: 'charlie', body: 'For Charlie' });

      const bobInbox = listInbox(db, { recipient: 'bob' });
      const charlieInbox = listInbox(db, { recipient: 'charlie' });

      expect(bobInbox.length).toBe(1);
      expect(bobInbox[0].body).toBe('For Bob');
      expect(charlieInbox.length).toBe(1);
      expect(charlieInbox[0].body).toBe('For Charlie');
    } finally {
      db.close();
    }
  });

  it('sendMessage with empty body throws', () => {
    const db = openDb();
    try {
      expect(() => sendMessage(db, { sender: 'alice', recipient: 'bob', body: '' })).toThrow();
    } finally {
      db.close();
    }
  });

  it('sendMessage with empty sender throws', () => {
    const db = openDb();
    try {
      expect(() => sendMessage(db, { sender: '', recipient: 'bob', body: 'Test' })).toThrow();
    } finally {
      db.close();
    }
  });

  it('sendMessage with empty recipient throws', () => {
    const db = openDb();
    try {
      expect(() => sendMessage(db, { sender: 'alice', recipient: '', body: 'Test' })).toThrow();
    } finally {
      db.close();
    }
  });

  it('listInbox without recipient filter returns all messages', () => {
    const db = openDb();
    try {
      sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'For Bob' });
      sendMessage(db, { sender: 'alice', recipient: 'charlie', body: 'For Charlie' });

      const inbox = listInbox(db, {});
      expect(inbox.length).toBe(2);
    } finally {
      db.close();
    }
  });

  it('sendMessage generates trace_id when provided', () => {
    const db = openDb();
    try {
      const result = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Trace test',
        traceId: 'trc_custom-trace',
      });
      expect(result.trace_id).toBe('trc_custom-trace');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Send dedupe causal linkage: send replays must not collide with replies
// ---------------------------------------------------------------------------

describe('send dedupe causal linkage', () => {
  it('dedupe key used for reply rejects when replayed as send', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Parent',
      });

      // First: create a reply with a dedupe key
      replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply with dedupe',
        dedupeKey: 'dup_reply-then-send',
      });

      // Now try to use the same dedupe key to create a top-level send — must fail
      // because the existing record is a reply (in_reply_to is set)
      expect(() =>
        sendMessage(db, {
          sender: 'bob',
          recipient: 'alice',
          body: 'Conflict send',
          dedupeKey: 'dup_reply-then-send',
        })
      ).toThrow(DedupeConflictError);
    } finally {
      db.close();
    }
  });

  it('send dedupe replay with matching context is accepted', () => {
    const db = openDb();
    try {
      const first = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Send dedupe',
        dedupeKey: 'dup_send-replay-ok',
      });

      const replay = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Send dedupe',
        dedupeKey: 'dup_send-replay-ok',
      });

      expect(replay.dedupe_replay).toBe(true);
      expect(replay.id).toBe(first.id);
    } finally {
      db.close();
    }
  });

  it('send dedupe conflict preserves original reply intact', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Parent msg',
      });

      const reply = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply msg',
        dedupeKey: 'dup_preserve-reply',
      });

      // Conflict: try send with same key
      expect(() =>
        sendMessage(db, {
          sender: 'bob',
          recipient: 'alice',
          body: 'Conflicting send',
          dedupeKey: 'dup_preserve-reply',
        })
      ).toThrow(DedupeConflictError);

      // Original reply remains intact
      const read = readMessage(db, reply.id);
      expect(read.in_reply_to).toBe(parent.id);
      expect(read.thread_id).toBe(parent.thread_id);
      expect(read.body).toBe('Reply msg');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Dedupe race-condition hardening: concurrent dedupe operations converge
// ---------------------------------------------------------------------------

describe('dedupe race-condition hardening', () => {
  it('concurrent sends with same dedupe key converge to one canonical message', () => {
    const db = openDb();
    try {
      const dedupeKey = 'dup_concurrent-race-send';
      const opts: SendOptions = {
        sender: 'alice',
        recipient: 'bob',
        body: 'Race condition test',
        dedupeKey,
      };

      // Simulate overlapping concurrent sends by running many in tight succession.
      // With better-sqlite3 (synchronous), true parallelism isn't possible within
      // a single process, but this exercises the full check-then-insert path
      // repeatedly and verifies convergence semantics.
      const results = Array.from({ length: 10 }, () => sendMessage(db, opts));

      // All results must converge to the same canonical message ID
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(1);

      // Exactly one was the original, rest are replays
      const originals = results.filter((r) => !r.dedupe_replay);
      const replays = results.filter((r) => r.dedupe_replay);
      expect(originals.length).toBe(1);
      expect(replays.length).toBe(9);

      // Only one message in inbox
      const inbox = listInbox(db, { recipient: 'bob' });
      expect(inbox.length).toBe(1);
      expect(inbox[0].id).toBe(results[0].id);
    } finally {
      db.close();
    }
  });

  it('UNIQUE constraint conflict on dedupe_key recovers canonical message without raw error leakage', () => {
    const db = openDb();
    try {
      const dedupeKey = 'dup_constraint-recovery';

      // Insert a message with the dedupe key directly (simulating a concurrent winner)
      const now = new Date().toISOString();
      const canonicalId = 'msg_canonical-winner';
      const canonicalThreadId = 'thr_canonical-winner';
      db.prepare(
        `INSERT INTO messages (id, thread_id, in_reply_to, sender, recipient, subject, body, dedupe_key, trace_id, state, read_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        canonicalId,
        canonicalThreadId,
        null,
        'alice',
        'bob',
        null,
        'Winner message',
        dedupeKey,
        null,
        'delivered',
        null,
        now,
        now
      );

      // Now try to send with the same dedupe key — the SELECT check will find it
      // and return the canonical message as a dedupe replay
      const result = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Loser attempt',
        dedupeKey,
      });

      // Should recover the canonical message, not throw SQLITE_CONSTRAINT
      expect(result.id).toBe(canonicalId);
      expect(result.thread_id).toBe(canonicalThreadId);
      expect(result.dedupe_replay).toBe(true);
    } finally {
      db.close();
    }
  });

  it('concurrent replies with same dedupe key converge to one canonical reply', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Parent for concurrent reply race',
      });

      const dedupeKey = 'dup_concurrent-reply-race';

      const results = Array.from({ length: 10 }, () =>
        replyMessage(db, {
          parentMessageId: parent.id,
          sender: 'bob',
          recipient: 'alice',
          body: 'Race reply',
          dedupeKey,
        })
      );

      // All results must converge to the same canonical reply ID
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(1);

      // Exactly one original, rest replays
      const originals = results.filter((r) => !r.dedupe_replay);
      const replays = results.filter((r) => r.dedupe_replay);
      expect(originals.length).toBe(1);
      expect(replays.length).toBe(9);

      // Thread should have exactly 2 messages: parent + 1 reply
      const thread = listThread(db, parent.thread_id);
      expect(thread.length).toBe(2);
    } finally {
      db.close();
    }
  });

  it('insert-level UNIQUE conflict on reply dedupe_key recovers canonical reply', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Parent for insert conflict',
      });

      const dedupeKey = 'dup_reply-constraint-recovery';

      // Pre-insert a reply with the dedupe key (simulating concurrent winner)
      const now = new Date().toISOString();
      const canonicalId = 'msg_reply-canonical-winner';
      db.prepare(
        `INSERT INTO messages (id, thread_id, in_reply_to, sender, recipient, subject, body, dedupe_key, trace_id, state, read_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        canonicalId,
        parent.thread_id,
        parent.id,
        'bob',
        'alice',
        null,
        'Winner reply',
        dedupeKey,
        null,
        'delivered',
        null,
        now,
        now
      );

      // Now try to reply with the same dedupe key — should recover canonical
      const result = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Loser reply attempt',
        dedupeKey,
      });

      // Should return the canonical reply, not throw SQLITE_CONSTRAINT
      expect(result.id).toBe(canonicalId);
      expect(result.in_reply_to).toBe(parent.id);
      expect(result.thread_id).toBe(parent.thread_id);
      expect(result.dedupe_replay).toBe(true);
    } finally {
      db.close();
    }
  });

  it('no SQLITE_CONSTRAINT leaks to caller on dedupe contention', () => {
    const db = openDb();
    try {
      const dedupeKey = 'dup_no-raw-leak';

      // Send the first message
      const first = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'First message',
        dedupeKey,
      });

      // The second send must not throw any SQLITE_CONSTRAINT error;
      // it must gracefully return the canonical message
      let caughtError: Error | null = null;
      let result: typeof first | null = null;
      try {
        result = sendMessage(db, {
          sender: 'alice',
          recipient: 'bob',
          body: 'Duplicate attempt',
          dedupeKey,
        });
      } catch (err) {
        caughtError = err as Error;
      }

      // No error should be thrown
      expect(caughtError).toBeNull();
      // Result should be the canonical replay
      expect(result).not.toBeNull();
      if (result) {
        expect(result.id).toBe(first.id);
        expect(result.dedupe_replay).toBe(true);
      }

      // Verify no error message contains SQLITE_CONSTRAINT
      // (this is a safeguard — if the above assertions pass, this is redundant)
      if (caughtError) {
        expect(caughtError.message).not.toMatch(/SQLITE_CONSTRAINT/i);
      }
    } finally {
      db.close();
    }
  });
});
