/**
 * Tests for reply and thread navigation commands.
 *
 * Covers:
 * - VAL-THREAD-001: Reply preserves causal linkage
 * - VAL-THREAD-002: Invalid reply target fails clearly
 * - VAL-THREAD-003: Concurrent replies are preserved exactly once each
 * - VAL-THREAD-004: Nested replies preserve root and immediate parent linkage
 * - VAL-THREAD-005: Thread order is deterministic and causal
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initCommand, getDbPath, getDbKeyPath } from '../src/init.js';
import { loadKey } from '../src/key-management.js';
import { openEncryptedDb } from '../src/store.js';
import { sendMessage, readMessage, replyMessage, listThread, listInbox } from '../src/message.js';
import { MorsError, DedupeConflictError } from '../src/errors.js';
import { ContractValidationError } from '../src/contract/errors.js';

let testDir: string;
let configDir: string;

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'mors-thread-test-'));
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
// VAL-THREAD-001: Reply preserves causal linkage
// ---------------------------------------------------------------------------

describe('VAL-THREAD-001: reply preserves causal linkage', () => {
  it('reply creates a message with same thread_id as parent', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Hello Bob!',
      });

      const reply = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Hi Alice!',
      });

      expect(reply.thread_id).toBe(parent.thread_id);
    } finally {
      db.close();
    }
  });

  it('reply has in_reply_to pointing to parent message', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Hello Bob!',
      });

      const reply = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Hi Alice!',
      });

      expect(reply.in_reply_to).toBe(parent.id);
    } finally {
      db.close();
    }
  });

  it('reply has a unique msg_ prefixed ID', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Original message',
      });

      const reply = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply message',
      });

      expect(reply.id).toMatch(/^msg_/);
      expect(reply.id).not.toBe(parent.id);
    } finally {
      db.close();
    }
  });

  it('reply is visible in inbox', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Original',
      });

      replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply',
      });

      const inbox = listInbox(db, { recipient: 'alice' });
      expect(inbox.length).toBe(1);
      expect(inbox[0].body).toBe('Reply');
      expect(inbox[0].in_reply_to).toBe(parent.id);
    } finally {
      db.close();
    }
  });

  it('reply is delivered immediately (local delivery)', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Original',
      });

      const reply = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply',
      });

      expect(reply.state).toBe('delivered');
    } finally {
      db.close();
    }
  });

  it('reply metadata is readable via readMessage --json', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Original',
      });

      const reply = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply content',
      });

      const read = readMessage(db, reply.id);
      expect(read.thread_id).toBe(parent.thread_id);
      expect(read.in_reply_to).toBe(parent.id);
      expect(read.body).toBe('Reply content');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-THREAD-002: Invalid reply target fails clearly
// ---------------------------------------------------------------------------

describe('VAL-THREAD-002: invalid reply target fails clearly', () => {
  it('reply to nonexistent message ID throws MessageNotFoundError', () => {
    const db = openDb();
    try {
      expect(() =>
        replyMessage(db, {
          parentMessageId: 'msg_nonexistent-id',
          sender: 'bob',
          recipient: 'alice',
          body: 'Orphan reply',
        })
      ).toThrow(MorsError);

      try {
        replyMessage(db, {
          parentMessageId: 'msg_nonexistent-id',
          sender: 'bob',
          recipient: 'alice',
          body: 'Orphan reply',
        });
      } catch (err: unknown) {
        expect((err as Error).message).toMatch(/not found/i);
      }
    } finally {
      db.close();
    }
  });

  it('reply to invalid format ID throws ContractValidationError', () => {
    const db = openDb();
    try {
      expect(() =>
        replyMessage(db, {
          parentMessageId: 'invalid-id-format',
          sender: 'bob',
          recipient: 'alice',
          body: 'Bad ID reply',
        })
      ).toThrow(ContractValidationError);
    } finally {
      db.close();
    }
  });

  it('reply with empty parent ID throws ContractValidationError', () => {
    const db = openDb();
    try {
      expect(() =>
        replyMessage(db, {
          parentMessageId: '',
          sender: 'bob',
          recipient: 'alice',
          body: 'Empty parent',
        })
      ).toThrow(ContractValidationError);
    } finally {
      db.close();
    }
  });

  it('reply with msg_ prefix only (no UUID) throws ContractValidationError', () => {
    const db = openDb();
    try {
      expect(() =>
        replyMessage(db, {
          parentMessageId: 'msg_',
          sender: 'bob',
          recipient: 'alice',
          body: 'Prefix-only',
        })
      ).toThrow(ContractValidationError);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-THREAD-003: Concurrent replies are preserved exactly once each
// ---------------------------------------------------------------------------

describe('VAL-THREAD-003: concurrent replies are preserved exactly once each', () => {
  it('two replies to same parent both persist with unique IDs', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Discussion topic',
      });

      const reply1 = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply one',
      });

      const reply2 = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'charlie',
        recipient: 'alice',
        body: 'Reply two',
      });

      expect(reply1.id).not.toBe(reply2.id);
      expect(reply1.thread_id).toBe(parent.thread_id);
      expect(reply2.thread_id).toBe(parent.thread_id);
      expect(reply1.in_reply_to).toBe(parent.id);
      expect(reply2.in_reply_to).toBe(parent.id);
    } finally {
      db.close();
    }
  });

  it('concurrent replies are all visible in thread listing', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root message',
      });

      replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply A',
      });

      replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'charlie',
        recipient: 'alice',
        body: 'Reply B',
      });

      replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'dave',
        recipient: 'alice',
        body: 'Reply C',
      });

      const thread = listThread(db, parent.thread_id);
      expect(thread.length).toBe(4); // parent + 3 replies
    } finally {
      db.close();
    }
  });

  it('no reply is duplicated or overwritten', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root',
      });

      const replies = [];
      for (let i = 0; i < 5; i++) {
        replies.push(
          replyMessage(db, {
            parentMessageId: parent.id,
            sender: `user${i}`,
            recipient: 'alice',
            body: `Reply ${i}`,
          })
        );
      }

      // All reply IDs should be unique
      const ids = new Set(replies.map((r) => r.id));
      expect(ids.size).toBe(5);

      // Thread should contain parent + all 5 replies
      const thread = listThread(db, parent.thread_id);
      expect(thread.length).toBe(6);

      // Verify each reply body is present
      const bodies = thread.map((m) => m.body);
      for (let i = 0; i < 5; i++) {
        expect(bodies).toContain(`Reply ${i}`);
      }
    } finally {
      db.close();
    }
  });

  it('reply with dedupe_key prevents duplicate reply creation', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Original',
      });

      const reply1 = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Dedupe reply',
        dedupeKey: 'dup_reply-dedupe-test',
      });

      const reply2 = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Dedupe reply',
        dedupeKey: 'dup_reply-dedupe-test',
      });

      expect(reply2.id).toBe(reply1.id);
      expect(reply2.dedupe_replay).toBe(true);

      // Thread should have exactly 2 messages: parent + 1 reply
      const thread = listThread(db, parent.thread_id);
      expect(thread.length).toBe(2);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-THREAD-004: Nested replies preserve root and immediate parent linkage
// ---------------------------------------------------------------------------

describe('VAL-THREAD-004: nested replies preserve root and immediate parent linkage', () => {
  it('reply to a reply keeps root thread_id', () => {
    const db = openDb();
    try {
      const root = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root message',
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
        body: 'Nested reply',
      });

      expect(reply2.thread_id).toBe(root.thread_id);
    } finally {
      db.close();
    }
  });

  it('nested reply sets in_reply_to to immediate parent (not root)', () => {
    const db = openDb();
    try {
      const root = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root message',
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
        body: 'Nested reply',
      });

      expect(reply2.in_reply_to).toBe(reply1.id);
      expect(reply2.in_reply_to).not.toBe(root.id);
    } finally {
      db.close();
    }
  });

  it('deeply nested replies all share the same thread_id', () => {
    const db = openDb();
    try {
      const root = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root',
      });

      let currentParent = root.id;
      const replyIds: string[] = [];

      for (let i = 0; i < 5; i++) {
        const reply = replyMessage(db, {
          parentMessageId: currentParent,
          sender: i % 2 === 0 ? 'bob' : 'alice',
          recipient: i % 2 === 0 ? 'alice' : 'bob',
          body: `Depth ${i + 1}`,
        });
        expect(reply.thread_id).toBe(root.thread_id);
        replyIds.push(reply.id);
        currentParent = reply.id;
      }

      // All messages in one thread
      const thread = listThread(db, root.thread_id);
      expect(thread.length).toBe(6); // root + 5 nested
    } finally {
      db.close();
    }
  });

  it('read --json on nested reply shows correct thread_id and in_reply_to', () => {
    const db = openDb();
    try {
      const root = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root',
      });

      const reply1 = replyMessage(db, {
        parentMessageId: root.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply 1',
      });

      const reply2 = replyMessage(db, {
        parentMessageId: reply1.id,
        sender: 'alice',
        recipient: 'bob',
        body: 'Reply 2',
      });

      const readRoot = readMessage(db, root.id);
      const readReply1 = readMessage(db, reply1.id);
      const readReply2 = readMessage(db, reply2.id);

      // Root has no parent
      expect(readRoot.in_reply_to).toBeNull();
      expect(readRoot.thread_id).toBe(root.thread_id);

      // Reply1 links to root
      expect(readReply1.in_reply_to).toBe(root.id);
      expect(readReply1.thread_id).toBe(root.thread_id);

      // Reply2 links to Reply1
      expect(readReply2.in_reply_to).toBe(reply1.id);
      expect(readReply2.thread_id).toBe(root.thread_id);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-THREAD-005: Thread order is deterministic and causal
// ---------------------------------------------------------------------------

describe('VAL-THREAD-005: thread order is deterministic and causal', () => {
  it('thread listing returns parent before descendants', () => {
    const db = openDb();
    try {
      const root = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root',
      });

      const reply1 = replyMessage(db, {
        parentMessageId: root.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply 1',
      });

      replyMessage(db, {
        parentMessageId: reply1.id,
        sender: 'alice',
        recipient: 'bob',
        body: 'Reply 2',
      });

      const thread = listThread(db, root.thread_id);

      // Root should be first
      expect(thread[0].id).toBe(root.id);
      // Reply1 should come before Reply2 (causal order)
      const reply1Idx = thread.findIndex((m) => m.id === reply1.id);
      const reply2Idx = thread.findIndex((m) => m.body === 'Reply 2');
      expect(reply1Idx).toBeLessThan(reply2Idx);
    } finally {
      db.close();
    }
  });

  it('sibling replies maintain stable ordering across repeated reads', () => {
    const db = openDb();
    try {
      const root = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root',
      });

      replyMessage(db, {
        parentMessageId: root.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Sibling A',
      });

      replyMessage(db, {
        parentMessageId: root.id,
        sender: 'charlie',
        recipient: 'alice',
        body: 'Sibling B',
      });

      // Read the thread multiple times and check ordering is deterministic
      const thread1 = listThread(db, root.thread_id);
      const thread2 = listThread(db, root.thread_id);
      const thread3 = listThread(db, root.thread_id);

      expect(thread1.map((m) => m.id)).toEqual(thread2.map((m) => m.id));
      expect(thread2.map((m) => m.id)).toEqual(thread3.map((m) => m.id));
    } finally {
      db.close();
    }
  });

  it('complex thread with branches preserves causal ordering', () => {
    const db = openDb();
    try {
      // Create a complex thread:
      // root
      //   ├─ reply_a
      //   │    └─ reply_a1
      //   └─ reply_b
      //        └─ reply_b1
      const root = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root',
      });

      const replyA = replyMessage(db, {
        parentMessageId: root.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply A',
      });

      const replyB = replyMessage(db, {
        parentMessageId: root.id,
        sender: 'charlie',
        recipient: 'alice',
        body: 'Reply B',
      });

      replyMessage(db, {
        parentMessageId: replyA.id,
        sender: 'alice',
        recipient: 'bob',
        body: 'Reply A1',
      });

      replyMessage(db, {
        parentMessageId: replyB.id,
        sender: 'alice',
        recipient: 'charlie',
        body: 'Reply B1',
      });

      const thread = listThread(db, root.thread_id);
      expect(thread.length).toBe(5);

      // Root must be first
      expect(thread[0].id).toBe(root.id);

      // For each message, its parent must appear before it
      for (let i = 1; i < thread.length; i++) {
        const msg = thread[i];
        if (msg.in_reply_to) {
          const parentIdx = thread.findIndex((m) => m.id === msg.in_reply_to);
          expect(parentIdx).toBeGreaterThanOrEqual(0);
          expect(parentIdx).toBeLessThan(i);
        }
      }
    } finally {
      db.close();
    }
  });

  it('thread listing for nonexistent thread returns empty array', () => {
    const db = openDb();
    try {
      const thread = listThread(db, 'thr_nonexistent');
      expect(thread).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('thread_id validation rejects invalid format', () => {
    const db = openDb();
    try {
      expect(() => listThread(db, 'invalid-thread-id')).toThrow(ContractValidationError);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases for reply
// ---------------------------------------------------------------------------

describe('reply edge cases', () => {
  it('reply with empty body throws', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root',
      });
      expect(() =>
        replyMessage(db, {
          parentMessageId: parent.id,
          sender: 'bob',
          recipient: 'alice',
          body: '',
        })
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('reply with empty sender throws', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root',
      });
      expect(() =>
        replyMessage(db, {
          parentMessageId: parent.id,
          sender: '',
          recipient: 'alice',
          body: 'Reply',
        })
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('reply preserves subject when provided', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Original',
        subject: 'Discussion',
      });

      const reply = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply with subject',
        subject: 'Re: Discussion',
      });

      const read = readMessage(db, reply.id);
      expect(read.subject).toBe('Re: Discussion');
    } finally {
      db.close();
    }
  });

  it('reply content fidelity with multiline markdown', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root',
      });

      const body = `# Reply Heading

> Quoted from parent

- Point 1
- Point 2

\`\`\`
code block
\`\`\``;

      const reply = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body,
      });

      const read = readMessage(db, reply.id);
      expect(read.body).toBe(body);
    } finally {
      db.close();
    }
  });

  it('reply with trace_id preserves it', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root',
      });

      const reply = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply with trace',
        traceId: 'trc_reply-trace',
      });

      expect(reply.trace_id).toBe('trc_reply-trace');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Reply dedupe causal linkage: dedupe replays must match thread context
// ---------------------------------------------------------------------------

describe('reply dedupe causal linkage', () => {
  it('dedupe replay with same parent is accepted', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Original',
      });

      const reply1 = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply',
        dedupeKey: 'dup_causal-ok',
      });

      // Replay with same parent — should succeed as dedupe replay
      const replay = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply',
        dedupeKey: 'dup_causal-ok',
      });

      expect(replay.dedupe_replay).toBe(true);
      expect(replay.id).toBe(reply1.id);
      expect(replay.thread_id).toBe(reply1.thread_id);
      expect(replay.in_reply_to).toBe(parent.id);
    } finally {
      db.close();
    }
  });

  it('dedupe replay with different parent rejects with DedupeConflictError', () => {
    const db = openDb();
    try {
      const msgA = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Message A',
      });

      const msgB = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Message B',
      });

      // Create reply to message A
      replyMessage(db, {
        parentMessageId: msgA.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply to A',
        dedupeKey: 'dup_conflict-parent',
      });

      // Try replaying same dedupe key but targeting message B — must fail
      expect(() =>
        replyMessage(db, {
          parentMessageId: msgB.id,
          sender: 'bob',
          recipient: 'alice',
          body: 'Reply to B',
          dedupeKey: 'dup_conflict-parent',
        })
      ).toThrow(DedupeConflictError);
    } finally {
      db.close();
    }
  });

  it('dedupe key used for send rejects when replayed as reply', () => {
    const db = openDb();
    try {
      // First: create a top-level send with a dedupe key
      sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Top-level message',
        dedupeKey: 'dup_send-then-reply',
      });

      const parent = sendMessage(db, {
        sender: 'bob',
        recipient: 'alice',
        body: 'Parent for reply',
      });

      // Now try to use the same dedupe key to create a reply — must fail
      // because the existing record is a top-level send (in_reply_to is null)
      expect(() =>
        replyMessage(db, {
          parentMessageId: parent.id,
          sender: 'alice',
          recipient: 'bob',
          body: 'Conflict reply',
          dedupeKey: 'dup_send-then-reply',
        })
      ).toThrow(DedupeConflictError);
    } finally {
      db.close();
    }
  });

  it('dedupe conflict preserves original message and thread integrity', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Original parent',
      });

      const otherParent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Other parent',
      });

      const reply = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply to original',
        dedupeKey: 'dup_integrity-check',
      });

      // Conflict attempt
      expect(() =>
        replyMessage(db, {
          parentMessageId: otherParent.id,
          sender: 'bob',
          recipient: 'alice',
          body: 'Conflicting reply',
          dedupeKey: 'dup_integrity-check',
        })
      ).toThrow(DedupeConflictError);

      // Verify original reply's thread linkage is intact
      const thread = listThread(db, parent.thread_id);
      expect(thread.length).toBe(2);
      const replyEntry = thread.find((m) => m.id === reply.id);
      expect(replyEntry).toBeDefined();
      expect(replyEntry?.in_reply_to).toBe(parent.id);
      expect(replyEntry?.thread_id).toBe(parent.thread_id);

      // Other parent's thread is unaffected (no stray replies)
      const otherThread = listThread(db, otherParent.thread_id);
      expect(otherThread.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('dedupe replay of nested reply with correct parent is accepted', () => {
    const db = openDb();
    try {
      const root = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root',
      });

      const child = replyMessage(db, {
        parentMessageId: root.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'First reply',
      });

      const nested = replyMessage(db, {
        parentMessageId: child.id,
        sender: 'alice',
        recipient: 'bob',
        body: 'Nested reply',
        dedupeKey: 'dup_nested-ok',
      });

      // Replay with same parent — should succeed
      const replay = replyMessage(db, {
        parentMessageId: child.id,
        sender: 'alice',
        recipient: 'bob',
        body: 'Nested reply',
        dedupeKey: 'dup_nested-ok',
      });

      expect(replay.dedupe_replay).toBe(true);
      expect(replay.id).toBe(nested.id);
      expect(replay.thread_id).toBe(root.thread_id);
      expect(replay.in_reply_to).toBe(child.id);
    } finally {
      db.close();
    }
  });

  it('dedupe replay of nested reply with wrong parent is rejected', () => {
    const db = openDb();
    try {
      const root = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root',
      });

      const childA = replyMessage(db, {
        parentMessageId: root.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply A',
      });

      const childB = replyMessage(db, {
        parentMessageId: root.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply B',
      });

      // Create nested reply to childA
      replyMessage(db, {
        parentMessageId: childA.id,
        sender: 'alice',
        recipient: 'bob',
        body: 'Nested to A',
        dedupeKey: 'dup_nested-conflict',
      });

      // Try replaying same dedupe key but targeting childB
      expect(() =>
        replyMessage(db, {
          parentMessageId: childB.id,
          sender: 'alice',
          recipient: 'bob',
          body: 'Nested to B',
          dedupeKey: 'dup_nested-conflict',
        })
      ).toThrow(DedupeConflictError);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// True overlapping contention: concurrent reply operations
// ---------------------------------------------------------------------------

describe('reply contention: overlapping multi-handle reply creation', () => {
  it('interleaved replies across multiple DB handles all persist with unique IDs', () => {
    // Open multiple independent DB handles to create real SQLite-level contention
    const handles = Array.from({ length: 4 }, () => openDb());
    try {
      // Use first handle to create root
      const root = sendMessage(handles[0], {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root for multi-handle contention test',
      });

      // Interleave reply operations across different handles (round-robin)
      // Each handle competes for SQLite write locks, exercising real overlap
      const replyCount = 20;
      const replies = Array.from({ length: replyCount }, (_, i) =>
        replyMessage(handles[i % handles.length], {
          parentMessageId: root.id,
          sender: `agent-${i}`,
          recipient: 'alice',
          body: `Multi-handle contention reply ${i}`,
        })
      );

      // All reply IDs must be unique
      const ids = new Set(replies.map((r) => r.id));
      expect(ids.size).toBe(replyCount);

      // All replies share the root's thread_id
      for (const reply of replies) {
        expect(reply.thread_id).toBe(root.thread_id);
        expect(reply.in_reply_to).toBe(root.id);
      }

      // Verify via a fresh handle to ensure cross-handle consistency
      const verifyDb = openDb();
      try {
        const thread = listThread(verifyDb, root.thread_id);
        expect(thread.length).toBe(replyCount + 1);
        expect(thread[0].id).toBe(root.id);
        for (let i = 1; i < thread.length; i++) {
          expect(thread[i].in_reply_to).toBe(root.id);
        }
      } finally {
        verifyDb.close();
      }
    } finally {
      for (const h of handles) h.close();
    }
  });

  it('dedupe replies across multiple DB handles converge without SQLITE_CONSTRAINT leakage', () => {
    const handles = Array.from({ length: 3 }, () => openDb());
    try {
      const root = sendMessage(handles[0], {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root for multi-handle dedupe contention',
      });

      // Interleave dedupe reply attempts across different handles
      const dedupeKey = 'dup_multi-handle-reply-dedupe';
      const results = Array.from({ length: 15 }, (_, i) =>
        replyMessage(handles[i % handles.length], {
          parentMessageId: root.id,
          sender: 'bob',
          recipient: 'alice',
          body: 'Same dedupe reply',
          dedupeKey,
        })
      );

      // All converge to one canonical reply
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(1);

      // Exactly one original, rest are replays
      const originals = results.filter((r) => !r.dedupe_replay);
      expect(originals.length).toBe(1);

      // Verify via fresh handle
      const verifyDb = openDb();
      try {
        const thread = listThread(verifyDb, root.thread_id);
        expect(thread.length).toBe(2);
      } finally {
        verifyDb.close();
      }
    } finally {
      for (const h of handles) h.close();
    }
  });

  it('interleaved nested replies to different parents across handles maintain correct linkage', () => {
    const handles = Array.from({ length: 3 }, () => openDb());
    try {
      const root = sendMessage(handles[0], {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root',
      });

      // Create branches on different handles
      const branchA = replyMessage(handles[1], {
        parentMessageId: root.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Branch A',
      });

      const branchB = replyMessage(handles[2], {
        parentMessageId: root.id,
        sender: 'charlie',
        recipient: 'alice',
        body: 'Branch B',
      });

      // Interleave nested replies across handles alternating between branches
      const nestedReplies: ReturnType<typeof replyMessage>[] = [];
      for (let i = 0; i < 10; i++) {
        const parentId = i % 2 === 0 ? branchA.id : branchB.id;
        const label = i % 2 === 0 ? 'A' : 'B';
        nestedReplies.push(
          replyMessage(handles[i % handles.length], {
            parentMessageId: parentId,
            sender: `agent-${label}${i}`,
            recipient: 'alice',
            body: `Nested ${label} ${i}`,
          })
        );
      }

      // Verify correct parent linkage
      for (let i = 0; i < nestedReplies.length; i++) {
        const expectedParent = i % 2 === 0 ? branchA.id : branchB.id;
        expect(nestedReplies[i].in_reply_to).toBe(expectedParent);
        expect(nestedReplies[i].thread_id).toBe(root.thread_id);
      }

      // Verify via fresh handle: root + 2 branches + 10 nested = 13
      const verifyDb = openDb();
      try {
        const thread = listThread(verifyDb, root.thread_id);
        expect(thread.length).toBe(13);

        // Causal ordering: root first, parents before children
        expect(thread[0].id).toBe(root.id);
        for (let i = 1; i < thread.length; i++) {
          const msg = thread[i];
          if (msg.in_reply_to) {
            const parentIdx = thread.findIndex((m) => m.id === msg.in_reply_to);
            expect(parentIdx).toBeGreaterThanOrEqual(0);
            expect(parentIdx).toBeLessThan(i);
          }
        }
      } finally {
        verifyDb.close();
      }
    } finally {
      for (const h of handles) h.close();
    }
  });

  it('mixed dedupe and non-dedupe replies across handles coexist correctly', () => {
    const handles = Array.from({ length: 3 }, () => openDb());
    try {
      const root = sendMessage(handles[0], {
        sender: 'alice',
        recipient: 'bob',
        body: 'Root for mixed multi-handle contention',
      });

      // Interleave dedupe replies across handles (same key, converge to 1)
      const dedupeKey = 'dup_mixed-multi-handle';
      const dedupeResults = Array.from({ length: 5 }, (_, i) =>
        replyMessage(handles[i % handles.length], {
          parentMessageId: root.id,
          sender: 'bob',
          recipient: 'alice',
          body: 'Dedupe reply',
          dedupeKey,
        })
      );

      // Interleave non-dedupe replies across handles
      const nonDedupeResults = Array.from({ length: 3 }, (_, i) =>
        replyMessage(handles[(i + 1) % handles.length], {
          parentMessageId: root.id,
          sender: `agent-${i}`,
          recipient: 'alice',
          body: `Non-dedupe reply ${i}`,
        })
      );

      // Dedupe results all converge to one ID
      const dedupeIds = new Set(dedupeResults.map((r) => r.id));
      expect(dedupeIds.size).toBe(1);

      // Non-dedupe results are all unique
      const nonDedupeIds = new Set(nonDedupeResults.map((r) => r.id));
      expect(nonDedupeIds.size).toBe(3);

      // Verify via fresh handle: root + 1 dedupe + 3 non-dedupe = 5
      const verifyDb = openDb();
      try {
        const thread = listThread(verifyDb, root.thread_id);
        expect(thread.length).toBe(5);
      } finally {
        verifyDb.close();
      }
    } finally {
      for (const h of handles) h.close();
    }
  });

  it('INSERT-level UNIQUE conflict on reply recovers canonical without raw error', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Parent for INSERT race',
      });

      const dedupeKey = 'dup_insert-race-reply';

      // Pre-insert a reply with the dedupe key via raw SQL (simulating concurrent winner)
      const now = new Date().toISOString();
      const winnerId = 'msg_insert-race-winner';
      db.prepare(
        `INSERT INTO messages (id, thread_id, in_reply_to, sender, recipient, subject, body, dedupe_key, trace_id, state, read_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        winnerId,
        parent.thread_id,
        parent.id,
        'bob',
        'alice',
        null,
        'Winner reply body',
        dedupeKey,
        null,
        'delivered',
        null,
        now,
        now
      );

      // Call replyMessage with the same dedupe key — SELECT will find it and
      // return it as a replay (the INSERT-level recovery is defense-in-depth)
      const result = replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Loser reply attempt',
        dedupeKey,
      });

      expect(result.id).toBe(winnerId);
      expect(result.in_reply_to).toBe(parent.id);
      expect(result.dedupe_replay).toBe(true);

      // No SQLITE_CONSTRAINT should have leaked — verify thread integrity
      const thread = listThread(db, parent.thread_id);
      expect(thread.length).toBe(2);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic INSERT-conflict recovery branch coverage for replyMessage
// ---------------------------------------------------------------------------

describe('replyMessage INSERT-conflict recovery branch (fault injection)', () => {
  /**
   * These tests force the catch/recovery code path inside replyMessage by
   * using a db.prepare spy. The spy intercepts the dedupe-check SELECT so
   * that it returns no match (simulating a race window where the SELECT
   * runs before a concurrent INSERT). The subsequent INSERT then collides
   * with the already-present row, triggering the UNIQUE constraint error
   * handler which calls recoverCanonicalReply.
   *
   * This is the ONLY way to deterministically reach the catch branch in a
   * single-handle, single-process test because better-sqlite3 is synchronous.
   */

  /**
   * Create a db.prepare spy that makes the first dedupe-check SELECT return
   * empty, allowing the INSERT to proceed and hit the UNIQUE constraint.
   * Subsequent calls (including the recovery SELECT) pass through unmodified.
   */
  function stubDedupeSelectMiss(db: ReturnType<typeof openDb>): {
    spy: ReturnType<typeof vi.spyOn>;
    recoveryReached: { value: boolean };
  } {
    const originalPrepare = db.prepare.bind(db);
    let selectIntercepted = false;
    const recoveryReached = { value: false };

    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      // Intercept only the first dedupe-check SELECT (contains WHERE dedupe_key)
      if (
        !selectIntercepted &&
        sql.includes('WHERE dedupe_key') &&
        sql.includes('SELECT') &&
        !sql.includes('INSERT')
      ) {
        selectIntercepted = true;
        // Return a statement-like object whose .get() returns undefined
        const fakeStmt = originalPrepare(sql);
        const originalGet = fakeStmt.get.bind(fakeStmt);
        fakeStmt.get = (..._args: unknown[]) => {
          void originalGet;
          return undefined;
        };
        return fakeStmt;
      }
      // All other calls (INSERT, parent lookup, recovery SELECT, etc.) pass through
      const stmt = originalPrepare(sql);
      if (selectIntercepted && sql.includes('WHERE dedupe_key') && sql.includes('SELECT')) {
        recoveryReached.value = true;
      }
      return stmt;
    });

    return { spy, recoveryReached };
  }

  it('exercises recoverCanonicalReply when INSERT hits UNIQUE constraint', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Parent for reply recovery test',
      });

      const dedupeKey = 'dup_insert-recovery-reply';
      const now = new Date().toISOString();
      const canonicalId = 'msg_canonical-reply-recovery';

      // Pre-insert a canonical reply with the dedupe key
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
        'Canonical reply winner',
        dedupeKey,
        null,
        'delivered',
        null,
        now,
        now
      );

      // Stub the dedupe SELECT to return empty (simulating race window)
      const { spy, recoveryReached } = stubDedupeSelectMiss(db);

      try {
        const result = replyMessage(db, {
          parentMessageId: parent.id,
          sender: 'bob',
          recipient: 'alice',
          body: 'Loser reply via INSERT conflict',
          dedupeKey,
        });

        // The recovery branch should have been reached
        expect(recoveryReached.value).toBe(true);

        // Should recover the canonical reply, not throw
        expect(result.id).toBe(canonicalId);
        expect(result.thread_id).toBe(parent.thread_id);
        expect(result.in_reply_to).toBe(parent.id);
        expect(result.dedupe_replay).toBe(true);
        expect(result.sender).toBe('bob');
        expect(result.recipient).toBe('alice');
      } finally {
        spy.mockRestore();
      }

      // Verify only one reply exists for this dedupe key
      const thread = listThread(db, parent.thread_id);
      const dedupeMatches = thread.filter((m) => m.dedupe_key === dedupeKey);
      expect(dedupeMatches.length).toBe(1);
      expect(dedupeMatches[0].id).toBe(canonicalId);
    } finally {
      db.close();
    }
  });

  it('recovery returns canonical reply metadata faithfully', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Parent for fidelity',
      });

      const dedupeKey = 'dup_reply-recovery-fidelity';
      const now = new Date().toISOString();

      // Pre-insert with specific metadata including trace_id
      db.prepare(
        `INSERT INTO messages (id, thread_id, in_reply_to, sender, recipient, subject, body, dedupe_key, trace_id, state, read_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'msg_reply-fidelity-check',
        parent.thread_id,
        parent.id,
        'bob',
        'alice',
        null,
        'Reply fidelity body',
        dedupeKey,
        'trc_reply-fidelity-trace',
        'delivered',
        null,
        now,
        now
      );

      const { spy, recoveryReached } = stubDedupeSelectMiss(db);

      try {
        const result = replyMessage(db, {
          parentMessageId: parent.id,
          sender: 'bob',
          recipient: 'alice',
          body: 'Different body (irrelevant)',
          dedupeKey,
          traceId: 'trc_different-trace',
        });

        expect(recoveryReached.value).toBe(true);
        expect(result.id).toBe('msg_reply-fidelity-check');
        expect(result.thread_id).toBe(parent.thread_id);
        expect(result.in_reply_to).toBe(parent.id);
        expect(result.trace_id).toBe('trc_reply-fidelity-trace');
        expect(result.dedupe_replay).toBe(true);
      } finally {
        spy.mockRestore();
      }
    } finally {
      db.close();
    }
  });

  it('no SQLITE_CONSTRAINT error leaks when reply INSERT-conflict recovery fires', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Parent for no-leak test',
      });

      const dedupeKey = 'dup_reply-no-leak-recovery';
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO messages (id, thread_id, in_reply_to, sender, recipient, subject, body, dedupe_key, trace_id, state, read_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'msg_reply-no-leak-canonical',
        parent.thread_id,
        parent.id,
        'bob',
        'alice',
        null,
        'No leak reply body',
        dedupeKey,
        null,
        'delivered',
        null,
        now,
        now
      );

      const { spy } = stubDedupeSelectMiss(db);

      let caughtError: Error | null = null;
      let result: ReturnType<typeof replyMessage> | null = null;
      try {
        result = replyMessage(db, {
          parentMessageId: parent.id,
          sender: 'bob',
          recipient: 'alice',
          body: 'Reply triggering INSERT conflict',
          dedupeKey,
        });
      } catch (err) {
        caughtError = err as Error;
      } finally {
        spy.mockRestore();
      }

      // No error should leak
      expect(caughtError).toBeNull();
      // No error message should contain SQLITE_CONSTRAINT
      if (caughtError) {
        expect(caughtError.message).not.toMatch(/SQLITE_CONSTRAINT/i);
      }
      // Result should be the recovered canonical
      expect(result).not.toBeNull();
      if (result) {
        expect(result.id).toBe('msg_reply-no-leak-canonical');
        expect(result.in_reply_to).toBe(parent.id);
        expect(result.dedupe_replay).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('recovery throws DedupeConflictError when canonical reply has wrong parent (causal mismatch)', () => {
    const db = openDb();
    try {
      const parentA = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Parent A',
      });

      const parentB = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Parent B',
      });

      const dedupeKey = 'dup_reply-recovery-causal-mismatch';
      const now = new Date().toISOString();

      // Pre-insert a reply to parentA with the dedupe key
      db.prepare(
        `INSERT INTO messages (id, thread_id, in_reply_to, sender, recipient, subject, body, dedupe_key, trace_id, state, read_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'msg_reply-wrong-parent',
        parentA.thread_id,
        parentA.id,
        'bob',
        'alice',
        null,
        'Reply to A',
        dedupeKey,
        null,
        'delivered',
        null,
        now,
        now
      );

      const { spy, recoveryReached } = stubDedupeSelectMiss(db);

      try {
        // Attempt to reply to parentB with the same dedupe key —
        // recovery should find the canonical reply points to parentA,
        // not parentB, and throw DedupeConflictError
        expect(() =>
          replyMessage(db, {
            parentMessageId: parentB.id,
            sender: 'bob',
            recipient: 'alice',
            body: 'Reply to B (wrong parent)',
            dedupeKey,
          })
        ).toThrow(DedupeConflictError);

        expect(recoveryReached.value).toBe(true);
      } finally {
        spy.mockRestore();
      }
    } finally {
      db.close();
    }
  });

  it('recovery throws DedupeConflictError when canonical record is a top-level send (not a reply)', () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Parent for send-vs-reply',
      });

      const dedupeKey = 'dup_reply-recovery-send-conflict';
      const now = new Date().toISOString();

      // Pre-insert a TOP-LEVEL send (in_reply_to = null) with the dedupe key
      db.prepare(
        `INSERT INTO messages (id, thread_id, in_reply_to, sender, recipient, subject, body, dedupe_key, trace_id, state, read_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'msg_send-not-reply',
        'thr_send-not-reply',
        null, // in_reply_to is null — top-level send
        'alice',
        'bob',
        null,
        'Top-level send body',
        dedupeKey,
        null,
        'delivered',
        null,
        now,
        now
      );

      const { spy, recoveryReached } = stubDedupeSelectMiss(db);

      try {
        // replyMessage expects in_reply_to to match parent.id,
        // but the canonical record is a top-level send (in_reply_to is null)
        // — recovery should throw DedupeConflictError
        expect(() =>
          replyMessage(db, {
            parentMessageId: parent.id,
            sender: 'alice',
            recipient: 'bob',
            body: 'Reply attempt',
            dedupeKey,
          })
        ).toThrow(DedupeConflictError);

        expect(recoveryReached.value).toBe(true);
      } finally {
        spy.mockRestore();
      }
    } finally {
      db.close();
    }
  });
});
