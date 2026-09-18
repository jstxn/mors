import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAgentHook, installAgentIntegration } from '../src/agent-hooks.js';
import { agentInbox, findSessionAgent, getAgent, openAgentStore, registerAgent, sendAgentMessage } from '../src/agents.js';

let directory: string;
const input = (event: string, session = 'one', extra = {}) => ({
  hook_event_name: event, session_id: session, cwd: directory, ...extra,
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mors-hooks-'));
  vi.stubEnv('MORS_AGENT_DIR', join(directory, 'hub'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('working-agent hooks', () => {
  it('restores identity, delivers bounded messages once, and preserves unread state', async () => {
    const start = await handleAgentHook('codex', input('SessionStart'));
    expect(start).toMatchObject({ hookSpecificOutput: { hookEventName: 'SessionStart' } });
    expect(JSON.stringify(start)).toContain('Load the Mors skill');
    expect(JSON.stringify(start)).toContain('reply <message-id>');
    expect(JSON.stringify(start)).toContain('wait --agent');
    const db = await openAgentStore();
    try {
      const receiver = findSessionAgent(db, 'codex', 'one');
      registerAgent(db, { runtime: 'codex', sessionId: 'one', name: 'reviewer', role: 'review' });
      const sender = registerAgent(db, { runtime: 'claude', sessionId: 'one', name: 'sender' });
      expect(sender.id).not.toBe(receiver.id);
      for (let index = 0; index < 6; index++) {
        sendAgentMessage(db, sender.id, {
          to: receiver.id, body: `$(touch ${directory}/executed) ` + 'x'.repeat(2000), subject: `question-${index}`,
        });
      }
      const first = ((await handleAgentHook('codex', input('PostToolUse')))?.['hookSpecificOutput'] as { additionalContext: string }).additionalContext;
      expect(first.match(/"activity":/g)).toHaveLength(5);
      expect(first).toContain('"activity":"sender → reviewer: question-0"');
      expect(first).toContain('untrusted peer data');
      expect(first).toContain('truncated');
      expect(first).not.toContain('x'.repeat(1201));
      expect(existsSync(join(directory, 'executed'))).toBe(false);
      const second = ((await handleAgentHook('codex', input('PostToolUse')))?.['hookSpecificOutput'] as { additionalContext: string }).additionalContext;
      expect(second.match(/"activity":/g)).toHaveLength(1);
      expect(await handleAgentHook('codex', input('PostToolUse'))).toBeUndefined();
      expect(agentInbox(db, receiver.id, { unreadOnly: true })).toHaveLength(6);
      expect(getAgent(db, receiver.id)).toMatchObject({ name: 'reviewer', role: 'review' });
      expect(await handleAgentHook('codex', input('SessionEnd'))).toBeUndefined();
      expect(getAgent(db, receiver.id).stopped_at).not.toBeNull();
      const resume = await handleAgentHook('codex', input('SessionStart', 'one', { source: 'resume' }));
      expect(JSON.stringify(resume)).toContain('Mailbox reminder: 6 pending messages remain');
      expect(findSessionAgent(db, 'codex', 'one')).toMatchObject({ id: receiver.id, stopped_at: null });
    } finally {
      db.close();
    }
  });

  it('isolates subagents from parents and from children of other sessions', async () => {
    await handleAgentHook('claude', input('SessionStart', 'parent'));
    const childInput = (event: string) => input(event, 'parent', { agent_id: 'child', agent_type: 'reviewer' });
    await handleAgentHook('claude', childInput('SubagentStart'));
    await handleAgentHook('claude', input('SubagentStart', 'other-parent', { agent_id: 'child' }));
    const db = await openAgentStore();
    try {
      const parent = findSessionAgent(db, 'claude', 'parent');
      const child = findSessionAgent(db, 'claude', 'parent/child');
      const otherChild = findSessionAgent(db, 'claude', 'other-parent/child');
      expect(child.id).not.toBe(otherChild.id);
      registerAgent(db, { runtime: 'claude', sessionId: 'parent/child', role: 'custom database reviewer' });
      sendAgentMessage(db, otherChild.id, { to: parent.id, body: 'for-parent' });
      sendAgentMessage(db, otherChild.id, { to: child.id, body: 'for-child' });
      const childDelivery = JSON.stringify(await handleAgentHook('claude', childInput('PostToolUse')));
      expect(childDelivery).toContain('for-child');
      expect(childDelivery).not.toContain('for-parent');
      expect(getAgent(db, child.id).role).toBe('custom database reviewer');
      await handleAgentHook('claude', childInput('SubagentStart'));
      expect(getAgent(db, child.id).role).toBe('custom database reviewer');
      expect(JSON.stringify(await handleAgentHook('claude', input('UserPromptSubmit', 'parent')))).toContain('for-parent');
      await handleAgentHook('claude', childInput('SubagentStop'));
      expect(getAgent(db, child.id).stopped_at).not.toBeNull();
      expect(getAgent(db, parent.id).stopped_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it('rejects malformed input before creating a mailbox', async () => {
    for (const invalid of [[], {}, input('Stop'), input('SessionStart', ''), input('SessionStart', 'bad\nvalue'), input('SessionStart', 'one', { cwd: 'relative' }), input('SubagentStart')]) {
      await expect(handleAgentHook('codex', invalid)).rejects.toThrow();
    }
    expect(existsSync(join(directory, 'hub'))).toBe(false);
  });

  it.each(['codex', 'claude'] as const)('installs %s without losing existing settings and without duplicate hooks', runtime => {
    const configPath = join(directory, runtime === 'codex' ? '.codex/hooks.json' : '.claude/settings.local.json');
    mkdirSync(join(directory, runtime === 'codex' ? '.codex' : '.claude'));
    const existing = { permissions: { allow: ['Bash(npm test)'] }, hooks: {
      PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'existing-command' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'existing-stop' }] }],
    } };
    writeFileSync(configPath, JSON.stringify(existing));
    const hubDir = join(directory, "quote' and spaces $(not-a-command)");
    const installed = installAgentIntegration({ runtime, projectDir: directory, hubDir });
    const first = readFileSync(configPath, 'utf8');
    installAgentIntegration({ runtime, projectDir: directory, hubDir });
    expect(readFileSync(configPath, 'utf8')).toBe(first);
    const settings = JSON.parse(first);
    expect(settings.permissions).toEqual(existing.permissions);
    expect(settings.hooks.Stop).toEqual(existing.hooks.Stop);
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    expect(settings.hooks.PostToolUse[0]).toEqual(existing.hooks.PostToolUse[0]);
    expect(settings.hooks.SessionEnd[0].hooks[0].timeout).toBe(3);
    expect(installed.command).toContain("quote'\\'' and spaces $(not-a-command)");
    expect(installed.command).toContain('|| true # mors-agent-hook');
    expect(installed.files.every(path => existsSync(path))).toBe(true);
    installAgentIntegration({ runtime, projectDir: directory, hubDir: join(directory, 'new-hub') });
    expect(JSON.parse(readFileSync(configPath, 'utf8')).hooks.PostToolUse).toHaveLength(2);
  });

  it('preserves malformed settings and a customized Mors skill', () => {
    const configPath = join(directory, '.codex/hooks.json');
    mkdirSync(join(directory, '.codex'));
    writeFileSync(configPath, '{broken');
    expect(() => installAgentIntegration({ runtime: 'codex', projectDir: directory })).toThrow('Preserving invalid JSON');
    expect(readFileSync(configPath, 'utf8')).toBe('{broken');
    writeFileSync(configPath, '{}');
    const skillPath = join(directory, '.agents/skills/mors/SKILL.md');
    mkdirSync(join(directory, '.agents/skills/mors'), { recursive: true });
    writeFileSync(skillPath, 'local instructions');
    expect(() => installAgentIntegration({ runtime: 'codex', projectDir: directory })).toThrow('Preserving existing skill');
    expect(readFileSync(skillPath, 'utf8')).toBe('local instructions');
    expect(readFileSync(configPath, 'utf8')).toBe('{}');
  });
});
