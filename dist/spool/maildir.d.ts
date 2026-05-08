import { type MaildirEntry, type MaildirZone, type SpoolMailbox, type SpoolMaterializedMessage } from './types.js';
import type { RelayMessageResponse } from '../relay/client.js';
export declare class MaildirSpoolError extends Error {
    constructor(message: string);
}
export declare class MaildirEntryError extends Error {
    constructor(message: string);
}
export interface MaildirSpoolOptions {
    root: string;
    agentId: string;
    maxEntryBytes?: number;
}
export interface WriteJsonOptions {
    name?: string;
}
export declare class MaildirSpool {
    readonly root: string;
    readonly agentId: string;
    readonly agentRoot: string;
    readonly maxEntryBytes: number;
    constructor(options: MaildirSpoolOptions);
    init(): void;
    mailboxDir(mailbox: SpoolMailbox, zone: MaildirZone): string;
    listNew(mailbox: SpoolMailbox): MaildirEntry[];
    readJson(entry: MaildirEntry): unknown;
    writeJson(mailbox: SpoolMailbox, value: unknown, options?: WriteJsonOptions): MaildirEntry;
    moveToCur(entry: MaildirEntry): MaildirEntry;
    moveToFailed(entry: MaildirEntry, reason: string): MaildirEntry;
    materializeInboxMessage(message: RelayMessageResponse): MaildirEntry | null;
    hasEntry(mailbox: SpoolMailbox, name: string): boolean;
}
export declare function assertMaildirName(name: string, label?: string): void;
export declare function relayMessageToSpoolMessage(message: RelayMessageResponse): SpoolMaterializedMessage;
//# sourceMappingURL=maildir.d.ts.map