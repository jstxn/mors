import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { getConfigDir } from './identity.js';
import { requireInit } from './init.js';
import { loadProfile, loadSession, markAuthEnabled, saveProfile, saveSession, } from './auth/session.js';
import { normalizeHandle, validateHandle } from './relay/account-store.js';
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
    getHostedProfile: fetchHostedProfile,
    registerHostedProfile: registerHostedProfile,
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
    const input = options.input ?? process.stdin;
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
    const prompt = options.prompt ?? createPrompt(input, output);
    try {
        const relayBaseUrl = await ensureRelayConfigured(configDir, prompt, output);
        const app = await ensureIdentityReady(configDir, relayBaseUrl, prompt, output, runtime);
        await publishLocalDeviceBundle(app, runtime);
        if (shouldUseFullScreenStartApp({ input, output, promptOverride: options.prompt !== undefined })) {
            await runFullScreenApp(app, input, output, runtime);
        }
        else {
            await runPromptLoop(app, prompt, output, runtime);
        }
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
export function shouldUseFullScreenStartApp(options) {
    if (options.promptOverride) {
        return false;
    }
    return isTtyInput(options.input ?? process.stdin) && isTtyOutput(options.output ?? process.stdout);
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
        await reconcileHostedProfile(configDir, relayBaseUrl, existingSession, existingProfile, runtime);
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
async function reconcileHostedProfile(configDir, relayBaseUrl, session, profile, runtime) {
    const getHostedProfile = runtime.getHostedProfile ?? fetchHostedProfile;
    const registerProfile = runtime.registerHostedProfile ?? registerHostedProfile;
    const remoteProfile = await getHostedProfile(relayBaseUrl, session.accessToken);
    if (remoteProfile) {
        return;
    }
    await registerProfile(relayBaseUrl, session.accessToken, {
        handle: profile.handle,
        displayName: profile.displayName,
    });
    saveProfile(configDir, {
        ...profile,
        createdAt: profile.createdAt,
    });
}
async function fetchHostedProfile(relayBaseUrl, token) {
    const response = await requestHostedJson('GET', relayBaseUrl, '/accounts/me', token);
    if (response.statusCode === 404 && response.body['error'] === 'not_onboarded') {
        return null;
    }
    if (response.statusCode === 401) {
        throw new Error('Your hosted session has expired or been revoked. Run "mors logout" and then "mors start" to sign in again.');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
        const detail = typeof response.body['detail'] === 'string'
            ? response.body['detail']
            : `Hosted profile lookup failed with status ${response.statusCode}.`;
        throw new Error(detail);
    }
    const accountId = typeof response.body['account_id'] === 'string' ? response.body['account_id'] : undefined;
    const handle = typeof response.body['handle'] === 'string' ? response.body['handle'] : undefined;
    const displayName = typeof response.body['display_name'] === 'string'
        ? response.body['display_name']
        : undefined;
    if (!accountId || !handle || !displayName) {
        throw new Error('Hosted profile lookup returned an incomplete response.');
    }
    return { accountId, handle, displayName };
}
async function registerHostedProfile(relayBaseUrl, token, profile) {
    const response = await requestHostedJson('POST', relayBaseUrl, '/accounts/register', token, {
        handle: profile.handle,
        display_name: profile.displayName,
    });
    if (response.statusCode === 401) {
        throw new Error('Your hosted session has expired or been revoked. Run "mors logout" and then "mors start" to sign in again.');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
        const detail = typeof response.body['detail'] === 'string'
            ? response.body['detail']
            : `Hosted profile repair failed with status ${response.statusCode}.`;
        throw new Error(detail);
    }
}
async function requestHostedJson(method, relayBaseUrl, pathname, token, body) {
    const { request: httpRequest } = await import('node:http');
    const { request: httpsRequest } = await import('node:https');
    const url = new URL(pathname, relayBaseUrl);
    const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const payload = body ? JSON.stringify(body) : undefined;
    return new Promise((resolve, reject) => {
        const req = doRequest(url, {
            method,
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`,
                ...(payload
                    ? {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                    }
                    : {}),
                Connection: 'close',
            },
            timeout: 10_000,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const parsed = (() => {
                    try {
                        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    }
                    catch {
                        return {};
                    }
                })();
                resolve({
                    statusCode: res.statusCode ?? 500,
                    body: parsed,
                });
            });
        });
        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy(new Error(`Request timed out for ${method} ${url.pathname}`));
        });
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
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
async function runPromptLoop(app, prompt, output, runtime) {
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
async function runFullScreenApp(app, input, output, runtime) {
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    const state = createInitialScreenState(app);
    let busy = false;
    let promptActive = false;
    let resolvePromise = null;
    const askQuestion = async (label) => {
        promptActive = true;
        let answer = '';
        const row = Math.max(1, output.rows ?? 24);
        const renderPrompt = () => {
            output.write('\x1b[?25h');
            output.write(`\x1b[${row};1H\x1b[2K${label}${answer}`);
        };
        return await new Promise((resolve) => {
            const finish = (value) => {
                input.off('keypress', onPromptKeypress);
                output.write('\x1b[?25l');
                output.write(`\x1b[${row};1H\x1b[2K`);
                promptActive = false;
                resolve(value);
            };
            const onPromptKeypress = (text, key) => {
                if (key.ctrl && key.name === 'c') {
                    finish('');
                    return;
                }
                if (key.name === 'escape') {
                    finish('');
                    return;
                }
                if (key.name === 'return' || key.name === 'enter') {
                    finish(answer);
                    return;
                }
                if (key.name === 'backspace') {
                    answer = answer.slice(0, -1);
                    renderPrompt();
                    return;
                }
                if (text && !key.ctrl && !key.meta && key.name !== 'tab') {
                    answer += text;
                    renderPrompt();
                }
            };
            input.on('keypress', onPromptKeypress);
            renderPrompt();
        });
    };
    const render = () => {
        const width = Math.max(80, output.columns ?? 100);
        const height = Math.max(24, output.rows ?? 30);
        output.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
        output.write(buildStartScreen(state, { width, height }));
    };
    const refresh = async () => {
        await refreshScreenData(app, runtime, state);
    };
    const cleanup = () => {
        if (cleanedUp) {
            return;
        }
        cleanedUp = true;
        input.off('keypress', keypressListener);
        input.setRawMode(false);
        output.write('\x1b[?25h\x1b[?1049l');
    };
    const onKeypress = async (text, key) => {
        if (promptActive || busy) {
            return;
        }
        busy = true;
        try {
            const shouldExit = await handleFullScreenKeypress({
                app,
                runtime,
                state,
                input,
                output,
                key,
                text,
                askQuestion,
                refresh,
            });
            render();
            if (shouldExit) {
                cleanup();
                resolvePromise?.();
            }
        }
        catch (err) {
            state.status = err instanceof Error ? err.message : String(err);
            render();
        }
        finally {
            busy = false;
        }
    };
    let cleanedUp = false;
    const keypressListener = (text, key) => {
        void onKeypress(text, key);
    };
    try {
        await refresh();
        render();
        await new Promise((resolve) => {
            resolvePromise = resolve;
            input.on('keypress', keypressListener);
        });
    }
    finally {
        cleanup();
    }
}
async function handleFullScreenKeypress(options) {
    const { app, runtime, state, key, text, askQuestion, refresh } = options;
    if (key.ctrl && key.name === 'c') {
        return true;
    }
    if (state.composerOpen) {
        if (key.name === 'escape') {
            state.composerOpen = false;
            state.draft = '';
            state.status = 'Composer cancelled.';
            return false;
        }
        if (key.name === 'return' || key.name === 'enter') {
            const target = getSelectedContact(state);
            if (!target) {
                state.status = 'Choose a contact before sending.';
                state.composerOpen = false;
                state.draft = '';
                return false;
            }
            const body = state.draft.trim();
            if (!body) {
                state.status = 'Message body cannot be empty.';
                return false;
            }
            const result = await sendToContact(app, runtime, target, body);
            state.composerOpen = false;
            state.draft = '';
            state.status = result.queued
                ? `Queued message for @${target.handle}.`
                : result.encrypted
                    ? `Sent encrypted message to @${target.handle}.`
                    : `Sent message to @${target.handle}.`;
            await refresh();
            return false;
        }
        if (key.name === 'backspace') {
            state.draft = state.draft.slice(0, -1);
            return false;
        }
        if (text && !key.ctrl && !key.meta && key.name !== 'tab') {
            state.draft += text;
        }
        return false;
    }
    if (key.name === 'q') {
        return true;
    }
    if (key.name === 'tab' || key.name === 'left' || key.name === 'right') {
        state.focus = state.focus === 'contacts' ? 'activity' : 'contacts';
        state.status = state.focus === 'contacts' ? 'Contacts focused.' : 'Activity focused.';
        return false;
    }
    if (key.name === 'down' || key.name === 'j') {
        moveSelection(state, 1);
        return false;
    }
    if (key.name === 'up' || key.name === 'k') {
        moveSelection(state, -1);
        return false;
    }
    if (key.name === 'i') {
        state.activityView = 'inbox';
        state.focus = 'activity';
        state.status = 'Inbox view.';
        return false;
    }
    if (key.name === 'p') {
        state.activityView = 'pending';
        state.focus = 'activity';
        state.status = 'Pending approvals view.';
        return false;
    }
    if (key.name === 'g') {
        await refresh();
        state.status = 'Refreshed contacts and inbox.';
        return false;
    }
    if (key.name === 'a') {
        const contact = await addContactViaFullscreen(app, runtime, state, askQuestion);
        if (contact) {
            await refresh();
            const nextIndex = state.contacts.findIndex((entry) => entry.account_id === contact.account_id);
            state.selectedContactIndex = nextIndex >= 0 ? nextIndex : state.selectedContactIndex;
        }
        return false;
    }
    if (key.name === 'r') {
        await reconfigureRelayFullscreen(app, state, askQuestion, runtime);
        await refresh();
        return false;
    }
    if (key.name === 'c') {
        if (!getSelectedContact(state)) {
            state.status = 'Add or select a contact first.';
            return false;
        }
        state.composerOpen = true;
        state.draft = '';
        state.status = 'Composer open. Type your message and press Enter to send.';
        return false;
    }
    if (key.name === 'return' || key.name === 'enter') {
        if (state.focus === 'contacts') {
            const contact = getSelectedContact(state);
            state.status = contact
                ? `Selected @${contact.handle}. Press c to compose.`
                : 'No contacts yet. Press a to add one.';
            return false;
        }
        if (state.activityView === 'pending') {
            const pending = getSelectedActivity(state);
            if (!pending) {
                state.status = 'No pending approvals.';
                return false;
            }
            await runtime.approveContact(app.relayBaseUrl, app.session.accessToken, pending.account_id);
            ensureContactSession(app.configDir, pending);
            await refresh();
            state.status = `Approved @${pending.handle}.`;
            return false;
        }
        const message = getSelectedActivity(state);
        if (!message) {
            state.status = 'Inbox is empty.';
            return false;
        }
        const body = await readMessageBody(app, message, runtime);
        state.previewTitle = `Message from ${describeMessageSender(state, message)}`;
        state.previewBody = wrapText(body, 54);
        state.status = 'Opened selected message.';
    }
    return false;
}
function createInitialScreenState(app) {
    return {
        handle: app.profile.handle,
        relayBaseUrl: app.relayBaseUrl,
        status: 'Press a to add a contact, c to compose, or Enter to open a message.',
        contacts: [],
        pending: [],
        inbox: [],
        selectedContactIndex: 0,
        selectedActivityIndex: 0,
        focus: 'contacts',
        activityView: 'inbox',
        previewTitle: 'Welcome',
        previewBody: ['Add a contact, then open inbox items or send messages from the composer.'],
        composerOpen: false,
        draft: '',
    };
}
async function refreshScreenData(app, runtime, state) {
    const [contacts, pending, inbox] = await Promise.all([
        runtime.listContacts(app.relayBaseUrl, app.session.accessToken),
        runtime.listPending(app.relayBaseUrl, app.session.accessToken),
        runtime.listInbox(app.relayBaseUrl, app.session.accessToken),
    ]);
    state.contacts = contacts;
    state.pending = pending;
    state.inbox = inbox;
    state.selectedContactIndex = clampIndex(state.selectedContactIndex, contacts.length);
    state.selectedActivityIndex = clampIndex(state.selectedActivityIndex, state.activityView === 'pending' ? pending.length : inbox.length);
    if (state.contacts.length === 0) {
        state.previewTitle = 'No contacts yet';
        state.previewBody = ['Press a to add someone by handle.'];
    }
    else if (state.activityView === 'pending' && state.pending.length === 0) {
        state.previewTitle = 'No pending approvals';
        state.previewBody = ['Switch to inbox with i, or add a contact with a.'];
    }
    else if (state.activityView === 'inbox' && state.inbox.length === 0) {
        state.previewTitle = 'Inbox is empty';
        state.previewBody = ['Send a message with c after selecting a contact.'];
    }
}
async function addContactViaFullscreen(app, runtime, state, askQuestion) {
    const raw = (await askQuestion('Add contact by handle: ')).trim();
    if (!raw) {
        state.status = 'Add contact cancelled.';
        return null;
    }
    let handle;
    try {
        handle = normalizeHandle(raw.startsWith('@') ? raw.slice(1) : raw);
        validateHandle(handle);
    }
    catch (err) {
        state.status = err instanceof Error ? err.message : 'Invalid handle.';
        return null;
    }
    const contact = await runtime.addContact(app.relayBaseUrl, app.session.accessToken, handle);
    ensureContactSession(app.configDir, contact);
    state.status = `Added @${contact.handle}.`;
    return contact;
}
async function reconfigureRelayFullscreen(app, state, askQuestion, runtime) {
    const envRelay = process.env['MORS_RELAY_BASE_URL']?.trim();
    if (envRelay) {
        state.status = `Relay pinned by MORS_RELAY_BASE_URL: ${envRelay}`;
        return;
    }
    const choice = (await askQuestion(`Relay [1 hosted / 2 custom] (current: ${app.relayBaseUrl}): `))
        .trim()
        .toLowerCase();
    if (choice === '1' || choice === 'hosted' || choice === '') {
        saveClientSettings(app.configDir, {
            relayMode: 'hosted',
            relayBaseUrl: DEFAULT_HOSTED_RELAY_BASE_URL,
        });
        app.relayBaseUrl = DEFAULT_HOSTED_RELAY_BASE_URL;
        state.relayBaseUrl = DEFAULT_HOSTED_RELAY_BASE_URL;
        await publishLocalDeviceBundle(app, runtime);
        state.status = `Using hosted relay ${DEFAULT_HOSTED_RELAY_BASE_URL}.`;
        return;
    }
    if (choice === '2' || choice === 'custom') {
        const custom = (await askQuestion('Custom relay URL: ')).trim();
        try {
            const normalized = new URL(custom).toString().replace(/\/$/, '');
            saveClientSettings(app.configDir, {
                relayMode: 'custom',
                relayBaseUrl: normalized,
            });
            app.relayBaseUrl = normalized;
            state.relayBaseUrl = normalized;
            await publishLocalDeviceBundle(app, runtime);
            state.status = `Using custom relay ${normalized}.`;
        }
        catch {
            state.status = 'Please enter a valid http(s) URL.';
        }
        return;
    }
    state.status = 'Relay change cancelled.';
}
function moveSelection(state, delta) {
    if (state.focus === 'contacts') {
        state.selectedContactIndex = clampIndex(state.selectedContactIndex + delta, state.contacts.length);
        return;
    }
    const length = state.activityView === 'pending' ? state.pending.length : state.inbox.length;
    state.selectedActivityIndex = clampIndex(state.selectedActivityIndex + delta, length);
}
function getSelectedContact(state) {
    if (state.contacts.length === 0) {
        return null;
    }
    return state.contacts[clampIndex(state.selectedContactIndex, state.contacts.length)];
}
function getSelectedActivity(state) {
    if (state.activityView === 'pending') {
        if (state.pending.length === 0) {
            return null;
        }
        return state.pending[clampIndex(state.selectedActivityIndex, state.pending.length)];
    }
    if (state.inbox.length === 0) {
        return null;
    }
    return state.inbox[clampIndex(state.selectedActivityIndex, state.inbox.length)];
}
export function buildStartScreen(state, options = {}) {
    const width = Math.max(80, options.width ?? 100);
    const height = Math.max(24, options.height ?? 30);
    const leftWidth = Math.max(26, Math.floor(width * 0.32));
    const rightWidth = width - leftWidth - 3;
    const bodyHeight = Math.max(12, height - 8);
    const activityHeight = Math.max(6, Math.floor(bodyHeight * 0.45));
    const previewHeight = bodyHeight - activityHeight - 1;
    const header = [
        truncate(`mors start | @${state.handle} | ${state.relayBaseUrl}`, width),
        truncate(`Status: ${state.status}`, width),
        ''.padEnd(width),
    ];
    const contactsLines = buildContactsPanel(state, leftWidth, bodyHeight);
    const activityLines = buildActivityPanel(state, rightWidth, activityHeight);
    const previewLines = buildPreviewPanel(state, rightWidth, previewHeight);
    const body = [];
    for (let index = 0; index < bodyHeight; index++) {
        const left = contactsLines[index] ?? ''.padEnd(leftWidth);
        const rightSource = index < activityHeight ? activityLines[index] : previewLines[index - activityHeight - 1] ?? ''.padEnd(rightWidth);
        const right = rightSource ?? ''.padEnd(rightWidth);
        const divider = index === activityHeight ? '-' : '|';
        body.push(`${left} ${divider} ${right}`);
    }
    const footer = [
        ''.padEnd(width, '-'),
        truncate('Keys: Tab switch | j/k move | Enter open/approve | a add | c compose | i inbox | p pending | r relay | g refresh | q quit', width),
        truncate(state.composerOpen
            ? `Compose -> @${getSelectedContact(state)?.handle ?? 'nobody'}: ${state.draft}_`
            : 'Composer closed. Select a contact and press c to send.', width),
    ];
    return [...header, ...body, ...footer].join('\n');
}
function buildContactsPanel(state, width, height) {
    const lines = [panelHeader('Contacts', width, state.focus === 'contacts')];
    if (state.contacts.length === 0) {
        lines.push(padLine('No contacts yet', width));
    }
    else {
        state.contacts.forEach((contact, index) => {
            const prefix = state.selectedContactIndex === index ? '>' : ' ';
            lines.push(padLine(`${prefix} @${contact.handle} ${contact.status === 'approved' ? '[ok]' : '[pending]'}`, width));
            lines.push(padLine(`  ${contact.display_name}`, width));
        });
    }
    return fillLines(lines, width, height);
}
function buildActivityPanel(state, width, height) {
    const title = state.activityView === 'pending' ? 'Pending approvals' : 'Inbox';
    const focused = state.focus === 'activity';
    const lines = [panelHeader(title, width, focused)];
    if (state.activityView === 'pending') {
        if (state.pending.length === 0) {
            lines.push(padLine('No pending contacts', width));
        }
        else {
            state.pending.forEach((contact, index) => {
                const prefix = state.selectedActivityIndex === index ? '>' : ' ';
                lines.push(padLine(`${prefix} @${contact.handle}`, width));
                lines.push(padLine(`  ${contact.display_name}`, width));
            });
        }
    }
    else if (state.inbox.length === 0) {
        lines.push(padLine('No messages yet', width));
    }
    else {
        state.inbox.forEach((message, index) => {
            const prefix = state.selectedActivityIndex === index ? '>' : ' ';
            const senderLabel = describeMessageSender(state, message);
            const preview = isEncryptedPayload(message.body)
                ? '[encrypted message]'
                : message.body.replace(/\s+/g, ' ').slice(0, Math.max(12, width - 18));
            lines.push(padLine(`${prefix} ${senderLabel} (${message.state})`, width));
            lines.push(padLine(`  ${preview}`, width));
        });
    }
    return fillLines(lines, width, height);
}
function buildPreviewPanel(state, width, height) {
    const lines = [panelHeader(state.previewTitle, width, false)];
    for (const line of state.previewBody) {
        for (const wrapped of wrapText(line, Math.max(10, width - 2))) {
            lines.push(padLine(wrapped, width));
        }
    }
    return fillLines(lines, width, height);
}
function panelHeader(title, width, focused) {
    const label = focused ? `[${title} *]` : `[${title}]`;
    return padLine(label, width);
}
function fillLines(lines, width, height) {
    const filled = lines.slice(0, height).map((line) => padLine(line, width));
    while (filled.length < height) {
        filled.push(''.padEnd(width));
    }
    return filled;
}
function padLine(value, width) {
    return truncate(value, width).padEnd(width);
}
function truncate(value, width) {
    if (value.length <= width) {
        return value;
    }
    if (width <= 1) {
        return value.slice(0, width);
    }
    return `${value.slice(0, width - 1)}~`;
}
function wrapText(value, width) {
    if (value.length <= width) {
        return [value];
    }
    const words = value.split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= width) {
            current = candidate;
            continue;
        }
        if (current) {
            lines.push(current);
            current = word;
        }
        else {
            lines.push(word.slice(0, width));
            current = word.slice(width);
        }
    }
    if (current) {
        lines.push(current);
    }
    return lines.length > 0 ? lines : [''];
}
function clampIndex(index, length) {
    if (length <= 0) {
        return 0;
    }
    if (index < 0) {
        return 0;
    }
    if (index >= length) {
        return length - 1;
    }
    return index;
}
function describeMessageSender(state, message) {
    const knownContact = state.contacts.find((contact) => contact.account_id === message.sender_id) ??
        state.pending.find((contact) => contact.account_id === message.sender_id);
    if (knownContact) {
        return `@${knownContact.handle}`;
    }
    return message.sender_login;
}
function isTtyInput(stream) {
    return Boolean(stream.isTTY && stream.setRawMode);
}
function isTtyOutput(stream) {
    return Boolean(stream.isTTY);
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
    const result = await sendToContact(app, runtime, target, body);
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
async function sendToContact(app, runtime, target, body) {
    const queueStorePath = getQueueStorePath(app.configDir);
    const session = ensureContactSession(app.configDir, target);
    if (session && runtime.sendEncryptedMessage) {
        const result = await runtime.sendEncryptedMessage(app.relayBaseUrl, app.session.accessToken, queueStorePath, target.account_id, body, session.sharedSecret);
        return { ...result, encrypted: true };
    }
    const result = await runtime.sendMessage(app.relayBaseUrl, app.session.accessToken, queueStorePath, target.account_id, body);
    return { ...result, encrypted: false };
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
    writeLine(output, '  - use the full-screen terminal app when running in a real TTY');
}
//# sourceMappingURL=start.js.map