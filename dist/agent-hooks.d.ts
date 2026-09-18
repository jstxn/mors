type Runtime = 'codex' | 'claude';
type JsonObject = Record<string, unknown>;
/** Hook messages are data, never shell input or permission to change the current task. */
export declare function handleAgentHook(runtime: Runtime, input: unknown): Promise<JsonObject | undefined>;
export declare function runAgentHook(runtime: string): Promise<void>;
export interface AgentIntegrationOptions {
    runtime: Runtime;
    projectDir: string;
    hubDir?: string;
}
/** Merge only Mors-owned handlers. Existing settings and unrelated hooks survive installation. */
export declare function installAgentIntegration(options: AgentIntegrationOptions): {
    runtime: Runtime;
    projectDir: string;
    hubDir: string;
    files: string[];
    command: string;
};
export {};
//# sourceMappingURL=agent-hooks.d.ts.map