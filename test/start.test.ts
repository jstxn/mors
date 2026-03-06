import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { persistIdentity, generateIdentity } from '../src/identity.js';
import {
  generateDeviceKeys,
  getDeviceKeysDir,
  persistDeviceKeys,
} from '../src/e2ee/device-keys.js';
import { runStartCommand } from '../src/start.js';

class ScriptedPrompt {
  constructor(private readonly answers: string[]) {}

  async question(_prompt: string): Promise<string> {
    if (this.answers.length === 0) {
      throw new Error('No more scripted answers.');
    }
    return this.answers.shift() ?? '';
  }

  close(): void {}
}

class MemoryWritable extends Writable {
  private readonly chunks: string[] = [];

  _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    callback();
  }

  toString(): string {
    return this.chunks.join('');
  }
}

function markInitialized(configDir: string): void {
  persistIdentity(configDir, generateIdentity());
  persistDeviceKeys(getDeviceKeysDir(configDir), generateDeviceKeys());
  writeFileSync(join(configDir, '.initialized'), 'ok\n');
}

describe('mors start', () => {
  it('requires init before interactive startup', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mors-start-'));
    const output = new MemoryWritable();
    const error = new MemoryWritable();
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;

      await runStartCommand([], {
        configDir,
        output,
        error,
        prompt: new ScriptedPrompt([]),
      });

      expect(output.toString()).toBe('');
      expect(error.toString()).toContain('mors is not initialized');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('walks a fresh user through hosted signup, add, inbox, and send', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mors-start-'));
    const output = new MemoryWritable();
    const error = new MemoryWritable();
    const originalExitCode = process.exitCode;
    const sendCalls: Array<{ recipientId: string; body: string }> = [];
    const contacts = [
      {
        account_id: 'acct-bob',
        handle: 'bob',
        display_name: 'Bob',
        status: 'approved' as const,
        autonomy_allowed: true,
      },
    ];

    markInitialized(configDir);

    try {
      process.exitCode = undefined;

      await runStartCommand([], {
        configDir,
        output,
        error,
        prompt: new ScriptedPrompt([
          'alice',
          'Alice Agent',
          '2',
          '@bob',
          '4',
          'hello bob',
          '3',
          '1',
          '7',
        ]),
        runtime: {
          async signup(_relayBaseUrl, options) {
            return {
              accessToken: 'token-1',
              accountId: 'acct-alice',
              deviceId: options.deviceId,
              handle: options.handle,
              displayName: options.displayName,
            };
          },
          async listContacts() {
            return contacts;
          },
          async addContact(_relayBaseUrl, _token, handle) {
            return {
              account_id: 'acct-bob',
              handle,
              display_name: 'Bob',
              status: 'approved',
              autonomy_allowed: true,
            };
          },
          async listPending() {
            return [];
          },
          async approveContact() {},
          async listInbox() {
            return [
              {
                id: 'msg-1',
                thread_id: 'thread-1',
                in_reply_to: null,
                sender_id: 'acct-bob',
                sender_device_id: 'device-bob',
                sender_login: 'bob',
                recipient_id: 'acct-alice',
                body: 'hello from bob',
                subject: null,
                state: 'new',
                read_at: null,
                acked_at: null,
                created_at: '2026-03-06T00:00:00.000Z',
                updated_at: '2026-03-06T00:00:00.000Z',
              },
            ];
          },
          async sendMessage(_relayBaseUrl, _token, _queueStorePath, recipientId, body) {
            sendCalls.push({ recipientId, body });
            return {
              queued: false,
              dedupeKey: 'dup_test',
              message: {
                id: 'msg-2',
                thread_id: 'thread-2',
                in_reply_to: null,
                sender_id: 'acct-alice',
                sender_device_id: 'device-alice',
                sender_login: 'alice',
                recipient_id: recipientId,
                body,
                subject: null,
                state: 'sent',
                read_at: null,
                acked_at: null,
                created_at: '2026-03-06T00:00:00.000Z',
                updated_at: '2026-03-06T00:00:00.000Z',
              },
            };
          },
        },
      });

      const settings = readFileSync(join(configDir, 'settings.json'), 'utf8');
      const session = readFileSync(join(configDir, 'session.json'), 'utf8');
      const profile = readFileSync(join(configDir, 'profile.json'), 'utf8');
      const transcript = output.toString();

      expect(error.toString()).toBe('');
      expect(process.exitCode ?? 0).toBe(0);
      expect(settings).toContain('https://relay.mors.app');
      expect(session).toContain('"accountId": "acct-alice"');
      expect(profile).toContain('"handle": "alice"');
      expect(transcript).toContain('Signed in as @alice (Alice Agent).');
      expect(transcript).toContain('Added @bob (approved).');
      expect(transcript).toContain('Message sent to @bob.');
      expect(transcript).toContain('Inbox:');
      expect(transcript).toContain('hello from bob');
      expect(sendCalls).toEqual([{ recipientId: 'acct-bob', body: 'hello bob' }]);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
