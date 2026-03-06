import { describe, it, expect, beforeEach } from 'vitest';
import { AccountStore } from '../../src/relay/account-store.js';

describe('AccountStore device directory', () => {
  let store: AccountStore;

  beforeEach(() => {
    store = new AccountStore();
  });

  it('publishes a public device bundle for a registered device', () => {
    store.register({ accountId: 'acct-001', handle: 'alice', displayName: 'Alice' });

    const published = store.publishDeviceBundle('acct-001', {
      deviceId: 'device-aaa',
      fingerprint: 'f'.repeat(64),
      x25519PublicKey: 'a'.repeat(64),
      ed25519PublicKey: 'b'.repeat(64),
      createdAt: '2026-03-06T00:00:00.000Z',
    });

    expect(published.accountId).toBe('acct-001');
    expect(published.deviceId).toBe('device-aaa');
    expect(published.fingerprint).toBe('f'.repeat(64));
    expect(store.listDevices('acct-001').map((device) => device.deviceId)).toContain('device-aaa');
  });

  it('updates an existing published device bundle in place for the same account/device pair', () => {
    store.register({ accountId: 'acct-001', handle: 'alice', displayName: 'Alice' });

    const first = store.publishDeviceBundle('acct-001', {
      deviceId: 'device-aaa',
      fingerprint: 'f'.repeat(64),
      x25519PublicKey: 'a'.repeat(64),
      ed25519PublicKey: 'b'.repeat(64),
      createdAt: '2026-03-06T00:00:00.000Z',
    });

    const second = store.publishDeviceBundle('acct-001', {
      deviceId: 'device-aaa',
      fingerprint: 'e'.repeat(64),
      x25519PublicKey: 'c'.repeat(64),
      ed25519PublicKey: 'd'.repeat(64),
      createdAt: '2026-03-06T01:00:00.000Z',
    });

    expect(second.accountId).toBe('acct-001');
    expect(second.deviceId).toBe('device-aaa');
    expect(second.fingerprint).toBe('e'.repeat(64));
    expect(second.x25519PublicKey).toBe('c'.repeat(64));
    expect(new Date(second.publishedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.publishedAt).getTime()
    );

    const listed = store.listPublishedDeviceBundles('acct-001');
    expect(listed).toHaveLength(1);
    expect(listed[0].fingerprint).toBe('e'.repeat(64));
  });

  it('published device bundles are account-scoped and fetchable by account/device pair', () => {
    store.register({ accountId: 'acct-001', handle: 'alice', displayName: 'Alice' });
    store.register({ accountId: 'acct-002', handle: 'bob-user', displayName: 'Bob' });

    store.publishDeviceBundle('acct-001', {
      deviceId: 'device-aaa',
      fingerprint: 'f'.repeat(64),
      x25519PublicKey: 'a'.repeat(64),
      ed25519PublicKey: 'b'.repeat(64),
      createdAt: '2026-03-06T00:00:00.000Z',
    });
    store.publishDeviceBundle('acct-002', {
      deviceId: 'device-bbb',
      fingerprint: 'e'.repeat(64),
      x25519PublicKey: 'c'.repeat(64),
      ed25519PublicKey: 'd'.repeat(64),
      createdAt: '2026-03-06T00:00:00.000Z',
    });

    expect(store.getPublishedDeviceBundle('acct-001', 'device-aaa')?.fingerprint).toBe(
      'f'.repeat(64)
    );
    expect(store.getPublishedDeviceBundle('acct-002', 'device-bbb')?.fingerprint).toBe(
      'e'.repeat(64)
    );
    expect(store.getPublishedDeviceBundle('acct-001', 'device-bbb')).toBeNull();
    expect(store.listPublishedDeviceBundles('acct-001')).toHaveLength(1);
    expect(store.listPublishedDeviceBundles('acct-002')).toHaveLength(1);
  });
});
