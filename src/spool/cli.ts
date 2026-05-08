import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { requireInit } from '../init.js';
import { requireAuth, NotAuthenticatedError } from '../auth/guards.js';
import { loadSession, loadSigningKey } from '../auth/session.js';
import { generateSessionToken } from '../auth/native.js';
import { MorsError } from '../errors.js';
import { RelayClient, RelayClientError } from '../relay/client.js';
import { RELAY_SCOPES, type RelayScope } from '../relay/auth-middleware.js';
import { resolveRelayBaseUrl } from '../settings.js';
import {
  MaildirSpool,
  MaildirQuotaError,
  MaildirSpoolError,
  assertMaildirName,
  type MaildirSpoolStats,
} from './maildir.js';
import { processSpoolOnce, runSpoolBridge } from './bridge.js';
import {
  DEFAULT_SPOOL_POLICY,
  SpoolPolicyError,
  loadSpoolPolicy,
  mergeSpoolPolicy,
  validateSpoolCommandPolicy,
  type SpoolPolicy,
  type SpoolQuotaPolicy,
} from './policy.js';
import {
  SpoolBridgeStateStore,
  defaultSpoolBridgeStatePath,
} from './state.js';
import { SPOOL_SCHEMA, type MaildirEntry, type MaildirZone, type SpoolCommand, type SpoolMailbox } from './types.js';

const MAILBOXES: SpoolMailbox[] = ['outbox', 'inbox', 'control', 'failed'];
const ZONES: MaildirZone[] = ['tmp', 'new', 'cur'];
const DEFAULT_DIRECT_RELAY_SCOPES: RelayScope[] = [
  'messages:read',
  'messages:write',
  'messages:state',
  'events:read',
];

class SpoolCliError extends MorsError {
  constructor(message: string) {
    super(message);
    this.name = 'SpoolCliError';
  }
}

interface RuntimeClientContext {
  client: RelayClient;
  baseUrl: string;
  token: string;
}

interface SpoolContext {
  spool: MaildirSpool;
  policy: SpoolPolicy;
  stateStore: SpoolBridgeStateStore;
}

export async function runSpoolCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);
  const { flags } = parseArgs(subArgs);
  const json = 'json' in flags;

  if (!subcommand || subcommand === '--help' || subcommand === '-h' || 'help' in flags) {
    printSpoolUsage();
    return;
  }

  try {
    if (subcommand === 'init') {
      runSpoolInit(flags, json);
      return;
    }

    if (subcommand === 'doctor') {
      runSpoolDoctor(flags, json);
      return;
    }

    if (subcommand === 'status') {
      runSpoolStatus(flags, json);
      return;
    }

    if (subcommand === 'write') {
      runSpoolWrite(flags, json);
      return;
    }

    if (subcommand === 'tail') {
      runSpoolTail(flags, json);
      return;
    }

    if (subcommand === 'wait') {
      await runSpoolWait(flags, json);
      return;
    }

    if (subcommand === 'export') {
      runSpoolExport(flags, json);
      return;
    }

    if (subcommand === 'bridge') {
      await runSpoolBridgeCommand(flags, json);
      return;
    }

    throw new SpoolCliError(`Unknown spool subcommand: ${subcommand}`);
  } catch (err: unknown) {
    process.exitCode = 1;
    formatSpoolError(err, json);
  }
}

export async function runSandboxCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);
  const { flags } = parseArgs(subArgs);
  const json = 'json' in flags;

  if (!subcommand || subcommand === '--help' || subcommand === '-h' || 'help' in flags) {
    printSandboxUsage();
    return;
  }

  try {
    if (subcommand === 'init') {
      runSpoolInit(flags, json, 'sandbox');
      return;
    }

    if (subcommand === 'doctor') {
      runSpoolDoctor(flags, json, 'sandbox');
      return;
    }

    if (subcommand === 'status') {
      runSpoolStatus(flags, json);
      return;
    }

    if (subcommand === 'token') {
      runSandboxToken(flags, json);
      return;
    }

    throw new SpoolCliError(`Unknown sandbox subcommand: ${subcommand}`);
  } catch (err: unknown) {
    process.exitCode = 1;
    formatSpoolError(err, json);
  }
}

