import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SPOOL_SCHEMA,
  type MaildirEntry,
  type MaildirZone,
  type SpoolMailbox,
  type SpoolMaterializedMessage,
} from './types.js';
import type { RelayMessageResponse } from '../relay/client.js';
import type { SpoolQuotaPolicy } from './policy.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAILDIR_ZONES: MaildirZone[] = ['tmp', 'new', 'cur'];
const MAILBOXES: SpoolMailbox[] = ['outbox', 'inbox', 'control', 'failed'];

export class MaildirSpoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaildirSpoolError';
  }
}

export class MaildirEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaildirEntryError';
  }
}

export class MaildirQuotaError extends MaildirSpoolError {
  constructor(message: string) {
    super(message);
    this.name = 'MaildirQuotaError';
  }
}

export interface MaildirSpoolOptions {
  root: string;
  agentId: string;
  maxEntryBytes?: number;
  quotas?: SpoolQuotaPolicy;
}

export interface WriteJsonOptions {
  name?: string;
}

export interface MaildirEntrySummary {
  mailbox: SpoolMailbox;
  zone: MaildirZone;
  name: string;
  path: string;
  bytes: number;
  isFile: boolean;
  modifiedAt: string;
}

export interface MaildirMailboxStats {
  entries: number;
  bytes: number;
  newEntries: number;
  newBytes: number;
  curEntries: number;
  failedEntries?: number;
}

export interface MaildirSpoolStats {
  root: string;
  agent_id: string;
  agent_root: string;
  exists: boolean;
  total_entries: number;
  total_bytes: number;
  pending_entries: number;
  pending_bytes: number;
  inbox_entries: number;
  failed_entries: number;
  oldest_pending_at: string | null;
  mailboxes: Record<SpoolMailbox, MaildirMailboxStats>;
  quotas: SpoolQuotaPolicy;
}

export class MaildirSpool {
  readonly root: string;
  readonly agentId: string;
  readonly agentRoot: string;
  readonly maxEntryBytes: number;
  readonly quotas: SpoolQuotaPolicy;

  constructor(options: MaildirSpoolOptions) {
    if (!options.root.trim()) {
      throw new MaildirSpoolError('Spool root is required.');
    }
    if (!options.agentId.trim()) {
      throw new MaildirSpoolError('Spool agent ID is required.');
    }
    assertMaildirName(options.agentId, 'spool agent ID');

    this.root = options.root;
    this.agentId = options.agentId;
    this.agentRoot = join(options.root, 'agents', options.agentId);
    this.quotas = {
      ...(options.quotas ?? {}),
      ...(options.maxEntryBytes ? { maxEntryBytes: options.maxEntryBytes } : {}),
    };
    this.maxEntryBytes = this.quotas.maxEntryBytes ?? 1024 * 1024;
  }

  init(): void {
    mkdirOwnerOnly(this.root);
    mkdirOwnerOnly(join(this.root, 'agents'));
    mkdirOwnerOnly(this.agentRoot);

    for (const mailbox of MAILBOXES) {
      for (const zone of MAILDIR_ZONES) {
        mkdirOwnerOnly(this.mailboxDir(mailbox, zone));
      }
    }
  }

  mailboxDir(mailbox: SpoolMailbox, zone: MaildirZone): string {
    return join(this.agentRoot, mailbox, zone);
  }

  listNew(mailbox: SpoolMailbox): MaildirEntry[] {
    return this.listEntries(mailbox, 'new');
  }

  listEntries(mailbox: SpoolMailbox, zone: MaildirZone): MaildirEntry[] {
    const targetDir = this.mailboxDir(mailbox, zone);
    if (!existsSync(targetDir)) return [];

    return readdirSync(targetDir)
      .sort()
      .map((name) => {
        assertMaildirName(name);
        return { mailbox, zone, name, path: join(targetDir, name) };
      });
  }

  readText(entry: MaildirEntry): string {
    const stat = lstatSync(entry.path);
    if (!stat.isFile()) {
      throw new MaildirEntryError(`Spool entry is not a regular file: ${entry.name}`);
    }
    if (stat.size > this.maxEntryBytes) {
      throw new MaildirEntryError(
        `Spool entry exceeds max size (${this.maxEntryBytes} bytes): ${entry.name}`
      );
    }
    return readFileSync(entry.path, 'utf8');
  }

