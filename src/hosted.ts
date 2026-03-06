import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

interface JsonResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

export interface HostedSignupResult {
  accessToken: string;
  accountId: string;
  deviceId: string;
  handle: string;
  displayName: string;
}

export interface HostedDeviceBundle {
  device_id: string;
  fingerprint: string;
  x25519_public_key: string;
  ed25519_public_key?: string;
}

export interface HostedContact {
  account_id: string;
  handle: string;
  display_name: string;
  status: 'pending' | 'approved';
  autonomy_allowed: boolean;
  first_contact?: boolean;
  device_bundle?: HostedDeviceBundle;
}

function requestJson(
  method: string,
  url: URL,
  options?: {
    token?: string;
    body?: Record<string, unknown>;
    timeoutMs?: number;
  }
): Promise<JsonResponse> {
  const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = options?.body ? JSON.stringify(options.body) : undefined;

  return new Promise((resolve, reject) => {
    const req = doRequest(
      url,
      {
        method,
        headers: {
          Accept: 'application/json',
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
          ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
          Connection: 'close',
        },
        timeout: options?.timeoutMs ?? 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          } catch {
            body = {};
          }

          resolve({
            statusCode: res.statusCode ?? 500,
            body,
          });
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out for ${method} ${url.pathname}`));
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function requireSuccess(response: JsonResponse, action: string): Record<string, unknown> {
  if (response.statusCode >= 200 && response.statusCode < 300) {
    return response.body;
  }

  const detail =
    typeof response.body['detail'] === 'string'
      ? (response.body['detail'] as string)
      : typeof response.body['message'] === 'string'
        ? (response.body['message'] as string)
        : `${action} failed with status ${response.statusCode}.`;

  throw new Error(detail);
}

export async function hostedSignup(
  relayBaseUrl: string,
  options: {
    handle: string;
    displayName: string;
    deviceId: string;
  }
): Promise<HostedSignupResult> {
  const response = await requestJson('POST', new URL('/auth/signup', relayBaseUrl), {
    body: {
      handle: options.handle,
      display_name: options.displayName,
      device_id: options.deviceId,
    },
  });
  const body = requireSuccess(response, 'signup');

  return {
    accessToken: body['access_token'] as string,
    accountId: body['account_id'] as string,
    deviceId: body['device_id'] as string,
    handle: body['handle'] as string,
    displayName: body['display_name'] as string,
  };
}

export async function addHostedContact(
  relayBaseUrl: string,
  token: string,
  handle: string
): Promise<HostedContact> {
  const response = await requestJson('POST', new URL('/contacts/add', relayBaseUrl), {
    token,
    body: { handle },
  });
  const body = requireSuccess(response, 'add contact');
  return body['contact'] as HostedContact;
}

export async function listHostedContacts(
  relayBaseUrl: string,
  token: string
): Promise<HostedContact[]> {
  const response = await requestJson('GET', new URL('/contacts', relayBaseUrl), { token });
  const body = requireSuccess(response, 'list contacts');
  return (body['contacts'] as HostedContact[]) ?? [];
}

export async function listPendingContacts(
  relayBaseUrl: string,
  token: string
): Promise<HostedContact[]> {
  const response = await requestJson('GET', new URL('/contacts/pending', relayBaseUrl), { token });
  const body = requireSuccess(response, 'list pending contacts');
  return (body['pending_contacts'] as HostedContact[]) ?? [];
}

export async function approveHostedContact(
  relayBaseUrl: string,
  token: string,
  accountId: string
): Promise<void> {
  const response = await requestJson('POST', new URL('/contacts/approve', relayBaseUrl), {
    token,
    body: { contact_account_id: accountId },
  });
  requireSuccess(response, 'approve contact');
}
