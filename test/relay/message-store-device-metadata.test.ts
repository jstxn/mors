import { describe, it, expect } from 'vitest';
import { RelayMessageStore } from '../../src/relay/message-store.js';

describe('RelayMessageStore sender device metadata', () => {
  it('stores sender_device_id on created relay messages', () => {
    const store = new RelayMessageStore();

    const { message } = store.send('acct_1001', 'alice', {
      senderDeviceId: 'device-alice-001',
      recipientId: 'acct_1002',
      body: 'hello from alice',
    });

    expect(message.sender_device_id).toBe('device-alice-001');
    const inbox = store.inbox('acct_1002');
    expect(inbox[0].sender_device_id).toBe('device-alice-001');
  });

  it('preserves sender_device_id across snapshot and rehydration', () => {
    const store = new RelayMessageStore();

    store.send('acct_1001', 'alice', {
      senderDeviceId: 'device-alice-001',
      recipientId: 'acct_1002',
      body: 'hello from alice',
    });

    const restored = RelayMessageStore.fromSnapshot(store.snapshot());
    const inbox = restored.inbox('acct_1002');

    expect(inbox).toHaveLength(1);
    expect(inbox[0].sender_device_id).toBe('device-alice-001');
  });

  it('includes sender_device_id in emitted stream events', () => {
    const store = new RelayMessageStore();
    const events: Array<{ sender_device_id: string | null }> = [];
    const unsubscribe = store.onStreamEvent((event) => {
      events.push({ sender_device_id: event.sender_device_id });
    });

    store.send('acct_1001', 'alice', {
      senderDeviceId: 'device-alice-001',
      recipientId: 'acct_1002',
      body: 'hello from alice',
    });
    unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0].sender_device_id).toBe('device-alice-001');
  });
});
