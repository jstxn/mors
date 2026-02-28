/**
 * CLI dispatcher for the mors command.
 *
 * Routes commands, handles init gating (VAL-INIT-005),
 * and formats output with secret redaction (VAL-INIT-004).
 */

import { initCommand, requireInit, getDbPath, getDbKeyPath } from './init.js';
import { loadKey } from './key-management.js';
import { openEncryptedDb } from './store.js';
import {
  sendMessage,
  listInbox,
  readMessage,
  ackMessage,
  replyMessage,
  listThread,
} from './message.js';
import { startWatch } from './watch.js';
import type { WatchEvent } from './watch.js';
import { runSetupShell } from './setup-shell.js';
import {
  MorsError,
  NotInitializedError,
  SqlCipherUnavailableError,
  DeviceNotBootstrappedError,
  KeyExchangeNotCompleteError,
  CipherError,
} from './errors.js';
import { assertDeviceBootstrapped, requireDeviceBootstrap } from './e2ee/bootstrap-guard.js';
import { getDeviceKeysDir, isDeviceBootstrapped } from './e2ee/device-keys.js';
import {
  loadKeyExchangeSession,
  listKeyExchangeSessions,
  type KeyExchangeSession,
} from './e2ee/key-exchange.js';
import { ContractValidationError } from './contract/errors.js';
import {
  saveSession,
  loadSession,
  clearSession,
  markAuthEnabled,
  saveSigningKey,
  loadSigningKey,
  saveProfile,
  loadProfile,
} from './auth/session.js';
import {
  validateInviteToken,
  generateSessionToken,
  generateSigningKey,
  NativeAuthPrerequisiteError,
} from './auth/native.js';
import {
  requireAuth,
  verifyTokenLiveness,
  NotAuthenticatedError,
  TokenLivenessError,
  SigningKeyMismatchError,
} from './auth/guards.js';
import { getConfigDir } from './identity.js';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync as execFileSyncImport } from 'node:child_process';
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import { RelayClient, RelayClientError, type RelayMessageResponse } from './relay/client.js';
import { connectRemoteWatch, type RemoteWatchEvent } from './remote-watch.js';
import {
  runDeployPreflight,
  formatDeployIssues,
  formatDeployResultJson,
  redactSecrets,
} from './deploy.js';
import { validateHandle } from './relay/account-store.js';

/** Commands that require initialization before use. */
const GATED_COMMANDS = new Set(['send', 'inbox', 'read', 'reply', 'ack', 'thread', 'watch']);

/** Commands that are implemented. */
const IMPLEMENTED_COMMANDS = new Set(['send', 'inbox', 'read', 'ack', 'reply', 'thread', 'watch']);

/**
 * Commands that require an authenticated session (in addition to init).
 *
 * After logout, these commands fail with login-required guidance (VAL-AUTH-005).
 */
const AUTH_GATED_COMMANDS = new Set(['send', 'inbox', 'read', 'reply', 'ack', 'thread', 'watch']);

