/**
 * Tests for the mors watch stream.
 *
 * Covers:
 * - VAL-WATCH-001: Watch streams new message and reply events
 * - VAL-WATCH-002: Watch exits cleanly and leaves terminal usable
 * - VAL-WATCH-003: Watch startup behavior is deterministic
 * - VAL-WATCH-004: Watch does not duplicate runtime events
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initCommand, getDbPath, getDbKeyPath } from '../src/init.js';
import { loadKey } from '../src/key-management.js';
import { openEncryptedDb } from '../src/store.js';
import { sendMessage, replyMessage, ackMessage, readMessage } from '../src/message.js';
import { startWatch } from '../src/watch.js';
import type { WatchEvent } from '../src/watch.js';

let testDir: string;
let configDir: string;

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'mors-watch-test-'));
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

/** Helper to wait for a specific number of events or timeout. */
function collectEvents(
  db: ReturnType<typeof openDb>,
  opts: {
    count: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
    beforeStart?: () => void;
    afterStart?: () => void;
  }
): Promise<{ events: WatchEvent[]; timedOut: boolean }> {
  return new Promise((resolve) => {
    const events: WatchEvent[] = [];
    const timeout = opts.timeoutMs ?? 5000;

    if (opts.beforeStart) {
      opts.beforeStart();
    }

    const handle = startWatch(db, {
      pollIntervalMs: opts.pollIntervalMs ?? 50,
      onEvent: (event) => {
        events.push(event);
        if (events.length >= opts.count) {
          handle.stop();
        }
      },
    });

    if (opts.afterStart) {
      // Give the poll a tick to establish baseline, then do actions.
      const afterStartFn = opts.afterStart;
      setTimeout(() => afterStartFn(), 20);
    }

    const timer = setTimeout(() => {
      handle.stop();
    }, timeout);

    handle.done.then(() => {
      clearTimeout(timer);
      resolve({ events, timedOut: events.length < opts.count });
    });
  });
}

// ---------------------------------------------------------------------------
// VAL-WATCH-001: Watch streams new message and reply events
// ---------------------------------------------------------------------------

