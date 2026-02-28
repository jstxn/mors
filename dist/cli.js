/**
 * CLI dispatcher for the mors command.
 *
 * Routes commands, handles init gating (VAL-INIT-005),
 * and formats output with secret redaction (VAL-INIT-004).
 */
import { initCommand, requireInit, getDbPath, getDbKeyPath } from './init.js';
import { loadKey } from './key-management.js';
import { openEncryptedDb } from './store.js';
import { sendMessage, listInbox, readMessage, ackMessage, replyMessage, listThread, } from './message.js';
import { startWatch } from './watch.js';
import { runSetupShell } from './setup-shell.js';
import { MorsError, NotInitializedError, SqlCipherUnavailableError } from './errors.js';
import { ContractValidationError } from './contract/errors.js';
import { saveSession, loadSession, clearSession } from './auth/session.js';
import { requestDeviceCode, pollForToken, fetchGitHubUser, validateAuthConfig, authConfigFromEnv, DeviceFlowError, TokenExpiredError, } from './auth/device-flow.js';
import { getConfigDir } from './identity.js';
import { randomUUID } from 'node:crypto';
/** Commands that require initialization before use. */
const GATED_COMMANDS = new Set(['send', 'inbox', 'read', 'reply', 'ack', 'thread', 'watch']);
/** Commands that are implemented. */
const IMPLEMENTED_COMMANDS = new Set(['send', 'inbox', 'read', 'ack', 'reply', 'thread', 'watch']);
export function run(args) {
    const command = args[0];
    if (!command || command === '--help' || command === '-h') {
        printUsage();
        return;
    }
    if (command === '--version' || command === '-v') {
        console.log('mors 0.1.0');
        return;
    }
    if (command === 'init') {
        runInit(args.slice(1));
        return;
    }
    if (command === 'setup-shell') {
        runSetupShellCommand(args.slice(1));
        return;
    }
    if (command === 'login') {
        runLogin(args.slice(1));
        return;
    }
    if (command === 'logout') {
        runLogout(args.slice(1));
        return;
    }
    if (command === 'status') {
        runStatus(args.slice(1));
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
        // Dispatch to implemented commands.
        if (IMPLEMENTED_COMMANDS.has(command)) {
            runCommand(command, args.slice(1), configDir);
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
/**
 * Open the encrypted database for an initialized config directory.
 */
function openStore(configDir) {
    const dbPath = getDbPath(configDir);
    const key = loadKey(getDbKeyPath(configDir));
    return openEncryptedDb({ dbPath, key });
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
// ── Inbox command ────────────────────────────────────────────────────
function runInbox(args, configDir) {
    const { flags } = parseArgs(args);
    const json = 'json' in flags;
    const recipient = typeof flags['to'] === 'string' ? flags['to'] : undefined;
    const unreadOnly = 'unread' in flags;
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
// ── Read command ─────────────────────────────────────────────────────
function runRead(args, configDir) {
    const { positional, flags } = parseArgs(args);
    const json = 'json' in flags;
    const messageId = positional[0];
    if (!messageId) {
        formatError('read requires a message ID argument', json);
        process.exitCode = 1;
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
// ── Ack command ──────────────────────────────────────────────────────
function runAck(args, configDir) {
    const { positional, flags } = parseArgs(args);
    const json = 'json' in flags;
    const messageId = positional[0];
    if (!messageId) {
        formatError('ack requires a message ID argument', json);
        process.exitCode = 1;
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
// ── Reply command ────────────────────────────────────────────────────
function runReply(args, configDir) {
    const { positional, flags } = parseArgs(args);
    const json = 'json' in flags;
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
// ── Login command (VAL-AUTH-001, VAL-AUTH-002, VAL-AUTH-007) ─────────
function runLogin(_args) {
    const { flags } = parseArgs(_args);
    const json = 'json' in flags;
    const configDir = getConfigDir();
    // Check for existing session
    const existing = loadSession(configDir);
    if (existing) {
        if (json) {
            console.log(JSON.stringify({
                status: 'already_authenticated',
                github_user_id: existing.githubUserId,
                github_login: existing.githubLogin,
                device_id: existing.deviceId,
            }));
        }
        else {
            console.log(`Already logged in as ${existing.githubLogin} (ID: ${existing.githubUserId})`);
            console.log('Run "mors logout" first to switch accounts.');
        }
        return;
    }
    // Validate OAuth config (VAL-AUTH-007)
    const authConfig = authConfigFromEnv();
    const validation = validateAuthConfig(authConfig);
    if (!validation.valid) {
        process.exitCode = 1;
        if (json) {
            console.log(JSON.stringify({
                status: 'error',
                error: 'missing_oauth_config',
                missing: validation.missing,
                message: 'Required OAuth configuration is missing. Set the following environment variables: ' +
                    validation.missing.join(', '),
            }));
        }
        else {
            console.error('Error: Required OAuth configuration is missing.');
            console.error('Set the following environment variables:');
            for (const m of validation.missing) {
                console.error(`  - ${m}`);
            }
        }
        return;
    }
    // Start device flow
    runDeviceFlow(authConfig, configDir, json);
}
function runDeviceFlow(authConfig, configDir, json) {
    requestDeviceCode(authConfig)
        .then((deviceCode) => {
        // Display verification info to user (VAL-AUTH-001)
        if (json) {
            console.log(JSON.stringify({
                status: 'awaiting_authorization',
                verification_uri: deviceCode.verification_uri,
                user_code: deviceCode.user_code,
                expires_in: deviceCode.expires_in,
            }));
        }
        else {
            console.log('\n🔐 GitHub Device Authorization');
            console.log('─'.repeat(40));
            console.log(`Open: ${deviceCode.verification_uri}`);
            console.log(`Code: ${deviceCode.user_code}`);
            console.log(`\nWaiting for authorization (expires in ${Math.floor(deviceCode.expires_in / 60)}m)...`);
        }
        // Poll for token (VAL-AUTH-001)
        return pollForToken(authConfig, deviceCode.device_code, {
            intervalMs: deviceCode.interval * 1000,
            expiresInMs: deviceCode.expires_in * 1000,
            onPoll: (state) => {
                if (!json && state === 'pending') {
                    process.stdout.write('.');
                }
            },
        });
    })
        .then(async (tokenResponse) => {
        if (!json) {
            console.log('\n✓ Authorization received. Fetching account info...');
        }
        // Fetch GitHub user for stable identity binding (VAL-AUTH-008)
        const user = await fetchGitHubUser(tokenResponse.access_token);
        // Generate device ID for this installation (VAL-AUTH-009)
        const deviceId = `device-${randomUUID()}`;
        // Persist session (VAL-AUTH-002)
        saveSession(configDir, {
            accessToken: tokenResponse.access_token,
            tokenType: tokenResponse.token_type,
            scope: tokenResponse.scope,
            githubUserId: user.id,
            githubLogin: user.login,
            deviceId,
            createdAt: new Date().toISOString(),
        });
        if (json) {
            console.log(JSON.stringify({
                status: 'authenticated',
                github_user_id: user.id,
                github_login: user.login,
                device_id: deviceId,
            }));
        }
        else {
            console.log(`\n✅ Logged in as ${user.login} (ID: ${user.id})`);
            console.log(`Device: ${deviceId}`);
        }
    })
        .catch((err) => {
        process.exitCode = 1;
        if (err instanceof DeviceFlowError || err instanceof TokenExpiredError) {
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
            console.log(`Logged out (was: ${existing.githubLogin}).`);
        }
        else {
            console.log('No active session. Already logged out.');
        }
    }
}
// ── Status command (VAL-AUTH-002, VAL-AUTH-006) ──────────────────────
function runStatus(_args) {
    const { flags } = parseArgs(_args);
    const json = 'json' in flags;
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
    if (json) {
        console.log(JSON.stringify({
            status: 'authenticated',
            github_user_id: session.githubUserId,
            github_login: session.githubLogin,
            device_id: session.deviceId,
            created_at: session.createdAt,
        }));
    }
    else {
        console.log(`Authenticated as ${session.githubLogin} (ID: ${session.githubUserId})`);
        console.log(`Device: ${session.deviceId}`);
        console.log(`Session created: ${session.createdAt}`);
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
// ── Usage ────────────────────────────────────────────────────────────
function printUsage() {
    console.log(`mors — markdown-first encrypted local CLI messaging

Usage:
  mors <command> [options]

Commands:
  init         Initialize identity and encrypted store
  login        Authenticate with GitHub (OAuth device flow)
  logout       Clear local auth session
  status       Show current auth status
  send         Send a message
  inbox        List messages
  read         Read a message
  reply        Reply to a message
  ack          Acknowledge a message
  thread       View thread messages in causal order
  watch        Watch for new messages
  setup-shell  Configure shell PATH for mors

Options:
  -h, --help     Show this help
  -v, --version  Show version

Send options:
  --to <recipient>       Recipient identity (required)
  --body <message>       Message body (required)
  --from <sender>        Sender identity (default: "local")
  --subject <subject>    Message subject
  --dedupe-key <key>     Dedupe key for idempotent sends (must start with "dup_")
  --trace-id <id>        Trace ID for observability (must start with "trc_")
  --json                 Output JSON

Inbox options:
  --to <recipient>       Filter by recipient
  --unread               Show only unread messages
  --json                 Output JSON

Read/Ack:
  mors read <message-id> [--json]
  mors ack <message-id> [--json]

Reply:
  mors reply <parent-message-id> --body <message> [options]
  --to <recipient>       Recipient identity (default: "local")
  --from <sender>        Sender identity (default: "local")
  --subject <subject>    Reply subject
  --dedupe-key <key>     Dedupe key for idempotent replies (must start with "dup_")
  --trace-id <id>        Trace ID for observability (must start with "trc_")
  --json                 Output JSON

Thread:
  mors thread <thread-id> [--json]

Watch:
  mors watch [--json] [--poll-interval <ms>]
  --json                 Output JSON (one event per line)
  --poll-interval <ms>   Polling interval in ms (default: 500, min: 10)

Login:
  mors login [--json]
  --json                 Output JSON

Logout:
  mors logout [--json]
  --json                 Output JSON

Status:
  mors status [--json]
  --json                 Output JSON

Setup Shell:
  mors setup-shell [--json] [--confirm] [--decline]
  --json                 Output JSON
  --confirm              Auto-confirm without prompting
  --decline              Auto-decline without prompting`);
}
//# sourceMappingURL=cli.js.map