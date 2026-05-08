import type { SpoolCommand } from './types.js';
export declare const SPOOL_POLICY_SCHEMA = "mors.spool.policy.v1";
export interface SpoolQuotaPolicy {
    maxEntryBytes?: number;
    maxPendingEntries?: number;
    maxPendingBytes?: number;
    maxInboxEntries?: number;
    maxFailedEntries?: number;
}
export interface SpoolToolPolicy {
    allowRequests?: boolean;
    allowedNames?: string[];
    maxArgsBytes?: number;
    runners?: Record<string, SpoolToolRunnerPolicy>;
}
export interface SpoolToolRunnerPolicy {
    command: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
}
export interface SpoolPolicy {
    schema: typeof SPOOL_POLICY_SCHEMA;
    quotas: SpoolQuotaPolicy;
    tools: SpoolToolPolicy;
}
export declare class SpoolPolicyError extends Error {
    constructor(message: string);
}
export declare const DEFAULT_SPOOL_POLICY: SpoolPolicy;
export declare function loadSpoolPolicy(path: string): SpoolPolicy;
export declare function mergeSpoolPolicy(base?: SpoolPolicy, overrides?: Partial<SpoolPolicy>): SpoolPolicy;
export declare function normalizeSpoolPolicy(value: unknown): SpoolPolicy;
export declare function validateSpoolCommandPolicy(command: SpoolCommand, policy: SpoolPolicy): void;
//# sourceMappingURL=policy.d.ts.map