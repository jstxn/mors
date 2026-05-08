import { type RelayMessageResponse } from '../relay/client.js';
import { MaildirSpool } from './maildir.js';
import { type MaildirEntry, type SpoolCommand, type SpoolRelayClient } from './types.js';
export declare class SpoolValidationError extends Error {
    constructor(message: string);
}
export interface SpoolBridgeResult {
    processed: number;
    sent: number;
    queued: number;
    read: number;
    acked: number;
    materialized: number;
    failed: number;
    deferred: number;
}
export interface SpoolBridgeOptions {
    spool: MaildirSpool;
    client: SpoolRelayClient;
    pollIntervalMs?: number;
    signal?: AbortSignal;
    logger?: (message: string) => void;
    onInboxMessage?: (message: RelayMessageResponse, entry: MaildirEntry) => void;
    watch?: {
        baseUrl: string;
        token: string;
    };
}
export interface SpoolBridgeHandle {
    stop(): void;
    done: Promise<void>;
}
export declare function processSpoolOnce(spool: MaildirSpool, client: SpoolRelayClient, options?: Pick<SpoolBridgeOptions, 'onInboxMessage'>): Promise<SpoolBridgeResult>;
export declare function reconcileInbox(spool: MaildirSpool, client: SpoolRelayClient, options?: Pick<SpoolBridgeOptions, 'onInboxMessage'>): Promise<number>;
export declare function runSpoolBridge(options: SpoolBridgeOptions): SpoolBridgeHandle;
export declare function parseSpoolCommand(value: unknown): SpoolCommand;
//# sourceMappingURL=bridge.d.ts.map