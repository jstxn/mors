import type { MaildirSpool } from './maildir.js';
import type { SpoolBridgeResult } from './bridge.js';
export declare const SPOOL_BRIDGE_STATE_SCHEMA = "mors.spool.bridge-state.v1";
export interface SpoolBridgeState {
    schema: typeof SPOOL_BRIDGE_STATE_SCHEMA;
    agent_id: string;
    updated_at: string;
    consecutive_failures: number;
    last_result?: SpoolBridgeResult;
    last_error?: string;
    next_retry_at?: string;
    last_event_id?: string;
}
export declare class SpoolBridgeStateStore {
    readonly path: string;
    readonly agentId: string;
    constructor(options: {
        path: string;
        agentId: string;
    });
    load(): SpoolBridgeState | null;
    recordResult(result: SpoolBridgeResult, options?: {
        nextRetryAt?: string;
    }): void;
    recordError(err: unknown, options?: {
        nextRetryAt?: string;
    }): void;
    recordEventCursor(eventId: string): void;
    private save;
}
export declare function defaultSpoolBridgeStatePath(spool: MaildirSpool): string;
//# sourceMappingURL=state.d.ts.map