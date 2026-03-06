/**
 * CLI dispatcher for the mors command.
 *
 * Routes commands, handles init gating (VAL-INIT-005),
 * and formats output with secret redaction (VAL-INIT-004).
 */
import { initCommand, requireInit, getDbPath, getDbKeyPath } from './init.js';
import { loadKey } from './key-management.js';
import { openEncryptedDb, verifySqlCipherAvailable } from './store.js';
import { sendMessage, listInbox, readMessage, ackMessage, replyMessage, listThread, } from './message.js';
import { startWatch } from './watch.js';
import { runSetupShell } from './setup-shell.js';
import { runStartCommand } from './start.js';
import { MorsError, NotInitializedError, SqlCipherUnavailableError, DeviceNotBootstrappedError, KeyExchangeNotCompleteError, CipherError, } from './errors.js';
import { assertDeviceBootstrapped, requireDeviceBootstrap } from './e2ee/bootstrap-guard.js';
import { getDeviceKeysDir, isDeviceBootstrapped } from './e2ee/device-keys.js';
import { performKeyExchange, loadKeyExchangeSession, listKeyExchangeSessions, } from './e2ee/key-exchange.js';
import { ContractValidationError } from './contract/errors.js';
import { saveSession, loadSession, clearSession, markAuthEnabled, saveSigningKey, loadSigningKey, saveProfile, loadProfile, } from './auth/session.js';
import { validateInviteToken, generateSessionToken, generateSigningKey, NativeAuthPrerequisiteError, } from './auth/native.js';
import { requireAuth, verifyTokenLiveness, NotAuthenticatedError, TokenLivenessError, SigningKeyMismatchError, } from './auth/guards.js';
import { getConfigDir } from './identity.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync as execFileSyncImport } from 'node:child_process';
import { RelayClient, RelayClientError } from './relay/client.js';
import { connectRemoteWatch } from './remote-watch.js';
import { runDeployPreflight, formatDeployIssues, formatDeployResultJson, redactSecrets, } from './deploy.js';
import { validateHandle, normalizeHandle } from './relay/account-store.js';
import { resolveRelayBaseUrl } from './settings.js';
/** Commands that require initialization before use. */
const GATED_COMMANDS = new Set(['send', 'inbox', 'read', 'reply', 'ack', 'thread', 'watch']);
/** Commands that are implemented. */
const IMPLEMENTED_COMMANDS = new Set(['send', 'inbox', 'read', 'ack', 'reply', 'thread', 'watch']);
/**
 * Commands that should short-circuit to help output when `--help`/`-h` is present.
 *
 * Commands with dedicated help handling (quickstart, doctor, deploy) are excluded
 * to preserve their existing command-specific help output.
 */
const HELP_BYPASS_COMMANDS = new Set([
    'init',
    'login',
    'logout',
    'status',
    'start',
    'onboard',
    'setup-shell',
    'send',
    'inbox',
    'read',
    'reply',
    'ack',
    'thread',
    'watch',
]);
/**
 * Commands that require an authenticated session (in addition to init).
 *
 * After logout, these commands fail with login-required guidance (VAL-AUTH-005).
 */
const AUTH_GATED_COMMANDS = new Set(['send', 'inbox', 'read', 'reply', 'ack', 'thread', 'watch']);
export function run(args) {
    const command = args[0];
    const commandArgs = args.slice(1);
    if (!command || command === '--help' || command === '-h') {
        printUsage();
        return;
    }
    if (command === '--version' || command === '-v') {
        console.log('mors 0.1.0');
        return;
    }
    // Command-level help should never run init/auth/prerequisite logic.
    if (HELP_BYPASS_COMMANDS.has(command) && hasHelpFlag(commandArgs)) {
        printUsage();
        return;
    }
    if (command === 'init') {
        runInit(commandArgs);
        return;
    }
    if (command === 'quickstart') {
        runQuickstart(commandArgs);
        return;
    }
    if (command === 'doctor') {
        runDoctor(commandArgs);
        return;
    }
    if (command === 'setup-shell') {
        runSetupShellCommand(commandArgs);
        return;
    }
    if (command === 'start') {
        runStartCommand(commandArgs).catch((err) => {
            process.exitCode = 1;
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`Error: ${msg}`);
        });
        return;
    }
    if (command === 'login') {
        runLogin(commandArgs);
        return;
    }
    if (command === 'logout') {
        runLogout(commandArgs);
        return;
    }
    if (command === 'status') {
        // runStatus is async (token-liveness check); attach error handler
        // so the process waits for completion and sets exitCode deterministically.
        runStatus(commandArgs).catch((err) => {
            process.exitCode = 1;
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`Error: ${msg}`);
        });
        return;
    }
    if (command === 'deploy') {
        runDeploy(commandArgs);
        return;
    }
    if (command === 'key-exchange') {
        runKeyExchange(commandArgs);
        return;
    }
    if (command === 'onboard') {
        runOnboard(commandArgs).catch((err) => {
            process.exitCode = 1;
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`Error: ${msg}`);
        });
        return;
    }
    // ── Pre-init command gating (VAL-INIT-005) ──────────────────────
    if (GATED_COMMANDS.has(command)) {
        let configDir;
        try {
            configDir = requireInit();
        }
        catch (err) {
            if (err instanceof NotInitializedError) {
                console.error(`Error: ${err.message}`);
                process.exitCode = 1;
                return;
            }
            throw err;
        }
        // ── Auth gating: require active session (VAL-AUTH-005) ────────
        if (AUTH_GATED_COMMANDS.has(command)) {
            const { flags: cmdFlags } = parseArgs(commandArgs);
            const isJson = 'json' in cmdFlags;
            try {
                requireAuth(configDir);
            }
            catch (err) {
                if (err instanceof NotAuthenticatedError) {
                    if (isJson) {
                        console.log(JSON.stringify({
                            status: 'error',
                            error: 'not_authenticated',
                            message: err.message,
                        }));
                    }
                    else {
                        console.error(`Error: ${err.message}`);
                    }
                    process.exitCode = 1;
                    return;
                }
                throw err;
            }
        }
        // Dispatch to implemented commands.
        if (IMPLEMENTED_COMMANDS.has(command)) {
            runCommand(command, commandArgs, configDir);
            return;
        }
        // Command is gated but not yet implemented — report it.
        console.error(`Command "${command}" is not yet implemented.`);
        process.exitCode = 1;
        return;
    }
    console.error(`Unknown command: ${command}`);
    console.error('Run "mors --help" for usage information.');
    process.exitCode = 1;
}
function hasHelpFlag(args) {
    return args.includes('--help') || args.includes('-h');
}
/**
 * Open the encrypted database for an initialized config directory.
 */
function openStore(configDir) {
    const dbPath = getDbPath(configDir);
    const key = loadKey(getDbKeyPath(configDir));
    return openEncryptedDb({ dbPath, key });
}
// ── Remote mode detection and RelayClient factory ───────────────────
/** Error class for when remote prerequisites are missing. */
class RemoteUnavailableError extends MorsError {
    constructor(message) {
        super(message);
        this.name = 'RemoteUnavailableError';
    }
}
/**
 * Create a RelayClient from the current session and relay config.
 *
 * Requires both an active authenticated session (with access token) and
 * a relay base URL (env override, saved setting, or hosted default).
 *
 * @param configDir - Config directory containing the session.
 * @returns A configured RelayClient.
 * @throws RemoteUnavailableError if relay URL is not configured.
 * @throws NotAuthenticatedError if no active session exists.
 */
function createRelayClientFromSession(configDir) {
    const session = loadSession(configDir);
    if (!session) {
        throw new NotAuthenticatedError();
    }
    const relayBaseUrl = resolveRelayBaseUrl(configDir);
    if (!relayBaseUrl) {
        throw new RemoteUnavailableError('Remote relay is not configured. Run "mors start" or set MORS_RELAY_BASE_URL.');
    }
    return new RelayClient({
        baseUrl: relayBaseUrl,
        token: session.accessToken,
        queueStorePath: `${configDir}/offline-queue.json`,
    });
}
// ── E2EE secure remote helpers ──────────────────────────────────────
/**
 * Resolve a key exchange session for encrypted remote messaging.
 *
 * If peerDeviceId is specified, loads the session for that specific peer.
 * If not specified, lists all sessions and uses the sole session if exactly one exists.
 *
 * @param configDir - Config directory (used to locate E2EE keys).
 * @param peerDeviceId - Optional explicit peer device ID.
 * @returns The resolved KeyExchangeSession.
 * @throws DeviceNotBootstrappedError if device keys are not bootstrapped.
 * @throws KeyExchangeNotCompleteError if no matching key exchange session exists.
 */
function resolveKeyExchangeSession(configDir, peerDeviceId) {
    const keysDir = getDeviceKeysDir(configDir);
    // First, ensure device is bootstrapped
    requireDeviceBootstrap(keysDir);
    if (peerDeviceId) {
        const session = loadKeyExchangeSession(keysDir, peerDeviceId);
        if (!session) {
            throw new KeyExchangeNotCompleteError(peerDeviceId);
        }
        return session;
    }
    // No peer specified — check if there's exactly one session
    const sessions = listKeyExchangeSessions(keysDir);
    if (sessions.length === 0) {
        throw new KeyExchangeNotCompleteError('any', 'No key exchange sessions found. Encrypted remote messaging requires a pre-established ' +
            'key exchange session. Use --no-encrypt to send plaintext via relay, or use ' +
            '--peer-device <device-id> after a session is available.');
    }
    if (sessions.length === 1) {
        return sessions[0];
    }
    // Multiple sessions — require explicit --peer-device
    throw new KeyExchangeNotCompleteError('any', `Multiple key exchange sessions found (${sessions.length} peers). ` +
        'Use --peer-device <device-id> to specify which peer to encrypt for.');
}
/**
 * Dispatch a gated command after init validation.
 */
function runCommand(command, args, configDir) {
    switch (command) {
        case 'send':
            runSend(args, configDir);
            break;
        case 'inbox':
            runInbox(args, configDir);
            break;
        case 'read':
            runRead(args, configDir);
            break;
        case 'ack':
            runAck(args, configDir);
            break;
        case 'reply':
            runReply(args, configDir);
            break;
        case 'thread':
            runThread(args, configDir);
            break;
        case 'watch':
            runWatch(args, configDir);
            break;
    }
}
/**
 * Parse named CLI flags from args.
 * Supports --flag value and --flag=value patterns, plus boolean --json.
 */
