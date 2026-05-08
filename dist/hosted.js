import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { DEFAULT_HOSTED_RELAY_BASE_URL } from './settings.js';
function requestJson(method, url, options) {
    const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const payload = options?.body ? JSON.stringify(options.body) : undefined;
    return new Promise((resolve, reject) => {
        const req = doRequest(url, {
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
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                let body;
                try {
                    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                }
                catch {
                    body = {};
                }
                resolve({
                    statusCode: res.statusCode ?? 500,
                    body,
                });
            });
        });
        req.on('error', (err) => {
            reject(formatHostedRequestError(method, url, err));
        });
        req.on('timeout', () => {
            req.destroy(new Error(`Request timed out for ${method} ${url.pathname}`));
        });
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}
export function formatHostedRequestError(method, url, err) {
    const error = err;
    const code = typeof error?.code === 'string' ? error.code : '';
    const message = typeof error?.message === 'string' ? error.message : String(err);
    const origin = url.origin.replace(/\/$/, '');
    const isHostedDefault = origin === DEFAULT_HOSTED_RELAY_BASE_URL;
    if (code === 'EPROTO' ||
        /tls|ssl|alert internal error|handshake/i.test(message)) {
        if (isHostedDefault) {
            return new Error(`Hosted relay is currently unavailable due to a TLS/SSL error at ${origin}. ` +
                'This is a deployment issue, not a local setup issue. ' +
                'Try again later, or point mors at a custom/local relay with MORS_RELAY_BASE_URL.');
        }
        return new Error(`Could not establish a secure connection to ${origin}. ` +
            'Check the relay TLS/SSL configuration or choose a different relay URL.');
    }
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
        return new Error(`Could not reach relay at ${origin}. ` +
            'Check that the relay URL is correct and that the relay is running.');
    }
    if (code === 'ETIMEDOUT' || /timed out/i.test(message)) {
        return new Error(`Timed out contacting relay at ${origin} for ${method} ${url.pathname}. ` +
            'Check your network connection or try again later.');
    }
    return err instanceof Error ? err : new Error(message);
}
function requireSuccess(response, action) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
        return response.body;
    }
    const detail = typeof response.body['detail'] === 'string'
        ? response.body['detail']
        : typeof response.body['message'] === 'string'
            ? response.body['message']
            : `${action} failed with status ${response.statusCode}.`;
    throw new Error(detail);
}
export async function hostedSignup(relayBaseUrl, options) {
    const response = await requestJson('POST', new URL('/auth/signup', relayBaseUrl), {
        body: {
            handle: options.handle,
            display_name: options.displayName,
            device_id: options.deviceId,
        },
    });
    const body = requireSuccess(response, 'signup');
    return {
        accessToken: body['access_token'],
        accountId: body['account_id'],
        deviceId: body['device_id'],
        handle: body['handle'],
        displayName: body['display_name'],
    };
}
export async function addHostedContact(relayBaseUrl, token, handle) {
    const response = await requestJson('POST', new URL('/contacts/add', relayBaseUrl), {
        token,
        body: { handle },
    });
    const body = requireSuccess(response, 'add contact');
    return body['contact'];
}
export async function listHostedContacts(relayBaseUrl, token) {
    const response = await requestJson('GET', new URL('/contacts', relayBaseUrl), { token });
    const body = requireSuccess(response, 'list contacts');
    return body['contacts'] ?? [];
}
export async function listPendingContacts(relayBaseUrl, token) {
    const response = await requestJson('GET', new URL('/contacts/pending', relayBaseUrl), { token });
    const body = requireSuccess(response, 'list pending contacts');
    return body['pending_contacts'] ?? [];
}
export async function approveHostedContact(relayBaseUrl, token, accountId) {
    const response = await requestJson('POST', new URL('/contacts/approve', relayBaseUrl), {
        token,
        body: { contact_account_id: accountId },
    });
    requireSuccess(response, 'approve contact');
}
//# sourceMappingURL=hosted.js.map