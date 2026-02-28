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
import { MorsError, NotInitializedError, SqlCipherUnavailableError } from './errors.js';
import { ContractValidationError } from './contract/errors.js';
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

/** Commands that require initialization before use. */
const GATED_COMMANDS = new Set(['send', 'inbox', 'read', 'reply', 'ack', 'thread', 'watch']);

/** Commands that are implemented. */
const IMPLEMENTED_COMMANDS = new Set(['send', 'inbox', 'read', 'ack', 'reply', 'thread']);

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

// ── Inbox command ────────────────────────────────────────────────────

function runInbox(args: string[], configDir: string): void {
  const { flags } = parseArgs(args);
  const json = 'json' in flags;
  const recipient = typeof flags['to'] === 'string' ? flags['to'] : undefined;
  const unreadOnly = 'unread' in flags;

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

// ── Read command ─────────────────────────────────────────────────────

function runRead(args: string[], configDir: string): void {
  const { positional, flags } = parseArgs(args);
  const json = 'json' in flags;
  const messageId = positional[0];

  if (!messageId) {
    formatError('read requires a message ID argument', json);
    process.exitCode = 1;
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

// ── Ack command ──────────────────────────────────────────────────────

function runAck(args: string[], configDir: string): void {
  const { positional, flags } = parseArgs(args);
  const json = 'json' in flags;
  const messageId = positional[0];

  if (!messageId) {
    formatError('ack requires a message ID argument', json);
    process.exitCode = 1;
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

// ── Reply command ────────────────────────────────────────────────────

function runReply(args: string[], configDir: string): void {
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

// ── Usage ────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`mors — markdown-first encrypted local CLI messaging

Usage:
  mors <command> [options]

Commands:
  init       Initialize identity and encrypted store
  send       Send a message
  inbox      List messages
  read       Read a message
  reply      Reply to a message
  ack        Acknowledge a message
  thread     View thread messages in causal order
  watch      Watch for new messages

Options:
  -h, --help     Show this help
  -v, --version  Show version

Send options:
  --to <recipient>       Recipient identity (required)
  --body <message>       Message body (required)
  --from <sender>        Sender identity (default: "local")
  --subject <subject>    Message subject
  --dedupe-key <key>     Dedupe key for idempotent sends
  --trace-id <id>        Trace ID for observability
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
  --dedupe-key <key>     Dedupe key for idempotent replies
  --trace-id <id>        Trace ID for observability
  --json                 Output JSON

Thread:
  mors thread <thread-id> [--json]`);
}
