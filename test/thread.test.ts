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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initCommand, getDbPath, getDbKeyPath } from '../src/init.js';
import { loadKey } from '../src/key-management.js';
import { openEncryptedDb } from '../src/store.js';
import { sendMessage, readMessage, replyMessage, listThread, listInbox } from '../src/message.js';
import { MorsError } from '../src/errors.js';
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