function runSpoolInit(
  flags: Record<string, string | true>,
  json: boolean,
  mode: 'spool' | 'sandbox' = 'spool'
): void {
  const context = createSpoolContext(flags);
  context.spool.init();
  const stats = context.spool.inspect();
  if (json) {
    console.log(
      JSON.stringify({
        status: 'initialized',
        mode,
        root: context.spool.root,
        agent_id: context.spool.agentId,
        agent_root: context.spool.agentRoot,
        quotas: stats.quotas,
        state_path: context.stateStore.path,
      })
    );
  } else {
    console.log(`${mode === 'sandbox' ? 'Sandbox' : 'Spool'} initialized for ${context.spool.agentId}: ${context.spool.agentRoot}`);
    console.log(`Bridge state: ${context.stateStore.path}`);
  }
}

function runSpoolDoctor(
  flags: Record<string, string | true>,
  json: boolean,
  mode: 'spool' | 'sandbox' = 'spool'
): void {
  const context = createSpoolContext(flags);
  const checks = runDoctorChecks(context);
  const ok = checks.every((check) => check.status === 'pass' || check.status === 'warn');
  if (!ok) process.exitCode = 1;

  if (json) {
    console.log(
      JSON.stringify({
        status: ok ? 'ok' : 'error',
        mode,
        root: context.spool.root,
        agent_id: context.spool.agentId,
        checks,
        stats: context.spool.inspect(),
        state: context.stateStore.load(),
      })
    );
  } else {
    for (const check of checks) {
      console.log(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
    }
  }
}

function runSpoolStatus(flags: Record<string, string | true>, json: boolean): void {
  const context = createSpoolContext(flags);
  const stats = context.spool.inspect();
  const quota = evaluateQuotaStatus(stats);
  const state = context.stateStore.load();

  if (json) {
    console.log(
      JSON.stringify({
        status: quota.ok ? 'ok' : 'quota_exceeded',
        root: context.spool.root,
        agent_id: context.spool.agentId,
        stats,
        quota,
        state,
      })
    );
  } else {
    console.log(`Agent: ${context.spool.agentId}`);
    console.log(`Pending: ${stats.pending_entries} entries / ${stats.pending_bytes} bytes`);
    console.log(`Inbox: ${stats.inbox_entries} entries`);
    console.log(`Failed: ${stats.failed_entries} entries`);
    if (state?.last_error) console.log(`Last error: ${state.last_error}`);
    for (const violation of quota.violations) console.log(`Quota: ${violation}`);
  }
}

function runSpoolWrite(flags: Record<string, string | true>, json: boolean): void {
  const context = createSpoolContext(flags);
  const kind = readOptionalFlag(flags, 'kind') ?? 'message';
  const command = buildSpoolWriteCommand(kind, flags);
  validateSpoolCommandPolicy(command, context.policy);
  const mailbox: SpoolMailbox = command.kind === 'read' || command.kind === 'ack' ? 'control' : 'outbox';
  const entry = context.spool.writeJson(mailbox, command);

  if (json) {
    console.log(
      JSON.stringify({
        status: 'written',
        root: context.spool.root,
        agent_id: context.spool.agentId,
        mailbox,
        zone: entry.zone,
        name: entry.name,
        path: entry.path,
      })
    );
  } else {
    console.log(`Wrote ${command.kind} to ${entry.path}`);
  }
}

function runSpoolTail(flags: Record<string, string | true>, json: boolean): void {
  const context = createSpoolContext(flags);
  const mailbox = parseMailbox(readOptionalFlag(flags, 'mailbox') ?? 'inbox');
  const zone = parseZone(readOptionalFlag(flags, 'zone') ?? 'new');
  const limit = parsePositiveInteger(flags['limit'], 'limit') ?? 20;
  const entries = readSpoolEntries(context.spool, mailbox, zone).slice(0, limit);

  if (json) {
    console.log(
      JSON.stringify({
        status: 'ok',
        root: context.spool.root,
        agent_id: context.spool.agentId,
        mailbox,
        zone,
        count: entries.length,
        entries,
      })
    );
  } else {
    for (const entry of entries) {
      console.log(`${entry.mailbox}/${entry.zone}/${entry.name}`);
    }
  }
}

async function runSpoolWait(flags: Record<string, string | true>, json: boolean): Promise<void> {
  const context = createSpoolContext(flags);
  const timeoutMs = parsePositiveInteger(flags['timeout-ms'], 'timeout-ms') ?? 30000;
  const pollMs = parsePositiveInteger(flags['poll-interval'], 'poll-interval') ?? 500;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const entries = readSpoolEntries(context.spool, 'inbox', 'new');
    if (entries.length > 0) {
      if (json) {
        console.log(
          JSON.stringify({
            status: 'ok',
            root: context.spool.root,
            agent_id: context.spool.agentId,
            count: entries.length,
            entries,
          })
        );
      } else {
        for (const entry of entries) console.log(`inbox/new/${entry.name}`);
      }
      return;
    }
    await sleep(pollMs);
  }

  process.exitCode = 1;
  if (json) {
    console.log(
      JSON.stringify({
        status: 'timeout',
        error: 'spool_wait_timeout',
        message: `No inbox entries arrived within ${timeoutMs} ms.`,
      })
    );
  } else {
    console.error(`No inbox entries arrived within ${timeoutMs} ms.`);
  }
}

