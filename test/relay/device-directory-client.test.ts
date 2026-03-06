import { describe, it, expect } from 'vitest';
import { RelayClient, RelayClientError } from '../../src/relay/client.js';

describe('RelayClient device directory helpers', () => {
  it('publishDeviceBundle sends the expected authenticated payload', async () => {
    const requests: Array<{ url: string; method?: string; body?: string | undefined }> = [];
    const client = new RelayClient({
      baseUrl: 'https://relay.example.test',
      token: 'token-123',
      maxRetries: 0,
      fetchFn: async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method,
          body: init?.body as string | undefined,
        });
        return new Response(
          JSON.stringify({
            account_id: 'acct_1001',
            device_id: 'device-aaa',
            fingerprint: 'f'.repeat(64),
            x25519_public_key: 'a'.repeat(64),
            ed25519_public_key: 'b'.repeat(64),
            created_at: '2026-03-06T00:00:00.000Z',
            published_at: '2026-03-06T00:00:01.000Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    const response = await client.publishDeviceBundle({
      deviceId: 'device-aaa',
      fingerprint: 'f'.repeat(64),
      x25519PublicKey: 'a'.repeat(64),
      ed25519PublicKey: 'b'.repeat(64),
      createdAt: '2026-03-06T00:00:00.000Z',
    });

    expect(response.device_id).toBe('device-aaa');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://relay.example.test/accounts/me/device-bundle');
    expect(requests[0].method).toBe('PUT');
    expect(JSON.parse(requests[0].body ?? '{}')).toEqual({
      device_id: 'device-aaa',
      fingerprint: 'f'.repeat(64),
      x25519_public_key: 'a'.repeat(64),
      ed25519_public_key: 'b'.repeat(64),
      created_at: '2026-03-06T00:00:00.000Z',
    });
  });

  it('fetchDeviceBundle resolves a published peer bundle by account/device pair', async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    const client = new RelayClient({
      baseUrl: 'https://relay.example.test',
      token: 'token-123',
      maxRetries: 0,
      fetchFn: async (url, init) => {
        requests.push({ url: String(url), method: init?.method });
        return new Response(
          JSON.stringify({
            account_id: 'acct_1002',
            device_id: 'device-bbb',
            fingerprint: 'e'.repeat(64),
            x25519_public_key: 'c'.repeat(64),
            ed25519_public_key: 'd'.repeat(64),
            created_at: '2026-03-06T00:00:00.000Z',
            published_at: '2026-03-06T00:00:01.000Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    const response = await client.fetchDeviceBundle('acct_1002', 'device-bbb');

    expect(response?.account_id).toBe('acct_1002');
    expect(response?.device_id).toBe('device-bbb');
    expect(requests).toEqual([
      {
        url: 'https://relay.example.test/accounts/acct_1002/device-bundles/device-bbb',
        method: 'GET',
      },
    ]);
  });

  it('fetchDeviceBundle returns null when the relay reports no bundle for that device', async () => {
    const client = new RelayClient({
      baseUrl: 'https://relay.example.test',
      token: 'token-123',
      maxRetries: 0,
      fetchFn: async () =>
        new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    await expect(client.fetchDeviceBundle('acct_1002', 'missing-device')).resolves.toBeNull();
  });

  it('fetchDeviceBundle rethrows non-404 relay client failures', async () => {
    const client = new RelayClient({
      baseUrl: 'https://relay.example.test',
      token: 'token-123',
      maxRetries: 0,
      fetchFn: async () =>
        new Response(JSON.stringify({ detail: 'forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    await expect(client.fetchDeviceBundle('acct_1002', 'device-bbb')).rejects.toBeInstanceOf(
      RelayClientError
    );
  });
});
