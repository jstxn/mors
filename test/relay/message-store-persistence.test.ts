/**
 * Tests for RelayMessageStore snapshot/rehydration (persistence boundary).
 *
 * Validates that the message store can serialize its state to a plain object
 * and reconstruct a new store instance from that serialized state, crossing
 * a true persistence boundary (no shared in-memory references).
 *
 * This directly supports VAL-CROSS-008 requirements: restart integrity tests
 * must cross a real persistence boundary (persist + rehydrate), not reuse
 * the same in-memory store instance.
 */

import { describe, it, expect } from 'vitest';
import { RelayMessageStore } from '../../src/relay/message-store.js';

describe('RelayMessageStore persistence boundary', () => {
  it('snapshot returns a JSON-serializable plain object', () => {
    const store = new RelayMessageStore();
    store.send(1001, 'alice', { recipientId: 1002, body: 'hello' });

    const snapshot = store.snapshot();
    // Must be JSON-serializable (round-trip through JSON)
    const json = JSON.stringify(snapshot);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(snapshot);
  });

  it('fromSnapshot recreates store with identical message state', () => {
    const store = new RelayMessageStore();
    const { message } = store.send(1001, 'alice', { recipientId: 1002, body: 'test msg' });

    const snapshot = store.snapshot();
    const restored = RelayMessageStore.fromSnapshot(snapshot);

    // Restored store returns same message via inbox
    const inbox = restored.inbox(1002);
    expect(inbox.length).toBe(1);
    expect(inbox[0].id).toBe(message.id);
    expect(inbox[0].body).toBe('test msg');
    expect(inbox[0].state).toBe('delivered');
  });

  it('fromSnapshot preserves read and ack state', () => {
    const store = new RelayMessageStore();
    const { message } = store.send(1001, 'alice', { recipientId: 1002, body: 'read+ack test' });
    store.read(message.id, 1002);
    store.ack(message.id, 1002);

    const snapshot = store.snapshot();
    const restored = RelayMessageStore.fromSnapshot(snapshot);

    const inbox = restored.inbox(1002);
    expect(inbox[0].state).toBe('acked');
    expect(inbox[0].read_at).not.toBeNull();
    expect(inbox[0].acked_at).not.toBeNull();
  });

  it('fromSnapshot preserves dedupe index across boundary', () => {
    const store = new RelayMessageStore();
    const { message } = store.send(1001, 'alice', {
      recipientId: 1002,
      body: 'deduped',
      dedupeKey: 'dk-001',
    });

    const snapshot = store.snapshot();
    const restored = RelayMessageStore.fromSnapshot(snapshot);

    // Retry with same dedupe key should return canonical message
    const retry = restored.send(1001, 'alice', {
      recipientId: 1002,
      body: 'deduped',
      dedupeKey: 'dk-001',
    });
    expect(retry.created).toBe(false);
    expect(retry.message.id).toBe(message.id);
  });

  it('fromSnapshot preserves thread participant tracking', () => {
    const store = new RelayMessageStore();
    const { message: root } = store.send(1001, 'alice', { recipientId: 1002, body: 'root' });
    store.send(1002, 'bob', {
      recipientId: 1001,
      body: 'reply',
      inReplyTo: root.id,
    });

    const snapshot = store.snapshot();
    const restored = RelayMessageStore.fromSnapshot(snapshot);

    // Both participants should be recognized
    expect(restored.isParticipant(root.thread_id, 1001)).toBe(true);
    expect(restored.isParticipant(root.thread_id, 1002)).toBe(true);
    // Non-participant should not be
    expect(restored.isParticipant(root.thread_id, 9999)).toBe(false);
  });

  it('fromSnapshot preserves event log for SSE cursor resume', () => {
    const store = new RelayMessageStore();
    store.send(1001, 'alice', { recipientId: 1002, body: 'msg1' });
    store.send(1001, 'alice', { recipientId: 1002, body: 'msg2' });

    // Register a cursor position to test eventIdIndex preservation
    store.registerCursorPosition('cursor-test-001');

    store.send(1001, 'alice', { recipientId: 1002, body: 'msg3' });

    const snapshot = store.snapshot();
    const restored = RelayMessageStore.fromSnapshot(snapshot);

    // Events after the cursor should only include msg3's event
    const eventsSince = restored.getEventsSince('cursor-test-001');
    expect(eventsSince.length).toBe(1);
    expect(eventsSince[0].event_type).toBe('message_created');
  });

  it('fromSnapshot produces an independent store (no shared references)', () => {
    const store = new RelayMessageStore();
    const { message } = store.send(1001, 'alice', { recipientId: 1002, body: 'original' });

    const snapshot = store.snapshot();
    const restored = RelayMessageStore.fromSnapshot(snapshot);

    // Mutate the original store — restored store should be unaffected
    store.ack(message.id, 1002);

    const originalInbox = store.inbox(1002);
    const restoredInbox = restored.inbox(1002);

    expect(originalInbox[0].state).toBe('acked');
    expect(restoredInbox[0].state).toBe('delivered'); // unchanged
  });

  it('snapshot + JSON round-trip + fromSnapshot produces equivalent store', () => {
    const store = new RelayMessageStore();
    const { message: root } = store.send(1001, 'alice', {
      recipientId: 1002,
      body: 'root',
      dedupeKey: 'rt-001',
    });
    store.read(root.id, 1002);
    store.send(1002, 'bob', {
      recipientId: 1001,
      body: 'reply',
      inReplyTo: root.id,
    });

    // Simulate real persistence: serialize to JSON string, then parse back
    const json = JSON.stringify(store.snapshot());
    const parsed = JSON.parse(json);
    const restored = RelayMessageStore.fromSnapshot(parsed);

    // Verify full state
    const aliceInbox = restored.inbox(1001);
    const bobInbox = restored.inbox(1002);
    expect(aliceInbox.length).toBe(1);
    expect(bobInbox.length).toBe(1);
    expect(bobInbox[0].read_at).not.toBeNull();
    expect(aliceInbox[0].thread_id).toBe(root.thread_id);
    expect(aliceInbox[0].in_reply_to).toBe(root.id);
  });
});
