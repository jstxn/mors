import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { persistIdentity, generateIdentity } from '../src/identity.js';
import {
  markAuthEnabled,
  saveProfile,
  saveSession,
  type AccountProfileLocal,
  type AuthSession,
} from '../src/auth/session.js';
import {
  generateDeviceKeys,
  getDeviceKeysDir,
  persistDeviceKeys,
} from '../src/e2ee/device-keys.js';
import { buildStartScreen, runStartCommand, shouldUseFullScreenStartApp } from '../src/start.js';

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

class FakeTtyInput extends PassThrough {
  isTTY = true;
  readonly rawModeChanges: boolean[] = [];

  setRawMode(enabled: boolean): void {
    this.rawModeChanges.push(enabled);
  }
}

class FakeTtyOutput extends MemoryWritable {
  isTTY = true;
  columns = 100;
  rows = 30;
}

function markInitialized(configDir: string): void {
  persistIdentity(configDir, generateIdentity());
  persistDeviceKeys(getDeviceKeysDir(configDir), generateDeviceKeys());
  writeFileSync(join(configDir, '.initialized'), 'ok\n');
}

function seedHostedSession(configDir: string, overrides: Partial<AuthSession> = {}): void {
  const createdAt = '2026-03-07T00:00:00.000Z';
  const session: AuthSession = {
    accessToken: 'token-seeded',
    tokenType: 'bearer',
    accountId: 'acct-seeded',
    deviceId: 'device-seeded',
    createdAt,
    ...overrides,
  };
  const profile: AccountProfileLocal = {
    handle: 'seeded',
    displayName: 'Seeded User',
    accountId: session.accountId,
    createdAt,
  };
  markAuthEnabled(configDir);
  saveSession(configDir, session);
  saveProfile(configDir, profile);
}

describe('mors start', () => {
  it('uses the full-screen app only for real tty sessions without a prompt override', () => {
    expect(
      shouldUseFullScreenStartApp({
        input: new FakeTtyInput(),
        output: new FakeTtyOutput(),
      })
    ).toBe(true);

    expect(
      shouldUseFullScreenStartApp({
        input: new FakeTtyInput(),
        output: new FakeTtyOutput(),
        promptOverride: true,
      })
    ).toBe(false);

    expect(
      shouldUseFullScreenStartApp({
        input: new PassThrough(),
        output: new FakeTtyOutput(),
      })
    ).toBe(false);
  });

  it('renders the full-screen dashboard with contacts, inbox, and composer state', () => {
    const screen = buildStartScreen(
      {
        handle: 'alice',
        relayBaseUrl: 'https://mors.fly.dev',
        status: 'Ready to message',
        contacts: [
          {
            account_id: 'acct-bob',
            handle: 'bob',
            display_name: 'Bob',
            status: 'approved',
            autonomy_allowed: true,
          },
        ],
        pending: [],
        inbox: [
          {
            id: 'msg-1',
            thread_id: 'thread-1',
            in_reply_to: null,
            sender_id: 'acct-bob',
            sender_device_id: 'device-bob',
            sender_login: 'bob',
            recipient_id: 'acct-alice',
            body: '{"ciphertext":"abc","iv":"def","authTag":"ghi"}',
            subject: null,
            state: 'delivered',
            read_at: null,
            acked_at: null,
            created_at: '2026-03-07T00:00:00.000Z',
            updated_at: '2026-03-07T00:00:00.000Z',
          },
        ],
        selectedContactIndex: 0,
        selectedActivityIndex: 0,
        focus: 'contacts',
        activityView: 'inbox',
        previewTitle: 'Message from bob',
        previewBody: ['hello from bob'],
        composerOpen: true,
        draft: 'hi there',
      },
      { width: 100, height: 24 }
    );

    expect(screen).toContain('mors start | @alice');
    expect(screen).toContain('[Contacts *]');
    expect(screen).toContain('@bob');
    expect(screen).toContain('[Inbox]');
    expect(screen).toContain('> @bob (delivered)');
    expect(screen).toContain('[encrypted message]');
    expect(screen).toContain('Message from bob');
    expect(screen).toContain('Compose -> @bob: hi there_');
  });

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
      expect(settings).toContain('https://mors.fly.dev');
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

  it('repairs a missing hosted profile for returning users before entering the app', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mors-start-'));
    const output = new MemoryWritable();
    const error = new MemoryWritable();
    const originalExitCode = process.exitCode;
    const repairedProfiles: Array<{ handle: string; displayName: string }> = [];

    markInitialized(configDir);
    seedHostedSession(configDir, {
      accountId: 'acct-returning',
      deviceId: 'device-returning',
      accessToken: 'token-returning',
    });

    try {
      process.exitCode = undefined;

      await runStartCommand([], {
        configDir,
        output,
        error,
        prompt: new ScriptedPrompt(['7']),
        runtime: {
          async signup() {
            throw new Error('signup should not run for returning users');
          },
          async listContacts() {
            return [];
          },
          async addContact() {
            throw new Error('add contact should not run');
          },
          async listPending() {
            return [];
          },
          async approveContact() {},
          async getHostedProfile() {
            return null;
          },
          async registerHostedProfile(_relayBaseUrl, _token, profile) {
            repairedProfiles.push(profile);
          },
          async listInbox() {
            return [];
          },
          async sendMessage() {
            throw new Error('send should not run');
          },
        },
      });

      expect(error.toString()).toBe('');
      expect(output.toString()).toContain('Welcome back, @seeded.');
      expect(repairedProfiles).toEqual([
        {
          handle: 'seeded',
          displayName: 'Seeded User',
        },
      ]);
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('restores tty state when fullscreen startup fails during initial refresh', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mors-start-'));
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput();
    const error = new MemoryWritable();
    const originalExitCode = process.exitCode;

    markInitialized(configDir);
    seedHostedSession(configDir);

    try {
      process.exitCode = undefined;

      await runStartCommand([], {
        configDir,
        input,
        output,
        error,
        runtime: {
          async signup() {
            throw new Error('signup should not be called');
          },
          async getHostedProfile() {
            return {
              accountId: 'acct-seeded',
              handle: 'seeded',
              displayName: 'Seeded User',
            };
          },
          async registerHostedProfile() {
            throw new Error('registerHostedProfile should not be called');
          },
          async listContacts() {
            throw new Error('contacts unavailable');
          },
          async addContact() {
            throw new Error('addContact should not be called');
          },
          async listPending() {
            return [];
          },
          async approveContact() {},
          async listInbox() {
            return [];
          },
          async sendMessage() {
            throw new Error('sendMessage should not be called');
          },
        },
      });

      expect(process.exitCode).toBe(1);
      expect(error.toString()).toContain('contacts unavailable');
      expect(input.rawModeChanges.at(0)).toBe(true);
      expect(input.rawModeChanges.at(-1)).toBe(false);
      expect(output.toString()).toContain('\x1b[?25h\x1b[?1049l');
    } finally {
      process.exitCode = originalExitCode;
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
