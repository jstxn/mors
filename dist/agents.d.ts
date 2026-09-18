import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import { type InboxEntry } from './message.js';
type Database = BetterSqlite3.Database;
export type AgentRuntime = 'codex' | 'claude' | 'other';
export interface Agent {
    id: string;
    name: string;
    runtime: AgentRuntime;
    session_id: string;
    project: string;
    role: string;
    last_seen: string;
    stopped_at: string | null;
}
export interface RegisterAgentOptions {
    runtime: AgentRuntime;
    sessionId: string;
    name?: string;
    role?: string;
    project?: string;
}
export interface AgentMessageOptions {
    body: string;
    subject?: string;
    dedupeKey?: string;
    traceId?: string;
}
type ActivityMessage = Pick<InboxEntry, 'sender' | 'recipient' | 'subject'>;
export declare function formatAgentActivity(senderName: string, recipientName: string, subject?: string | null): string;
export declare function agentActivity(db: Database, message: ActivityMessage): string;
export declare function getAgentConfigDir(): string;
export declare function openAgentStore(configDir?: string): Promise<Database>;
export declare function registerAgent(db: Database, options: RegisterAgentOptions): Agent;
export declare function getAgent(db: Database, reference: string): Agent;
export declare function findSessionAgent(db: Database, runtime: string, sessionId: string): Agent;
export declare function listAgents(db: Database, options?: {
    all?: boolean;
    project?: string;
    maxAgeMs?: number;
}): Array<Agent & {
    status: string;
}>;
export declare function heartbeatAgent(db: Database, id: string): void;
export declare function stopAgent(db: Database, id: string): void;
export declare function sendAgentMessage(db: Database, agentId: string, options: AgentMessageOptions & {
    to: string;
}): {
    activity: string;
    id: string;
    thread_id: string;
    sender: string;
    recipient: string;
    state: string;
    created_at: string;
    dedupe_key: string | null;
    trace_id: string | null;
    dedupe_replay: boolean;
};
export declare function replyAgentMessage(db: Database, agentId: string, parentId: string, options: AgentMessageOptions & {
    ack?: boolean;
}): {
    activity: string;
    parent_acknowledged: boolean;
    id: string;
    thread_id: string;
    in_reply_to: string;
    sender: string;
    recipient: string;
    state: string;
    created_at: string;
    dedupe_key: string | null;
    trace_id: string | null;
    dedupe_replay: boolean;
};
export declare function agentInbox(db: Database, agentId: string, options?: {
    unreadOnly?: boolean;
    pendingOnly?: boolean;
}): InboxEntry[];
export declare function agentOutbox(db: Database, agentId: string): Array<InboxEntry & {
    reply_count: number;
}>;
export declare function readAgentMessage(db: Database, agentId: string, messageId: string): InboxEntry;
export declare function ackAgentMessage(db: Database, agentId: string, messageId: string): import("./message.js").AckResult;
export declare function agentThread(db: Database, agentId: string, threadId: string): InboxEntry[];
export declare function pollAgentMessages(db: Database, agentId: string, limit?: number): InboxEntry[];
/** Wait for work, independent of notification claims; returning a message never handles it. */
export declare function waitForAgentMessages(db: Database, agentId: string, options?: {
    timeoutMs?: number;
    limit?: number;
}): Promise<InboxEntry[]>;
export {};
//# sourceMappingURL=agents.d.ts.map