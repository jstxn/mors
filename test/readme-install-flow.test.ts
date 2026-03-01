/**
 * README audience-split install flow tests.
 *
 * Validates:
 * - VAL-LAUNCH-009: README provides audience-split guidance for agents and humans
 *
 * Tests cover:
 * - README contains clearly labeled `For Agents` and `For Humans` sections
 * - Each section includes concise install and first-use instructions aligned with current CLI behavior
 * - At least one representative command path per audience is validated and documented accurately
 * - Agent section documents npx/node dist/index.js invocation, MORS_CONFIG_DIR, --json, and error table
 * - Human section documents npm global install, setup-shell, and guided lifecycle
 * - Documented commands actually work when executed against the built CLI
 * - quickstart and doctor commands are discoverable in README
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'index.js');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

/** Extract a section from README by heading (## heading text). */
function extractSection(heading: string): string {
  const pattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
  const start = README.search(pattern);
  if (start === -1) return '';
  // Find the next ## heading or end of file
  const rest = README.slice(start);
  const nextHeading = rest.search(/\n## /);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

/** Run the CLI and capture output. */
function runCli(
  args: string,
  options?: {
    configDir?: string;
    env?: Record<string, string>;
    expectFailure?: boolean;
  }
): { stdout: string; stderr: string; exitCode: number } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...options?.env,
  };
  if (options?.configDir) {
    env['MORS_CONFIG_DIR'] = options.configDir;
  }

  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd: ROOT,
      encoding: 'utf8',
      env,
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    if (options?.expectFailure) {
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        exitCode: e.status ?? 1,
      };
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// VAL-LAUNCH-009: README audience-split structure
// ═══════════════════════════════════════════════════════════════════════

describe('VAL-LAUNCH-009: README audience-split sections', () => {
  it('README contains a clearly labeled "For Agents" section', () => {
    expect(README).toMatch(/^## For Agents/m);
  });

  it('README contains a clearly labeled "For Humans" section', () => {
    expect(README).toMatch(/^## For Humans/m);
  });

  it('"For Agents" section appears before "For Humans" section', () => {
    const agentIdx = README.indexOf('## For Agents');
    const humanIdx = README.indexOf('## For Humans');
    expect(agentIdx).toBeGreaterThan(-1);
    expect(humanIdx).toBeGreaterThan(-1);
    expect(agentIdx).toBeLessThan(humanIdx);
  });

  it('both sections are non-empty and contain substantive content', () => {
    const agentSection = extractSection('For Agents');
    const humanSection = extractSection('For Humans');
    // Each section should have at least 200 chars of content (non-trivial)
    expect(agentSection.length).toBeGreaterThan(200);
    expect(humanSection.length).toBeGreaterThan(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// For Agents section: install and first-use instructions
// ═══════════════════════════════════════════════════════════════════════

describe('VAL-LAUNCH-009: For Agents section content', () => {
  const agentSection = extractSection('For Agents');

  it('documents npx or node dist/index.js invocation path', () => {
    expect(
      agentSection.includes('npx') || agentSection.includes('node dist/index.js')
    ).toBe(true);
  });

  it('documents npm global install from GitHub', () => {
    expect(agentSection).toContain('npm install -g github:jstxn/mors');
  });

  it('documents MORS_CONFIG_DIR for environment isolation', () => {
    expect(agentSection).toContain('MORS_CONFIG_DIR');
  });

  it('documents --json flag for machine-readable output', () => {
    expect(agentSection).toContain('--json');
  });

  it('documents the local lifecycle commands: init, send, inbox, read, ack', () => {
    expect(agentSection).toContain('init');
    expect(agentSection).toContain('send');
    expect(agentSection).toContain('inbox');
    expect(agentSection).toContain('read');
    expect(agentSection).toContain('ack');
  });

  it('documents error handling patterns for agents', () => {
    // Should include error table or error types
    expect(agentSection).toContain('not_initialized');
    expect(agentSection).toContain('not_authenticated');
  });

  it('documents exit code convention (0 = success, non-zero = failure)', () => {
    expect(agentSection.toLowerCase()).toMatch(/exit\s*code.*0/);
  });

  it('mentions quickstart or doctor for agent discovery', () => {
    // Agents should be pointed to quickstart and/or doctor for validation
    expect(
      agentSection.includes('quickstart') || agentSection.includes('doctor')
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// For Humans section: install and first-use instructions
// ═══════════════════════════════════════════════════════════════════════

describe('VAL-LAUNCH-009: For Humans section content', () => {
  const humanSection = extractSection('For Humans');

  it('documents npm global install from GitHub', () => {
    expect(humanSection).toContain('npm install -g github:jstxn/mors');
  });

  it('documents setup-shell for interactive users', () => {
    expect(humanSection).toContain('setup-shell');
  });

  it('documents the standard lifecycle: init, login, send, inbox, read, ack', () => {
    expect(humanSection).toContain('init');
    expect(humanSection).toContain('login');
    expect(humanSection).toContain('send');
    expect(humanSection).toContain('inbox');
    expect(humanSection).toContain('read');
    expect(humanSection).toContain('ack');
  });

  it('documents mors onboard with handle and display-name', () => {
    expect(humanSection).toContain('onboard');
    expect(humanSection).toContain('--handle');
    expect(humanSection).toContain('--display-name');
  });

  it('documents Homebrew formula install path', () => {
    expect(humanSection).toContain('brew install');
    expect(humanSection).toContain('Formula/mors.rb');
  });

  it('documents watch command for real-time events', () => {
    expect(humanSection).toContain('watch');
  });

  it('mentions quickstart or doctor for human discovery', () => {
    expect(
      humanSection.includes('quickstart') || humanSection.includes('doctor')
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Representative command path: Agent (validated end-to-end)
// ═══════════════════════════════════════════════════════════════════════

describe('VAL-LAUNCH-009: agent representative command path works', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'mors-readme-agent-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('agent path from README: node dist/index.js --version succeeds', () => {
    const result = runCli('--version', { configDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^mors \d+\.\d+\.\d+$/);
  });

  it('agent path from README: full lifecycle with --json (init → send → inbox → read → ack)', () => {
    // This validates the exact command sequence documented in the For Agents section
    // Step 1: init
    const initResult = runCli('init --json', { configDir });
    expect(initResult.exitCode).toBe(0);
    const initParsed = JSON.parse(initResult.stdout.trim());
    expect(initParsed.status).toBe('initialized');

    // Step 2: send
    const sendResult = runCli(
      'send --to peer-agent --body "hello from agent" --json',
      { configDir }
    );
    expect(sendResult.exitCode).toBe(0);
    const sendParsed = JSON.parse(sendResult.stdout.trim());
    expect(sendParsed.status).toBe('sent');
    expect(sendParsed.id).toBeDefined();

    // Step 3: inbox
    const inboxResult = runCli('inbox --json', { configDir });
    expect(inboxResult.exitCode).toBe(0);
    const inboxParsed = JSON.parse(inboxResult.stdout.trim());
    expect(inboxParsed.status).toBe('ok');
    expect(inboxParsed.messages.length).toBeGreaterThan(0);
    expect(inboxParsed.messages[0].id).toBe(sendParsed.id);

    // Step 4: read
    const readResult = runCli(`read ${sendParsed.id} --json`, { configDir });
    expect(readResult.exitCode).toBe(0);
    const readParsed = JSON.parse(readResult.stdout.trim());
    expect(readParsed.status).toBe('ok');
    expect(readParsed.message.body).toBe('hello from agent');

    // Step 5: ack
    const ackResult = runCli(`ack ${sendParsed.id} --json`, { configDir });
    expect(ackResult.exitCode).toBe(0);
    const ackParsed = JSON.parse(ackResult.stdout.trim());
    expect(ackParsed.status).toBe('acked');
  });

  it('agent error handling from README: not_initialized error is actionable', () => {
    const result = runCli('inbox --json', {
      configDir: join(configDir, 'empty'),
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output.toLowerCase()).toContain('init');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Representative command path: Human (validated end-to-end)
// ═══════════════════════════════════════════════════════════════════════

describe('VAL-LAUNCH-009: human representative command path works', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'mors-readme-human-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('human path from README: mors --version works after build', () => {
    const result = runCli('--version', { configDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^mors \d+\.\d+\.\d+$/);
  });

  it('human path from README: init → send → inbox → read → ack lifecycle', () => {
    // Step 1: init
    const initResult = runCli('init', { configDir });
    expect(initResult.exitCode).toBe(0);

    // Step 2: send
    const sendResult = runCli('send --to agent-b --body "hello" --json', { configDir });
    expect(sendResult.exitCode).toBe(0);
    const sendParsed = JSON.parse(sendResult.stdout.trim());
    expect(sendParsed.status).toBe('sent');

    // Step 3: inbox
    const inboxResult = runCli('inbox --json', { configDir });
    expect(inboxResult.exitCode).toBe(0);
    const inboxParsed = JSON.parse(inboxResult.stdout.trim());
    expect(inboxParsed.count).toBeGreaterThan(0);

    // Step 4: read
    const readResult = runCli(`read ${sendParsed.id}`, { configDir });
    expect(readResult.exitCode).toBe(0);
    expect(readResult.stdout).toContain('hello');

    // Step 5: ack
    const ackResult = runCli(`ack ${sendParsed.id}`, { configDir });
    expect(ackResult.exitCode).toBe(0);
    expect(ackResult.stdout.toLowerCase()).toContain('acknowledged');
  });

  it('human path from README: setup-shell is available', () => {
    // setup-shell should be recognized (with --decline to avoid mutation)
    const result = runCli('setup-shell --decline', { configDir });
    expect(result.exitCode).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// README cross-references: quickstart and doctor
// ═══════════════════════════════════════════════════════════════════════

describe('VAL-LAUNCH-009: README references quickstart and doctor', () => {
  it('README mentions quickstart command', () => {
    expect(README).toContain('quickstart');
  });

  it('README mentions doctor command', () => {
    expect(README).toContain('doctor');
  });

  it('README links to ONBOARDING.md for extended guidance', () => {
    expect(README).toContain('ONBOARDING.md');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// README accuracy: commands match current CLI behavior
// ═══════════════════════════════════════════════════════════════════════

describe('VAL-LAUNCH-009: README command accuracy', () => {
  it('--version output matches README version reference pattern', () => {
    const result = runCli('--version');
    expect(result.exitCode).toBe(0);
    // README documents `mors --version` and `npx github:jstxn/mors --version`
    expect(result.stdout.trim()).toMatch(/^mors \d+\.\d+\.\d+$/);
  });

  it('--help lists all commands referenced in README', () => {
    const result = runCli('--help');
    expect(result.exitCode).toBe(0);
    // All commands documented in README should appear in --help
    const helpOutput = result.stdout;
    expect(helpOutput).toContain('init');
    expect(helpOutput).toContain('send');
    expect(helpOutput).toContain('inbox');
    expect(helpOutput).toContain('read');
    expect(helpOutput).toContain('ack');
    expect(helpOutput).toContain('login');
    expect(helpOutput).toContain('watch');
    expect(helpOutput).toContain('quickstart');
    expect(helpOutput).toContain('doctor');
  });

  it('README documents correct invite token format for login', () => {
    // The README documents: mors login --invite-token mors-invite-0123456789abcdef0123456789abcdef
    // Verify the format matches what the CLI expects
    expect(README).toMatch(/mors login --invite-token\s+mors-invite-[0-9a-f]{32}/);
  });

  it('README documents correct onboard flag format', () => {
    expect(README).toMatch(/mors onboard --handle\s+\S+\s+--display-name\s+/);
  });
});