function runSpoolExport(flags: Record<string, string | true>, json: boolean): void {
  const context = createSpoolContext(flags);
  const entries = MAILBOXES.flatMap((mailbox) =>
    (['new', 'cur'] as MaildirZone[]).flatMap((zone) => readSpoolEntries(context.spool, mailbox, zone))
  );
  const payload = {
    status: 'exported',
    root: context.spool.root,
    agent_id: context.spool.agentId,
    exported_at: new Date().toISOString(),
    count: entries.length,
    entries,
  };

  if (json || !('output' in flags)) {
    console.log(JSON.stringify(payload, null, json ? 0 : 2));
    return;
  }

  const output = readRequiredFlag(flags, 'output');
  writeFileSync(output, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  console.log(`Exported ${entries.length} entries to ${output}`);
}

async function runSpoolBridgeCommand(
  flags: Record<string, string | true>,
  json: boolean
): Promise<void> {
  const context = createSpoolContext(flags);
  const runtime = createRuntimeClient();
  const once = 'once' in flags;

  if (once) {
    const result = await processSpoolOnce(context.spool, runtime.client, {
      policy: context.policy,
      stateStore: context.stateStore,
    });
    if (json) {
      console.log(JSON.stringify({ status: 'processed', ...result, state_path: context.stateStore.path }));
    } else {
      printBridgeResult(resultSummary(result));
    }
    return;
  }

  const pollIntervalMs = parsePollInterval(flags['poll-interval']);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());

  const handle = runSpoolBridge({
    spool: context.spool,
    client: runtime.client,
    policy: context.policy,
    stateStore: context.stateStore,
    pollIntervalMs,
    signal: controller.signal,
    logger: (message) => {
      if (!json) console.error(message);
    },
    watch: {
      baseUrl: runtime.baseUrl,
      token: runtime.token,
    },
  });

  if (!json) {
    console.log(`Spool bridge running for ${context.spool.agentId}. Press Ctrl+C to stop.`);
    console.log(`State: ${context.stateStore.path}`);
  }
  await handle.done;
  if (json) {
    console.log(JSON.stringify({ status: 'stopped', agent_id: context.spool.agentId }));
  }
}