function parseArgs(args) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const eqIndex = arg.indexOf('=');
            if (eqIndex >= 0) {
                const key = arg.slice(2, eqIndex);
                flags[key] = arg.slice(eqIndex + 1);
            }
            else {
                const key = arg.slice(2);
                const next = args[i + 1];
                if (next !== undefined && !next.startsWith('--')) {
                    flags[key] = next;
                    i++;
                }
                else {
                    flags[key] = true;
                }
            }
        }
        else {
            positional.push(arg);
        }
    }
    return { positional, flags };
}
// ── Send command ──────────────────────────────────────────────────────
function runSend(args, configDir) {
    const { flags } = parseArgs(args);
    const json = 'json' in flags;
    const secure = 'secure' in flags;
    const remote = 'remote' in flags;
    const noEncrypt = 'no-encrypt' in flags;
    const peerDevice = typeof flags['peer-device'] === 'string' ? flags['peer-device'] : undefined;
    const to = typeof flags['to'] === 'string' ? flags['to'] : undefined;
    const from = typeof flags['from'] === 'string' ? flags['from'] : undefined;
    const subject = typeof flags['subject'] === 'string' ? flags['subject'] : undefined;
    const body = typeof flags['body'] === 'string' ? flags['body'] : undefined;
    const dedupeKey = typeof flags['dedupe-key'] === 'string' ? flags['dedupe-key'] : undefined;
    const traceId = typeof flags['trace-id'] === 'string' ? flags['trace-id'] : undefined;
    if (!to) {
        formatError('send requires --to <recipient>', json);
        process.exitCode = 1;
        return;
    }
    if (!body) {
        formatError('send requires --body <message>', json);
        process.exitCode = 1;
        return;
    }
    // ── Remote mode: route through RelayClient ────────────────────────
    if (remote) {
        runRemoteSend(configDir, json, {
            to,
            body,
            subject,
            inReplyTo: undefined,
            noEncrypt,
            peerDevice,
        });
        return;
    }
    // ── E2EE bootstrap guard (VAL-E2EE-001) ──────────────────────────
    // When --secure is requested, verify device keys exist before proceeding.
    if (secure) {
        try {
            assertDeviceBootstrapped(getDeviceKeysDir(configDir));
        }
        catch (err) {
            if (err instanceof DeviceNotBootstrappedError) {
                if (json) {
                    console.log(JSON.stringify({
                        status: 'error',
                        error: 'device_not_bootstrapped',
                        message: err.message,
                    }));
                }
                else {
                    console.error(`Error: ${err.message}`);
                }
                process.exitCode = 1;
                return;
            }
            throw err;
        }
    }
    // Default sender to "local" if not specified.
    const sender = from ?? 'local';
    let db = null;
    try {
        db = openStore(configDir);
        const result = sendMessage(db, {
            sender,
            recipient: to,
            body,
            subject,
            dedupeKey,
            traceId,
        });
        if (json) {
            console.log(JSON.stringify({
                status: 'sent',
                id: result.id,
                thread_id: result.thread_id,
                sender: result.sender,
                recipient: result.recipient,
                state: result.state,
                dedupe_key: result.dedupe_key,
                trace_id: result.trace_id,
                dedupe_replay: result.dedupe_replay,
                created_at: result.created_at,
            }));
        }
        else {
            if (result.dedupe_replay) {
                console.log(`Message already sent (dedupe replay): ${result.id}`);
            }
            else {
                console.log(`Message sent: ${result.id}`);
            }
            console.log(`Thread: ${result.thread_id}`);
        }
    }
    catch (err) {
        process.exitCode = 1;
        handleCommandError(err, json);
    }
    finally {
        if (db)
            db.close();
    }
}
/**
 * Send a message through the relay via RelayClient.
 *
 * By default, uses encrypted transport (sendEncrypted) when a key-exchange
 * session exists for the peer device. Provides actionable guidance when
 * secure prerequisites (device bootstrap, key exchange) are missing.
 *
 * Use --no-encrypt to explicitly bypass encryption and send plaintext.
 *
 * Uses durable queue/retry from RelayClient. If the relay is unreachable,
 * the message is queued offline for later delivery.
 */
function runRemoteSend(configDir, json, opts) {
    let client;
    try {
        client = createRelayClientFromSession(configDir);
    }
    catch (err) {
        process.exitCode = 1;
        handleRemoteError(err, json);
        return;
    }
    const recipientId = opts.to.trim();
    if (!recipientId) {
        formatError('Remote send requires --to <recipient_account_id>', json, 'validation_error');
        process.exitCode = 1;
        return;
    }
    // ── Default encrypted path: resolve key exchange session ──────────
    if (!opts.noEncrypt) {
        let session;
        try {
            session = resolveKeyExchangeSession(configDir, opts.peerDevice);
        }
        catch (err) {
            process.exitCode = 1;
            handleSecureSetupError(err, json);
            return;
        }
        client
            .sendEncrypted({
            recipientId,
            body: opts.body,
            subject: opts.subject,
            inReplyTo: opts.inReplyTo,
            sharedSecret: session.sharedSecret,
        })
            .then((result) => {
            formatRemoteSendResult(result, json, true);
        })
            .catch((err) => {
            process.exitCode = 1;
            handleRemoteError(err, json);
        });
        return;
    }
    // ── Plaintext path (--no-encrypt) ─────────────────────────────────
    client
        .send({
        recipientId,
        body: opts.body,
        subject: opts.subject,
        inReplyTo: opts.inReplyTo,
    })
        .then((result) => {
        formatRemoteSendResult(result, json, false);
    })
        .catch((err) => {
        process.exitCode = 1;
        handleRemoteError(err, json);
    });
}
/**
 * Format the result of a remote send operation for CLI output.
 */
function formatRemoteSendResult(result, json, encrypted) {
    if (result.queued) {
        if (json) {
            console.log(JSON.stringify({
                status: 'queued',
                mode: 'remote',
                dedupe_key: result.dedupeKey,
                ...(encrypted ? { encrypted: true } : {}),
                message: 'Message queued offline. It will be delivered when the relay is reachable.',
            }));
        }
        else {
            console.log(`Message queued offline (dedupe key: ${result.dedupeKey})`);
            console.log('It will be delivered when the relay is reachable.');
        }
    }
    else if (result.message) {
        const msg = result.message;
        if (json) {
            console.log(JSON.stringify({
                status: 'sent',
                mode: 'remote',
                id: msg.id,
                thread_id: msg.thread_id,
                in_reply_to: msg.in_reply_to,
                sender_id: msg.sender_id,
                recipient_id: msg.recipient_id,
                state: msg.state,
                dedupe_key: result.dedupeKey,
                ...(encrypted ? { encrypted: true } : {}),
                created_at: msg.created_at,
            }));
        }
        else {
            const enc = encrypted ? ' [encrypted]' : '';
            console.log(`Message sent (remote${enc}): ${msg.id}`);
            console.log(`Thread: ${msg.thread_id}`);
        }
    }
}
// ── Inbox command ────────────────────────────────────────────────────
function runInbox(args, configDir) {
    const { flags } = parseArgs(args);
    const json = 'json' in flags;
    const remote = 'remote' in flags;
    const recipient = typeof flags['to'] === 'string' ? flags['to'] : undefined;
    const unreadOnly = 'unread' in flags;
    // ── Remote mode: fetch inbox from relay ───────────────────────────
    if (remote) {
        runRemoteInbox(configDir, json, { unreadOnly });
        return;
    }
    let db = null;
    try {
        db = openStore(configDir);
        const inbox = listInbox(db, { recipient, unreadOnly });
        if (json) {
            console.log(JSON.stringify({
                status: 'ok',
                count: inbox.length,
                messages: inbox,
            }));
        }
        else {
            if (inbox.length === 0) {
                console.log('No messages.');
            }
            else {
                for (const msg of inbox) {
                    const readMarker = msg.read_at ? '✓' : '•';
                    const stateTag = msg.state === 'acked' ? ' [acked]' : '';
                    console.log(`${readMarker} ${msg.id}  from:${msg.sender}  ${msg.state}${stateTag}`);
                    if (msg.subject) {
                        console.log(`  Subject: ${msg.subject}`);
                    }
                    console.log(`  ${msg.body.split('\n')[0].slice(0, 80)}`);
                }
                console.log(`\n${inbox.length} message(s)`);
            }
        }
    }
    catch (err) {
        process.exitCode = 1;
        handleCommandError(err, json);
    }
    finally {
        if (db)
            db.close();
    }
}
/**
 * Fetch inbox from the relay.
 *
 * Uses createRelayClientFromSession to validate prerequisites (session + relay URL),
 * then performs a direct HTTP request to the relay inbox endpoint.
 */
