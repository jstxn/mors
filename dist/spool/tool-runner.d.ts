import type { SpoolToolRunnerPolicy } from './policy.js';
import type { SpoolSendCommand } from './types.js';
export interface SpoolToolRunResult {
    ok: boolean;
    tool_name: string;
    exit_code: number | null;
    signal: NodeJS.Signals | null;
    timed_out: boolean;
    duration_ms: number;
    stdout: string;
    stderr: string;
    stdout_truncated: boolean;
    stderr_truncated: boolean;
}
export declare function runSpoolTool(command: SpoolSendCommand, runner: SpoolToolRunnerPolicy): Promise<SpoolToolRunResult>;
//# sourceMappingURL=tool-runner.d.ts.map