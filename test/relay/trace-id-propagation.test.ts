/**
 * trace_id propagation through the relay store.
 *
 * An orchestrator tags a suggestion with a correlation id and needs the same id
 * back on the worker's reply. Before this, the relay dropped trace_id entirely.
 * These tests lock in that the store carries it through send, inbox, read, and
 * reply, and reports null when absent.
 */

import { describe, it, expect } from 'vitest';
import { RelayMessageStore } from '../../src/relay/message-store.js';

describe('relay trace_id propagation', () => {
  it('carries trace_id through send and inbox', () => {
    const store = new RelayMessageStore();
    const { message } = store.send('acct_orchestrator', 'orchestrator', {
      recipientId: 'acct_worker',
      body: 'consider switching routes',
      traceId: 'trc_route_decision_1',
    });
    expect(message.trace_id).toBe('trc_route_decision_1');

    const inbox = store.inbox('acct_worker');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.trace_id).toBe('trc_route_decision_1');
  });

  it('preserves trace_id on read', () => {
    const store = new RelayMessageStore();
    const { message } = store.send('acct_a', 'a', {
      recipientId: 'acct_b',
      body: 'hi',
      traceId: 'trc_abc',
    });
    const { message: read } = store.read(message.id, 'acct_b');
    expect(read.trace_id).toBe('trc_abc');
  });

  it('inherits correlation across a reply thread', () => {
    const store = new RelayMessageStore();
    const { message: root } = store.send('acct_orchestrator', 'orchestrator', {
      recipientId: 'acct_worker',
      body: 'suggestion',
      traceId: 'trc_thread_9',
    });
    const { message: reply } = store.send('acct_worker', 'worker', {
      recipientId: 'acct_orchestrator',
      body: 'acknowledged',
      inReplyTo: root.id,
      traceId: 'trc_thread_9',
    });
    expect(reply.thread_id).toBe(root.thread_id);
    expect(reply.trace_id).toBe('trc_thread_9');
  });

  it('reports null trace_id when none is supplied', () => {
    const store = new RelayMessageStore();
    const { message } = store.send('acct_a', 'a', {
      recipientId: 'acct_b',
      body: 'no trace',
    });
    expect(message.trace_id).toBeNull();
  });
});
