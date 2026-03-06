import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../../src/relay/account-store.js';
import { ContactStore } from '../../src/relay/contact-store.js';
import { createRelayPersistenceContext } from '../../src/relay/persistence.js';

describe('relay persistence', () => {
  it('AccountStore snapshot/fromSnapshot preserves profiles, devices, and bundles', () => {
    const store = new AccountStore();
    store.register({
      accountId: 'acct-alice',
      handle: 'alice',
      displayName: 'Alice',
    });
    store.registerDevice('acct-alice', 'device-alice');
    store.publishDeviceBundle('acct-alice', {
      deviceId: 'device-alice',
      fingerprint: 'fingerprint-alice',
      x25519PublicKey: 'x25519-alice',
      ed25519PublicKey: 'ed25519-alice',
      createdAt: '2026-03-07T00:00:00.000Z',
    });

    const restored = AccountStore.fromSnapshot(store.snapshot());
    expect(restored.getByAccountId('acct-alice')?.handle).toBe('alice');
    expect(restored.listDevices('acct-alice')).toHaveLength(1);
    expect(restored.getPublishedDeviceBundle('acct-alice', 'device-alice')?.fingerprint).toBe(
      'fingerprint-alice'
    );
  });

  it('ContactStore snapshot/fromSnapshot preserves pending and approved contacts', () => {
    const store = new ContactStore();
    store.recordContact('acct-alice', 'acct-bob');
    store.approveContact('acct-alice', 'acct-carol');

    const restored = ContactStore.fromSnapshot(store.snapshot());
    expect(restored.getContactStatus('acct-alice', 'acct-bob')).toBe('pending');
    expect(restored.getContactStatus('acct-alice', 'acct-carol')).toBe('approved');
  });

  it('configured relay persistence rehydrates account, contact, and message state across restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mors-relay-persist-'));
    const statePath = join(dir, 'relay-state.json');

    try {
      const first = createRelayPersistenceContext({ statePath });

      first.accountStore.register({
        accountId: 'acct-alice',
        handle: 'alice',
        displayName: 'Alice',
      });
      first.accountStore.register({
        accountId: 'acct-bob',
        handle: 'bob',
        displayName: 'Bob',
      });
      first.accountStore.publishDeviceBundle('acct-alice', {
        deviceId: 'device-alice',
        fingerprint: 'fingerprint-alice',
        x25519PublicKey: 'x25519-alice',
        ed25519PublicKey: 'ed25519-alice',
        createdAt: '2026-03-07T00:00:00.000Z',
      });
      first.contactStore.recordContact('acct-bob', 'acct-alice');
      first.contactStore.approveContact('acct-bob', 'acct-alice');

      const { message } = first.messageStore.send('acct-alice', 'alice', {
        recipientId: 'acct-bob',
        body: 'hello from persisted relay',
        senderDeviceId: 'device-alice',
      });
      first.messageStore.read(message.id, 'acct-bob');
      first.messageStore.ack(message.id, 'acct-bob');

      expect(existsSync(statePath)).toBe(true);

      const second = createRelayPersistenceContext({ statePath });

      expect(second.accountStore.getByHandle('alice')?.accountId).toBe('acct-alice');
      expect(second.contactStore.getContactStatus('acct-bob', 'acct-alice')).toBe('approved');
      expect(
        second.accountStore.getPublishedDeviceBundle('acct-alice', 'device-alice')?.fingerprint
      ).toBe('fingerprint-alice');

      const inbox = second.messageStore.inbox('acct-bob');
      expect(inbox).toHaveLength(1);
      expect(inbox[0].body).toBe('hello from persisted relay');
      expect(inbox[0].state).toBe('acked');
      expect(inbox[0].sender_device_id).toBe('device-alice');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