function runSandboxToken(flags: Record<string, string | true>, json: boolean): void {
  const agentId = readRequiredFlag(flags, 'agent');
  assertMaildirName(agentId, 'sandbox agent ID');
  const configDir = requireInit();
  requireAuth(configDir);
  const session = loadSession(configDir);
  if (!session) throw new NotAuthenticatedError();
  const signingKey = loadSigningKey(configDir);
  if (!signingKey) {
    throw new SpoolCliError(
      'No local signing key is available. Run "mors login" with the relay signing key configured before issuing scoped sandbox tokens.'
    );
  }

  const scopes = parseScopes(readOptionalFlag(flags, 'scopes'));
  const deviceId = `sandbox-${agentId}`;
  const accessToken = generateSessionToken({
    accountId: session.accountId,
    deviceId,
    signingKey,
    scopes,
  });

  if (json) {
    console.log(
      JSON.stringify({
        status: 'token_issued',
        token_type: 'bearer',
        access_token: accessToken,
        account_id: session.accountId,
        device_id: deviceId,
        scopes,
      })
    );
  } else {
    console.log(accessToken);
  }
}

function createSpoolContext(flags: Record<string, string | true>): SpoolContext {
  const root = readRequiredFlag(flags, 'root');
  const agentId = readRequiredFlag(flags, 'agent');
  const policy = readPolicyFromFlags(flags);
  const spool = new MaildirSpool({ root, agentId, quotas: policy.quotas });
  const statePath = readOptionalFlag(flags, 'state') ?? defaultSpoolBridgeStatePath(spool);
  return {
    spool,
    policy,
    stateStore: new SpoolBridgeStateStore({ path: statePath, agentId }),
  };
}

function readPolicyFromFlags(flags: Record<string, string | true>): SpoolPolicy {
  const policyPath = readOptionalFlag(flags, 'policy');
  const basePolicy = policyPath ? loadSpoolPolicy(policyPath) : DEFAULT_SPOOL_POLICY;
  const quotaOverrides = readQuotaOverrides(flags);
  return mergeSpoolPolicy(basePolicy, { quotas: quotaOverrides });
}

function readQuotaOverrides(flags: Record<string, string | true>): SpoolQuotaPolicy {
  return {
    maxEntryBytes: parsePositiveInteger(flags['max-entry-bytes'], 'max-entry-bytes'),
    maxPendingEntries: parsePositiveInteger(flags['max-pending-entries'], 'max-pending-entries'),
    maxPendingBytes: parsePositiveInteger(flags['max-pending-bytes'], 'max-pending-bytes'),
    maxInboxEntries: parsePositiveInteger(flags['max-inbox-entries'], 'max-inbox-entries'),
    maxFailedEntries: parsePositiveInteger(flags['max-failed-entries'], 'max-failed-entries'),
  };
}

function createRuntimeClient(): RuntimeClientContext {
  const configDir = requireInit();
  requireAuth(configDir);

  const session = loadSession(configDir);
  if (!session) {
    throw new NotAuthenticatedError();
  }

  const baseUrl = resolveRelayBaseUrl(configDir);
  if (!baseUrl) {
    throw new SpoolCliError(
      'Remote relay is not configured. Run "mors start" or set MORS_RELAY_BASE_URL.'
    );
  }

  return {
    client: new RelayClient({
      baseUrl,
      token: session.accessToken,
      queueStorePath: `${configDir}/offline-queue.json`,
    }),
    baseUrl,
    token: session.accessToken,
  };
}

