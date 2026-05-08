import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MaildirSpool } from '../../src/spool/maildir.js';
import { runSandboxCommand, runSpoolCommand } from '../../src/spool/cli.js';
import { SPOOL_SCHEMA } from '../../src/spool/types.js';

async function captureCommand(fn: () => Promise<void>): Promise<{
  stdout: string;
  exitCode: string | number | undefined;
}> {
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  const lines: string[] = [];
  process.exitCode = undefined;
  console.log = (message?: unknown) => {
    lines.push(String(message ?? ''));
  };
  console.error = (message?: unknown) => {
    lines.push(String(message ?? ''));
  };
  try {
    await fn();
    return { stdout: lines.join('\n'), exitCode: process.exitCode };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
}

describe('spool and sandbox CLI helpers', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'mors-spool-cli-'));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('initializes, writes, tails, waits, and exports spool entries as JSON', async () => {
    const init = await captureCommand(() =>
      runSpoolCommand(['init', '--root', tempRoot, '--agent', 'worker-a', '--json'])
    );
    expect(JSON.parse(init.stdout)).toMatchObject({
      status: 'initialized',
      agent_id: 'worker-a',
    });

    const write = await captureCommand(() =>
      runSpoolCommand([
        'write',
        '--root',
        tempRoot,
        '--agent',
        'worker-a',
        '--kind',
        'message',
        '--to',
        'acct_host',
        '--body',
        'hello from vm',
        '--json',
      ])
    );
    expect(JSON.parse(write.stdout)).toMatchObject({ status: 'written', mailbox: 'outbox' });

    const tail = await captureCommand(() =>
      runSpoolCommand([
        'tail',
        '--root',
        tempRoot,
        '--agent',
        'worker-a',
        '--mailbox',
        'outbox',
        '--json',
      ])
    );
    const tailJson = JSON.parse(tail.stdout) as { count: number; entries: Array<{ body: unknown }> };
    expect(tailJson.count).toBe(1);
    expect(tailJson.entries[0].body).toMatchObject({ kind: 'message', body: { content: 'hello from vm' } });

    const spool = new MaildirSpool({ root: tempRoot, agentId: 'worker-a' });
    spool.writeJson('inbox', {
      schema: SPOOL_SCHEMA,
      kind: 'relay_message',
      id: 'msg_wait',
      thread_id: 'thr_wait',
      in_reply_to: null,
      sender_id: 'acct_host',
      sender_device_id: 'device-host',
      sender_login: 'host',
      recipient_id: 'acct_worker',
      body: 'ready',
      subject: null,
      state: 'delivered',
      read_at: null,
      acked_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const wait = await captureCommand(() =>
      runSpoolCommand([
        'wait',
        '--root',
        tempRoot,
        '--agent',
        'worker-a',
        '--timeout-ms',
        '10',
        '--json',
      ])
    );
    expect(JSON.parse(wait.stdout)).toMatchObject({ status: 'ok', count: 1 });

    const exported = await captureCommand(() =>
      runSpoolCommand(['export', '--root', tempRoot, '--agent', 'worker-a', '--json'])
    );
    expect(JSON.parse(exported.stdout)).toMatchObject({ status: 'exported', count: 2 });
  });

  it('sandbox doctor reports a passing shared-folder contract after init', async () => {
    await captureCommand(() =>
      runSandboxCommand(['init', '--root', tempRoot, '--agent', 'worker-a', '--json'])
    );

    const doctor = await captureCommand(() =>
      runSandboxCommand(['doctor', '--root', tempRoot, '--agent', 'worker-a', '--json'])
    );
    const parsed = JSON.parse(doctor.stdout) as {
      status: string;
      checks: Array<{ name: string; status: string }>;
    };

    expect(parsed.status).toBe('ok');
    expect(parsed.checks.find((check) => check.name === 'write_probe')?.status).toBe('pass');
  });
});
