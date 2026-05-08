import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'index.js');

function runCli(
  args: string[],
  options: { configDir?: string; expectFailure?: boolean } = {}
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(options.configDir ? { MORS_CONFIG_DIR: options.configDir } : {}),
    },
  });

  const status = result.status ?? 1;
  if (!options.expectFailure && status !== 0) {
    throw new Error(
      `Command failed: ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status,
  };
}

async function runCliAsync(
  args: string[],
  options: { configDir?: string; expectFailure?: boolean } = {}
): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...(options.configDir ? { MORS_CONFIG_DIR: options.configDir } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => {
      const status = code ?? 1;
      if (!options.expectFailure && status !== 0) {
        reject(new Error(`Command failed: ${args.join(' ')}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr, status });
    });
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function writeJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    Connection: 'close',
  });
  res.end(payload);
}

async function startRelayStub(options: { deviceBundleStatus?: number } = {}): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  publishedBundles: Record<string, unknown>[];
}> {
  const publishedBundles: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      writeJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'POST' && req.url === '/auth/signup') {
      const body = await readJson(req);
      writeJson(res, 200, {
        access_token: 'relay-token-worker-a',
        account_id: 'acct_worker_a',
        device_id: body['device_id'],
        handle: body['handle'],
        display_name: body['display_name'],
      });
      return;
    }

    if (req.method === 'PUT' && req.url === '/accounts/me/device-bundle') {
      publishedBundles.push(await readJson(req));
      if (options.deviceBundleStatus && options.deviceBundleStatus !== 200) {
        writeJson(res, options.deviceBundleStatus, { error: 'device_bundle_rejected' });
        return;
      }
      writeJson(res, 200, {
        status: 'ok',
      });
      return;
    }

    writeJson(res, 404, { error: 'not_found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Relay stub did not bind to a TCP port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    publishedBundles,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('setup command', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'mors-setup-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('setup local initializes a config dir and leaves local messaging usable', () => {
    const setup = runCli(['setup', 'local', '--json'], { configDir });
    const parsed = JSON.parse(setup.stdout) as {
      status: string;
      mode: string;
      config_dir: string;
      initialized: boolean;
      checks: Array<{ name: string; status: string }>;
    };

    expect(parsed).toMatchObject({
      status: 'ready',
      mode: 'local',
      config_dir: configDir,
      initialized: true,
    });
    expect(parsed.checks.every((check) => check.status === 'pass')).toBe(true);

    const send = runCli(['send', '--to', 'peer-agent', '--body', 'hello', '--json'], {
      configDir,
    });
    expect(JSON.parse(send.stdout).status).toBe('sent');

    const inbox = runCli(['inbox', '--json'], { configDir });
    expect(JSON.parse(inbox.stdout).count).toBe(1);
  });

  it('setup local can target a config dir with --config-dir', () => {
    const explicitDir = join(configDir, 'explicit');
    const setup = runCli(['setup', 'local', '--config-dir', explicitDir, '--json']);
    const parsed = JSON.parse(setup.stdout) as { status: string; config_dir: string };

    expect(parsed.status).toBe('ready');
    expect(parsed.config_dir).toBe(explicitDir);
  });

  it('setup local blocks auth-enabled config dirs that no longer have a session', () => {
    runCli(['init', '--json'], { configDir });
    runCli(
      ['login', '--invite-token', 'mors-invite-0123456789abcdef0123456789abcdef', '--json'],
      { configDir }
    );
    runCli(['logout', '--json'], { configDir });

    const setup = runCli(['setup', 'local', '--json'], { configDir, expectFailure: true });
    const parsed = JSON.parse(setup.stdout) as {
      status: string;
      checks: Array<{ name: string; status: string }>;
    };

    expect(setup.status).toBe(1);
    expect(parsed.status).toBe('blocked');
    expect(parsed.checks).toContainEqual(
      expect.objectContaining({ name: 'local_auth_gate', status: 'fail' })
    );
  });

  it('setup relay configures a reachable relay without requiring identity flags', async () => {
    const relay = await startRelayStub();
    try {
      const setup = await runCliAsync(
        ['setup', 'relay', '--relay-url', relay.baseUrl, '--json'],
        { configDir }
      );
      const parsed = JSON.parse(setup.stdout) as {
        status: string;
        mode: string;
        relay_url: string;
        authenticated: boolean;
        checks: Array<{ name: string; status: string }>;
      };

      expect(parsed).toMatchObject({
        status: 'needs_identity',
        mode: 'relay',
        relay_url: relay.baseUrl,
        authenticated: false,
      });
      expect(parsed.checks).toContainEqual(
        expect.objectContaining({ name: 'relay_reachable', status: 'pass' })
      );

      const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
        relayBaseUrl: string;
      };
      expect(settings.relayBaseUrl).toBe(relay.baseUrl);
    } finally {
      await relay.close();
    }
  });

  it('setup relay can complete hosted signup and publish the local device bundle', async () => {
    const relay = await startRelayStub();
    try {
      const setup = await runCliAsync(
        [
          'setup',
          'relay',
          '--relay-url',
          relay.baseUrl,
          '--handle',
          'worker-a',
          '--display-name',
          'Worker A',
          '--json',
        ],
        { configDir }
      );
      const parsed = JSON.parse(setup.stdout) as {
        status: string;
        authenticated: boolean;
        onboarded: boolean;
        device_bundle_published: boolean;
      };

      expect(parsed).toMatchObject({
        status: 'ready',
        authenticated: true,
        onboarded: true,
        device_bundle_published: true,
      });
      expect(relay.publishedBundles).toHaveLength(1);
      expect(relay.publishedBundles[0]).toEqual(
        expect.objectContaining({
          device_id: expect.any(String),
          fingerprint: expect.any(String),
          x25519_public_key: expect.any(String),
        })
      );
    } finally {
      await relay.close();
    }
  });

  it('setup relay supports native invite-token auth plus profile setup', async () => {
    const relay = await startRelayStub();
    try {
      const setup = await runCliAsync(
        [
          'setup',
          'relay',
          '--relay-url',
          relay.baseUrl,
          '--invite-token',
          'mors-invite-0123456789abcdef0123456789abcdef',
          '--handle',
          'worker-native',
          '--display-name',
          'Worker Native',
          '--json',
        ],
        { configDir }
      );
      const parsed = JSON.parse(setup.stdout) as {
        status: string;
        authenticated: boolean;
        onboarded: boolean;
        device_bundle_published: boolean;
      };

      expect(parsed).toMatchObject({
        status: 'ready',
        authenticated: true,
        onboarded: true,
        device_bundle_published: true,
      });
      expect(relay.publishedBundles).toHaveLength(1);
    } finally {
      await relay.close();
    }
  });

  it('setup relay blocks when an authenticated profile cannot publish its device bundle', async () => {
    const relay = await startRelayStub({ deviceBundleStatus: 401 });
    try {
      const setup = await runCliAsync(
        [
          'setup',
          'relay',
          '--relay-url',
          relay.baseUrl,
          '--invite-token',
          'mors-invite-0123456789abcdef0123456789abcdef',
          '--handle',
          'worker-native',
          '--display-name',
          'Worker Native',
          '--json',
        ],
        { configDir, expectFailure: true }
      );
      const parsed = JSON.parse(setup.stdout) as {
        status: string;
        device_bundle_published: boolean;
        checks: Array<{ name: string; status: string }>;
      };

      expect(setup.status).toBe(1);
      expect(parsed.status).toBe('blocked');
      expect(parsed.device_bundle_published).toBe(false);
      expect(parsed.checks).toContainEqual(
        expect.objectContaining({ name: 'device_bundle', status: 'warn' })
      );
      expect(relay.publishedBundles).toHaveLength(1);
    } finally {
      await relay.close();
    }
  });

  it('setup fails clearly for missing option values and unknown options', () => {
    const missingValue = runCli(['setup', 'relay', '--handle', '--json'], {
      configDir,
      expectFailure: true,
    });
    const missingParsed = JSON.parse(missingValue.stdout) as { error: string; message: string };
    expect(missingValue.status).toBe(1);
    expect(missingParsed.error).toBe('missing_setup_option_value');
    expect(missingParsed.message).toContain('--handle');

    const unknown = runCli(['setup', 'relay', '--relayurl', 'http://127.0.0.1:3100', '--json'], {
      configDir,
      expectFailure: true,
    });
    const unknownParsed = JSON.parse(unknown.stdout) as { error: string; message: string };
    expect(unknown.status).toBe(1);
    expect(unknownParsed.error).toBe('unknown_setup_option');
    expect(unknownParsed.message).toContain('--relayurl');

    const relayOnly = runCli(['setup', 'local', '--relay-url', 'http://127.0.0.1:3100', '--json'], {
      configDir,
      expectFailure: true,
    });
    const relayOnlyParsed = JSON.parse(relayOnly.stdout) as { error: string; message: string };
    expect(relayOnly.status).toBe(1);
    expect(relayOnlyParsed.error).toBe('unsupported_setup_option');
    expect(relayOnlyParsed.message).toContain('setup relay');
  });

  it('setup help documents local and relay modes', () => {
    const result = runCli(['setup', '--help']);

    expect(result.stdout).toContain('mors setup local');
    expect(result.stdout).toContain('mors setup relay');
  });
});
