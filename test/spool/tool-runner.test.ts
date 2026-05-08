import { describe, expect, it } from 'vitest';
import { runSpoolTool } from '../../src/spool/tool-runner.js';
import { SPOOL_SCHEMA, type SpoolSendCommand } from '../../src/spool/types.js';

function toolCommand(overrides: Partial<SpoolSendCommand> = {}): SpoolSendCommand {
  return {
    schema: SPOOL_SCHEMA,
    kind: 'tool_request',
    recipient_id: 'acct_host',
    body: {
      format: 'text/plain',
      content: 'body from sandbox',
    },
    trace_id: 'trc_runner',
    tool: {
      name: 'inspect-env',
      args: { target: 'unit' },
    },
    ...overrides,
  };
}

describe('spool tool runner', () => {
  it('passes sandbox tool data through a constrained environment', async () => {
    const result = await runSpoolTool(toolCommand(), {
      command: process.execPath,
      args: [
        '-e',
        [
          'console.log(JSON.stringify({',
          'name: process.env.MORS_TOOL_NAME,',
          'args: JSON.parse(process.env.MORS_TOOL_ARGS_JSON),',
          'body: process.env.MORS_TOOL_BODY,',
          'trace: process.env.MORS_TOOL_TRACE_ID,',
          'hasHome: Object.prototype.hasOwnProperty.call(process.env, "HOME")',
          '}));',
        ].join(''),
      ],
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual({
      name: 'inspect-env',
      args: { target: 'unit' },
      body: 'body from sandbox',
      trace: 'trc_runner',
      hasHome: false,
    });
  });

  it('bounds stdout captured from host tools', async () => {
    const result = await runSpoolTool(toolCommand(), {
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(32));'],
      maxOutputBytes: 8,
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('xxxxxxxx');
    expect(result.stdout_truncated).toBe(true);
  });

  it('marks long-running host tools as timed out', async () => {
    const result = await runSpoolTool(toolCommand(), {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000);'],
      timeoutMs: 25,
    });

    expect(result.ok).toBe(false);
    expect(result.timed_out).toBe(true);
    expect(result.signal).not.toBeNull();
  });
});