function runRemoteInbox(configDir, json, opts) {
    // Validate prerequisites (session exists, relay URL configured)
    try {
        createRelayClientFromSession(configDir);
    }
    catch (err) {
        process.exitCode = 1;
        handleRemoteError(err, json);
        return;
    }
    const session = loadSession(configDir);
    const baseUrl = resolveRelayBaseUrl(configDir);
    // Both are validated by createRelayClientFromSession above
    if (!session || !baseUrl)
        return;
    const token = session.accessToken;
    const unreadParam = opts.unreadOnly ? '?unread=true' : '';
    fetch(`${baseUrl}/inbox${unreadParam}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            Connection: 'close',
        },
    })
        .then(async (res) => {
        if (!res.ok) {
            throw new RelayClientError(res.status, await res.json().catch(() => res.statusText));
        }
        return res.json();
    })
        .then((data) => {
        if (json) {
            console.log(JSON.stringify({
                status: 'ok',
                mode: 'remote',
                count: data.count,
                messages: data.messages,
            }));
        }
        else {
            if (data.count === 0) {
                console.log('No messages (remote).');
            }
            else {
                for (const msg of data.messages) {
                    const readMarker = msg.read_at ? '✓' : '•';
                    const stateTag = msg.state === 'acked' ? ' [acked]' : '';
                    console.log(`${readMarker} ${msg.id}  from:${msg.sender_login}  ${msg.state}${stateTag}`);
                    if (msg.subject) {
                        console.log(`  Subject: ${msg.subject}`);
                    }
                    console.log(`  ${msg.body.split('\n')[0].slice(0, 80)}`);
                }
                console.log(`\n${data.count} message(s) (remote)`);
            }
        }
    })
        .catch((err) => {
        process.exitCode = 1;
        handleRemoteError(err, json);
    });
}
// ── Read command ─────────────────────────────────────────────────────
function runRead(args, configDir) {
    const { positional, flags } = parseArgs(args);
    const json = 'json' in flags;
    const remote = 'remote' in flags;
    const noEncrypt = 'no-encrypt' in flags;
    const peerDevice = typeof flags['peer-device'] === 'string' ? flags['peer-device'] : undefined;
    const messageId = positional[0];
    if (!messageId) {
        formatError('read requires a message ID argument', json);
        process.exitCode = 1;
        return;
    }
    // ── Remote mode: read through relay ───────────────────────────────
    if (remote) {
        runRemoteRead(configDir, json, messageId, { noEncrypt, peerDevice });
        return;
    }
    let db = null;
    try {
        db = openStore(configDir);
        const result = readMessage(db, messageId);
        if (json) {
            console.log(JSON.stringify({
                status: 'ok',
                message: result,
            }));
        }
        else {
            console.log(`Message: ${result.id}`);
            console.log(`Thread: ${result.thread_id}`);
            if (result.in_reply_to) {
                console.log(`In reply to: ${result.in_reply_to}`);
            }
            console.log(`From: ${result.sender}`);
            console.log(`To: ${result.recipient}`);
            console.log(`State: ${result.state}`);
            if (result.subject) {
                console.log(`Subject: ${result.subject}`);
            }
            console.log(`Read at: ${result.read_at ?? 'just now'}`);
            console.log(`Created: ${result.created_at}`);
            console.log('---');
            console.log(result.body);
        }
    }
    catch (err) {
        process.exitCode = 1;
        handleCommandError(err, json);
    }
    finally {
        if (db)
            db.close();
    }
}
/**
 * Read a message through the relay via RelayClient.
 */
/**
 * Read a message through the relay via RelayClient.
 *
 * By default, uses the encrypted read path (readDecrypted) when a key-exchange
 * session exists. The ciphertext body is decrypted and the plaintext is displayed.
 * Provides actionable guidance when secure prerequisites are missing.
 *
 * Use --no-encrypt to explicitly read the raw (ciphertext) body without decryption.
 */
function runRemoteRead(configDir, json, messageId, opts) {
    let client;
    try {
        client = createRelayClientFromSession(configDir);
    }
    catch (err) {
        process.exitCode = 1;
        handleRemoteError(err, json);
        return;
    }
    // ── Default encrypted path: resolve key exchange session ──────────
    if (!opts?.noEncrypt) {
        let session;
        try {
            session = resolveKeyExchangeSession(configDir, opts?.peerDevice);
        }
        catch (err) {
            process.exitCode = 1;
            handleSecureSetupError(err, json);
            return;
        }
        client
            .readDecrypted(messageId, session.sharedSecret)
            .then((result) => {
            const msg = result.message;
            if (json) {
                console.log(JSON.stringify({
                    status: 'ok',
                    mode: 'remote',
                    encrypted: true,
                    first_read: result.firstRead,
                    decrypted_body: result.decryptedBody,
                    message: msg,
                }));
            }
            else {
                console.log(`Message (remote) [encrypted]: ${msg.id}`);
                console.log(`Thread: ${msg.thread_id}`);
                if (msg.in_reply_to) {
                    console.log(`In reply to: ${msg.in_reply_to}`);
                }
                console.log(`From: ${msg.sender_login} (ID: ${msg.sender_id})`);
                console.log(`To: ${msg.recipient_id}`);
                console.log(`State: ${msg.state}`);
                if (msg.subject) {
                    console.log(`Subject: ${msg.subject}`);
                }
                console.log(`Read at: ${msg.read_at ?? 'just now'}`);
                console.log(`Created: ${msg.created_at}`);
                console.log('---');
                console.log(result.decryptedBody);
            }
        })
            .catch((err) => {
            process.exitCode = 1;
            if (err instanceof CipherError) {
                handleSecureSetupError(err, json);
            }
            else {
                handleRemoteError(err, json);
            }
        });
        return;
    }
    // ── Plaintext path (--no-encrypt) ─────────────────────────────────
    client
        .read(messageId)
        .then((result) => {
        const msg = result.message;
        if (json) {
            console.log(JSON.stringify({
                status: 'ok',
                mode: 'remote',
                first_read: result.firstRead,
                message: msg,
            }));
        }
        else {
            console.log(`Message (remote): ${msg.id}`);
            console.log(`Thread: ${msg.thread_id}`);
            if (msg.in_reply_to) {
                console.log(`In reply to: ${msg.in_reply_to}`);
            }
            console.log(`From: ${msg.sender_login} (ID: ${msg.sender_id})`);
            console.log(`To: ${msg.recipient_id}`);
            console.log(`State: ${msg.state}`);
            if (msg.subject) {
                console.log(`Subject: ${msg.subject}`);
            }
            console.log(`Read at: ${msg.read_at ?? 'just now'}`);
            console.log(`Created: ${msg.created_at}`);
            console.log('---');
            console.log(msg.body);
        }
    })
        .catch((err) => {
        process.exitCode = 1;
        handleRemoteError(err, json);
    });
}
// ── Ack command ──────────────────────────────────────────────────────
function runAck(args, configDir) {
    const { positional, flags } = parseArgs(args);
    const json = 'json' in flags;
    const remote = 'remote' in flags;
    const messageId = positional[0];
    if (!messageId) {
        formatError('ack requires a message ID argument', json);
        process.exitCode = 1;
        return;
    }
    // ── Remote mode: ack through relay ────────────────────────────────
    if (remote) {
        runRemoteAck(configDir, json, messageId);
        return;
    }
    let db = null;
    try {
        db = openStore(configDir);
        const result = ackMessage(db, messageId);
        if (json) {
            console.log(JSON.stringify({
                status: 'acked',
                id: result.id,
                thread_id: result.thread_id,
                state: result.state,
                updated_at: result.updated_at,
            }));
        }
        else {
            console.log(`Message acknowledged: ${result.id}`);
            console.log(`State: ${result.state}`);
        }
    }
    catch (err) {
        process.exitCode = 1;
        handleCommandError(err, json);
    }
    finally {
        if (db)
            db.close();
    }
}
/**
 * Acknowledge a message through the relay via RelayClient.
 */
function runRemoteAck(configDir, json, messageId) {
    let client;
    try {
        client = createRelayClientFromSession(configDir);
    }
    catch (err) {
        process.exitCode = 1;
        handleRemoteError(err, json);
        return;
    }
    client
        .ack(messageId)
        .then((result) => {
        const msg = result.message;
        if (json) {
            console.log(JSON.stringify({
                status: 'acked',
                mode: 'remote',
                id: msg.id,
                thread_id: msg.thread_id,
                state: msg.state,
                acked_at: msg.acked_at,
                updated_at: msg.updated_at,
                first_ack: result.firstAck,
            }));
        }
        else {
            console.log(`Message acknowledged (remote): ${msg.id}`);
            console.log(`State: ${msg.state}`);
        }
    })
        .catch((err) => {
        process.exitCode = 1;
        handleRemoteError(err, json);
    });
}
// ── Reply command ────────────────────────────────────────────────────
function runReply(args, configDir) {
    const { positional, flags } = parseArgs(args);
    const json = 'json' in flags;
    const secure = 'secure' in flags;
    const remote = 'remote' in flags;
    const noEncrypt = 'no-encrypt' in flags;
    const peerDevice = typeof flags['peer-device'] === 'string' ? flags['peer-device'] : undefined;
    const parentId = positional[0];
    const from = typeof flags['from'] === 'string' ? flags['from'] : undefined;
    const to = typeof flags['to'] === 'string' ? flags['to'] : undefined;
    const subject = typeof flags['subject'] === 'string' ? flags['subject'] : undefined;
    const body = typeof flags['body'] === 'string' ? flags['body'] : undefined;
    const dedupeKey = typeof flags['dedupe-key'] === 'string' ? flags['dedupe-key'] : undefined;
    const traceId = typeof flags['trace-id'] === 'string' ? flags['trace-id'] : undefined;
    if (!parentId) {
        formatError('reply requires a parent message ID argument', json);
        process.exitCode = 1;
        return;
    }
    if (!body) {
        formatError('reply requires --body <message>', json);
        process.exitCode = 1;
        return;
    }
    // ── Remote mode: reply through relay ──────────────────────────────
    if (remote) {
        const recipientId = to ?? undefined;
        runRemoteReply(configDir, json, {
            parentId,
            to: recipientId,
            body,
            subject,
            noEncrypt,
            peerDevice,
        });
        return;
    }
    // ── E2EE bootstrap guard (VAL-E2EE-001) ──────────────────────────
    // When --secure is requested, verify device keys exist before proceeding.
    if (secure) {
        try {
            assertDeviceBootstrapped(getDeviceKeysDir(configDir));
        }
        catch (err) {
            if (err instanceof DeviceNotBootstrappedError) {
                if (json) {
                    console.log(JSON.stringify({
                        status: 'error',
                        error: 'device_not_bootstrapped',
                        message: err.message,
                    }));
                }
                else {
                    console.error(`Error: ${err.message}`);
                }
                process.exitCode = 1;
                return;
            }
            throw err;
        }
    }
    // Default sender to "local" if not specified.
    const sender = from ?? 'local';
    // Default recipient to "local" if not specified.
    const recipient = to ?? 'local';
    let db = null;
    try {
        db = openStore(configDir);
        const result = replyMessage(db, {
            parentMessageId: parentId,
            sender,
            recipient,
            body,
            subject,
            dedupeKey,
            traceId,
        });
        if (json) {
            console.log(JSON.stringify({
                status: 'replied',
                id: result.id,
                thread_id: result.thread_id,
                in_reply_to: result.in_reply_to,
                sender: result.sender,
                recipient: result.recipient,
                state: result.state,
                dedupe_key: result.dedupe_key,
                trace_id: result.trace_id,
                dedupe_replay: result.dedupe_replay,
                created_at: result.created_at,
            }));
        }
        else {
            if (result.dedupe_replay) {
                console.log(`Reply already sent (dedupe replay): ${result.id}`);
            }
            else {
                console.log(`Reply sent: ${result.id}`);
            }
            console.log(`Thread: ${result.thread_id}`);
            console.log(`In reply to: ${result.in_reply_to}`);
        }
    }
    catch (err) {
        process.exitCode = 1;
        handleCommandError(err, json);
    }
    finally {
        if (db)
            db.close();
    }
}
/**
 * Reply to a message through the relay via RelayClient.
 *
 * By default, uses encrypted transport (sendEncrypted) when a key-exchange
 * session exists for the peer device. Provides actionable guidance when
 * secure prerequisites are missing.
 *
 * Uses the send endpoint with inReplyTo to establish causal linkage.
 * The relay server resolves thread_id from the parent message.
 */
function runRemoteReply(configDir, json, opts) {
    let client;
    try {
        client = createRelayClientFromSession(configDir);
    }
    catch (err) {
        process.exitCode = 1;
        handleRemoteError(err, json);
        return;
    }
    // For remote reply, --to must be a recipient account ID
    const recipientId = opts.to?.trim() ?? '';
    if (!recipientId) {
        formatError('Remote reply requires --to <recipient_account_id>', json, 'validation_error');
        process.exitCode = 1;
        return;
    }
    // ── Default encrypted path: resolve key exchange session ──────────
    if (!opts.noEncrypt) {
        let session;
        try {
            session = resolveKeyExchangeSession(configDir, opts.peerDevice);
        }
        catch (err) {
            process.exitCode = 1;
            handleSecureSetupError(err, json);
            return;
        }
        client
            .sendEncrypted({
            recipientId,
            body: opts.body,
            subject: opts.subject,
            inReplyTo: opts.parentId,
            sharedSecret: session.sharedSecret,
        })
            .then((result) => {
            formatRemoteReplyResult(result, json, true, opts.parentId);
        })
            .catch((err) => {
            process.exitCode = 1;
            handleRemoteError(err, json);
        });
        return;
    }
    // ── Plaintext path (--no-encrypt) ─────────────────────────────────
    client
        .send({
        recipientId,
        body: opts.body,
        subject: opts.subject,
        inReplyTo: opts.parentId,
    })
        .then((result) => {
        formatRemoteReplyResult(result, json, false, opts.parentId);
    })
        .catch((err) => {
        process.exitCode = 1;
        handleRemoteError(err, json);
    });
}
/**
 * Format the result of a remote reply operation for CLI output.
 */
function formatRemoteReplyResult(result, json, encrypted, parentId) {
    if (result.queued) {
        if (json) {
            console.log(JSON.stringify({
                status: 'queued',
                mode: 'remote',
                dedupe_key: result.dedupeKey,
                in_reply_to: parentId,
                ...(encrypted ? { encrypted: true } : {}),
                message: 'Reply queued offline. It will be delivered when the relay is reachable.',
            }));
        }
        else {
            console.log(`Reply queued offline (dedupe key: ${result.dedupeKey})`);
            console.log(`In reply to: ${parentId}`);
        }
    }
    else if (result.message) {
        const msg = result.message;
        if (json) {
            console.log(JSON.stringify({
                status: 'replied',
                mode: 'remote',
                id: msg.id,
                thread_id: msg.thread_id,
                in_reply_to: msg.in_reply_to,
                sender_id: msg.sender_id,
                recipient_id: msg.recipient_id,
                state: msg.state,
                dedupe_key: result.dedupeKey,
                ...(encrypted ? { encrypted: true } : {}),
                created_at: msg.created_at,
            }));
        }
        else {
            const enc = encrypted ? ' [encrypted]' : '';
            console.log(`Reply sent (remote${enc}): ${msg.id}`);
            console.log(`Thread: ${msg.thread_id}`);
            console.log(`In reply to: ${msg.in_reply_to}`);
        }
    }
}
// ── Thread command ───────────────────────────────────────────────────
function runThread(args, configDir) {
    const { positional, flags } = parseArgs(args);
    const json = 'json' in flags;
    const threadId = positional[0];
    if (!threadId) {
        formatError('thread requires a thread ID argument', json);
        process.exitCode = 1;
        return;
    }
    let db = null;
    try {
        db = openStore(configDir);
        const thread = listThread(db, threadId);
        if (json) {
            console.log(JSON.stringify({
                status: 'ok',
                thread_id: threadId,
                count: thread.length,
                messages: thread,
            }));
        }
        else {
            if (thread.length === 0) {
                console.log('No messages in thread.');
            }
            else {
                console.log(`Thread: ${threadId} (${thread.length} message(s))\n`);
                for (const msg of thread) {
                    const indent = msg.in_reply_to ? '  ↳ ' : '';
                    const readMarker = msg.read_at ? '✓' : '•';
                    const stateTag = msg.state === 'acked' ? ' [acked]' : '';
                    console.log(`${indent}${readMarker} ${msg.id}  from:${msg.sender}  ${msg.state}${stateTag}`);
                    if (msg.in_reply_to) {
                        console.log(`${indent}  In reply to: ${msg.in_reply_to}`);
                    }
                    if (msg.subject) {
                        console.log(`${indent}  Subject: ${msg.subject}`);
                    }
                    console.log(`${indent}  ${msg.body.split('\n')[0].slice(0, 80)}`);
                }
            }
        }
    }
    catch (err) {
        process.exitCode = 1;
        handleCommandError(err, json);
    }
    finally {
        if (db)
            db.close();
    }
}
// ── Watch command ─────────────────────────────────────────────────
function runWatch(args, configDir) {
    const { flags } = parseArgs(args);
    const json = 'json' in flags;
    const remote = 'remote' in flags;
    // ── Remote mode: connect to relay SSE stream ─────────────────────
    if (remote) {
        runRemoteWatch(configDir, json);
        return;
    }
    const pollInterval = typeof flags['poll-interval'] === 'string' ? parseInt(flags['poll-interval'], 10) : 500;
    if (isNaN(pollInterval) || pollInterval < 10) {
        formatError('--poll-interval must be a number >= 10 (ms)', json);
        process.exitCode = 1;
        return;
    }
    let db = null;
    try {
        db = openStore(configDir);
    }
    catch (err) {
        process.exitCode = 1;
        handleCommandError(err, json);
        return;
    }
    const controller = new AbortController();
    // ── SIGINT handling for clean shutdown (VAL-WATCH-002) ──────────
    const onSigint = () => {
        controller.abort();
    };
    process.on('SIGINT', onSigint);
    if (!json) {
        console.log('Watching for new events... (press Ctrl+C to stop)');
    }
    const handle = startWatch(db, {
        pollIntervalMs: pollInterval,
        signal: controller.signal,
        onEvent: (event) => {
            if (json) {
                console.log(JSON.stringify(event));
            }
            else {
                formatWatchEvent(event);
            }
        },
        onShutdown: () => {
            // Clean up: remove SIGINT listener, close DB.
            process.removeListener('SIGINT', onSigint);
            if (db) {
                try {
                    db.close();
                }
                catch {
                    // Best-effort DB close.
                }
                db = null;
            }
            if (!json) {
                console.log('\nWatch stopped.');
            }
        },
    });
    // Keep the process alive until done resolves.
    handle.done.then(() => {
        // Ensure clean exit code.
        if (!process.exitCode) {
            process.exitCode = 0;
        }
    });
}
/**
 * Run remote watch: connect to relay SSE /events endpoint with auth.
 *
 * Establishes an authenticated SSE connection for realtime event streaming.
 * When SSE is unavailable (connection refused, auth failure, server error),
 * displays explicit degraded fallback indication and exits cleanly.
 *
 * Reconnect with cursor/Last-Event-ID is supported through the underlying
 * connectRemoteWatch module.
 *
 * Covers:
 * - VAL-STREAM-001: watch --remote connects to relay SSE with auth session
 * - VAL-STREAM-003: Remote watch reconnect uses cursor/Last-Event-ID path
 * - VAL-STREAM-007: When SSE is unavailable, CLI displays explicit fallback/degraded mode
 */
function runRemoteWatch(configDir, json) {
    // Validate prerequisites: session + relay URL
    const session = loadSession(configDir);
    if (!session) {
        process.exitCode = 1;
        handleRemoteError(new NotAuthenticatedError(), json);
        return;
    }
    const relayBaseUrl = resolveRelayBaseUrl(configDir);
    if (!relayBaseUrl) {
        process.exitCode = 1;
        handleRemoteError(new RemoteUnavailableError('Remote relay is not configured. Run "mors start" or set MORS_RELAY_BASE_URL.'), json);
        return;
    }
    if (!json) {
        console.log('Connecting to remote watch stream... (press Ctrl+C to stop)');
    }
    const handle = connectRemoteWatch({
        baseUrl: relayBaseUrl,
        token: session.accessToken,
        onEvent: (event) => {
            if (json) {
                console.log(JSON.stringify({
                    event: event.event,
                    ...(event.id ? { event_id: event.id } : {}),
                    ...event.data,
                }));
            }
            else {
                formatRemoteWatchEvent(event);
            }
        },
        onStateChange: (newState, reason) => {
            if (newState === 'fallback') {
                if (json) {
                    console.log(JSON.stringify({
                        status: 'degraded',
                        mode: 'fallback',
                        reason: reason ?? 'SSE unavailable',
                    }));
                }
                else {
                    console.log(`\n⚠️  Degraded mode: ${reason ?? 'SSE unavailable'}`);
                    console.log('Realtime events are not available. Use "mors inbox --remote" to check for new messages.');
                }
            }
        },
    });
    // ── SIGINT handling for clean shutdown ──────────────────────────
    const onSigint = () => {
        handle.stop();
        process.removeListener('SIGINT', onSigint);
        if (!json) {
            console.log('\nRemote watch stopped.');
        }
    };
    process.on('SIGINT', onSigint);
    // Keep the process alive until done resolves.
    handle.done.then(() => {
        process.removeListener('SIGINT', onSigint);
        if (!process.exitCode) {
            process.exitCode = 0;
        }
    });
}
/**
 * Format a remote watch event for human-readable CLI output.
 */
function formatRemoteWatchEvent(event) {
    if (event.event === 'connected') {
        const accountId = event.data.account_id ?? 'unknown';
        console.log(`✓ Connected to remote watch (account: ${accountId})`);
        return;
    }
    if (event.event === 'auth_expired') {
        const detail = event.data.detail ?? 'Token expired';
        console.log(`\n⚠️  Auth expired: ${detail}`);
        console.log('Run "mors login" to re-authenticate, then restart watch.');
        return;
    }
    if (event.event === 'fallback') {
        // Already handled by onStateChange callback
        return;
    }
    const typeLabel = event.event === 'message_created'
        ? '📨 New message'
        : event.event === 'reply_created'
            ? '↩️  Reply'
            : event.event === 'message_acked'
                ? '✅ Acked'
                : event.event;
    const timestamp = event.data.timestamp ?? new Date().toISOString();
    const messageId = event.data.message_id ?? 'unknown';
    const threadId = event.data.thread_id ?? 'unknown';
    const senderId = event.data.sender_id ?? 'unknown';
    const recipientId = event.data.recipient_id ?? 'unknown';
    const inReplyTo = event.data.in_reply_to;
    console.log(`[${timestamp}] ${typeLabel}`);
    console.log(`  Message: ${messageId}  Thread: ${threadId}`);
    console.log(`  From: ${senderId} → To: ${recipientId}`);
    if (inReplyTo) {
        console.log(`  In reply to: ${inReplyTo}`);
    }
}
function formatWatchEvent(event) {
    const typeLabel = event.event_type === 'message_created'
        ? '📨 New message'
        : event.event_type === 'reply_created'
            ? '↩️  Reply'
            : event.event_type === 'message_acked'
                ? '✅ Acked'
                : event.event_type;
    const replyInfo = event.in_reply_to ? `  In reply to: ${event.in_reply_to}` : '';
    console.log(`[${event.timestamp}] ${typeLabel}`);
    console.log(`  Message: ${event.message_id}  Thread: ${event.thread_id}`);
    console.log(`  From: ${event.sender} → To: ${event.recipient}  State: ${event.state}`);
    if (replyInfo) {
        console.log(replyInfo);
    }
}
// ── Setup-shell command ──────────────────────────────────────────────
function runSetupShellCommand(_args) {
    const { flags } = parseArgs(_args);
    const json = 'json' in flags;
    const autoConfirm = 'confirm' in flags;
    const autoDecline = 'decline' in flags;
    runSetupShell({
        json,
        autoConfirm,
        autoDecline,
    })
        .then(() => {
        // Success — exit code remains 0.
    })
        .catch((err) => {
        process.exitCode = 1;
        const msg = err instanceof Error ? err.message : String(err);
        if (json) {
            console.log(JSON.stringify({
                status: 'error',
                error: 'setup_shell_failed',
                message: msg,
            }));
        }
        else {
            console.error(`Error: ${msg}`);
        }
    });
}
// ── Login command (VAL-AUTH-001, VAL-AUTH-002, VAL-AUTH-007, VAL-AUTH-011) ─
function runLogin(_args) {
    const { flags, positional } = parseArgs(_args);
    const json = 'json' in flags;
    const configDir = getConfigDir();
    // Check for existing session
    const existing = loadSession(configDir);
    if (existing) {
        if (json) {
            console.log(JSON.stringify({
                status: 'already_authenticated',
                account_id: existing.accountId,
                device_id: existing.deviceId,
            }));
        }
        else {
            console.log(`Already logged in (account: ${existing.accountId})`);
            console.log('Run "mors logout" first to switch accounts.');
        }
        return;
    }
    // ── Prerequisites check (VAL-AUTH-007, VAL-AUTH-011) ──────────
    const missing = [];
    // Check invite token
    const inviteToken = flags['invite-token'] ??
        positional[0] ??
        process.env['MORS_INVITE_TOKEN'];
    if (!inviteToken) {
        missing.push('invite_token');
    }
    // Check device keys bootstrap
    const keysDir = getDeviceKeysDir(configDir);
    const hasDeviceKeys = isDeviceBootstrapped(keysDir);
    if (!hasDeviceKeys) {
        missing.push('device_keys');
    }
    // Check init
    const isInited = existsSyncCheck(`${configDir}/.initialized`);
    if (!isInited) {
        missing.push('initialized');
    }
    if (missing.length > 0) {
        process.exitCode = 1;
        const prereqError = new NativeAuthPrerequisiteError(missing);
        if (json) {
            console.log(JSON.stringify({
                status: 'error',
                error: 'missing_prerequisites',
                missing,
                message: prereqError.message,
            }));
        }
        else {
            console.error(`Error: ${prereqError.message}`);
        }
        return;
    }
    // Validate invite token format (VAL-AUTH-011)
    const inviteResult = validateInviteToken(inviteToken);
    if (!inviteResult.valid) {
        process.exitCode = 1;
        if (json) {
            console.log(JSON.stringify({
                status: 'error',
                error: 'invalid_invite_token',
                message: inviteResult.reason ?? 'Invalid invite token.',
            }));
        }
        else {
            console.error(`Error: ${inviteResult.reason ?? 'Invalid invite token.'}`);
            console.error('Obtain a valid invite token from an existing mors user or admin.');
        }
        return;
    }
    // Generate device ID for this installation (VAL-AUTH-009)
    const deviceId = `device-${randomUUID()}`;
    // Resolve signing key for session tokens.
    // Prefer MORS_RELAY_SIGNING_KEY env var for deterministic key coordination
    // between CLI token issuance and relay token verification. This ensures
    // login-issued tokens are accepted by the relay under configured signing-key policy.
    // Falls back to a locally generated key when env var is not set (offline/local-only use).
    const envSigningKey = (process.env['MORS_RELAY_SIGNING_KEY'] ?? '').trim();
    let signingKey;
    if (envSigningKey) {
        signingKey = envSigningKey;
        // Persist the env-sourced key locally so offline status checks work
        saveSigningKey(configDir, signingKey);
    }
    else {
        signingKey = loadSigningKey(configDir) ?? '';
        if (!signingKey) {
            signingKey = generateSigningKey();
            saveSigningKey(configDir, signingKey);
        }
    }
    // Generate session token (HMAC-signed, VAL-AUTH-002)
    const sessionToken = generateSessionToken({
        accountId: inviteResult.accountId,
        deviceId,
        signingKey,
    });
    // Mark auth as enabled so logout re-gates protected commands (VAL-AUTH-005)
    markAuthEnabled(configDir);
    // Persist session (VAL-AUTH-002)
    saveSession(configDir, {
        accessToken: sessionToken,
        tokenType: 'bearer',
        accountId: inviteResult.accountId,
        deviceId,
        createdAt: new Date().toISOString(),
    });
    if (json) {
        console.log(JSON.stringify({
            status: 'authenticated',
            account_id: inviteResult.accountId,
            device_id: deviceId,
        }));
    }
    else {
        console.log('\n✅ Authenticated with mors-native identity');
        console.log(`Account: ${inviteResult.accountId}`);
        console.log(`Device: ${deviceId}`);
    }
}
/** Check if a path exists on disk (sync). */
function existsSyncCheck(filePath) {
    return existsSync(filePath);
}
// ── Logout command (VAL-AUTH-005) ────────────────────────────────────
function runLogout(_args) {
    const { flags } = parseArgs(_args);
    const json = 'json' in flags;
    const configDir = getConfigDir();
    const existing = loadSession(configDir);
    clearSession(configDir);
    if (json) {
        console.log(JSON.stringify({
            status: 'logged_out',
            had_session: existing !== null,
        }));
    }
    else {
        if (existing) {
            console.log(`Logged out (was: ${existing.accountId}).`);
        }
        else {
            console.log('No active session. Already logged out.');
        }
    }
}
/**
 * Call the relay /accounts/register endpoint to enforce global handle uniqueness.
 *
 * Uses Node.js built-in http/https to avoid the undici connection-pool
 * keep-alive behavior that prevents the CLI process from exiting promptly.
 *
 * Returns a result indicating whether the relay rejected the registration.
 * If the relay is unreachable, returns success (graceful degradation —
 * global uniqueness will be enforced when relay becomes available).
 *
 * @param relayBaseUrl - Relay server base URL (e.g. http://localhost:3100).
 * @param token - Bearer token for authentication.
 * @param opts - Handle and display name to register.
 * @returns Registration result.
 */
async function relayRegisterHandle(relayBaseUrl, token, opts) {
    const { request: httpRequest } = await import('node:http');
    const { request: httpsRequest } = await import('node:https');
    const url = new URL('/accounts/register', relayBaseUrl);
    const isHttps = url.protocol === 'https:';
    const doRequest = isHttps ? httpsRequest : httpRequest;
    const payload = JSON.stringify({
        handle: opts.handle,
        display_name: opts.displayName,
    });
    return new Promise((resolve) => {
        const req = doRequest(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                Connection: 'close',
            },
            timeout: 10000,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const statusCode = res.statusCode ?? 500;
                let body = {};
                try {
                    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                }
                catch {
                    /* ignore parse errors */
                }
                if (statusCode === 409) {
                    resolve({
                        error: true,
                        errorType: body['error'] ?? 'duplicate_handle',
                        message: body['detail'] ?? 'Handle is already taken or cannot be changed.',
                    });
                    return;
                }
                if (statusCode === 400) {
                    resolve({
                        error: true,
                        errorType: 'invalid_handle',
                        message: body['detail'] ?? 'Invalid handle format.',
                    });
                    return;
                }
                if (statusCode === 401) {
                    resolve({
                        error: true,
                        errorType: 'not_authenticated',
                        message: 'Authentication failed with relay. Run "mors login" to re-authenticate.',
                    });
                    return;
                }
                // Success or unexpected error — don't block local persistence
                resolve({ error: false });
            });
        });
        req.on('error', () => {
            // Relay unreachable — graceful degradation
            resolve({ error: false });
        });
        req.on('timeout', () => {
            req.destroy();
            // Timeout — graceful degradation
            resolve({ error: false });
        });
        req.write(payload);
        req.end();
    });
}
/**
 * First-run onboarding wizard.
 *
 * Captures a globally unique immutable handle and basic profile metadata.
 * When MORS_RELAY_BASE_URL is configured, calls the relay /accounts/register
 * endpoint first to enforce global unique-handle constraints end-to-end.
 * Only persists the profile locally after relay confirmation (or if relay
 * is unreachable for graceful degradation).
 *
 * Requires:
 * - Initialization (mors init)
 * - Authenticated session (mors login)
 *
 * Flags:
 * - --handle <handle>         Required. Globally unique handle.
 * - --display-name <name>     Required. Display name for profile.
 * - --json                    Output JSON.
 */
async function runOnboard(_args) {
    const { flags } = parseArgs(_args);
    const json = 'json' in flags;
    const configDir = getConfigDir();
    // Check init
    try {
        requireInit();
    }
    catch (err) {
        if (err instanceof NotInitializedError) {
            process.exitCode = 1;
            if (json) {
                console.log(JSON.stringify({
                    status: 'error',
                    error: 'not_initialized',
                    message: err.message,
                }));
            }
            else {
                console.error(`Error: ${err.message}`);
            }
            return;
        }
        throw err;
    }
    // Check auth
    try {
        requireAuth(configDir);
    }
    catch (err) {
        if (err instanceof NotAuthenticatedError) {
            process.exitCode = 1;
            if (json) {
                console.log(JSON.stringify({
                    status: 'error',
                    error: 'not_authenticated',
                    message: 'Not authenticated. Run "mors login" before onboarding.',
                }));
            }
            else {
                console.error('Error: Not authenticated. Run "mors login" before onboarding.');
            }
            return;
        }
        throw err;
    }
    const session = loadSession(configDir);
    if (!session) {
        process.exitCode = 1;
        if (json) {
            console.log(JSON.stringify({
                status: 'error',
                error: 'not_authenticated',
                message: 'No active session. Run "mors login" to authenticate.',
            }));
        }
        else {
            console.error('Error: No active session. Run "mors login" to authenticate.');
        }
        return;
    }
    // Check if already onboarded
    const existingProfile = loadProfile(configDir);
    if (existingProfile) {
        if (json) {
            console.log(JSON.stringify({
                status: 'already_onboarded',
                handle: existingProfile.handle,
                display_name: existingProfile.displayName,
                account_id: existingProfile.accountId,
            }));
        }
        else {
            console.log(`Already onboarded (handle: ${existingProfile.handle}).`);
            console.log('Handles are immutable and cannot be changed after creation.');
        }
        return;
    }
    // Parse required flags
    const rawHandle = typeof flags['handle'] === 'string' ? flags['handle'] : undefined;
    const displayName = typeof flags['display-name'] === 'string' ? flags['display-name'] : undefined;
    if (!rawHandle || !displayName) {
        process.exitCode = 1;
        const missing = [];
        if (!rawHandle)
            missing.push('--handle');
        if (!displayName)
            missing.push('--display-name');
        if (json) {
            console.log(JSON.stringify({
                status: 'error',
                error: 'missing_required_fields',
                missing,
                message: `Missing required fields: ${missing.join(', ')}. Both --handle and --display-name are required for onboarding.`,
            }));
        }
        else {
            console.error(`Error: Missing required fields: ${missing.join(', ')}.`);
            console.error('Usage: mors onboard --handle <handle> --display-name <name> [--json]');
        }
        return;
    }
    // Normalize and validate handle format locally before attempting relay registration
    let handle;
    try {
        handle = normalizeHandle(rawHandle);
        validateHandle(handle);
    }
    catch (err) {
        process.exitCode = 1;
        if (err instanceof Error) {
            if (json) {
                console.log(JSON.stringify({
                    status: 'error',
                    error: 'invalid_handle',
                    message: err.message,
                }));
            }
            else {
                console.error(`Error: ${err.message}`);
            }
        }
        return;
    }
    // ── Relay registration: enforce global uniqueness before local persistence ──
    // If MORS_RELAY_BASE_URL is configured, call relay /accounts/register
    // to enforce the global unique-handle constraint end-to-end.
    // On relay rejection (duplicate/immutable), fail without local persistence.
    // On relay unreachable, persist locally as graceful degradation.
    const relayBaseUrl = resolveRelayBaseUrl(configDir);
    if (relayBaseUrl) {
        const relayResult = await relayRegisterHandle(relayBaseUrl, session.accessToken, {
            handle,
            displayName,
        });
        if (relayResult.error) {
            process.exitCode = 1;
            if (json) {
                console.log(JSON.stringify({
                    status: 'error',
                    error: relayResult.errorType ?? 'relay_error',
                    message: relayResult.message ?? 'Relay registration failed.',
                }));
            }
            else {
                console.error(`Error: ${relayResult.message ?? 'Relay registration failed.'}`);
            }
            return;
        }
        // If relay succeeded or was unreachable, continue to local persistence.
    }
    // Persist profile locally (VAL-AUTH-008, VAL-AUTH-012)
    saveProfile(configDir, {
        handle,
        displayName,
        accountId: session.accountId,
        createdAt: new Date().toISOString(),
    });
    if (json) {
        console.log(JSON.stringify({
            status: 'onboarded',
            handle,
            display_name: displayName,
            account_id: session.accountId,
        }));
    }
    else {
        console.log('\n✅ Onboarding complete');
        console.log(`Handle: ${handle}`);
        console.log(`Display Name: ${displayName}`);
        console.log(`Account: ${session.accountId}`);
        console.log('\nYour handle is immutable and cannot be changed.');
    }
}
// ── Status command (VAL-AUTH-002, VAL-AUTH-006) ──────────────────────
async function runStatus(_args) {
    const { flags } = parseArgs(_args);
    const json = 'json' in flags;
    const skipLiveness = 'offline' in flags;
    const configDir = getConfigDir();
    const session = loadSession(configDir);
    if (!session) {
        if (json) {
            console.log(JSON.stringify({
                status: 'not_authenticated',
                message: 'No active session. Run "mors login" to authenticate.',
            }));
        }
        else {
            console.log('Not authenticated. Run "mors login" to authenticate.');
        }
        return;
    }
    // If --offline, skip token liveness verification and report local session only
    if (skipLiveness) {
        reportAuthStatus(session, json);
        return;
    }
    // Verify token liveness (VAL-AUTH-006)
    // Using await ensures deterministic output and exit-code before process exit.
    try {
        const principal = await verifyTokenLiveness(session.accessToken, { configDir });
        // Token is valid — report authenticated status with live data
        if (json) {
            console.log(JSON.stringify({
                status: 'authenticated',
                token_valid: true,
                account_id: principal.accountId,
                device_id: principal.deviceId,
                created_at: session.createdAt,
            }));
        }
        else {
            console.log(`Authenticated (account: ${principal.accountId})`);
            console.log(`Device: ${principal.deviceId}`);
            console.log(`Session created: ${session.createdAt}`);
            console.log('Token: valid');
        }
    }
    catch (err) {
        process.exitCode = 1;
        // Check SigningKeyMismatchError first (subclass of TokenLivenessError)
        if (err instanceof SigningKeyMismatchError) {
            if (json) {
                console.log(JSON.stringify({
                    status: 'signing_key_mismatch',
                    token_valid: false,
                    message: err.message,
                    account_id: session.accountId,
                    device_id: session.deviceId,
                }));
            }
            else {
                console.error(`Error: ${err.message}`);
            }
        }
        else if (err instanceof TokenLivenessError) {
            if (json) {
                console.log(JSON.stringify({
                    status: 'token_expired',
                    token_valid: false,
                    message: err.message,
                    account_id: session.accountId,
                    device_id: session.deviceId,
                }));
            }
            else {
                console.error(`Error: ${err.message}`);
            }
        }
        else {
            const msg = err instanceof Error ? err.message : String(err);
            if (json) {
                console.log(JSON.stringify({
                    status: 'error',
                    error: 'unknown',
                    message: msg,
                }));
            }
            else {
                console.error(`Error: ${msg}`);
            }
        }
    }
}
/**
 * Report auth status from local session without liveness check.
 */
function reportAuthStatus(session, json) {
    if (json) {
        console.log(JSON.stringify({
            status: 'authenticated',
            account_id: session.accountId,
            device_id: session.deviceId,
            created_at: session.createdAt,
        }));
    }
    else {
        console.log(`Authenticated (account: ${session.accountId})`);
        console.log(`Device: ${session.deviceId}`);
        console.log(`Session created: ${session.createdAt}`);
    }
}
function runKeyExchange(args) {
    const { positional, flags } = parseArgs(args);
    const json = 'json' in flags;
    if (hasHelpFlag(args) || positional.length === 0) {
        printKeyExchangeHelp();
        return;
    }
    try {
        requireInit();
    }
    catch (err) {
        if (err instanceof NotInitializedError) {
            formatError(err.message, json, 'not_initialized');
            process.exitCode = 1;
            return;
        }
        throw err;
    }
    const configDir = getConfigDir();
    const subcommand = positional[0];
    const subArgs = args.slice(1);
    try {
        if (subcommand === 'offer') {
            runKeyExchangeOffer(configDir, json);
            return;
        }
        if (subcommand === 'accept') {
            runKeyExchangeAccept(configDir, subArgs, json);
            return;
        }
        if (subcommand === 'list') {
            runKeyExchangeList(configDir, json);
            return;
        }
        formatError(`Unknown key-exchange subcommand: ${subcommand}. Run "mors key-exchange --help" for usage.`, json, 'unknown_subcommand');
        process.exitCode = 1;
    }
    catch (err) {
        handleCommandError(err, json);
    }
}
function printKeyExchangeHelp() {
    console.log(`mors key-exchange - establish E2EE sessions with peer devices

Usage:
  mors key-exchange offer [--json]
  mors key-exchange accept --bundle <json|-> [--json]
  mors key-exchange accept --bundle-file <path> [--json]
  mors key-exchange list [--json]

Subcommands:
  offer                  Print your shareable E2EE device bundle
  accept                 Import a peer bundle and persist a shared session
  list                   Show established peer key-exchange sessions

Options:
  --bundle <json|->      Peer bundle JSON inline, or "-" to read from stdin
  --bundle-file <path>   Read peer bundle JSON from a file
  --json                 Output JSON

Typical flow:
  mors key-exchange offer --json > my-bundle.json
  mors key-exchange accept --bundle-file peer-bundle.json

Notes:
  Exchange bundles out-of-band with the other user or agent.
  When exactly one session exists, encrypted remote messaging auto-selects it.
  Use --peer-device <device-id> on send/read/reply when multiple sessions exist.`);
}
function runKeyExchangeOffer(configDir, json) {
    const localBundle = requireDeviceBootstrap(getDeviceKeysDir(configDir));
    const bundle = buildKeyExchangeBundle(localBundle);
    if (json) {
        console.log(JSON.stringify({ status: 'ok', bundle }));
        return;
    }
    console.log('Share this bundle with the peer device you want to trust:');
    console.log(JSON.stringify(bundle, null, 2));
    console.log('');
    console.log('Next step: have the peer run:');
    console.log('  mors key-exchange accept --bundle-file <your-bundle.json>');
}
function runKeyExchangeAccept(configDir, args, json) {
    const { flags } = parseArgs(args);
    const inlineBundle = typeof flags['bundle'] === 'string' ? flags['bundle'] : undefined;
    const bundleFile = typeof flags['bundle-file'] === 'string' ? flags['bundle-file'] : undefined;
    if (!inlineBundle && !bundleFile) {
        formatError('Missing required input. Provide --bundle <json|-> or --bundle-file <path>.', json, 'missing_bundle');
        process.exitCode = 1;
        return;
    }
    if (inlineBundle && bundleFile) {
        formatError('Provide exactly one bundle source: --bundle or --bundle-file.', json, 'ambiguous_bundle');
        process.exitCode = 1;
        return;
    }
    let rawInput;
    if (inlineBundle === '-') {
        rawInput = readFileSync(0, 'utf8');
    }
    else if (inlineBundle) {
        rawInput = inlineBundle;
    }
    else if (bundleFile) {
        rawInput = readFileSync(bundleFile, 'utf8');
    }
    else {
        formatError('Missing required input. Provide --bundle <json|-> or --bundle-file <path>.', json, 'missing_bundle');
        process.exitCode = 1;
        return;
    }
    const peerBundle = parseKeyExchangeBundle(rawInput);
    const keysDir = getDeviceKeysDir(configDir);
    const localBundle = requireDeviceBootstrap(keysDir);
    const session = performKeyExchange(keysDir, localBundle, Buffer.from(peerBundle.x25519_public_key, 'hex'), peerBundle.device_id, peerBundle.fingerprint);
    if (json) {
        console.log(JSON.stringify({
            status: 'ok',
            peer_device_id: session.peerDeviceId,
            peer_fingerprint: session.peerFingerprint,
            completed_at: session.completedAt,
        }));
        return;
    }
    console.log('Key exchange complete.');
    console.log(`Peer device: ${session.peerDeviceId}`);
    console.log(`Peer fingerprint: ${session.peerFingerprint}`);
    console.log(`Completed at: ${session.completedAt}`);
}
function runKeyExchangeList(configDir, json) {
    const sessions = listKeyExchangeSessions(getDeviceKeysDir(configDir));
    if (json) {
        console.log(JSON.stringify({
            status: 'ok',
            count: sessions.length,
            sessions: sessions.map((session) => ({
                peer_device_id: session.peerDeviceId,
                peer_fingerprint: session.peerFingerprint,
                completed_at: session.completedAt,
            })),
        }));
        return;
    }
    if (sessions.length === 0) {
        console.log('No key exchange sessions found.');
        return;
    }
    console.log(`Key exchange sessions (${sessions.length}):`);
    for (const session of sessions) {
        console.log(`- ${session.peerDeviceId} (${session.peerFingerprint})`);
        console.log(`  completed: ${session.completedAt}`);
    }
}
function buildKeyExchangeBundle(bundle) {
    return {
        kind: 'mors-key-exchange-bundle-v1',
        device_id: bundle.deviceId,
        fingerprint: bundle.fingerprint,
        x25519_public_key: bundle.x25519PublicKey.toString('hex'),
    };
}
function parseKeyExchangeBundle(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new MorsError('Invalid bundle JSON. Expected a JSON object from "mors key-exchange offer".');
    }
    const candidate = parsed &&
        typeof parsed === 'object' &&
        'bundle' in parsed &&
        parsed.bundle &&
        typeof parsed.bundle === 'object'
        ? parsed.bundle
        : parsed;
    if (!candidate || typeof candidate !== 'object') {
        throw new MorsError('Invalid key exchange bundle. Expected an object payload.');
    }
    const bundle = candidate;
    if (bundle.kind !== 'mors-key-exchange-bundle-v1') {
        throw new MorsError('Invalid key exchange bundle kind.');
    }
    if (!bundle.device_id || !bundle.fingerprint || !bundle.x25519_public_key) {
        throw new MorsError('Invalid key exchange bundle. Missing required fields.');
    }
    if (!/^[0-9a-fA-F]+$/.test(bundle.x25519_public_key) || bundle.x25519_public_key.length !== 64) {
        throw new MorsError('Invalid key exchange bundle. x25519_public_key must be 32-byte hex.');
    }
    return {
        kind: 'mors-key-exchange-bundle-v1',
        device_id: bundle.device_id,
        fingerprint: bundle.fingerprint,
        x25519_public_key: bundle.x25519_public_key.toLowerCase(),
    };
}
/**
 * Run the quickstart lifecycle check.
 *
 * Executes the deterministic local lifecycle: init → send → inbox → read → ack.
 * Reports per-step results and an overall summary with actionable remediation on failure.
 *
 * Flags:
 *   --json                     Output machine-readable JSON
 *   --help                     Show quickstart usage
 *   --simulate-init-failure    (testing) Force init step to fail
 */
function runQuickstart(_args) {
    const json = _args.includes('--json');
    const simulateInitFailure = _args.includes('--simulate-init-failure');
    if (_args.includes('--help') || _args.includes('-h')) {
        console.log(`mors quickstart — run local lifecycle check

Executes a deterministic local-only lifecycle sequence:
  init → send → inbox → read → ack

Reports per-step results and overall success/failure status.

Usage:
  mors quickstart [--json]

Options:
  --json    Output machine-readable JSON with per-step lifecycle results
  --help    Show this help`);
        return;
    }
    const steps = [];
    let messageId;
    let configDir;
    // ── Step 1: init ────────────────────────────────────────────────
    try {
        if (simulateInitFailure) {
            throw new SqlCipherUnavailableError('SQLCipher is not available. Install it with: brew install sqlcipher && npm rebuild');
        }
        // Use synchronous path: call initCommand and wait for result
        // initCommand is async, so we use a synchronous approach for quickstart
        const initResult = initCommandSync();
        configDir = initResult.configDir;
        steps.push({ name: 'init', status: 'pass' });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        steps.push({ name: 'init', status: 'fail', error: msg });
        // Fill remaining steps as skipped
        for (const name of ['send', 'inbox', 'read', 'ack']) {
            steps.push({ name, status: 'skipped' });
        }
        emitQuickstartResult(json, steps, true, undefined);
        return;
    }
    // ── Step 2: send ────────────────────────────────────────────────
    try {
        const db = openStore(configDir);
        try {
            const result = sendMessage(db, {
                recipient: 'quickstart-recipient',
                sender: 'local',
                body: 'quickstart verification message',
            });
            messageId = result.id;
            steps.push({ name: 'send', status: 'pass', messageId });
        }
        finally {
            db.close();
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        steps.push({ name: 'send', status: 'fail', error: msg });
        for (const name of ['inbox', 'read', 'ack']) {
            steps.push({ name, status: 'skipped' });
        }
        emitQuickstartResult(json, steps, true, configDir);
        return;
    }
    // ── Step 3: inbox ───────────────────────────────────────────────
    try {
        const db = openStore(configDir);
        try {
            const inbox = listInbox(db, {});
            const found = inbox.find((m) => m.id === messageId);
            if (!found) {
                throw new Error(`Message ${messageId} not found in inbox`);
            }
            steps.push({ name: 'inbox', status: 'pass', messageId });
        }
        finally {
            db.close();
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        steps.push({ name: 'inbox', status: 'fail', error: msg });
        for (const name of ['read', 'ack']) {
            steps.push({ name, status: 'skipped' });
        }
        emitQuickstartResult(json, steps, true, configDir);
        return;
    }
    // ── Step 4: read ────────────────────────────────────────────────
    try {
        const db = openStore(configDir);
        try {
            // messageId is guaranteed defined after successful send step
            const readResult = readMessage(db, messageId);
            if (!readResult) {
                throw new Error(`Message ${messageId} not found for read`);
            }
            if (!readResult.read_at) {
                throw new Error(`Message ${messageId} read_at not set after read`);
            }
            steps.push({ name: 'read', status: 'pass', messageId });
        }
        finally {
            db.close();
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        steps.push({ name: 'read', status: 'fail', error: msg });
        steps.push({ name: 'ack', status: 'skipped' });
        emitQuickstartResult(json, steps, true, configDir);
        return;
    }
    // ── Step 5: ack ─────────────────────────────────────────────────
    try {
        const db = openStore(configDir);
        try {
            // messageId is guaranteed defined after successful send step
            const ackResult = ackMessage(db, messageId);
            if (ackResult.state !== 'acked') {
                throw new Error(`Expected state=acked but got ${ackResult.state}`);
            }
            steps.push({ name: 'ack', status: 'pass', messageId });
        }
        finally {
            db.close();
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        steps.push({ name: 'ack', status: 'fail', error: msg });
        emitQuickstartResult(json, steps, true, configDir);
        return;
    }
    // ── All steps passed ───────────────────────────────────────────
    emitQuickstartResult(json, steps, false, configDir);
}
/**
 * Synchronous init for quickstart.
 *
 * Calls the async initCommand and blocks the event loop until it resolves.
 * This is acceptable for quickstart which is a one-shot diagnostic flow.
 */
function initCommandSync() {
    // We need to run initCommand synchronously. Since initCommand is async,
    // we use execFileSync to call ourselves with `init --json` and parse the result.
    const args = ['--json'];
    const cliPath = new URL('./index.js', import.meta.url).pathname;
    const env = {
        ...process.env,
    };
    const stdout = execFileSyncImport(process.execPath, [cliPath, 'init', ...args], {
        encoding: 'utf8',
        timeout: 15_000,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(stdout.trim());
    if (parsed.status === 'error') {
        throw new MorsError(parsed.message || 'init failed');
    }
    return {
        fingerprint: parsed.fingerprint,
        configDir: parsed.configDir,
        alreadyInitialized: parsed.status === 'already_initialized',
    };
}
/**
 * Emit quickstart results in JSON or human-readable format.
 */
function emitQuickstartResult(json, steps, failed, configDir) {
    const totalSteps = steps.length;
    const passedSteps = steps.filter((s) => s.status === 'pass').length;
    if (failed) {
        process.exitCode = 1;
    }
    // Build remediation guidance for failures
    const remediation = [];
    if (failed) {
        const failedStep = steps.find((s) => s.status === 'fail');
        if (failedStep) {
            switch (failedStep.name) {
                case 'init':
                    if (failedStep.error?.toLowerCase().includes('sqlcipher')) {
                        remediation.push('brew install sqlcipher && npm rebuild');
                    }
                    remediation.push('mors init --json');
                    break;
                case 'send':
                    remediation.push('mors init --json');
                    remediation.push('mors send --to test --body "hello" --json');
                    break;
                case 'inbox':
                    remediation.push('mors inbox --json');
                    break;
                case 'read':
                    remediation.push('mors inbox --json');
                    break;
                case 'ack':
                    remediation.push('mors inbox --json');
                    break;
            }
        }
    }
    if (json) {
        const result = {
            status: failed ? 'failure' : 'success',
            steps,
            totalSteps,
            passedSteps,
            configDir: configDir ?? null,
        };
        if (failed) {
            result['remediation'] = remediation;
        }
        console.log(JSON.stringify(result));
    }
    else {
        // Human-readable output
        console.log('mors quickstart — local lifecycle check\n');
        for (const step of steps) {
            const icon = step.status === 'pass' ? '✓' : step.status === 'fail' ? '✗' : '○';
            const label = `${icon} ${step.name}`;
            if (step.status === 'pass') {
                console.log(`  ${label}`);
            }
            else if (step.status === 'fail') {
                console.log(`  ${label}: ${step.error}`);
            }
            else {
                console.log(`  ${label} (skipped)`);
            }
        }
        console.log('');
        if (failed) {
            console.log(`Result: FAIL (${passedSteps}/${totalSteps} steps passed)`);
            if (remediation.length > 0) {
                console.log('\nNext steps:');
                for (const r of remediation) {
                    console.log(`  $ ${r}`);
                }
            }
        }
        else {
            console.log(`Result: SUCCESS (${totalSteps}/${totalSteps} steps passed)`);
        }
    }
}
/**
 * Run the doctor diagnostic checks.
 *
 * Checks prerequisite and configuration health, returning copy/paste
 * remediation commands tailored to detected failures.
 *
 * Checks performed:
 *   - node_version:  Node.js >= 20
 *   - sqlcipher:     SQLCipher encryption available
 *   - init:          Config directory initialized
 *   - device_keys:   E2EE device keys bootstrapped
 *   - auth_session:  Auth session present (warn if missing)
 *   - relay_config:  MORS_RELAY_BASE_URL set (warn if missing)
 *
 * Flags:
 *   --json                          Output machine-readable JSON
 *   --help                          Show doctor usage
 *   --simulate-sqlcipher-failure    (testing) Force sqlcipher check to fail
 */
function runDoctor(_args) {
    const json = _args.includes('--json');
    const simulateSqlCipherFailure = _args.includes('--simulate-sqlcipher-failure');
    if (_args.includes('--help') || _args.includes('-h')) {
        console.log(`mors doctor — check prerequisites and configuration health

Runs diagnostic checks and reports actionable remediation commands
for any detected failures.

Checks:
  node_version   Node.js >= 20
  sqlcipher       SQLCipher encryption support
  init            Config directory initialized
  device_keys     E2EE device keys bootstrapped
  auth_session    Auth session present (warn if missing)
  relay_config    Relay URL configured (warn if missing)

Usage:
  mors doctor [--json]

Options:
  --json    Output machine-readable JSON with per-check health results
  --help    Show this help`);
        return;
    }
    const configDir = getConfigDir();
    const checks = [];
    // ── Check 1: Node.js version ──────────────────────────────────────
    {
        const major = parseInt(process.versions.node.split('.')[0], 10);
        if (major >= 20) {
            checks.push({
                name: 'node_version',
                status: 'pass',
                message: `Node.js v${process.versions.node}`,
            });
        }
        else {
            checks.push({
                name: 'node_version',
                status: 'fail',
                message: `Node.js v${process.versions.node} (requires >= 20)`,
                remediation: ['Install Node.js >= 20: https://nodejs.org/', 'nvm install 20 && nvm use 20'],
            });
        }
    }
    // ── Check 2: SQLCipher availability ───────────────────────────────
    {
        try {
            verifySqlCipherAvailable(simulateSqlCipherFailure);
            checks.push({
                name: 'sqlcipher',
                status: 'pass',
                message: 'SQLCipher encryption available',
            });
        }
        catch {
            checks.push({
                name: 'sqlcipher',
                status: 'fail',
                message: 'SQLCipher is not available',
                remediation: ['brew install sqlcipher && npm rebuild'],
            });
        }
    }
    // ── Check 3: Init status ──────────────────────────────────────────
    {
        const sentinelPath = join(configDir, '.initialized');
        const initialized = existsSync(sentinelPath);
        if (initialized) {
            checks.push({
                name: 'init',
                status: 'pass',
                message: `Config directory initialized: ${configDir}`,
            });
        }
        else {
            checks.push({
                name: 'init',
                status: 'fail',
                message: `Config directory not initialized: ${configDir}`,
                remediation: ['mors init --json'],
            });
        }
    }
    // ── Check 4: Device keys ──────────────────────────────────────────
    {
        const keysDir = getDeviceKeysDir(configDir);
        const bootstrapped = isDeviceBootstrapped(keysDir);
        if (bootstrapped) {
            checks.push({
                name: 'device_keys',
                status: 'pass',
                message: 'E2EE device keys bootstrapped',
            });
        }
        else {
            checks.push({
                name: 'device_keys',
                status: 'fail',
                message: 'E2EE device keys not found',
                remediation: ['mors init --json'],
            });
        }
    }
    // ── Check 5: Auth session ─────────────────────────────────────────
    {
        const session = loadSession(configDir);
        if (session) {
            checks.push({
                name: 'auth_session',
                status: 'pass',
                message: `Authenticated as ${session.accountId}`,
            });
        }
        else {
            checks.push({
                name: 'auth_session',
                status: 'warn',
                message: 'No auth session (remote features unavailable)',
                remediation: ['mors login --invite-token <your-invite-token> --json'],
            });
        }
    }
    // ── Check 6: Relay configuration ──────────────────────────────────
    {
        const relayUrl = resolveRelayBaseUrl(configDir);
        if (relayUrl) {
            checks.push({
                name: 'relay_config',
                status: 'pass',
                message: `Relay URL: ${relayUrl}`,
            });
        }
        else {
            checks.push({
                name: 'relay_config',
                status: 'warn',
                message: 'Relay URL not configured (remote features unavailable)',
                remediation: ['mors start', 'export MORS_RELAY_BASE_URL=https://relay.example.com'],
            });
        }
    }
    // ── Determine overall status ──────────────────────────────────────
    const hasFail = checks.some((c) => c.status === 'fail');
    const overallStatus = hasFail ? 'unhealthy' : 'healthy';
    if (hasFail) {
        process.exitCode = 1;
    }
    // ── Emit results ──────────────────────────────────────────────────
    if (json) {
        const result = {
            status: overallStatus,
            checks,
            configDir,
        };
        console.log(JSON.stringify(result));
    }
    else {
        console.log('mors doctor — prerequisite and configuration health\n');
        for (const check of checks) {
            const icon = check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : '⚠';
            const label = `${icon} ${check.name}`;
            if (check.message) {
                console.log(`  ${label}: ${check.message}`);
            }
            else {
                console.log(`  ${label}`);
            }
            if (check.remediation && check.remediation.length > 0) {
                for (const r of check.remediation) {
                    console.log(`    → ${r}`);
                }
            }
        }
        console.log('');
        if (hasFail) {
            console.log(`Result: UNHEALTHY (${checks.filter((c) => c.status === 'fail').length} failing check(s))`);
        }
        else {
            const warns = checks.filter((c) => c.status === 'warn').length;
            if (warns > 0) {
                console.log(`Result: HEALTHY (${warns} warning(s))`);
            }
            else {
                console.log('Result: HEALTHY');
            }
        }
    }
}
// ── Init command ─────────────────────────────────────────────────────
function runInit(_args) {
    // Parse --json flag for machine-readable output.
    const json = _args.includes('--json');
    // Parse testing hooks (hidden flags, not shown in help).
    const simulateSqlCipherUnavailable = _args.includes('--simulate-sqlcipher-unavailable');
    const simulateFailureAfterIdentity = _args.includes('--simulate-failure-after-identity');
    // Use a promise to handle the async initCommand.
    initCommand({
        simulateSqlCipherUnavailable,
        simulateFailureAfterIdentity,
    })
        .then((result) => {
        if (json) {
            console.log(JSON.stringify({
                status: result.alreadyInitialized ? 'already_initialized' : 'initialized',
                fingerprint: result.fingerprint,
                configDir: result.configDir,
            }));
        }
        else if (result.alreadyInitialized) {
            console.log('mors is already initialized.');
            console.log(`Identity fingerprint: ${result.fingerprint}`);
            console.log(`Config directory: ${result.configDir}`);
        }
        else {
            console.log('mors initialized successfully.');
            console.log(`Identity fingerprint: ${result.fingerprint}`);
            console.log(`Config directory: ${result.configDir}`);
        }
    })
        .catch((err) => {
        process.exitCode = 1;
        if (err instanceof SqlCipherUnavailableError) {
            if (json) {
                console.log(JSON.stringify({
                    status: 'error',
                    error: 'sqlcipher_unavailable',
                    message: err.message,
                }));
            }
            else {
                console.error(`Error: ${err.message}`);
            }
        }
        else if (err instanceof MorsError) {
            if (json) {
                console.log(JSON.stringify({
                    status: 'error',
                    error: err.name,
                    message: err.message,
                }));
            }
            else {
                console.error(`Error: ${err.message}`);
            }
        }
        else {
            const msg = err instanceof Error ? err.message : String(err);
            if (json) {
                console.log(JSON.stringify({
                    status: 'error',
                    error: 'unknown',
                    message: msg,
                }));
            }
            else {
                console.error(`Error: ${msg}`);
            }
        }
    });
}
// ── Error handling helpers ───────────────────────────────────────────
function handleCommandError(err, json) {
    if (err instanceof ContractValidationError || err instanceof MorsError) {
        formatError(err.message, json, err.name);
    }
    else {
        const msg = err instanceof Error ? err.message : String(err);
        formatError(msg, json, 'unknown');
    }
}
/**
 * Handle errors from remote (relay) operations with deterministic output.
 *
 * Maps specific relay error types to actionable CLI output:
 * - RemoteUnavailableError → remote_unavailable with config guidance
 * - NotAuthenticatedError → not_authenticated with login guidance
 * - RelayClientError (4xx) → relay_error with status code
 * - Other errors → unknown error
 */
function handleRemoteError(err, json) {
    if (err instanceof RemoteUnavailableError) {
        formatError(err.message, json, 'remote_unavailable');
    }
    else if (err instanceof NotAuthenticatedError) {
        formatError(err.message, json, 'not_authenticated');
    }
    else if (err instanceof RelayClientError) {
        formatError(err.message, json, 'relay_error');
    }
    else if (err instanceof MorsError) {
        formatError(err.message, json, err.name);
    }
    else {
        const msg = err instanceof Error ? err.message : String(err);
        formatError(msg, json, 'unknown');
    }
}
/**
 * Handle errors from secure setup prerequisites with actionable guidance.
 *
 * Maps specific E2EE error types to actionable CLI output:
 * - DeviceNotBootstrappedError → device_not_bootstrapped with init guidance
 * - KeyExchangeNotCompleteError → key_exchange_required with exchange guidance
 * - CipherError → cipher_error with rekey guidance
 * - Other MorsError → error type name
 */
function handleSecureSetupError(err, json) {
    if (err instanceof DeviceNotBootstrappedError) {
        formatError(err.message, json, 'device_not_bootstrapped');
    }
    else if (err instanceof KeyExchangeNotCompleteError) {
        formatError(err.message, json, 'key_exchange_required');
    }
    else if (err instanceof CipherError) {
        formatError(err.message, json, 'cipher_error');
    }
    else if (err instanceof MorsError) {
        formatError(err.message, json, err.name);
    }
    else {
        const msg = err instanceof Error ? err.message : String(err);
        formatError(msg, json, 'unknown');
    }
}
function formatError(message, json, errorType) {
    if (json) {
        console.log(JSON.stringify({
            status: 'error',
            error: errorType ?? 'error',
            message,
        }));
    }
    else {
        console.error(`Error: ${message}`);
    }
}
// ── Deploy command ───────────────────────────────────────────────────
/**
 * Run the deploy command.
 *
 * Validates Fly.io deploy prerequisites and optionally triggers deployment.
 * All output is redacted for secrets before display.
 *
 * Flags:
 *   --json      Output structured JSON
 *   --dry-run   Validate prerequisites only (do not deploy)
 *   --help      Show deploy usage
 */
function runDeploy(args) {
    const { flags } = parseArgs(args);
    const isJson = 'json' in flags;
    const isDryRun = 'dry-run' in flags;
    const isHelp = 'help' in flags || 'h' in flags;
    if (isHelp) {
        console.log(`mors deploy — Deploy the mors relay to Fly.io

Usage:
  mors deploy [--json] [--dry-run]

Options:
  --json       Output structured JSON
  --dry-run    Validate deploy prerequisites without deploying
  --help       Show this help

Required environment variables:
  FLY_APP_NAME          Fly.io application name
  FLY_ORG               Fly.io organization slug
  FLY_PRIMARY_REGION    Primary region (default: iad)

Authentication (one of):
  FLY_ACCESS_TOKEN      Fly.io deploy token
  flyctl auth login     Interactive authentication

Prerequisites:
  flyctl                Fly CLI tool (brew install flyctl or https://fly.io/install.sh)`);
        return;
    }
    // Run pre-flight checks
    const result = runDeployPreflight();
    if (!result.ready) {
        process.exitCode = 1;
        if (isJson) {
            console.log(formatDeployResultJson(result));
        }
        else {
            console.error(redactSecrets(formatDeployIssues(result.issues)));
        }
        return;
    }
    // Pre-flight passed — extract validated config
    const deployConfig = result.config;
    if (!deployConfig) {
        // Should not happen after ready=true, but fail-closed
        process.exitCode = 1;
        console.error('Internal error: deploy config missing after pre-flight.');
        return;
    }
    if (isDryRun) {
        if (isJson) {
            console.log(formatDeployResultJson(result));
        }
        else {
            console.log('Deploy pre-flight checks passed.');
            console.log(`  App:    ${deployConfig.appName}`);
            console.log(`  Region: ${deployConfig.primaryRegion}`);
            console.log(`  Org:    ${deployConfig.org}`);
            console.log('\nDry run complete. Run without --dry-run to deploy.');
        }
        return;
    }
    // Actual deploy — execute flyctl deploy
    if (isJson) {
        console.log(JSON.stringify({
            status: 'deploying',
            config: {
                appName: deployConfig.appName,
                primaryRegion: deployConfig.primaryRegion,
                org: deployConfig.org,
            },
        }));
    }
    else {
        console.log(`Deploying to Fly.io (app: ${deployConfig.appName}, region: ${deployConfig.primaryRegion})...`);
    }
    try {
        const deployOutput = execFileSyncImport(deployConfig.flyctlPath, ['deploy', '--app', deployConfig.appName, '--primary-region', deployConfig.primaryRegion], {
            cwd: process.cwd(),
            encoding: 'utf8',
            timeout: 300_000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        // Redact any secrets from deploy output before display
        const safeOutput = redactSecrets(deployOutput);
        if (isJson) {
            console.log(JSON.stringify({ status: 'deployed', output: safeOutput }));
        }
        else {
            console.log(safeOutput);
            console.log('Deploy complete.');
        }
    }
    catch (err) {
        process.exitCode = 1;
        const e = err;
        const rawOutput = (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '');
        const safeOutput = redactSecrets(rawOutput);
        if (isJson) {
            console.log(JSON.stringify({
                status: 'error',
                error: 'deploy_failed',
                message: safeOutput,
            }));
        }
        else {
            console.error(`Deploy failed:\n${safeOutput}`);
        }
    }
}
// ── Usage ────────────────────────────────────────────────────────────
function printUsage() {
    console.log(`mors — agent-first encrypted CLI messaging

Usage:
  mors <command> [options]

Commands:
  quickstart   Run local lifecycle check (init → send → inbox → read → ack)
  doctor       Check prerequisites and configuration health
  init         Initialize identity and encrypted store
  key-exchange Share, accept, and inspect E2EE peer sessions
  login        Authenticate with mors-native auth
  logout       Clear local auth session
  status       Show current auth status
  start        Launch the hosted mors app experience
  onboard      First-run setup: register handle + profile
  send         Send a message
  inbox        List messages
  read         Read a message
  reply        Reply to a message
  ack          Acknowledge a message
  thread       View thread messages in causal order
  watch        Watch for new messages
  deploy       Deploy relay to Fly.io
  setup-shell  Configure shell PATH for mors

Options:
  -h, --help     Show this help
  -v, --version  Show version

Remote mode:
  --remote               Route command through relay (requires auth + relay config)
  --peer-device <id>     Peer device ID for E2EE key exchange session lookup
  --no-encrypt           Bypass E2EE encryption (send/read plaintext via relay)

Send options:
  --to <recipient>       Recipient identity (required; account ID for --remote)
  --body <message>       Message body (required)
  --from <sender>        Sender identity (default: "local")
  --subject <subject>    Message subject
  --dedupe-key <key>     Dedupe key for idempotent sends (must start with "dup_")
  --trace-id <id>        Trace ID for observability (must start with "trc_")
  --remote               Send through relay server (encrypted by default)
  --json                 Output JSON

Inbox options:
  --to <recipient>       Filter by recipient
  --unread               Show only unread messages
  --remote               Fetch inbox from relay server
  --json                 Output JSON

Read/Ack:
  mors read <message-id> [--json] [--remote] [--peer-device <id>] [--no-encrypt]
  mors ack <message-id> [--json] [--remote]

Reply:
  mors reply <parent-message-id> --body <message> [options]
  --to <recipient>       Recipient identity (default: "local"; account ID for --remote)
  --from <sender>        Sender identity (default: "local")
  --subject <subject>    Reply subject
  --dedupe-key <key>     Dedupe key for idempotent replies (must start with "dup_")
  --trace-id <id>        Trace ID for observability (must start with "trc_")
  --remote               Reply through relay server (encrypted by default)
  --json                 Output JSON

Thread:
  mors thread <thread-id> [--json]

Watch:
  mors watch [--json] [--poll-interval <ms>]
  mors watch --remote [--json]
  --json                 Output JSON (one event per line)
  --remote               Watch via relay SSE stream (requires auth + MORS_RELAY_BASE_URL)
  --poll-interval <ms>   Polling interval in ms (default: 500, min: 10; local only)

Login:
  mors login --invite-token <token> [--json]
  mors login [--json]    (uses MORS_INVITE_TOKEN env var when set)
  --invite-token <token> Invite token (required unless MORS_INVITE_TOKEN is set)
  MORS_INVITE_TOKEN      Environment fallback for invite token
  --json                 Output JSON

Logout:
  mors logout [--json]
  --json                 Output JSON

Status:
  mors status [--json] [--offline]
  --json                 Output JSON
  --offline              Skip token liveness check (report local session only)

Start:
  mors start
  Interactive relay-backed app for signup, contacts, inbox, and messaging

Onboard:
  mors onboard --handle <handle> --display-name <name> [--json]
  --handle <handle>      Globally unique handle (3-32 chars, letters/numbers/hyphens/underscores)
  --display-name <name>  Your display name
  --json                 Output JSON

Quickstart:
  mors quickstart [--json]
  --json                 Output machine-readable JSON with per-step lifecycle results

Doctor:
  mors doctor [--json]
  --json                 Output machine-readable JSON with per-check health results

Key Exchange:
  mors key-exchange offer [--json]
  mors key-exchange accept --bundle <json|-> [--json]
  mors key-exchange accept --bundle-file <path> [--json]
  mors key-exchange list [--json]
  offer                  Print your shareable E2EE device bundle
  accept                 Import a peer bundle and persist a shared session
  list                   Show established peer key-exchange sessions

Deploy:
  mors deploy [--json] [--dry-run]
  --json                 Output JSON
  --dry-run              Validate deploy prerequisites without deploying

Setup Shell:
  mors setup-shell [--json] [--confirm] [--decline]
  --json                 Output JSON
  --confirm              Auto-confirm without prompting
  --decline              Auto-decline without prompting`);
}
//# sourceMappingURL=cli.js.map