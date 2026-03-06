import { createInterface } from 'node:readline/promises';
import { getConfigDir } from './identity.js';
import { requireInit } from './init.js';
import { loadProfile, loadSession, markAuthEnabled, saveProfile, saveSession, } from './auth/session.js';
import { validateHandle, normalizeHandle } from './relay/account-store.js';
import { DEFAULT_HOSTED_RELAY_BASE_URL, loadClientSettings, saveClientSettings, } from './settings.js';
import { addHostedContact, approveHostedContact, hostedSignup, listHostedContacts, listPendingContacts, } from './hosted.js';
import { decryptMessage, ensureSessionForInboundMessage, ensureSessionFromPeerBundle, getDeviceKeysDir, loadKeyExchangeSession, requireDeviceBootstrap, } from './e2ee/index.js';
import { RelayClient, } from './relay/client.js';
const DEFAULT_RUNTIME = {
    signup: hostedSignup,
    listContacts: listHostedContacts,
    addContact: addHostedContact,
    listPending: listPendingContacts,
    approveContact: approveHostedContact,
    async listInbox(relayBaseUrl, token) {
        const response = await fetch(`${relayBaseUrl}/inbox`, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
                Connection: 'close',
            },
        });
        if (!response.ok) {
            let detail = `Inbox request failed with status ${response.status}.`;
            try {
                const body = (await response.json());
                if (typeof body['detail'] === 'string') {
                    detail = body['detail'];
                }
            }
            catch {
                // Keep the default detail.
            }
            throw new Error(detail);
        }
        const body = (await response.json());
        return body.messages ?? [];
    },
    async publishDeviceBundle(relayBaseUrl, token, queueStorePath, bundle) {
        const client = new RelayClient({
            baseUrl: relayBaseUrl,
            token,
            queueStorePath,
        });
        await client.publishDeviceBundle(bundle);
    },
    async fetchDeviceBundle(relayBaseUrl, token, queueStorePath, accountId, deviceId) {
        const client = new RelayClient({
            baseUrl: relayBaseUrl,
            token,
            queueStorePath,
        });
        return client.fetchDeviceBundle(accountId, deviceId);
    },
    async sendMessage(relayBaseUrl, token, queueStorePath, recipientId, body) {
        const client = new RelayClient({
            baseUrl: relayBaseUrl,
            token,
            queueStorePath,
        });
        return client.send({ recipientId, body });
    },
    async sendEncryptedMessage(relayBaseUrl, token, queueStorePath, recipientId, body, sharedSecret, inReplyTo) {
        const client = new RelayClient({
            baseUrl: relayBaseUrl,
            token,
            queueStorePath,
        });
        return client.sendEncrypted({ recipientId, body, sharedSecret, inReplyTo });
    },
};
export async function runStartCommand(args, options = {}) {
    if (args.includes('--help') || args.includes('-h')) {
        printStartUsage(options.output);
        return;
    }
    const configDir = options.configDir ?? getConfigDir();
    const output = options.output ?? process.stdout;
    const error = options.error ?? process.stderr;
    const runtime = options.runtime ?? DEFAULT_RUNTIME;
    try {
        requireInit(configDir);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeLine(error, `Error: ${message}`);
        process.exitCode = 1;
        return;
    }
    const prompt = options.prompt ?? createPrompt(options.input, output);
    try {
        const relayBaseUrl = await ensureRelayConfigured(configDir, prompt, output);
        const app = await ensureIdentityReady(configDir, relayBaseUrl, prompt, output, runtime);
        await publishLocalDeviceBundle(app, runtime);
        await runMainLoop(app, prompt, output, runtime);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeLine(error, `Error: ${message}`);
        process.exitCode = 1;
    }
    finally {
        prompt.close();
    }
}
function createPrompt(input, output) {
    const rl = createInterface({
        input: input ?? process.stdin,
        output: output ?? process.stdout,
    });
    return {
        question(prompt) {
            return rl.question(prompt);
        },
        close() {
            rl.close();
        },
    };
}
async function ensureRelayConfigured(configDir, prompt, output, options) {
    const envRelay = process.env['MORS_RELAY_BASE_URL']?.trim();
    if (envRelay) {
        if (options?.forcePrompt) {
            writeLine(output, `Relay is pinned by MORS_RELAY_BASE_URL: ${envRelay}`);
        }
        else {
            writeLine(output, `Relay: ${envRelay}`);
        }
        return envRelay;
    }
    const settings = loadClientSettings(configDir);
    if (settings.relayBaseUrl && !options?.forcePrompt) {
        writeLine(output, `Relay: ${settings.relayBaseUrl}`);
        return settings.relayBaseUrl;
    }
    if (!options?.forcePrompt) {
        saveClientSettings(configDir, {
            relayMode: 'hosted',
            relayBaseUrl: DEFAULT_HOSTED_RELAY_BASE_URL,
        });
        writeLine(output, `Relay: ${DEFAULT_HOSTED_RELAY_BASE_URL}`);
        return DEFAULT_HOSTED_RELAY_BASE_URL;
    }
    writeLine(output, 'Choose a relay for mors:');
    writeLine(output, `1. Hosted default (${DEFAULT_HOSTED_RELAY_BASE_URL})`);
    writeLine(output, '2. Custom relay URL');
    while (true) {
        const choice = (await prompt.question('Relay choice [1/2]: ')).trim().toLowerCase();
        if (choice === '1' || choice === 'hosted') {
            saveClientSettings(configDir, {
                relayMode: 'hosted',
                relayBaseUrl: DEFAULT_HOSTED_RELAY_BASE_URL,
            });
            writeLine(output, `Using hosted relay: ${DEFAULT_HOSTED_RELAY_BASE_URL}`);
            return DEFAULT_HOSTED_RELAY_BASE_URL;
        }
        if (choice === '2' || choice === 'custom') {
            const custom = (await prompt.question('Custom relay URL: ')).trim();
            try {
                const normalized = new URL(custom).toString().replace(/\/$/, '');
                saveClientSettings(configDir, {
                    relayMode: 'custom',
                    relayBaseUrl: normalized,
                });
                writeLine(output, `Using custom relay: ${normalized}`);
                return normalized;
            }
            catch {
                writeLine(output, 'Please enter a valid http(s) URL.');
            }
            continue;
        }
        writeLine(output, 'Enter 1 for hosted or 2 for a custom relay.');
    }
}
async function ensureIdentityReady(configDir, relayBaseUrl, prompt, output, runtime) {
    const existingSession = loadSession(configDir);
    const existingProfile = loadProfile(configDir);
    if (existingSession && existingProfile) {
        writeLine(output, `Welcome back, @${existingProfile.handle}.`);
        return {
            configDir,
            relayBaseUrl,
            session: existingSession,
            profile: existingProfile,
        };
    }
    if (existingSession || existingProfile) {
        throw new Error('Partial account state detected. Run "mors logout" and remove the local profile, or finish setup with the legacy commands first.');
    }
    writeLine(output, 'Create your mors profile');
    const handle = await promptForHandle(prompt, output);
    const displayName = await promptForDisplayName(prompt, output);
    const localBundle = requireDeviceBootstrap(getDeviceKeysDir(configDir));
    const signup = await runtime.signup(relayBaseUrl, {
        handle,
        displayName,
        deviceId: localBundle.deviceId,
    });
    const session = {
        accessToken: signup.accessToken,
        tokenType: 'bearer',
        accountId: signup.accountId,
        deviceId: signup.deviceId,
        createdAt: new Date().toISOString(),
    };
    const profile = {
        handle: signup.handle,
        displayName: signup.displayName,
        accountId: signup.accountId,
        createdAt: new Date().toISOString(),
    };
    markAuthEnabled(configDir);
    saveSession(configDir, session);
    saveProfile(configDir, profile);
    writeLine(output, `Signed in as @${profile.handle} (${profile.displayName}).`);
    return {
        configDir,
        relayBaseUrl,
        session,
        profile,
    };
}
async function promptForHandle(prompt, output) {
    while (true) {
        const raw = (await prompt.question('Handle: ')).trim();
        try {
            const normalized = normalizeHandle(raw.startsWith('@') ? raw.slice(1) : raw);
            validateHandle(normalized);
            return normalized;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Invalid handle.';
            writeLine(output, message);
        }
    }
}
async function promptForDisplayName(prompt, output) {
    while (true) {
        const displayName = (await prompt.question('Display name: ')).trim();
        if (displayName.length > 0) {
            return displayName;
        }
        writeLine(output, 'Display name is required.');
    }
}
async function runMainLoop(app, prompt, output, runtime) {
    let selectedContact = null;
    while (true) {
        writeLine(output, '');
        writeLine(output, `@${app.profile.handle} on ${app.relayBaseUrl}`);
        writeLine(output, `Selected contact: ${selectedContact ? `@${selectedContact.handle}` : 'none yet'}`);
        writeLine(output, '1. Contacts');
        writeLine(output, '2. Add contact');
        writeLine(output, '3. Inbox');
        writeLine(output, '4. Send message');
        writeLine(output, '5. Pending approvals');
        writeLine(output, '6. Relay settings');
        writeLine(output, '7. Quit');
        const choice = (await prompt.question('Choose an action: ')).trim();
        if (choice === '1') {
            const contacts = await runtime.listContacts(app.relayBaseUrl, app.session.accessToken);
            selectedContact = await showContacts(output, prompt, contacts, selectedContact);
            continue;
        }
        if (choice === '2') {
            const added = await addContactFlow(app, prompt, output, runtime);
            if (added) {
                selectedContact = added;
            }
            continue;
        }
        if (choice === '3') {
            await inboxFlow(app, prompt, output, runtime);
            continue;
        }
        if (choice === '4') {
            selectedContact = await sendFlow(app, prompt, output, runtime, selectedContact);
            continue;
        }
        if (choice === '5') {
            await pendingFlow(app, prompt, output, runtime);
            continue;
        }
        if (choice === '6') {
            app.relayBaseUrl = await ensureRelayConfigured(app.configDir, prompt, output, {
                forcePrompt: true,
            });
            await publishLocalDeviceBundle(app, runtime);
            continue;
        }
        if (choice === '7' || choice.toLowerCase() === 'q' || choice.toLowerCase() === 'quit') {
            writeLine(output, 'Bye.');
            return;
        }
        writeLine(output, 'Choose 1-7.');
    }
}
async function showContacts(output, prompt, contacts, selectedContact) {
    if (contacts.length === 0) {
        writeLine(output, 'No contacts yet. Add one by handle first.');
        return selectedContact;
    }
    writeLine(output, 'Contacts:');
    for (const [index, contact] of contacts.entries()) {
        const marker = selectedContact?.account_id === contact.account_id ? '*' : ' ';
        writeLine(output, `${marker} ${index + 1}. @${contact.handle} (${contact.display_name}) [${contact.status}]`);
    }
    const answer = (await prompt.question('Select contact number, or press Enter to go back: ')).trim();
    if (!answer) {
        return selectedContact;
    }
    const index = Number(answer);
    if (!Number.isInteger(index) || index < 1 || index > contacts.length) {
        writeLine(output, 'Invalid contact selection.');
        return selectedContact;
    }
    const next = contacts[index - 1];
    writeLine(output, `Selected @${next.handle}.`);
    return next;
}
async function addContactFlow(app, prompt, output, runtime) {
    const raw = (await prompt.question('Add contact by handle: ')).trim();
    if (!raw) {
        writeLine(output, 'No handle entered.');
        return null;
    }
    let handle;
    try {
        handle = normalizeHandle(raw.startsWith('@') ? raw.slice(1) : raw);
        validateHandle(handle);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid handle.';
        writeLine(output, message);
        return null;
    }
    const contact = await runtime.addContact(app.relayBaseUrl, app.session.accessToken, handle);
    ensureContactSession(app.configDir, contact);
    writeLine(output, `Added @${contact.handle} (${contact.status}).`);
    return contact;
}
async function inboxFlow(app, prompt, output, runtime) {
    const messages = await runtime.listInbox(app.relayBaseUrl, app.session.accessToken);
    if (messages.length === 0) {
        writeLine(output, 'Inbox is empty.');
        return;
    }
    writeLine(output, 'Inbox:');
    for (const [index, message] of messages.entries()) {
        const preview = isEncryptedPayload(message.body)
            ? '[encrypted message]'
            : message.body.replace(/\s+/g, ' ').slice(0, 72);
        writeLine(output, `${index + 1}. from:${message.sender_login} state:${message.state} ${preview}`);
    }
    const answer = (await prompt.question('Open which message? Press Enter to go back: ')).trim();
    if (!answer) {
        return;
    }
    const index = Number(answer);
    if (!Number.isInteger(index) || index < 1 || index > messages.length) {
        writeLine(output, 'Invalid message selection.');
        return;
    }
    const selected = messages[index - 1];
    const body = await readMessageBody(app, selected, runtime);
    writeLine(output, '---');
    writeLine(output, `From: ${selected.sender_login}`);
    writeLine(output, body);
}
async function sendFlow(app, prompt, output, runtime, selectedContact) {
    let target = selectedContact;
    if (!target) {
        const contacts = await runtime.listContacts(app.relayBaseUrl, app.session.accessToken);
        target = await showContacts(output, prompt, contacts, null);
    }
    if (!target) {
        writeLine(output, 'Choose a contact before sending.');
        return selectedContact;
    }
    const body = (await prompt.question(`Message for @${target.handle}: `)).trim();
    if (!body) {
        writeLine(output, 'Message body cannot be empty.');
        return target;
    }
    const queueStorePath = getQueueStorePath(app.configDir);
    const session = ensureContactSession(app.configDir, target);
    const result = session && runtime.sendEncryptedMessage
        ? await runtime.sendEncryptedMessage(app.relayBaseUrl, app.session.accessToken, queueStorePath, target.account_id, body, session.sharedSecret)
        : await runtime.sendMessage(app.relayBaseUrl, app.session.accessToken, queueStorePath, target.account_id, body);
    if (result.queued) {
        writeLine(output, 'Message queued offline.');
    }
    else {
        writeLine(output, `Message sent to @${target.handle}.`);
    }
    return target;
}
async function pendingFlow(app, prompt, output, runtime) {
    const pending = await runtime.listPending(app.relayBaseUrl, app.session.accessToken);
    if (pending.length === 0) {
        writeLine(output, 'No pending approvals.');
        return;
    }
    writeLine(output, 'Pending contacts:');
    for (const [index, contact] of pending.entries()) {
        writeLine(output, `${index + 1}. @${contact.handle} (${contact.display_name})`);
    }
    const answer = (await prompt.question('Approve which contact? Press Enter to go back: ')).trim();
    if (!answer) {
        return;
    }
    const index = Number(answer);
    if (!Number.isInteger(index) || index < 1 || index > pending.length) {
        writeLine(output, 'Invalid pending selection.');
        return;
    }
    const contact = pending[index - 1];
    await runtime.approveContact(app.relayBaseUrl, app.session.accessToken, contact.account_id);
    ensureContactSession(app.configDir, contact);
    writeLine(output, `Approved @${contact.handle}.`);
}
async function publishLocalDeviceBundle(app, runtime) {
    if (!runtime.publishDeviceBundle) {
        return;
    }
    const localBundle = requireDeviceBootstrap(getDeviceKeysDir(app.configDir));
    await runtime.publishDeviceBundle(app.relayBaseUrl, app.session.accessToken, getQueueStorePath(app.configDir), {
        deviceId: localBundle.deviceId,
        fingerprint: localBundle.fingerprint,
        x25519PublicKey: localBundle.x25519PublicKey.toString('hex'),
        ed25519PublicKey: localBundle.ed25519PublicKey.toString('hex'),
        createdAt: app.session.createdAt,
    });
}
function ensureContactSession(configDir, contact) {
    if (!contact.device_bundle) {
        return null;
    }
    const keysDir = getDeviceKeysDir(configDir);
    const localBundle = requireDeviceBootstrap(keysDir);
    return ensureSessionFromPeerBundle(keysDir, mapHostedBundle(contact.device_bundle), localBundle);
}
async function readMessageBody(app, message, runtime) {
    if (!isEncryptedPayload(message.body)) {
        return message.body;
    }
    const keysDir = getDeviceKeysDir(app.configDir);
    let session = message.sender_device_id
        ? loadKeyExchangeSession(keysDir, message.sender_device_id)
        : null;
    if (!session && runtime.fetchDeviceBundle) {
        await ensureSessionForInboundMessage({
            keysDir,
            localBundle: requireDeviceBootstrap(keysDir),
            message,
            resolvePeerBundle: async (accountId, deviceId) => {
                const bundle = await runtime.fetchDeviceBundle?.(app.relayBaseUrl, app.session.accessToken, getQueueStorePath(app.configDir), accountId, deviceId);
                return bundle ? mapRelayBundle(bundle) : null;
            },
        });
        session = message.sender_device_id
            ? loadKeyExchangeSession(keysDir, message.sender_device_id)
            : null;
    }
    if (!session) {
        throw new Error('Encrypted message received, but no peer session could be established for the sender device.');
    }
    return decryptMessage(session.sharedSecret, JSON.parse(message.body));
}
function getQueueStorePath(configDir) {
    return `${configDir}/offline-queue.json`;
}
function mapHostedBundle(bundle) {
    return {
        accountId: undefined,
        deviceId: bundle.device_id,
        fingerprint: bundle.fingerprint,
        x25519PublicKey: bundle.x25519_public_key,
        ed25519PublicKey: bundle.ed25519_public_key,
    };
}
function mapRelayBundle(bundle) {
    return {
        accountId: bundle.account_id,
        deviceId: bundle.device_id,
        fingerprint: bundle.fingerprint,
        x25519PublicKey: bundle.x25519_public_key,
        ed25519PublicKey: bundle.ed25519_public_key,
        createdAt: bundle.created_at,
        publishedAt: bundle.published_at,
    };
}
function isEncryptedPayload(body) {
    try {
        const parsed = JSON.parse(body);
        return (typeof parsed['ciphertext'] === 'string' &&
            typeof parsed['iv'] === 'string' &&
            typeof parsed['authTag'] === 'string');
    }
    catch {
        return false;
    }
}
function writeLine(stream, line) {
    stream.write(`${line}\n`);
}
function printStartUsage(output = process.stdout) {
    writeLine(output, 'Usage: mors start');
    writeLine(output, '');
    writeLine(output, 'Interactive mors app flow:');
    writeLine(output, '  - connect to the hosted relay automatically');
    writeLine(output, '  - sign up with handle + display name');
    writeLine(output, '  - publish device keys for automatic encrypted messaging');
    writeLine(output, '  - add contacts by handle');
    writeLine(output, '  - read and send messages');
}
//# sourceMappingURL=start.js.map