describe('VAL-WATCH-001: watch streams new message and reply events', () => {
  it('emits message_created for a new message sent after watch starts', async () => {
    const db = openDb();
    try {
      const { events, timedOut } = await collectEvents(db, {
        count: 1,
        afterStart: () => {
          sendMessage(db, {
            sender: 'alice',
            recipient: 'bob',
            body: 'Hello from watch!',
          });
        },
      });

      expect(timedOut).toBe(false);
      expect(events.length).toBe(1);
      expect(events[0].event_type).toBe('message_created');
      expect(events[0].message_id).toMatch(/^msg_/);
      expect(events[0].thread_id).toMatch(/^thr_/);
      expect(events[0].in_reply_to).toBeNull();
      expect(events[0].sender).toBe('alice');
      expect(events[0].recipient).toBe('bob');
    } finally {
      db.close();
    }
  });

  it('emits reply_created for a reply sent after watch starts', async () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Original message',
      });

      const { events, timedOut } = await collectEvents(db, {
        count: 1,
        afterStart: () => {
          replyMessage(db, {
            parentMessageId: parent.id,
            sender: 'bob',
            recipient: 'alice',
            body: 'Reply message',
          });
        },
      });

      expect(timedOut).toBe(false);
      expect(events.length).toBe(1);
      expect(events[0].event_type).toBe('reply_created');
      expect(events[0].message_id).toMatch(/^msg_/);
      expect(events[0].thread_id).toBe(parent.thread_id);
      expect(events[0].in_reply_to).toBe(parent.id);
    } finally {
      db.close();
    }
  });

  it('emits message_acked when a message is acked after watch starts', async () => {
    const db = openDb();
    try {
      const msg = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'To be acked',
      });
      readMessage(db, msg.id);

      const { events, timedOut } = await collectEvents(db, {
        count: 1,
        afterStart: () => {
          ackMessage(db, msg.id);
        },
      });

      expect(timedOut).toBe(false);
      // Should have at least message_acked
      const ackEvents = events.filter((e) => e.event_type === 'message_acked');
      expect(ackEvents.length).toBe(1);
      expect(ackEvents[0].message_id).toBe(msg.id);
      expect(ackEvents[0].state).toBe('acked');
    } finally {
      db.close();
    }
  });

  it('streams multiple event types for send, reply, and ack', async () => {
    const db = openDb();
    try {
      const { events, timedOut } = await collectEvents(db, {
        count: 3,
        timeoutMs: 5000,
        afterStart: () => {
          const msg = sendMessage(db, {
            sender: 'alice',
            recipient: 'bob',
            body: 'Watch all events',
          });

          replyMessage(db, {
            parentMessageId: msg.id,
            sender: 'bob',
            recipient: 'alice',
            body: 'Reply to it',
          });

          readMessage(db, msg.id);
          ackMessage(db, msg.id);
        },
      });

      expect(timedOut).toBe(false);
      const eventTypes = events.map((e) => e.event_type);
      expect(eventTypes).toContain('message_created');
      expect(eventTypes).toContain('reply_created');
      expect(eventTypes).toContain('message_acked');
    } finally {
      db.close();
    }
  });

  it('event includes required context fields', async () => {
    const db = openDb();
    try {
      const { events, timedOut } = await collectEvents(db, {
        count: 1,
        afterStart: () => {
          sendMessage(db, {
            sender: 'alice',
            recipient: 'bob',
            body: 'Context check',
          });
        },
      });

      expect(timedOut).toBe(false);
      const evt = events[0];
      // All required context fields must be present
      expect(evt).toHaveProperty('event_type');
      expect(evt).toHaveProperty('message_id');
      expect(evt).toHaveProperty('thread_id');
      expect(evt).toHaveProperty('in_reply_to');
      expect(evt).toHaveProperty('sender');
      expect(evt).toHaveProperty('recipient');
      expect(evt).toHaveProperty('state');
      expect(evt).toHaveProperty('timestamp');
      expect(typeof evt.timestamp).toBe('string');
      expect(evt.timestamp.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-WATCH-002: Watch exits cleanly and leaves terminal usable
// ---------------------------------------------------------------------------

describe('VAL-WATCH-002: watch exits cleanly', () => {
  it('stop() resolves done promise and ceases polling', async () => {
    const db = openDb();
    try {
      const events: WatchEvent[] = [];
      const handle = startWatch(db, {
        pollIntervalMs: 50,
        onEvent: (event) => events.push(event),
      });

      // Let it poll a few times.
      await new Promise((r) => setTimeout(r, 150));

      handle.stop();
      await handle.done;

      // After stop, sending a message should not produce events.
      const countBefore = events.length;
      sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'After stop' });
      await new Promise((r) => setTimeout(r, 200));
      expect(events.length).toBe(countBefore);
    } finally {
      db.close();
    }
  });

  it('stop() is idempotent (calling multiple times is safe)', async () => {
    const db = openDb();
    try {
      let shutdownCount = 0;
      const handle = startWatch(db, {
        pollIntervalMs: 50,
        onEvent: () => {},
        onShutdown: () => shutdownCount++,
      });

      handle.stop();
      handle.stop();
      handle.stop();
      await handle.done;

      // onShutdown should only be called once.
      expect(shutdownCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it('AbortController signal stops the watch stream', async () => {
    const db = openDb();
    try {
      const controller = new AbortController();
      let shutdownCalled = false;

      const handle = startWatch(db, {
        pollIntervalMs: 50,
        onEvent: () => {},
        onShutdown: () => {
          shutdownCalled = true;
        },
        signal: controller.signal,
      });

      // Abort after a short delay.
      await new Promise((r) => setTimeout(r, 100));
      controller.abort();
      await handle.done;

      expect(shutdownCalled).toBe(true);
    } finally {
      db.close();
    }
  });

  it('already-aborted signal prevents watch from starting', async () => {
    const db = openDb();
    try {
      const controller = new AbortController();
      controller.abort(); // Abort before starting.

      let shutdownCalled = false;
      const handle = startWatch(db, {
        pollIntervalMs: 50,
        onEvent: () => {},
        onShutdown: () => {
          shutdownCalled = true;
        },
        signal: controller.signal,
      });

      await handle.done;
      expect(shutdownCalled).toBe(true);
    } finally {
      db.close();
    }
  });

  it('onShutdown callback is called when watch stops', async () => {
    const db = openDb();
    try {
      let shutdownCalled = false;
      const handle = startWatch(db, {
        pollIntervalMs: 50,
        onEvent: () => {},
        onShutdown: () => {
          shutdownCalled = true;
        },
      });

      handle.stop();
      await handle.done;
      expect(shutdownCalled).toBe(true);
    } finally {
      db.close();
    }
  });

  it('done promise resolves within bounded time after stop', async () => {
    const db = openDb();
    try {
      const handle = startWatch(db, {
        pollIntervalMs: 50,
        onEvent: () => {},
      });

      const startTime = Date.now();
      handle.stop();
      await handle.done;
      const elapsed = Date.now() - startTime;

      // Should resolve almost immediately (well under 1 second).
      expect(elapsed).toBeLessThan(1000);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-WATCH-003: Watch startup behavior is deterministic
// ---------------------------------------------------------------------------

describe('VAL-WATCH-003: watch startup behavior is deterministic', () => {
  it('does not emit events for messages that exist before watch starts', async () => {
    const db = openDb();
    try {
      // Create messages BEFORE starting watch.
      sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Pre-existing 1' });
      sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Pre-existing 2' });

      const events: WatchEvent[] = [];
      const handle = startWatch(db, {
        pollIntervalMs: 50,
        onEvent: (event) => events.push(event),
      });

      // Wait a bit to give polling time to process.
      await new Promise((r) => setTimeout(r, 300));
      handle.stop();
      await handle.done;

      // Should have zero events — all messages were pre-existing.
      expect(events.length).toBe(0);
    } finally {
      db.close();
    }
  });

  it('only emits events for messages created after watch starts', async () => {
    const db = openDb();
    try {
      // Pre-existing messages.
      sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Old message' });

      const { events, timedOut } = await collectEvents(db, {
        count: 1,
        afterStart: () => {
          sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'New message' });
        },
      });

      expect(timedOut).toBe(false);
      expect(events.length).toBe(1);
      expect(events[0].event_type).toBe('message_created');
    } finally {
      db.close();
    }
  });

  it('does not emit for pre-existing acked messages', async () => {
    const db = openDb();
    try {
      // Create and ack a message before watch.
      const msg = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Pre-acked',
      });
      readMessage(db, msg.id);
      ackMessage(db, msg.id);

      const events: WatchEvent[] = [];
      const handle = startWatch(db, {
        pollIntervalMs: 50,
        onEvent: (event) => events.push(event),
      });

      await new Promise((r) => setTimeout(r, 300));
      handle.stop();
      await handle.done;

      expect(events.length).toBe(0);
    } finally {
      db.close();
    }
  });

  it('startup with empty database emits no events', async () => {
    const db = openDb();
    try {
      const events: WatchEvent[] = [];
      const handle = startWatch(db, {
        pollIntervalMs: 50,
        onEvent: (event) => events.push(event),
      });

      await new Promise((r) => setTimeout(r, 300));
      handle.stop();
      await handle.done;

      expect(events.length).toBe(0);
    } finally {
      db.close();
    }
  });

  it('startup is deterministic across multiple watch sessions', async () => {
    const db = openDb();
    try {
      // Create a message before any watch session.
      sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Pre-existing' });

      // Run two consecutive watch sessions.
      for (let session = 0; session < 2; session++) {
        const events: WatchEvent[] = [];
        const handle = startWatch(db, {
          pollIntervalMs: 50,
          onEvent: (event) => events.push(event),
        });

        await new Promise((r) => setTimeout(r, 200));
        handle.stop();
        await handle.done;

        // Neither session should emit the pre-existing message.
        expect(events.length).toBe(0);
      }
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-WATCH-004: Watch does not duplicate runtime events
// ---------------------------------------------------------------------------

describe('VAL-WATCH-004: watch does not duplicate runtime events', () => {
  it('each message_created event is emitted only once', async () => {
    const db = openDb();
    try {
      const events: WatchEvent[] = [];
      const handle = startWatch(db, {
        pollIntervalMs: 50,
        onEvent: (event) => events.push(event),
      });

      // Give a tick for baseline, then send.
      await new Promise((r) => setTimeout(r, 20));
      sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Single emit test' });

      // Wait several poll cycles.
      await new Promise((r) => setTimeout(r, 500));
      handle.stop();
      await handle.done;

      const createEvents = events.filter((e) => e.event_type === 'message_created');
      expect(createEvents.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('each reply_created event is emitted only once', async () => {
    const db = openDb();
    try {
      const parent = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Parent for dedupe',
      });

      const events: WatchEvent[] = [];
      const handle = startWatch(db, {
        pollIntervalMs: 50,
        onEvent: (event) => events.push(event),
      });

      await new Promise((r) => setTimeout(r, 20));
      replyMessage(db, {
        parentMessageId: parent.id,
        sender: 'bob',
        recipient: 'alice',
        body: 'Reply dedupe test',
      });

      await new Promise((r) => setTimeout(r, 500));
      handle.stop();
      await handle.done;

      const replyEvents = events.filter((e) => e.event_type === 'reply_created');
      expect(replyEvents.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('each message_acked event is emitted only once', async () => {
    const db = openDb();
    try {
      const msg = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Ack dedupe test',
      });
      readMessage(db, msg.id);

      const events: WatchEvent[] = [];
      const handle = startWatch(db, {
        pollIntervalMs: 50,
        onEvent: (event) => events.push(event),
      });

      await new Promise((r) => setTimeout(r, 20));
      ackMessage(db, msg.id);

      await new Promise((r) => setTimeout(r, 500));
      handle.stop();
      await handle.done;

      const ackEvents = events.filter((e) => e.event_type === 'message_acked');
      expect(ackEvents.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('multiple messages each emit exactly one event', async () => {
    const db = openDb();
    try {
      const events: WatchEvent[] = [];
      const handle = startWatch(db, {
        pollIntervalMs: 50,
        onEvent: (event) => events.push(event),
      });

      await new Promise((r) => setTimeout(r, 20));

      const msgIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const msg = sendMessage(db, {
          sender: 'alice',
          recipient: 'bob',
          body: `Message ${i}`,
        });
        msgIds.push(msg.id);
      }

      await new Promise((r) => setTimeout(r, 500));
      handle.stop();
      await handle.done;

      // Each message should have exactly one create event.
      for (const id of msgIds) {
        const eventsForId = events.filter(
          (e) => e.message_id === id && e.event_type === 'message_created'
        );
        expect(eventsForId.length).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it('send+ack sequence emits create and ack events each once', async () => {
    const db = openDb();
    try {
      const events: WatchEvent[] = [];
      const handle = startWatch(db, {
        pollIntervalMs: 50,
        onEvent: (event) => events.push(event),
      });

      await new Promise((r) => setTimeout(r, 20));

      const msg = sendMessage(db, {
        sender: 'alice',
        recipient: 'bob',
        body: 'Send then ack',
      });
      readMessage(db, msg.id);
      ackMessage(db, msg.id);

      await new Promise((r) => setTimeout(r, 500));
      handle.stop();
      await handle.done;

      const createEvents = events.filter(
        (e) => e.message_id === msg.id && e.event_type === 'message_created'
      );
      const ackEvents = events.filter(
        (e) => e.message_id === msg.id && e.event_type === 'message_acked'
      );

      expect(createEvents.length).toBe(1);
      expect(ackEvents.length).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

describe('watch edge cases', () => {
  it('watch handles rapid succession of send/reply/ack', async () => {
    const db = openDb();
    try {
      const { events, timedOut } = await collectEvents(db, {
        count: 4,
        timeoutMs: 5000,
        afterStart: () => {
          const msg1 = sendMessage(db, {
            sender: 'alice',
            recipient: 'bob',
            body: 'Rapid 1',
          });

          const reply = replyMessage(db, {
            parentMessageId: msg1.id,
            sender: 'bob',
            recipient: 'alice',
            body: 'Rapid reply',
          });

          readMessage(db, msg1.id);
          ackMessage(db, msg1.id);

          readMessage(db, reply.id);
          ackMessage(db, reply.id);
        },
      });

      expect(timedOut).toBe(false);
      expect(events.length).toBeGreaterThanOrEqual(4);

      const eventTypes = events.map((e) => e.event_type);
      expect(eventTypes).toContain('message_created');
      expect(eventTypes).toContain('reply_created');
      expect(eventTypes).toContain('message_acked');
    } finally {
      db.close();
    }
  });

  it('watch with very short poll interval still dedupes correctly', async () => {
    const db = openDb();
    try {
      const events: WatchEvent[] = [];
      const handle = startWatch(db, {
        pollIntervalMs: 10, // Very fast polling
        onEvent: (event) => events.push(event),
      });

      await new Promise((r) => setTimeout(r, 20));
      sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Fast poll test' });

      await new Promise((r) => setTimeout(r, 300));
      handle.stop();
      await handle.done;

      const createEvents = events.filter((e) => e.event_type === 'message_created');
      expect(createEvents.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('watch emits events in chronological order', async () => {
    const db = openDb();
    try {
      const { events, timedOut } = await collectEvents(db, {
        count: 3,
        timeoutMs: 5000,
        afterStart: () => {
          sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'First' });
          sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Second' });
          sendMessage(db, { sender: 'alice', recipient: 'bob', body: 'Third' });
        },
      });

      expect(timedOut).toBe(false);
      // Events should be in ascending timestamp order.
      for (let i = 1; i < events.length; i++) {
        expect(events[i].timestamp >= events[i - 1].timestamp).toBe(true);
      }
    } finally {
      db.close();
    }
  });
});