function buildSpoolWriteCommand(kind: string, flags: Record<string, string | true>): SpoolCommand {
  if (kind === 'read' || kind === 'ack') {
    return {
      schema: SPOOL_SCHEMA,
      kind,
      message_id: readRequiredFlag(flags, 'message-id'),
      dedupe_key: readOptionalFlag(flags, 'dedupe-key'),
    };
  }

  if (kind !== 'message' && kind !== 'tool_request' && kind !== 'tool_result') {
    throw new SpoolCliError(`Unsupported spool write kind: ${kind}`);
  }

  const sendKind = kind as 'message' | 'tool_request' | 'tool_result';
  const body = readRequiredFlag(flags, 'body');
  const toolName = readOptionalFlag(flags, 'tool');
  return {
    schema: SPOOL_SCHEMA,
    kind: sendKind,
    recipient_id: readRequiredFlag(flags, 'to'),
    body: {
      format: readOptionalFlag(flags, 'format') ?? 'text/markdown',
      content: body,
    },
    subject: readOptionalFlag(flags, 'subject'),
    in_reply_to: readOptionalFlag(flags, 'in-reply-to') ?? null,
    dedupe_key: readOptionalFlag(flags, 'dedupe-key'),
    trace_id: readOptionalFlag(flags, 'trace-id'),
    tool: toolName
      ? {
          name: toolName,
          args: parseArgsJson(readOptionalFlag(flags, 'args-json')),
        }
      : undefined,
  };
}

function runDoctorChecks(context: SpoolContext): Array<{
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}> {
  const checks: Array<{ name: string; status: 'pass' | 'warn' | 'fail'; message: string }> = [];
  const stats = context.spool.inspect();
  checks.push({
    name: 'agent_root',
    status: stats.exists ? 'pass' : 'fail',
    message: stats.exists
      ? `Agent root exists at ${context.spool.agentRoot}.`
      : 'Agent root is missing. Run "mors sandbox init --root <path> --agent <id>".',
  });

  for (const mailbox of MAILBOXES) {
    for (const zone of ZONES) {
      const path = context.spool.mailboxDir(mailbox, zone);
      checks.push({
        name: `${mailbox}_${zone}`,
        status: existsSync(path) ? 'pass' : 'fail',
        message: existsSync(path) ? `${path} exists.` : `${path} is missing.`,
      });
    }
  }

  const quota = evaluateQuotaStatus(stats);
  checks.push({
    name: 'quotas',
    status: quota.ok ? 'pass' : 'fail',
    message: quota.ok ? 'Spool is within configured quotas.' : quota.violations.join('; '),
  });

  checks.push(runWriteProbe(context));
  return checks;
}

function runWriteProbe(context: SpoolContext): {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
} {
  const tmpDir = context.spool.mailboxDir('control', 'tmp');
  const newDir = context.spool.mailboxDir('control', 'new');
  if (!existsSync(tmpDir) || !existsSync(newDir)) {
    return {
      name: 'write_probe',
      status: 'fail',
      message: 'Cannot run write probe because control tmp/new directories are missing.',
    };
  }

  const name = `probe-${process.pid}-${randomUUID()}.json`;
  const tmpPath = join(tmpDir, name);
  const newPath = join(newDir, name);
  try {
    writeFileSync(tmpPath, JSON.stringify({ schema: SPOOL_SCHEMA, kind: 'probe' }) + '\n', {
      mode: 0o600,
    });
    renameSync(tmpPath, newPath);
    readFileSync(newPath, 'utf8');
    unlinkSync(newPath);
    return { name: 'write_probe', status: 'pass', message: 'Host can write and read probe files.' };
  } catch (err: unknown) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
      if (existsSync(newPath)) unlinkSync(newPath);
    } catch {
      // Best effort cleanup after probe failure.
    }
    return {
      name: 'write_probe',
      status: 'fail',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function evaluateQuotaStatus(stats: MaildirSpoolStats): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  if (
    stats.quotas.maxPendingEntries !== undefined &&
    stats.pending_entries > stats.quotas.maxPendingEntries
  ) {
    violations.push(`pending entries ${stats.pending_entries} > ${stats.quotas.maxPendingEntries}`);
  }
  if (stats.quotas.maxPendingBytes !== undefined && stats.pending_bytes > stats.quotas.maxPendingBytes) {
    violations.push(`pending bytes ${stats.pending_bytes} > ${stats.quotas.maxPendingBytes}`);
  }
  if (stats.quotas.maxInboxEntries !== undefined && stats.inbox_entries > stats.quotas.maxInboxEntries) {
    violations.push(`inbox entries ${stats.inbox_entries} > ${stats.quotas.maxInboxEntries}`);
  }
  if (stats.quotas.maxFailedEntries !== undefined && stats.failed_entries > stats.quotas.maxFailedEntries) {
    violations.push(`failed entries ${stats.failed_entries} > ${stats.quotas.maxFailedEntries}`);
  }
  return { ok: violations.length === 0, violations };
}