export function run(args: string[]): void {
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
    // runStatus is async (token-liveness check); attach error handler
    // so the process waits for completion and sets exitCode deterministically.
    runStatus(args.slice(1)).catch((err: unknown) => {
      process.exitCode = 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
    });
    return;
  }

  if (command === 'deploy') {
    runDeploy(args.slice(1));
    return;
  }

  if (command === 'onboard') {
    runOnboard(args.slice(1));
    return;
  }

  // ── Pre-init command gating (VAL-INIT-005) ──────────────────────
  if (GATED_COMMANDS.has(command)) {
    let configDir: string;
    try {
      configDir = requireInit();
    } catch (err: unknown) {
      if (err instanceof NotInitializedError) {
        console.error(`Error: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }

    // ── Auth gating: require active session (VAL-AUTH-005) ────────
    if (AUTH_GATED_COMMANDS.has(command)) {
      const cmdArgs = args.slice(1);
      const { flags: cmdFlags } = parseArgs(cmdArgs);
      const isJson = 'json' in cmdFlags;

      try {
        requireAuth(configDir);
      } catch (err: unknown) {
        if (err instanceof NotAuthenticatedError) {
          if (isJson) {
            console.log(
              JSON.stringify({
                status: 'error',
                error: 'not_authenticated',
                message: err.message,
              })
            );
          } else {
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
function openStore(configDir: string): BetterSqlite3.Database {
  const dbPath = getDbPath(configDir);
  const key = loadKey(getDbKeyPath(configDir));
  return openEncryptedDb({ dbPath, key });
}

// ── Remote mode detection and RelayClient factory ───────────────────

/** Error class for when remote prerequisites are missing. */
class RemoteUnavailableError extends MorsError {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteUnavailableError';
  }
}

/**
 * Create a RelayClient from the current session and relay config.
 *
 * Requires both an active authenticated session (with access token) and
 * a relay base URL (MORS_RELAY_BASE_URL env var).
 *
 * @param configDir - Config directory containing the session.
 * @returns A configured RelayClient.
 * @throws RemoteUnavailableError if relay URL is not configured.
 * @throws NotAuthenticatedError if no active session exists.
 */
function createRelayClientFromSession(configDir: string): RelayClient {
  const session = loadSession(configDir);
  if (!session) {
    throw new NotAuthenticatedError();
  }

  const relayBaseUrl = process.env['MORS_RELAY_BASE_URL'];
  if (!relayBaseUrl) {
    throw new RemoteUnavailableError(
      'Remote mode requires MORS_RELAY_BASE_URL to be set. ' +
        'Set this environment variable to the relay server URL (e.g. http://localhost:3100).'
    );
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
function resolveKeyExchangeSession(configDir: string, peerDeviceId?: string): KeyExchangeSession {
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
    throw new KeyExchangeNotCompleteError(
      'any',
      'No key exchange sessions found. Run "mors key-exchange" with a peer device\'s ' +
        'public key before sending encrypted messages, or use --peer-device to specify a peer.'
    );
  }
  if (sessions.length === 1) {
    return sessions[0];
  }

  // Multiple sessions — require explicit --peer-device
  throw new KeyExchangeNotCompleteError(
    'any',
    `Multiple key exchange sessions found (${sessions.length} peers). ` +
      'Use --peer-device <device-id> to specify which peer to encrypt for.'
  );
}

/**
 * Dispatch a gated command after init validation.
 */
function runCommand(command: string, args: string[], configDir: string): void {
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
function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      if (eqIndex >= 0) {
        const key = arg.slice(2, eqIndex);
        flags[key] = arg.slice(eqIndex + 1);
      } else {
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

// ── Send command ──────────────────────────────────────────────────────

function runSend(args: string[], configDir: string): void {
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
    } catch (err: unknown) {
      if (err instanceof DeviceNotBootstrappedError) {
        if (json) {
          console.log(
            JSON.stringify({
              status: 'error',
              error: 'device_not_bootstrapped',
              message: err.message,
            })
          );
        } else {
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

  let db: BetterSqlite3.Database | null = null;
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
      console.log(
        JSON.stringify({
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
        })
      );
    } else {
      if (result.dedupe_replay) {
        console.log(`Message already sent (dedupe replay): ${result.id}`);
      } else {
        console.log(`Message sent: ${result.id}`);
      }
      console.log(`Thread: ${result.thread_id}`);
    }
  } catch (err: unknown) {
    process.exitCode = 1;
    handleCommandError(err, json);
  } finally {
    if (db) db.close();
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
function runRemoteSend(
  configDir: string,
  json: boolean,
  opts: {
    to: string;
    body: string;
    subject?: string;
    inReplyTo?: string;
    noEncrypt?: boolean;
    peerDevice?: string;
  }
): void {
  let client: RelayClient;
  try {
    client = createRelayClientFromSession(configDir);
  } catch (err: unknown) {
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
    let session: KeyExchangeSession;
    try {
      session = resolveKeyExchangeSession(configDir, opts.peerDevice);
    } catch (err: unknown) {
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
      .catch((err: unknown) => {
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
    .catch((err: unknown) => {
      process.exitCode = 1;
      handleRemoteError(err, json);
    });
}

/**
 * Format the result of a remote send operation for CLI output.
 */
function formatRemoteSendResult(
  result: import('./relay/client.js').SendResult,
  json: boolean,
  encrypted: boolean
): void {
  if (result.queued) {
    if (json) {
      console.log(
        JSON.stringify({
          status: 'queued',
          mode: 'remote',
          dedupe_key: result.dedupeKey,
          ...(encrypted ? { encrypted: true } : {}),
          message: 'Message queued offline. It will be delivered when the relay is reachable.',
        })
      );
    } else {
      console.log(`Message queued offline (dedupe key: ${result.dedupeKey})`);
      console.log('It will be delivered when the relay is reachable.');
    }
  } else if (result.message) {
    const msg = result.message;
    if (json) {
      console.log(
        JSON.stringify({
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
        })
      );
    } else {
      const enc = encrypted ? ' [encrypted]' : '';
      console.log(`Message sent (remote${enc}): ${msg.id}`);
      console.log(`Thread: ${msg.thread_id}`);
    }
  }
}

// ── Inbox command ────────────────────────────────────────────────────

function runInbox(args: string[], configDir: string): void {
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

  let db: BetterSqlite3.Database | null = null;
  try {
    db = openStore(configDir);
    const inbox = listInbox(db, { recipient, unreadOnly });

    if (json) {
      console.log(
        JSON.stringify({
          status: 'ok',
          count: inbox.length,
          messages: inbox,
        })
      );
    } else {
      if (inbox.length === 0) {
        console.log('No messages.');
      } else {
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
  } catch (err: unknown) {
    process.exitCode = 1;
    handleCommandError(err, json);
  } finally {
    if (db) db.close();
  }
}

/**
 * Fetch inbox from the relay.
 *
 * Uses createRelayClientFromSession to validate prerequisites (session + relay URL),
 * then performs a direct HTTP request to the relay inbox endpoint.
 */
function runRemoteInbox(configDir: string, json: boolean, opts: { unreadOnly?: boolean }): void {
  // Validate prerequisites (session exists, relay URL configured)
  try {
    createRelayClientFromSession(configDir);
  } catch (err: unknown) {
    process.exitCode = 1;
    handleRemoteError(err, json);
    return;
  }

  const session = loadSession(configDir);
  const baseUrl = process.env['MORS_RELAY_BASE_URL'];
  // Both are validated by createRelayClientFromSession above
  if (!session || !baseUrl) return;
  const token = session.accessToken;
  const unreadParam = opts.unreadOnly ? '?unread=true' : '';

  fetch(`${baseUrl}/inbox${unreadParam}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  })
    .then(async (res) => {
      if (!res.ok) {
        throw new RelayClientError(res.status, await res.json().catch(() => res.statusText));
      }
      return res.json() as Promise<{ count: number; messages: RelayMessageResponse[] }>;
    })
    .then((data) => {
      if (json) {
        console.log(
          JSON.stringify({
            status: 'ok',
            mode: 'remote',
            count: data.count,
            messages: data.messages,
          })
        );
      } else {
        if (data.count === 0) {
          console.log('No messages (remote).');
        } else {
          for (const msg of data.messages) {
            const readMarker = msg.read_at ? '✓' : '•';
            const stateTag = msg.state === 'acked' ? ' [acked]' : '';
            console.log(
              `${readMarker} ${msg.id}  from:${msg.sender_login}  ${msg.state}${stateTag}`
            );
            if (msg.subject) {
              console.log(`  Subject: ${msg.subject}`);
            }
            console.log(`  ${msg.body.split('\n')[0].slice(0, 80)}`);
          }
          console.log(`\n${data.count} message(s) (remote)`);
        }
      }
    })
    .catch((err: unknown) => {
      process.exitCode = 1;
      handleRemoteError(err, json);
    });
}

// ── Read command ─────────────────────────────────────────────────────

function runRead(args: string[], configDir: string): void {
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

  let db: BetterSqlite3.Database | null = null;
  try {
    db = openStore(configDir);
    const result = readMessage(db, messageId);

    if (json) {
      console.log(
        JSON.stringify({
          status: 'ok',
          message: result,
        })
      );
    } else {
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
  } catch (err: unknown) {
    process.exitCode = 1;
    handleCommandError(err, json);
  } finally {
    if (db) db.close();
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
function runRemoteRead(
  configDir: string,
  json: boolean,
  messageId: string,
  opts?: { noEncrypt?: boolean; peerDevice?: string }
): void {
  let client: RelayClient;
  try {
    client = createRelayClientFromSession(configDir);
  } catch (err: unknown) {
    process.exitCode = 1;
    handleRemoteError(err, json);
    return;
  }

  // ── Default encrypted path: resolve key exchange session ──────────
  if (!opts?.noEncrypt) {
    let session: KeyExchangeSession;
    try {
      session = resolveKeyExchangeSession(configDir, opts?.peerDevice);
    } catch (err: unknown) {
      process.exitCode = 1;
      handleSecureSetupError(err, json);
      return;
    }

    client
      .readDecrypted(messageId, session.sharedSecret)
      .then((result) => {
        const msg = result.message;
        if (json) {
          console.log(
            JSON.stringify({
              status: 'ok',
              mode: 'remote',
              encrypted: true,
              first_read: result.firstRead,
              decrypted_body: result.decryptedBody,
              message: msg,
            })
          );
        } else {
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
      .catch((err: unknown) => {
        process.exitCode = 1;
        if (err instanceof CipherError) {
          handleSecureSetupError(err, json);
        } else {
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
        console.log(
          JSON.stringify({
            status: 'ok',
            mode: 'remote',
            first_read: result.firstRead,
            message: msg,
          })
        );
      } else {
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
    .catch((err: unknown) => {
      process.exitCode = 1;
      handleRemoteError(err, json);
    });
}

// ── Ack command ──────────────────────────────────────────────────────

function runAck(args: string[], configDir: string): void {
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

  let db: BetterSqlite3.Database | null = null;
  try {
    db = openStore(configDir);
    const result = ackMessage(db, messageId);

    if (json) {
      console.log(
        JSON.stringify({
          status: 'acked',
          id: result.id,
          thread_id: result.thread_id,
          state: result.state,
          updated_at: result.updated_at,
        })
      );
    } else {
      console.log(`Message acknowledged: ${result.id}`);
      console.log(`State: ${result.state}`);
    }
  } catch (err: unknown) {
    process.exitCode = 1;
    handleCommandError(err, json);
  } finally {
    if (db) db.close();
  }
}

/**
 * Acknowledge a message through the relay via RelayClient.
 */
function runRemoteAck(configDir: string, json: boolean, messageId: string): void {
  let client: RelayClient;
  try {
    client = createRelayClientFromSession(configDir);
  } catch (err: unknown) {
    process.exitCode = 1;
    handleRemoteError(err, json);
    return;
  }

  client
    .ack(messageId)
    .then((result) => {
      const msg = result.message;
      if (json) {
        console.log(
          JSON.stringify({
            status: 'acked',
            mode: 'remote',
            id: msg.id,
            thread_id: msg.thread_id,
            state: msg.state,
            acked_at: msg.acked_at,
            updated_at: msg.updated_at,
            first_ack: result.firstAck,
          })
        );
      } else {
        console.log(`Message acknowledged (remote): ${msg.id}`);
        console.log(`State: ${msg.state}`);
      }
    })
    .catch((err: unknown) => {
      process.exitCode = 1;
      handleRemoteError(err, json);
    });
}

// ── Reply command ────────────────────────────────────────────────────

function runReply(args: string[], configDir: string): void {
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
    } catch (err: unknown) {
      if (err instanceof DeviceNotBootstrappedError) {
        if (json) {
          console.log(
            JSON.stringify({
              status: 'error',
              error: 'device_not_bootstrapped',
              message: err.message,
            })
          );
        } else {
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

  let db: BetterSqlite3.Database | null = null;
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
      console.log(
        JSON.stringify({
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
        })
      );
    } else {
      if (result.dedupe_replay) {
        console.log(`Reply already sent (dedupe replay): ${result.id}`);
      } else {
        console.log(`Reply sent: ${result.id}`);
      }
      console.log(`Thread: ${result.thread_id}`);
      console.log(`In reply to: ${result.in_reply_to}`);
    }
  } catch (err: unknown) {
    process.exitCode = 1;
    handleCommandError(err, json);
  } finally {
    if (db) db.close();
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
function runRemoteReply(
  configDir: string,
  json: boolean,
  opts: {
    parentId: string;
    to?: string;
    body: string;
    subject?: string;
    noEncrypt?: boolean;
    peerDevice?: string;
  }
): void {
  let client: RelayClient;
  try {
    client = createRelayClientFromSession(configDir);
  } catch (err: unknown) {
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
    let session: KeyExchangeSession;
    try {
      session = resolveKeyExchangeSession(configDir, opts.peerDevice);
    } catch (err: unknown) {
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
      .catch((err: unknown) => {
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
    .catch((err: unknown) => {
      process.exitCode = 1;
      handleRemoteError(err, json);
    });
}

/**
 * Format the result of a remote reply operation for CLI output.
 */
function formatRemoteReplyResult(
  result: import('./relay/client.js').SendResult,
  json: boolean,
  encrypted: boolean,
  parentId: string
): void {
  if (result.queued) {
    if (json) {
      console.log(
        JSON.stringify({
          status: 'queued',
          mode: 'remote',
          dedupe_key: result.dedupeKey,
          in_reply_to: parentId,
          ...(encrypted ? { encrypted: true } : {}),
          message: 'Reply queued offline. It will be delivered when the relay is reachable.',
        })
      );
    } else {
      console.log(`Reply queued offline (dedupe key: ${result.dedupeKey})`);
      console.log(`In reply to: ${parentId}`);
    }
  } else if (result.message) {
    const msg = result.message;
    if (json) {
      console.log(
        JSON.stringify({
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
        })
      );
    } else {
      const enc = encrypted ? ' [encrypted]' : '';
      console.log(`Reply sent (remote${enc}): ${msg.id}`);
      console.log(`Thread: ${msg.thread_id}`);
      console.log(`In reply to: ${msg.in_reply_to}`);
    }
  }
}

// ── Thread command ───────────────────────────────────────────────────

function runThread(args: string[], configDir: string): void {
  const { positional, flags } = parseArgs(args);
  const json = 'json' in flags;
  const threadId = positional[0];

  if (!threadId) {
    formatError('thread requires a thread ID argument', json);
    process.exitCode = 1;
    return;
  }

  let db: BetterSqlite3.Database | null = null;
  try {
    db = openStore(configDir);
    const thread = listThread(db, threadId);

    if (json) {
      console.log(
        JSON.stringify({
          status: 'ok',
          thread_id: threadId,
          count: thread.length,
          messages: thread,
        })
      );
    } else {
      if (thread.length === 0) {
        console.log('No messages in thread.');
      } else {
        console.log(`Thread: ${threadId} (${thread.length} message(s))\n`);
        for (const msg of thread) {
          const indent = msg.in_reply_to ? '  ↳ ' : '';
          const readMarker = msg.read_at ? '✓' : '•';
          const stateTag = msg.state === 'acked' ? ' [acked]' : '';
          console.log(
            `${indent}${readMarker} ${msg.id}  from:${msg.sender}  ${msg.state}${stateTag}`
          );
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
  } catch (err: unknown) {
    process.exitCode = 1;
    handleCommandError(err, json);
  } finally {
    if (db) db.close();
  }
}

// ── Watch command ─────────────────────────────────────────────────

function runWatch(args: string[], configDir: string): void {
  const { flags } = parseArgs(args);
  const json = 'json' in flags;
  const remote = 'remote' in flags;

  // ── Remote mode: connect to relay SSE stream ─────────────────────
  if (remote) {
    runRemoteWatch(configDir, json);
    return;
  }

  const pollInterval =
    typeof flags['poll-interval'] === 'string' ? parseInt(flags['poll-interval'], 10) : 500;

  if (isNaN(pollInterval) || pollInterval < 10) {
    formatError('--poll-interval must be a number >= 10 (ms)', json);
    process.exitCode = 1;
    return;
  }

  let db: BetterSqlite3.Database | null = null;
  try {
    db = openStore(configDir);
  } catch (err: unknown) {
    process.exitCode = 1;
    handleCommandError(err, json);
    return;
  }

  const controller = new AbortController();

  // ── SIGINT handling for clean shutdown (VAL-WATCH-002) ──────────
  const onSigint = (): void => {
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  if (!json) {
    console.log('Watching for new events... (press Ctrl+C to stop)');
  }

  const handle = startWatch(db, {
    pollIntervalMs: pollInterval,
    signal: controller.signal,
    onEvent: (event: WatchEvent) => {
      if (json) {
        console.log(JSON.stringify(event));
      } else {
        formatWatchEvent(event);
      }
    },
    onShutdown: () => {
      // Clean up: remove SIGINT listener, close DB.
      process.removeListener('SIGINT', onSigint);
      if (db) {
        try {
          db.close();
        } catch {
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
function runRemoteWatch(configDir: string, json: boolean): void {
  // Validate prerequisites: session + relay URL
  const session = loadSession(configDir);
  if (!session) {
    process.exitCode = 1;
    handleRemoteError(new NotAuthenticatedError(), json);
    return;
  }

  const relayBaseUrl = process.env['MORS_RELAY_BASE_URL'];
  if (!relayBaseUrl) {
    process.exitCode = 1;
    handleRemoteError(
      new RemoteUnavailableError(
        'MORS_RELAY_BASE_URL is not set. Configure the relay base URL to use remote watch.'
      ),
      json
    );
    return;
  }

  if (!json) {
    console.log('Connecting to remote watch stream... (press Ctrl+C to stop)');
  }

  const handle = connectRemoteWatch({
    baseUrl: relayBaseUrl,
    token: session.accessToken,
    onEvent: (event: RemoteWatchEvent) => {
      if (json) {
        console.log(
          JSON.stringify({
            event: event.event,
            ...(event.id ? { event_id: event.id } : {}),
            ...event.data,
          })
        );
      } else {
        formatRemoteWatchEvent(event);
      }
    },
    onStateChange: (newState, reason) => {
      if (newState === 'fallback') {
        if (json) {
          console.log(
            JSON.stringify({
              status: 'degraded',
              mode: 'fallback',
              reason: reason ?? 'SSE unavailable',
            })
          );
        } else {
          console.log(`\n⚠️  Degraded mode: ${reason ?? 'SSE unavailable'}`);
          console.log(
            'Realtime events are not available. Use "mors inbox --remote" to check for new messages.'
          );
        }
      }
    },
  });

  // ── SIGINT handling for clean shutdown ──────────────────────────
  const onSigint = (): void => {
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
function formatRemoteWatchEvent(event: RemoteWatchEvent): void {
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

  const typeLabel =
    event.event === 'message_created'
      ? '📨 New message'
      : event.event === 'reply_created'
        ? '↩️  Reply'
        : event.event === 'message_acked'
          ? '✅ Acked'
          : event.event;

  const timestamp = (event.data.timestamp as string) ?? new Date().toISOString();
  const messageId = (event.data.message_id as string) ?? 'unknown';
  const threadId = (event.data.thread_id as string) ?? 'unknown';
  const senderId = event.data.sender_id ?? 'unknown';
  const recipientId = event.data.recipient_id ?? 'unknown';
  const inReplyTo = event.data.in_reply_to as string | null;

  console.log(`[${timestamp}] ${typeLabel}`);
  console.log(`  Message: ${messageId}  Thread: ${threadId}`);
  console.log(`  From: ${senderId} → To: ${recipientId}`);
  if (inReplyTo) {
    console.log(`  In reply to: ${inReplyTo}`);
  }
}

function formatWatchEvent(event: WatchEvent): void {
  const typeLabel =
    event.event_type === 'message_created'
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

function runSetupShellCommand(_args: string[]): void {
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
    .catch((err: unknown) => {
      process.exitCode = 1;
      const msg = err instanceof Error ? err.message : String(err);
      if (json) {
        console.log(
          JSON.stringify({
            status: 'error',
            error: 'setup_shell_failed',
            message: msg,
          })
        );
      } else {
        console.error(`Error: ${msg}`);
      }
    });
}

// ── Login command (VAL-AUTH-001, VAL-AUTH-002, VAL-AUTH-007, VAL-AUTH-011) ─

function runLogin(_args: string[]): void {
  const { flags, positional } = parseArgs(_args);
  const json = 'json' in flags;

  const configDir = getConfigDir();

  // Check for existing session
  const existing = loadSession(configDir);
  if (existing) {
    if (json) {
      console.log(
        JSON.stringify({
          status: 'already_authenticated',
          account_id: existing.accountId,
          device_id: existing.deviceId,
        })
      );
    } else {
      console.log(`Already logged in (account: ${existing.accountId})`);
      console.log('Run "mors logout" first to switch accounts.');
    }
    return;
  }

  // ── Prerequisites check (VAL-AUTH-007, VAL-AUTH-011) ──────────
  const missing: string[] = [];

  // Check invite token
  const inviteToken =
    (flags['invite-token'] as string | undefined) ??
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
      console.log(
        JSON.stringify({
          status: 'error',
          error: 'missing_prerequisites',
          missing,
          message: prereqError.message,
        })
      );
    } else {
      console.error(`Error: ${prereqError.message}`);
    }
    return;
  }

  // Validate invite token format (VAL-AUTH-011)
  const inviteResult = validateInviteToken(inviteToken);
  if (!inviteResult.valid) {
    process.exitCode = 1;
    if (json) {
      console.log(
        JSON.stringify({
          status: 'error',
          error: 'invalid_invite_token',
          message: inviteResult.reason ?? 'Invalid invite token.',
        })
      );
    } else {
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
  let signingKey: string;
  if (envSigningKey) {
    signingKey = envSigningKey;
    // Persist the env-sourced key locally so offline status checks work
    saveSigningKey(configDir, signingKey);
  } else {
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
    console.log(
      JSON.stringify({
        status: 'authenticated',
        account_id: inviteResult.accountId,
        device_id: deviceId,
      })
    );
  } else {
    console.log('\n✅ Authenticated with mors-native identity');
    console.log(`Account: ${inviteResult.accountId}`);
    console.log(`Device: ${deviceId}`);
  }
}

/** Check if a path exists on disk (sync). */
function existsSyncCheck(filePath: string): boolean {
  return existsSync(filePath);
}

// ── Logout command (VAL-AUTH-005) ────────────────────────────────────

function runLogout(_args: string[]): void {
  const { flags } = parseArgs(_args);
  const json = 'json' in flags;

  const configDir = getConfigDir();
  const existing = loadSession(configDir);

  clearSession(configDir);

  if (json) {
    console.log(
      JSON.stringify({
        status: 'logged_out',
        had_session: existing !== null,
      })
    );
  } else {
    if (existing) {
      console.log(`Logged out (was: ${existing.accountId}).`);
    } else {
      console.log('No active session. Already logged out.');
    }
  }
}

// ── Onboard command (VAL-AUTH-008, VAL-AUTH-012) ─────────────────────

/**
 * First-run onboarding wizard.
 *
 * Captures a globally unique immutable handle and basic profile metadata,
 * then persists the account profile locally.
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
function runOnboard(_args: string[]): void {
  const { flags } = parseArgs(_args);
  const json = 'json' in flags;

  const configDir = getConfigDir();

  // Check init
  try {
    requireInit();
  } catch (err: unknown) {
    if (err instanceof NotInitializedError) {
      process.exitCode = 1;
      if (json) {
        console.log(
          JSON.stringify({
            status: 'error',
            error: 'not_initialized',
            message: err.message,
          })
        );
      } else {
        console.error(`Error: ${err.message}`);
      }
      return;
    }
    throw err;
  }

  // Check auth
  try {
    requireAuth(configDir);
  } catch (err: unknown) {
    if (err instanceof NotAuthenticatedError) {
      process.exitCode = 1;
      if (json) {
        console.log(
          JSON.stringify({
            status: 'error',
            error: 'not_authenticated',
            message: 'Not authenticated. Run "mors login" before onboarding.',
          })
        );
      } else {
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
      console.log(
        JSON.stringify({
          status: 'error',
          error: 'not_authenticated',
          message: 'No active session. Run "mors login" to authenticate.',
        })
      );
    } else {
      console.error('Error: No active session. Run "mors login" to authenticate.');
    }
    return;
  }

  // Check if already onboarded
  const existingProfile = loadProfile(configDir);
  if (existingProfile) {
    if (json) {
      console.log(
        JSON.stringify({
          status: 'already_onboarded',
          handle: existingProfile.handle,
          display_name: existingProfile.displayName,
          account_id: existingProfile.accountId,
        })
      );
    } else {
      console.log(`Already onboarded (handle: ${existingProfile.handle}).`);
      console.log('Handles are immutable and cannot be changed after creation.');
    }
    return;
  }

  // Parse required flags
  const handle = typeof flags['handle'] === 'string' ? flags['handle'] : undefined;
  const displayName = typeof flags['display-name'] === 'string' ? flags['display-name'] : undefined;

  if (!handle || !displayName) {
    process.exitCode = 1;
    const missing: string[] = [];
    if (!handle) missing.push('--handle');
    if (!displayName) missing.push('--display-name');

    if (json) {
      console.log(
        JSON.stringify({
          status: 'error',
          error: 'missing_required_fields',
          missing,
          message: `Missing required fields: ${missing.join(', ')}. Both --handle and --display-name are required for onboarding.`,
        })
      );
    } else {
      console.error(`Error: Missing required fields: ${missing.join(', ')}.`);
      console.error('Usage: mors onboard --handle <handle> --display-name <name> [--json]');
    }
    return;
  }

  // Validate handle format locally before attempting relay registration
  try {
    validateHandle(handle);
  } catch (err: unknown) {
    process.exitCode = 1;
    if (err instanceof Error) {
      if (json) {
        console.log(
          JSON.stringify({
            status: 'error',
            error: 'invalid_handle',
            message: err.message,
          })
        );
      } else {
        console.error(`Error: ${err.message}`);
      }
    }
    return;
  }

  // Persist profile locally (VAL-AUTH-008, VAL-AUTH-012)
  // In the current phase, onboarding persists locally. Future milestones
  // will also register with the relay for global uniqueness enforcement.
  saveProfile(configDir, {
    handle,
    displayName,
    accountId: session.accountId,
    createdAt: new Date().toISOString(),
  });

  if (json) {
    console.log(
      JSON.stringify({
        status: 'onboarded',
        handle,
        display_name: displayName,
        account_id: session.accountId,
      })
    );
  } else {
    console.log('\n✅ Onboarding complete');
    console.log(`Handle: ${handle}`);
    console.log(`Display Name: ${displayName}`);
    console.log(`Account: ${session.accountId}`);
    console.log('\nYour handle is immutable and cannot be changed.');
  }
}

// ── Status command (VAL-AUTH-002, VAL-AUTH-006) ──────────────────────

async function runStatus(_args: string[]): Promise<void> {
  const { flags } = parseArgs(_args);
  const json = 'json' in flags;
  const skipLiveness = 'offline' in flags;

  const configDir = getConfigDir();
  const session = loadSession(configDir);

  if (!session) {
    if (json) {
      console.log(
        JSON.stringify({
          status: 'not_authenticated',
          message: 'No active session. Run "mors login" to authenticate.',
        })
      );
    } else {
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
      console.log(
        JSON.stringify({
          status: 'authenticated',
          token_valid: true,
          account_id: principal.accountId,
          device_id: principal.deviceId,
          created_at: session.createdAt,
        })
      );
    } else {
      console.log(`Authenticated (account: ${principal.accountId})`);
      console.log(`Device: ${principal.deviceId}`);
      console.log(`Session created: ${session.createdAt}`);
      console.log('Token: valid');
    }
  } catch (err: unknown) {
    process.exitCode = 1;
    // Check SigningKeyMismatchError first (subclass of TokenLivenessError)
    if (err instanceof SigningKeyMismatchError) {
      if (json) {
        console.log(
          JSON.stringify({
            status: 'signing_key_mismatch',
            token_valid: false,
            message: err.message,
            account_id: session.accountId,
            device_id: session.deviceId,
          })
        );
      } else {
        console.error(`Error: ${err.message}`);
      }
    } else if (err instanceof TokenLivenessError) {
      if (json) {
        console.log(
          JSON.stringify({
            status: 'token_expired',
            token_valid: false,
            message: err.message,
            account_id: session.accountId,
            device_id: session.deviceId,
          })
        );
      } else {
        console.error(`Error: ${err.message}`);
      }
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      if (json) {
        console.log(
          JSON.stringify({
            status: 'error',
            error: 'unknown',
            message: msg,
          })
        );
      } else {
        console.error(`Error: ${msg}`);
      }
    }
  }
}

/**
 * Report auth status from local session without liveness check.
 */
function reportAuthStatus(session: import('./auth/session.js').AuthSession, json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify({
        status: 'authenticated',
        account_id: session.accountId,
        device_id: session.deviceId,
        created_at: session.createdAt,
      })
    );
  } else {
    console.log(`Authenticated (account: ${session.accountId})`);
    console.log(`Device: ${session.deviceId}`);
    console.log(`Session created: ${session.createdAt}`);
  }
}

// ── Init command ─────────────────────────────────────────────────────

function runInit(_args: string[]): void {
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
        console.log(
          JSON.stringify({
            status: result.alreadyInitialized ? 'already_initialized' : 'initialized',
            fingerprint: result.fingerprint,
            configDir: result.configDir,
          })
        );
      } else if (result.alreadyInitialized) {
        console.log('mors is already initialized.');
        console.log(`Identity fingerprint: ${result.fingerprint}`);
        console.log(`Config directory: ${result.configDir}`);
      } else {
        console.log('mors initialized successfully.');
        console.log(`Identity fingerprint: ${result.fingerprint}`);
        console.log(`Config directory: ${result.configDir}`);
      }
    })
    .catch((err: unknown) => {
      process.exitCode = 1;
      if (err instanceof SqlCipherUnavailableError) {
        if (json) {
          console.log(
            JSON.stringify({
              status: 'error',
              error: 'sqlcipher_unavailable',
              message: err.message,
            })
          );
        } else {
          console.error(`Error: ${err.message}`);
        }
      } else if (err instanceof MorsError) {
        if (json) {
          console.log(
            JSON.stringify({
              status: 'error',
              error: err.name,
              message: err.message,
            })
          );
        } else {
          console.error(`Error: ${err.message}`);
        }
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        if (json) {
          console.log(
            JSON.stringify({
              status: 'error',
              error: 'unknown',
              message: msg,
            })
          );
        } else {
          console.error(`Error: ${msg}`);
        }
      }
    });
}

// ── Error handling helpers ───────────────────────────────────────────

function handleCommandError(err: unknown, json: boolean): void {
  if (err instanceof ContractValidationError || err instanceof MorsError) {
    formatError(err.message, json, err.name);
  } else {
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
function handleRemoteError(err: unknown, json: boolean): void {
  if (err instanceof RemoteUnavailableError) {
    formatError(err.message, json, 'remote_unavailable');
  } else if (err instanceof NotAuthenticatedError) {
    formatError(err.message, json, 'not_authenticated');
  } else if (err instanceof RelayClientError) {
    formatError(err.message, json, 'relay_error');
  } else if (err instanceof MorsError) {
    formatError(err.message, json, err.name);
  } else {
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
function handleSecureSetupError(err: unknown, json: boolean): void {
  if (err instanceof DeviceNotBootstrappedError) {
    formatError(err.message, json, 'device_not_bootstrapped');
  } else if (err instanceof KeyExchangeNotCompleteError) {
    formatError(err.message, json, 'key_exchange_required');
  } else if (err instanceof CipherError) {
    formatError(err.message, json, 'cipher_error');
  } else if (err instanceof MorsError) {
    formatError(err.message, json, err.name);
  } else {
    const msg = err instanceof Error ? err.message : String(err);
    formatError(msg, json, 'unknown');
  }
}

function formatError(message: string, json: boolean, errorType?: string): void {
  if (json) {
    console.log(
      JSON.stringify({
        status: 'error',
        error: errorType ?? 'error',
        message,
      })
    );
  } else {
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
function runDeploy(args: string[]): void {
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
    } else {
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
    } else {
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
    console.log(
      JSON.stringify({
        status: 'deploying',
        config: {
          appName: deployConfig.appName,
          primaryRegion: deployConfig.primaryRegion,
          org: deployConfig.org,
        },
      })
    );
  } else {
    console.log(
      `Deploying to Fly.io (app: ${deployConfig.appName}, region: ${deployConfig.primaryRegion})...`
    );
  }

  try {
    const deployOutput = execFileSyncImport(
      deployConfig.flyctlPath,
      ['deploy', '--app', deployConfig.appName, '--primary-region', deployConfig.primaryRegion],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 300_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    // Redact any secrets from deploy output before display
    const safeOutput = redactSecrets(deployOutput);
    if (isJson) {
      console.log(JSON.stringify({ status: 'deployed', output: safeOutput }));
    } else {
      console.log(safeOutput);
      console.log('Deploy complete.');
    }
  } catch (err: unknown) {
    process.exitCode = 1;
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const rawOutput = (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '');
    const safeOutput = redactSecrets(rawOutput);

    if (isJson) {
      console.log(
        JSON.stringify({
          status: 'error',
          error: 'deploy_failed',
          message: safeOutput,
        })
      );
    } else {
      console.error(`Deploy failed:\n${safeOutput}`);
    }
  }
}

// ── Usage ────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`mors — markdown-first encrypted local CLI messaging

Usage:
  mors <command> [options]

Commands:
  init         Initialize identity and encrypted store
  login        Authenticate with mors-native auth
  logout       Clear local auth session
  status       Show current auth status
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
  --remote               Route command through relay (requires auth + MORS_RELAY_BASE_URL)
  --peer-device <id>     Peer device ID for E2EE key exchange session lookup
  --no-encrypt           Bypass E2EE encryption (send/read plaintext via relay)

Send options:
  --to <recipient>       Recipient identity (required; numeric GitHub user ID for --remote)
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
  --to <recipient>       Recipient identity (default: "local"; numeric GitHub user ID for --remote)
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
  mors login [--json]
  --json                 Output JSON

Logout:
  mors logout [--json]
  --json                 Output JSON

Status:
  mors status [--json] [--offline]
  --json                 Output JSON
  --offline              Skip token liveness check (report local session only)

Onboard:
  mors onboard --handle <handle> --display-name <name> [--json]
  --handle <handle>      Globally unique handle (3-32 chars, letters/numbers/hyphens/underscores)
  --display-name <name>  Your display name
  --json                 Output JSON

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
