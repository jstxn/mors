import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { initCommand, getDbKeyPath, getDbPath } from './init.js';
import { getConfigDir } from './identity.js';
import { loadKey } from './key-management.js';
import { openEncryptedDb, verifySqlCipherAvailable } from './store.js';
import { DEFAULT_HOSTED_RELAY_BASE_URL, saveClientSettings, } from './settings.js';
import { getDeviceKeysDir, isDeviceBootstrapped } from './e2ee/device-keys.js';
import { requireDeviceBootstrap } from './e2ee/bootstrap-guard.js';
import { clearSession, isAuthEnabled, loadProfile, loadSession, loadSigningKey, markAuthEnabled, saveProfile, saveSession, saveSigningKey, } from './auth/session.js';
import { generateSessionToken, generateSigningKey, validateInviteToken } from './auth/native.js';
import { normalizeHandle, validateHandle } from './relay/account-store.js';
import { hostedSignup } from './hosted.js';
import { RelayClient } from './relay/client.js';
const VALUE_FLAGS = new Set(['config-dir', 'relay-url', 'handle', 'display-name', 'invite-token']);
const BOOLEAN_FLAGS = new Set(['json', 'skip-relay-check', 'help']);
const RELAY_ONLY_FLAGS = new Set([
    'relay-url',
    'handle',
    'display-name',
    'invite-token',
    'skip-relay-check',
]);
class SetupUsageError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'SetupUsageError';
        this.code = code;
    }
}
export async function runSetupCommand(args) {
    const { positional, flags } = parseSetupArgs(args);
    const json = 'json' in flags;
    if (positional.length === 0 || hasHelpFlag(args)) {
        printSetupUsage();
        return;
    }
    try {
        const mode = positional[0];
        validateSetupFlags(flags, mode);
        if (mode === 'local') {
            const result = await setupLocal(flags);
            writeSetupResult(result, json);
            setBlockedExitCode(result);
            return;
        }
        if (mode === 'relay') {
            const result = await setupRelay(flags);
            writeSetupResult(result, json);
            setBlockedExitCode(result);
            return;
        }
        throw new SetupUsageError('unknown_setup_mode', `Unknown setup mode "${mode}". Use "mors setup local" or "mors setup relay".`);
    }
    catch (err) {
        process.exitCode = 1;
        writeSetupError(err, json);
    }
}
async function setupLocal(flags) {
    const configDir = resolveConfigDir(flags);
    const checks = [];
    const init = await ensureInitialized(configDir);
    checks.push(checkSqlCipher());
    checks.push(checkEncryptedStore(configDir));
    checks.push(checkDeviceKeys(configDir));
    if (hasFailedChecks(checks)) {
        return {
            status: 'blocked',
            mode: 'local',
            config_dir: configDir,
            initialized: init.initialized,
            already_initialized: init.alreadyInitialized,
            authenticated: Boolean(loadSession(configDir)),
            onboarded: Boolean(loadProfile(configDir)),
            checks,
            next_commands: ['mors doctor --json'],
        };
    }
    const authEnabled = isAuthEnabled(configDir);
    const session = loadSession(configDir);
    if (authEnabled && !session) {
        checks.push({
            name: 'local_auth_gate',
            status: 'fail',
            message: 'This config has auth enabled but no active session. Use a fresh MORS_CONFIG_DIR for local-only agents or run mors login.',
        });
        return {
            status: 'blocked',
            mode: 'local',
            config_dir: configDir,
            initialized: init.initialized,
            already_initialized: init.alreadyInitialized,
            authenticated: false,
            onboarded: Boolean(loadProfile(configDir)),
            checks,
            next_commands: [
                `MORS_CONFIG_DIR=${shellValue(configDir)} mors init --json`,
                'mors login --invite-token <token> --json',
            ],
        };
    }
    return {
        status: 'ready',
        mode: 'local',
        config_dir: configDir,
        initialized: init.initialized,
        already_initialized: init.alreadyInitialized,
        authenticated: Boolean(session),
        onboarded: Boolean(loadProfile(configDir)),
        checks,
        next_commands: [
            'mors send --to peer-agent --body "hello" --json',
            'mors inbox --json',
            'mors read <message-id> --json',
            'mors ack <message-id> --json',
            'mors quickstart --json',
        ],
    };
}
async function setupRelay(flags) {
    const configDir = resolveConfigDir(flags);
    const checks = [];
    const init = await ensureInitialized(configDir);
    const relay = resolveSetupRelay(flags);
    const handle = optionalHandle(flags);
    const displayName = optionalStringFlag(flags, 'display-name');
    const inviteToken = optionalStringFlag(flags, 'invite-token') ?? process.env['MORS_INVITE_TOKEN'];
    saveClientSettings(configDir, relay.settings);
    checks.push(checkSqlCipher());
    checks.push(checkEncryptedStore(configDir));
    checks.push(checkDeviceKeys(configDir));
    checks.push('skip-relay-check' in flags
        ? {
            name: 'relay_reachable',
            status: 'skipped',
            message: 'Relay reachability check skipped by --skip-relay-check.',
        }
        : await checkRelayReachable(relay.url));
    if (hasFailedChecks(checks)) {
        return {
            status: 'blocked',
            mode: 'relay',
            config_dir: configDir,
            initialized: init.initialized,
            already_initialized: init.alreadyInitialized,
            relay_url: relay.url,
            authenticated: Boolean(loadSession(configDir)),
            onboarded: Boolean(loadProfile(configDir)),
            device_bundle_published: false,
            checks,
            next_commands: relayNextCommands('blocked'),
        };
    }
    if (handle && !displayName) {
        throw new SetupUsageError('missing_display_name', 'Relay setup with --handle also requires --display-name <name>.');
    }
    let session = loadSession(configDir);
    let profile = loadProfile(configDir);
    if (!session && inviteToken) {
        session = createNativeSession(configDir, inviteToken);
        checks.push({
            name: 'relay_auth',
            status: 'pass',
            message: 'Native invite-token session saved.',
        });
    }
    if (!session && handle && displayName) {
        const signup = await hostedSignup(relay.url, {
            handle,
            displayName,
            deviceId: requireDeviceBootstrap(getDeviceKeysDir(configDir)).deviceId,
        });
        markAuthEnabled(configDir);
        saveSession(configDir, {
            accessToken: signup.accessToken,
            tokenType: 'bearer',
            accountId: signup.accountId,
            deviceId: signup.deviceId,
            createdAt: new Date().toISOString(),
        });
        saveProfile(configDir, {
            handle: signup.handle,
            displayName: signup.displayName,
            accountId: signup.accountId,
            createdAt: new Date().toISOString(),
        });
        session = loadSession(configDir);
        profile = loadProfile(configDir);
        checks.push({
            name: 'hosted_signup',
            status: 'pass',
            message: `Signed in as @${signup.handle}.`,
        });
    }
    if (session && !profile && handle && displayName) {
        saveProfile(configDir, {
            handle,
            displayName,
            accountId: session.accountId,
            createdAt: new Date().toISOString(),
        });
        profile = loadProfile(configDir);
        checks.push({
            name: 'relay_profile',
            status: 'pass',
            message: `Saved local profile @${handle}.`,
        });
    }
    const publishCheck = session && profile ? await publishDeviceBundle(configDir, relay.url, session.accessToken) : null;
    if (publishCheck) {
        checks.push(publishCheck);
    }
    const status = publishCheck?.status === 'warn'
        ? 'blocked'
        : session && profile
            ? 'ready'
            : session
                ? 'needs_profile'
                : 'needs_identity';
    return {
        status,
        mode: 'relay',
        config_dir: configDir,
        initialized: init.initialized,
        already_initialized: init.alreadyInitialized,
        relay_url: relay.url,
        authenticated: Boolean(session),
        onboarded: Boolean(profile),
        device_bundle_published: publishCheck?.status === 'pass',
        checks,
        next_commands: relayNextCommands(status),
    };
}
async function ensureInitialized(configDir) {
    const result = await initCommand({ configDir });
    return {
        initialized: true,
        alreadyInitialized: result.alreadyInitialized,
    };
}
function checkSqlCipher() {
    try {
        verifySqlCipherAvailable();
        return {
            name: 'sqlcipher',
            status: 'pass',
            message: 'SQLCipher is available.',
        };
    }
    catch (err) {
        return {
            name: 'sqlcipher',
            status: 'fail',
            message: err instanceof Error ? err.message : String(err),
        };
    }
}
function checkEncryptedStore(configDir) {
    let db = null;
    try {
        db = openEncryptedDb({
            dbPath: getDbPath(configDir),
            key: loadKey(getDbKeyPath(configDir)),
        });
        db.prepare('SELECT 1').get();
        return {
            name: 'encrypted_store',
            status: 'pass',
            message: 'Encrypted local store opens successfully.',
        };
    }
    catch (err) {
        return {
            name: 'encrypted_store',
            status: 'fail',
            message: err instanceof Error ? err.message : String(err),
        };
    }
    finally {
        if (db)
            db.close();
    }
}
function checkDeviceKeys(configDir) {
    return isDeviceBootstrapped(getDeviceKeysDir(configDir))
        ? {
            name: 'device_keys',
            status: 'pass',
            message: 'Device keys are bootstrapped.',
        }
        : {
            name: 'device_keys',
            status: 'fail',
            message: 'Device keys are missing. Run mors init.',
        };
}
function createNativeSession(configDir, inviteToken) {
    const inviteResult = validateInviteToken(inviteToken);
    if (!inviteResult.valid) {
        throw new SetupUsageError('invalid_invite_token', inviteResult.reason ?? 'Invite token is invalid.');
    }
    const envSigningKey = (process.env['MORS_RELAY_SIGNING_KEY'] ?? '').trim();
    let signingKey = envSigningKey || loadSigningKey(configDir) || '';
    if (!signingKey) {
        signingKey = generateSigningKey();
    }
    saveSigningKey(configDir, signingKey);
    const deviceId = `device-${randomUUID()}`;
    const session = {
        accessToken: generateSessionToken({
            accountId: inviteResult.accountId,
            deviceId,
            signingKey,
        }),
        tokenType: 'bearer',
        accountId: inviteResult.accountId,
        deviceId,
        createdAt: new Date().toISOString(),
    };
    markAuthEnabled(configDir);
    clearSession(configDir);
    saveSession(configDir, session);
    return session;
}
async function publishDeviceBundle(configDir, relayBaseUrl, token) {
    try {
        const localBundle = requireDeviceBootstrap(getDeviceKeysDir(configDir));
        const client = new RelayClient({
            baseUrl: relayBaseUrl,
            token,
            queueStorePath: `${configDir}/offline-queue.json`,
        });
        await client.publishDeviceBundle({
            deviceId: localBundle.deviceId,
            fingerprint: localBundle.fingerprint,
            x25519PublicKey: localBundle.x25519PublicKey.toString('hex'),
            ed25519PublicKey: localBundle.ed25519PublicKey.toString('hex'),
            createdAt: new Date().toISOString(),
        });
        return {
            name: 'device_bundle',
            status: 'pass',
            message: 'Published local device bundle to relay.',
        };
    }
    catch (err) {
        return {
            name: 'device_bundle',
            status: 'warn',
            message: `Device bundle was not published: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
async function checkRelayReachable(relayBaseUrl) {
    let url;
    try {
        url = new URL('/health', relayBaseUrl);
    }
    catch {
        return {
            name: 'relay_reachable',
            status: 'fail',
            message: `Invalid relay URL: ${relayBaseUrl}`,
        };
    }
    const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve) => {
        let settled = false;
        const finish = (check) => {
            if (!settled) {
                settled = true;
                resolve(check);
            }
        };
        const req = doRequest(url, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Connection: 'close',
            },
            timeout: 1500,
        }, (res) => {
            res.resume();
            const statusCode = res.statusCode ?? 0;
            if (statusCode >= 200 && statusCode < 300) {
                finish({
                    name: 'relay_reachable',
                    status: 'pass',
                    message: `Relay health check passed at ${relayBaseUrl}.`,
                });
                return;
            }
            finish({
                name: 'relay_reachable',
                status: 'warn',
                message: `Relay health check returned HTTP ${statusCode}.`,
            });
        });
        req.on('error', (err) => {
            finish({
                name: 'relay_reachable',
                status: 'warn',
                message: `Relay health check could not connect: ${err.message}`,
            });
        });
        req.on('timeout', () => {
            finish({
                name: 'relay_reachable',
                status: 'warn',
                message: `Relay health check timed out at ${relayBaseUrl}.`,
            });
            req.destroy();
        });
        req.end();
    });
}
function resolveSetupRelay(flags) {
    const rawUrl = optionalStringFlag(flags, 'relay-url');
    const relayBaseUrl = normalizeRelayUrl(rawUrl ?? DEFAULT_HOSTED_RELAY_BASE_URL);
    return {
        url: relayBaseUrl,
        settings: {
            relayMode: rawUrl ? 'custom' : 'hosted',
            relayBaseUrl,
        },
    };
}
function normalizeRelayUrl(value) {
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('Relay URL must use http or https.');
        }
        return parsed.toString().replace(/\/$/, '');
    }
    catch (err) {
        if (err instanceof Error && err.message === 'Relay URL must use http or https.') {
            throw new SetupUsageError('invalid_relay_url', err.message);
        }
        throw new SetupUsageError('invalid_relay_url', `Invalid relay URL: ${value}`);
    }
}
function optionalHandle(flags) {
    const raw = optionalStringFlag(flags, 'handle');
    if (!raw)
        return undefined;
    const handle = normalizeHandle(raw.startsWith('@') ? raw.slice(1) : raw);
    validateHandle(handle);
    return handle;
}
function relayNextCommands(status) {
    if (status === 'blocked') {
        return ['mors doctor --json', 'mors setup relay --json'];
    }
    if (status === 'ready') {
        return [
            'mors start',
            'mors send --remote --to <account-id> --body "hello"',
            'mors watch --remote',
        ];
    }
    if (status === 'needs_profile') {
        return [
            'mors onboard --handle <handle> --display-name "<name>" --json',
            'mors start',
        ];
    }
    return [
        'mors setup relay --handle <handle> --display-name "<name>"',
        'mors start',
    ];
}
function hasFailedChecks(checks) {
    return checks.some((check) => check.status === 'fail');
}
function setBlockedExitCode(result) {
    if (result.status === 'blocked') {
        process.exitCode = 1;
    }
}
function writeSetupResult(result, json) {
    if (json) {
        console.log(JSON.stringify(result));
        return;
    }
    console.log(`mors ${result.mode} setup: ${result.status}`);
    console.log(`Config: ${result.config_dir}`);
    if (result.relay_url) {
        console.log(`Relay: ${result.relay_url}`);
    }
    console.log('');
    for (const check of result.checks) {
        console.log(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
    }
    console.log('');
    console.log('Next commands:');
    for (const command of result.next_commands) {
        console.log(`  ${command}`);
    }
}
function writeSetupError(err, json) {
    const message = err instanceof Error ? err.message : String(err);
    const error = err instanceof SetupUsageError
        ? err.code
        : err instanceof Error
            ? err.name
            : 'setup_failed';
    if (json) {
        console.log(JSON.stringify({
            status: 'error',
            error,
            message,
        }));
    }
    else {
        console.error(`Error: ${message}`);
    }
}
function validateSetupFlags(flags, mode) {
    for (const [name, value] of Object.entries(flags)) {
        if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) {
            throw new SetupUsageError('unknown_setup_option', `Unknown setup option --${name}.`);
        }
        if (VALUE_FLAGS.has(name) && (value === true || value.trim().length === 0)) {
            throw new SetupUsageError('missing_setup_option_value', `Setup option --${name} requires a value.`);
        }
        if (mode === 'local' && RELAY_ONLY_FLAGS.has(name)) {
            throw new SetupUsageError('unsupported_setup_option', `Setup option --${name} only applies to "mors setup relay".`);
        }
    }
}
function resolveConfigDir(flags) {
    return optionalStringFlag(flags, 'config-dir') ?? getConfigDir();
}
function optionalStringFlag(flags, name) {
    const value = flags[name];
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function shellValue(value) {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
function parseSetupArgs(args) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const eqIndex = arg.indexOf('=');
            if (eqIndex >= 0) {
                flags[arg.slice(2, eqIndex)] = arg.slice(eqIndex + 1);
                continue;
            }
            const key = arg.slice(2);
            const next = args[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                flags[key] = next;
                i++;
            }
            else {
                flags[key] = true;
            }
            continue;
        }
        positional.push(arg);
    }
    return { positional, flags };
}
function hasHelpFlag(args) {
    return args.includes('--help') || args.includes('-h');
}
function printSetupUsage() {
    console.log(`mors setup

Usage:
  mors setup local [--json] [--config-dir <path>]
  mors setup relay [--json] [--config-dir <path>] [--relay-url <url>]
  mors setup relay --handle <handle> --display-name <name> [--json]

Modes:
  local    Prepare local-only messaging for people, scripts, and local agents
  relay    Prepare external relay-backed messaging

Relay options:
  --relay-url <url>       Use a custom relay instead of the hosted default
  --handle <handle>       Hosted handle to create when signing up
  --display-name <name>   Display name for hosted signup or local profile
  --invite-token <token>  Use native invite-token auth instead of hosted signup
  --skip-relay-check      Skip the /health reachability check

Common options:
  --config-dir <path>     Use a specific mors config directory
  --json                  Output machine-readable JSON`);
}
//# sourceMappingURL=setup.js.map