function readSpoolEntries(spool: MaildirSpool, mailbox: SpoolMailbox, zone: MaildirZone): Array<{
  mailbox: SpoolMailbox;
  zone: MaildirZone;
  name: string;
  path: string;
  body?: unknown;
  error?: string;
}> {
  return spool.listEntries(mailbox, zone).map((entry) => readSpoolEntry(spool, entry));
}

function readSpoolEntry(spool: MaildirSpool, entry: MaildirEntry): {
  mailbox: SpoolMailbox;
  zone: MaildirZone;
  name: string;
  path: string;
  body?: unknown;
  error?: string;
} {
  try {
    return { ...entry, body: spool.readJson(entry) };
  } catch (err: unknown) {
    return { ...entry, error: err instanceof Error ? err.message : String(err) };
  }
}

function resultSummary(result: {
  processed: number;
  sent: number;
  queued: number;
  read: number;
  acked: number;
  materialized: number;
  failed: number;
  deferred: number;
  policy_rejected: number;
  quota_rejected: number;
}): string {
  return `Processed ${result.processed} spool ${result.processed === 1 ? 'entry' : 'entries'}; sent=${result.sent}, queued=${result.queued}, read=${result.read}, acked=${result.acked}, materialized=${result.materialized}, failed=${result.failed}, deferred=${result.deferred}, policy_rejected=${result.policy_rejected}, quota_rejected=${result.quota_rejected}`;
}

function printBridgeResult(summary: string): void {
  console.log(summary);
}

function parseArgsJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('args JSON must be an object.');
    }
    return parsed as Record<string, unknown>;
  } catch (err: unknown) {
    throw new SpoolCliError(`Invalid --args-json: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseMailbox(value: string): SpoolMailbox {
  if (!MAILBOXES.includes(value as SpoolMailbox)) {
    throw new SpoolCliError(`--mailbox must be one of: ${MAILBOXES.join(', ')}`);
  }
  return value as SpoolMailbox;
}

function parseZone(value: string): MaildirZone {
  if (!ZONES.includes(value as MaildirZone)) {
    throw new SpoolCliError(`--zone must be one of: ${ZONES.join(', ')}`);
  }
  return value as MaildirZone;
}

function parseScopes(raw: string | undefined): RelayScope[] {
  if (!raw) return DEFAULT_DIRECT_RELAY_SCOPES;
  const scopes = raw
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (scopes.length === 0) {
      throw new SpoolCliError('--scopes must include at least one comma-separated scope.');
  }
  const invalid = scopes.filter((scope) => !isRelayScope(scope));
  if (invalid.length > 0) {
    throw new SpoolCliError(
      `Unsupported relay scope(s): ${invalid.join(', ')}. Allowed scopes: ${RELAY_SCOPES.join(', ')}.`
    );
  }
  return scopes as RelayScope[];
}

function readRequiredFlag(flags: Record<string, string | true>, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SpoolCliError(`spool requires --${name} <value>.`);
  }
  return value;
}

function readOptionalFlag(flags: Record<string, string | true>, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SpoolCliError(`--${name} must have a non-empty value.`);
  }
  return value;
}

function parsePositiveInteger(value: string | true | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (value === true) throw new SpoolCliError(`--${name} requires a value.`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SpoolCliError(`--${name} must be a positive integer.`);
  }
  return parsed;
}

function parsePollInterval(value: string | true | undefined): number {
  if (value === undefined || value === true) return 1000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 100) {
    throw new SpoolCliError('--poll-interval must be an integer >= 100.');
  }
  return parsed;
}

function formatSpoolError(err: unknown, json: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  let error = 'spool_error';
  if (err instanceof NotAuthenticatedError) error = 'not_authenticated';
  if (err instanceof RelayClientError) error = 'relay_error';
  if (err instanceof SpoolCliError) error = 'validation_error';
  if (err instanceof SpoolPolicyError) error = 'policy_error';
  if (err instanceof MaildirSpoolError) error = 'validation_error';
  if (err instanceof MaildirQuotaError) error = 'quota_error';

  if (json) {
    console.log(JSON.stringify({ status: 'error', error, message }));
  } else {
    console.error(`Error: ${message}`);
  }
}

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      if (eqIndex >= 0) {
        flags[arg.slice(2, eqIndex)] = arg.slice(eqIndex + 1);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRelayScope(scope: string): scope is RelayScope {
  return (RELAY_SCOPES as readonly string[]).includes(scope);
}

function printSpoolUsage(): void {
  console.log(`mors spool - Maildir-style agent communication spool

Usage:
  mors spool init --root <path> --agent <agent-id> [--policy <file>] [--json]
  mors spool doctor --root <path> --agent <agent-id> [--policy <file>] [--json]
  mors spool status --root <path> --agent <agent-id> [--json]
  mors spool write --root <path> --agent <agent-id> --kind <kind> [options] [--json]
  mors spool tail --root <path> --agent <agent-id> [--mailbox inbox] [--zone new] [--json]
  mors spool wait --root <path> --agent <agent-id> [--timeout-ms 30000] [--json]
  mors spool export --root <path> --agent <agent-id> [--output <file>] [--json]
  mors spool bridge --root <path> --agent <agent-id> [--once] [--policy <file>] [--json]

Commands:
  init     Create per-agent outbox, inbox, control, failed folders
  doctor   Verify layout, quotas, and write/read probe behavior
  status   Show queue depth, quota state, and bridge state
  write    Atomically write message, tool_request, tool_result, read, or ack commands
  tail     Read recent spool entries without mutating them
  wait     Block until inbox/new has entries or timeout expires
  export   Export a local transcript for debugging or replay review
  bridge   Drain outbound entries, reconcile inbound relay messages, and run continuously

Common options:
  --root <path>                  Spool root directory
  --agent <agent-id>             Local agent spool identity
  --policy <file>                Host policy JSON (${SPOOL_SCHEMA} commands, mors.spool.policy.v1 policy)
  --state <file>                 Bridge state file path (default: agent bridge-state.json)
  --max-entry-bytes <n>          Per-entry byte limit
  --max-pending-entries <n>      Pending outbox/control entry limit
  --max-pending-bytes <n>        Pending outbox/control byte limit
  --json                         Output JSON`);
}

function printSandboxUsage(): void {
  console.log(`mors sandbox - VM and sandbox agent helper commands

Usage:
  mors sandbox init --root <path> --agent <agent-id> [--json]
  mors sandbox doctor --root <path> --agent <agent-id> [--json]
  mors sandbox status --root <path> --agent <agent-id> [--json]
  mors sandbox token --agent <agent-id> [--scopes messages:read,messages:write] [--json]

Commands:
  init     Create the shared folder contract for a sandboxed agent
  doctor   Verify mount/layout/quotas before starting a VM agent
  status   Show queue depth, quotas, and bridge state
  token    Issue a scoped direct relay token for trusted VM agents only`);
}