  readJson(entry: MaildirEntry): unknown {
    const raw = this.readText(entry);
    try {
      return JSON.parse(raw);
    } catch {
      throw new MaildirEntryError(`Spool entry is not valid JSON: ${entry.name}`);
    }
  }

  writeJson(mailbox: SpoolMailbox, value: unknown, options: WriteJsonOptions = {}): MaildirEntry {
    this.init();
    const name = options.name ?? `${Date.now()}.${process.pid}.${randomUUID()}.json`;
    assertMaildirName(name);

    const tmpPath = join(this.mailboxDir(mailbox, 'tmp'), name);
    const newPath = join(this.mailboxDir(mailbox, 'new'), name);
    const data = JSON.stringify(value, null, 2) + '\n';
    this.assertCanAddEntry(mailbox, Buffer.byteLength(data, 'utf8'));

    const fd = openSync(tmpPath, 'wx', FILE_MODE);
    try {
      writeFileSync(fd, data, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmpPath, FILE_MODE);
    renameSync(tmpPath, newPath);

    return { mailbox, zone: 'new', name, path: newPath };
  }

  moveToCur(entry: MaildirEntry): MaildirEntry {
    const curPath = join(this.mailboxDir(entry.mailbox, 'cur'), entry.name);
    renameSync(entry.path, curPath);
    return { ...entry, zone: 'cur', path: curPath };
  }

  moveToFailed(entry: MaildirEntry, reason: string): MaildirEntry {
    this.assertCanAddEntry('failed', 0);
    const failedName = `${entry.mailbox}-${entry.name}`;
    assertMaildirName(failedName);

    const failedPath = join(this.mailboxDir('failed', 'new'), failedName);
    const errorPath = `${failedPath}.error.json`;
    renameSync(entry.path, failedPath);
    writeFileSync(
      errorPath,
      JSON.stringify(
        {
          schema: SPOOL_SCHEMA,
          kind: 'spool_error',
          source_mailbox: entry.mailbox,
          source_name: entry.name,
          error: reason,
        },
        null,
        2
      ) + '\n',
      { mode: FILE_MODE }
    );
    chmodSync(errorPath, FILE_MODE);
    return { mailbox: 'failed', zone: 'new', name: failedName, path: failedPath };
  }

  materializeInboxMessage(message: RelayMessageResponse): MaildirEntry | null {
    const name = `${message.id}.json`;
    assertMaildirName(name);
    if (this.hasEntry('inbox', name)) {
      return null;
    }

    const materialized: SpoolMaterializedMessage = {
      schema: SPOOL_SCHEMA,
      kind: 'relay_message',
      ...message,
    };
    return this.writeJson('inbox', materialized, { name });
  }

  hasEntry(mailbox: SpoolMailbox, name: string): boolean {
    assertMaildirName(name);
    return (
      existsSync(join(this.mailboxDir(mailbox, 'new'), name)) ||
      existsSync(join(this.mailboxDir(mailbox, 'cur'), name))
    );
  }

  inspect(): MaildirSpoolStats {
    const mailboxStats = emptyMailboxStats();
    const summaries: MaildirEntrySummary[] = [];

    if (existsSync(this.agentRoot)) {
      for (const mailbox of MAILBOXES) {
        for (const zone of MAILDIR_ZONES) {
          summaries.push(...this.summarizeEntries(mailbox, zone));
        }
      }
    }

    let oldestPendingAt: string | null = null;
    for (const summary of summaries) {
      const stats = mailboxStats[summary.mailbox];
      stats.entries++;
      stats.bytes += summary.bytes;
      if (summary.zone === 'new') {
        stats.newEntries++;
        stats.newBytes += summary.bytes;
      }
      if (summary.zone === 'cur') {
        stats.curEntries++;
      }
      if (summary.mailbox === 'failed' && !isFailedErrorMetadata(summary.name)) {
        stats.failedEntries = (stats.failedEntries ?? 0) + 1;
      }
      if (
        (summary.mailbox === 'outbox' || summary.mailbox === 'control') &&
        summary.zone === 'new' &&
        (oldestPendingAt === null || summary.modifiedAt < oldestPendingAt)
      ) {
        oldestPendingAt = summary.modifiedAt;
      }
    }

    const pendingEntries = mailboxStats.outbox.newEntries + mailboxStats.control.newEntries;
    const pendingBytes = mailboxStats.outbox.newBytes + mailboxStats.control.newBytes;

    return {
      root: this.root,
      agent_id: this.agentId,
      agent_root: this.agentRoot,
      exists: existsSync(this.agentRoot),
      total_entries: summaries.length,
      total_bytes: summaries.reduce((sum, entry) => sum + entry.bytes, 0),
      pending_entries: pendingEntries,
      pending_bytes: pendingBytes,
      inbox_entries: mailboxStats.inbox.entries,
      failed_entries: mailboxStats.failed.failedEntries ?? 0,
      oldest_pending_at: oldestPendingAt,
      mailboxes: mailboxStats,
      quotas: this.quotas,
    };
  }

  private summarizeEntries(mailbox: SpoolMailbox, zone: MaildirZone): MaildirEntrySummary[] {
    const dir = this.mailboxDir(mailbox, zone);
    if (!existsSync(dir)) return [];

    return readdirSync(dir)
      .sort()
      .map((name) => {
        assertMaildirName(name);
        const path = join(dir, name);
        const stat = lstatSync(path);
        return {
          mailbox,
          zone,
          name,
          path,
          bytes: stat.size,
          isFile: stat.isFile(),
          modifiedAt: stat.mtime.toISOString(),
        };
      });
  }

  private assertCanAddEntry(mailbox: SpoolMailbox, bytes: number): void {
    if (bytes > this.maxEntryBytes) {
      throw new MaildirQuotaError(
        `Spool entry exceeds max size (${this.maxEntryBytes} bytes): ${bytes} bytes.`
      );
    }

    const stats = this.inspect();
    if (
      (mailbox === 'outbox' || mailbox === 'control') &&
      this.quotas.maxPendingEntries !== undefined &&
      stats.pending_entries + 1 > this.quotas.maxPendingEntries
    ) {
      throw new MaildirQuotaError(
        `Spool pending entry quota exceeded (${this.quotas.maxPendingEntries}).`
      );
    }

    if (
      (mailbox === 'outbox' || mailbox === 'control') &&
      this.quotas.maxPendingBytes !== undefined &&
      stats.pending_bytes + bytes > this.quotas.maxPendingBytes
    ) {
      throw new MaildirQuotaError(
        `Spool pending byte quota exceeded (${this.quotas.maxPendingBytes} bytes).`
      );
    }

    if (
      mailbox === 'inbox' &&
      this.quotas.maxInboxEntries !== undefined &&
      stats.inbox_entries + 1 > this.quotas.maxInboxEntries
    ) {
      throw new MaildirQuotaError(
        `Spool inbox entry quota exceeded (${this.quotas.maxInboxEntries}).`
      );
    }

    if (
      mailbox === 'failed' &&
      this.quotas.maxFailedEntries !== undefined &&
      stats.failed_entries + 1 > this.quotas.maxFailedEntries
    ) {
      throw new MaildirQuotaError(
        `Spool failed entry quota exceeded (${this.quotas.maxFailedEntries}).`
      );
    }
  }
}

export function assertMaildirName(name: string, label = 'Maildir entry name'): void {
  if (!name || name === '.' || name === '..' || basename(name) !== name || name.includes('\0')) {
    throw new MaildirSpoolError(`Invalid ${label}: ${JSON.stringify(name)}`);
  }
}

export function relayMessageToSpoolMessage(
  message: RelayMessageResponse
): SpoolMaterializedMessage {
  return {
    schema: SPOOL_SCHEMA,
    kind: 'relay_message',
    ...message,
  };
}

function mkdirOwnerOnly(path: string): void {
  const existed = existsSync(path);
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    throw new MaildirSpoolError(`Spool path is not a directory: ${path}`);
  }
  if (!existed) {
    chmodSync(path, DIR_MODE);
  }
}

function emptyMailboxStats(): Record<SpoolMailbox, MaildirMailboxStats> {
  return {
    outbox: { entries: 0, bytes: 0, newEntries: 0, newBytes: 0, curEntries: 0 },
    inbox: { entries: 0, bytes: 0, newEntries: 0, newBytes: 0, curEntries: 0 },
    control: { entries: 0, bytes: 0, newEntries: 0, newBytes: 0, curEntries: 0 },
    failed: {
      entries: 0,
      bytes: 0,
      newEntries: 0,
      newBytes: 0,
      curEntries: 0,
      failedEntries: 0,
    },
  };
}

function isFailedErrorMetadata(name: string): boolean {
  return name.endsWith('.error.json');
}
