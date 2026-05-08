import { spawn } from 'node:child_process';
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const FORCE_KILL_GRACE_MS = 1000;
export async function runSpoolTool(command, runner) {
    const startedAt = Date.now();
    const timeoutMs = runner.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const maxOutputBytes = runner.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let forceKillTimer;
    return await new Promise((resolve) => {
        const child = spawn(runner.command, runner.args ?? [], {
            cwd: runner.cwd,
            shell: false,
            env: {
                PATH: process.env['PATH'] ?? '',
                MORS_TOOL_NAME: command.tool?.name ?? '',
                MORS_TOOL_ARGS_JSON: JSON.stringify(command.tool?.args ?? {}),
                MORS_TOOL_BODY: command.body.content,
                MORS_TOOL_TRACE_ID: command.trace_id ?? '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            forceKillTimer = setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill('SIGKILL');
                }
            }, FORCE_KILL_GRACE_MS);
        }, timeoutMs);
        child.stdout.on('data', (chunk) => {
            const appended = appendLimited(stdout, chunk.toString('utf8'), maxOutputBytes);
            stdout = appended.value;
            stdoutTruncated = stdoutTruncated || appended.truncated;
        });
        child.stderr.on('data', (chunk) => {
            const appended = appendLimited(stderr, chunk.toString('utf8'), maxOutputBytes);
            stderr = appended.value;
            stderrTruncated = stderrTruncated || appended.truncated;
        });
        child.once('error', (err) => {
            clearTimeout(timer);
            if (forceKillTimer)
                clearTimeout(forceKillTimer);
            resolve({
                ok: false,
                tool_name: command.tool?.name ?? '',
                exit_code: null,
                signal: null,
                timed_out: timedOut,
                duration_ms: Date.now() - startedAt,
                stdout,
                stderr: stderr ? `${stderr}\n${err.message}` : err.message,
                stdout_truncated: stdoutTruncated,
                stderr_truncated: stderrTruncated,
            });
        });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            if (forceKillTimer)
                clearTimeout(forceKillTimer);
            resolve({
                ok: code === 0 && !timedOut,
                tool_name: command.tool?.name ?? '',
                exit_code: code,
                signal,
                timed_out: timedOut,
                duration_ms: Date.now() - startedAt,
                stdout,
                stderr,
                stdout_truncated: stdoutTruncated,
                stderr_truncated: stderrTruncated,
            });
        });
    });
}
function appendLimited(current, addition, maxBytes) {
    const combined = current + addition;
    if (Buffer.byteLength(combined, 'utf8') <= maxBytes) {
        return { value: combined, truncated: false };
    }
    return {
        value: Buffer.from(combined, 'utf8').subarray(0, maxBytes).toString('utf8'),
        truncated: true,
    };
}
//# sourceMappingURL=tool-runner.js.map