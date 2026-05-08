import { type MaildirEntry, type MaildirZone, type SpoolMailbox, type SpoolMaterializedMessage } from './types.js';
import type { RelayMessageResponse } from '../relay/client.js';
import type { SpoolQuotaPolicy } from './policy.js';
export declare class MaildirSpoolError extends Error {
    constructor(message: string);
}
export declare class MaildirEntryError extends Error {
    constructor(message: string);
}
export declare class MaildirQuotaError extends MaildirSpoolError {
    constructor(message: string);
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
export declare class MaildirSpool {
    readonly root: string;
    readonly agentId: string;
    readonly agentRoot: string;
    readonly maxEntryBytes: number;
    readonly quotas: SpoolQuotaPolicy;
    constructor(options: MaildirSpoolOptions);
    init(): void;
    mailboxDir(mailbox: SpoolMailbox, zone: MaildirZone): string;
    listNew(mailbox: SpoolMailbox): MaildirEntry[];
    listEntries(mailbox: SpoolMailbox, zone: MaildirZone): MaildirEntry[];
    readText(entry: MaildirEntry): string;
    readJson(entry: MaildirEntry): unknown;
    writeJson(mailbox: SpoolMailbox, value: unknown, options?: WriteJsonOptions): MaildirEntry;
    moveToCur(entry: MaildirEntry): MaildirEntry;
    moveToFailed(entry: MaildirEntry, reason: string): MaildirEntry;
    materializeInboxMessage(message: RelayMessageResponse): MaildirEntry | null;
    hasEntry(mailbox: SpoolMailbox, name: string): boolean;
    inspect(): MaildirSpoolStats;
    private summarizeEntries;
    private assertCanAddEntry;
}
export declare function assertMaildirName(name: string, label?: string): void;
export declare function relayMessageToSpoolMessage(message: RelayMessageResponse): SpoolMaterializedMessage;
//# sourceMappingURL=maildir.d.ts.map