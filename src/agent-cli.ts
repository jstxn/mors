import { parseArgs } from 'node:util';
import {
  openAgentStore, getAgentConfigDir, registerAgent, getAgent, findSessionAgent,
  listAgents, heartbeatAgent, stopAgent, sendAgentMessage, replyAgentMessage,
  agentInbox, agentOutbox, readAgentMessage, ackAgentMessage, agentThread, pollAgentMessages, waitForAgentMessages,
  type AgentRuntime,
} from './agents.js';

const HELP = `Usage: mors agent <command> [options]

Local communication between trusted working agents. Shares one encrypted hub
across projects; MORS_AGENT_DIR overrides ~/.local/share/mors/agents.

  register  --runtime codex|claude|other --session <id>
            [--name <alias>] [--role <description>] [--project <path>]
  list      [--all] [--project <path>] [--max-age-ms <milliseconds>]
  send      --to <agent-id-or-name> --body <text>
  inbox     [--unread] [--pending] (pending means not acknowledged)
  outbox    List sent messages, read/ack state and peer reply_count
  read      <message-id>
  reply     <msg_id> --body <text> [--ack] (save reply and ack parent atomically)
  ack       <message-id> (only acknowledge messages addressed to you)
  thread    <thread-id>
  poll      [--limit <1..100>] (unread/unacked notifications retry after 60 seconds)
  wait      [--timeout-ms <0..30000>] [--limit <1..100>] (default 10 seconds)
  leave     Mark this session offline without deleting its inbox
  install   --runtime codex|claude [--project <path>] [--hub-dir <path>]
            Install project hooks and the communication skill, preserving config
  hook      --runtime codex|claude (runtime hook JSON on stdin)

All commands support --json. Mailbox commands bind identity via --agent <id/name>,
MORS_AGENT_ID, or a registered --runtime/--session (MORS_RUNTIME/MORS_SESSION_ID).
Codex sessions can use CODEX_THREAD_ID automatically. Child agents should use
the exact --agent address supplied by their hook.
Send/reply: [--summary <one-line action and key detail>] [--dedupe-key <key>] [--trace-id <trc_id>]
--subject is a compatibility alias for --summary; use only one. The summary is
written by the sender and stored as the message subject, never inferred from the body.
Successful send/reply receipts include an activity line; skip dedupe replays in user-visible progress.
Names cannot be taken over by another session. list --all includes offline/stale
sessions; active means seen in the last 15 minutes, not necessarily available.
Hooks deliver at tool/prompt boundaries; they do not wake idle sessions.
wait returns status "messages" or "timeout" and never reads or acknowledges.
read_at records an explicit read; ack can follow a full preview without a read.
For questions, verify a successful reply receipt before treating the work as done.
`;

export async function runAgentCommand(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const emit = (value: unknown): void => console.log(JSON.stringify(value, null, json ? 0 : 2));
  try {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true,
      options: {
        json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
        agent: { type: 'string' }, runtime: { type: 'string' }, session: { type: 'string' },
        name: { type: 'string' }, role: { type: 'string' }, project: { type: 'string' },
        all: { type: 'boolean' }, unread: { type: 'boolean' }, pending: { type: 'boolean' }, ack: { type: 'boolean' },
        to: { type: 'string' }, body: { type: 'string' }, subject: { type: 'string' }, summary: { type: 'string' },
        'dedupe-key': { type: 'string' }, 'trace-id': { type: 'string' },
        'max-age-ms': { type: 'string' }, limit: { type: 'string' }, 'hub-dir': { type: 'string' },
        'timeout-ms': { type: 'string' },
      },
    });
    const [command, messageId] = positionals;
    if (values.help || !command) {
      console.log(HELP);
      return;
    }
    const requireValue = (value: string | undefined, label: string): string => {
      if (!value?.trim()) throw new Error(`${label} is required. See "mors agent --help".`);
      return value;
    };
    const runtime = values.runtime ?? process.env['MORS_RUNTIME'] ?? (process.env['CODEX_THREAD_ID'] ? 'codex' : 'other');
    const sessionId = values.session ?? process.env['MORS_SESSION_ID'] ?? process.env['CODEX_THREAD_ID'];
    if (command === 'hook') {
      const { runAgentHook } = await import('./agent-hooks.js');
      await runAgentHook(requireValue(values.runtime, '--runtime'));
      return;
    }
    if (command === 'install') {
      if (values.runtime !== 'codex' && values.runtime !== 'claude') throw new Error('Install requires --runtime codex or --runtime claude.');
      const { installAgentIntegration } = await import('./agent-hooks.js');
      emit({ status: 'installed', ...installAgentIntegration({
        runtime: values.runtime, projectDir: values.project ?? process.cwd(),
        hubDir: values['hub-dir'] ?? getAgentConfigDir(),
      }) });
      return;
    }
    const commands = ['register', 'list', 'send', 'inbox', 'outbox', 'read', 'reply', 'ack', 'thread', 'poll', 'wait', 'leave'];
    if (!commands.includes(command)) throw new Error(`Unknown agent command "${command}". See "mors agent --help".`);
    if (values.summary !== undefined && values.subject !== undefined) throw new Error('Use only --summary or --subject, not both.');
    if (values.ack && command !== 'reply') throw new Error('--ack is only valid with reply. Use the ack command for a message already handled.');
    if (values['timeout-ms'] !== undefined && command !== 'wait') throw new Error('--timeout-ms is only valid with wait.');
    if (values.pending && command !== 'inbox') throw new Error('--pending is only valid with inbox.');
    if (positionals.length > (['read', 'reply', 'ack', 'thread'].includes(command) ? 2 : 1)) {
      throw new Error('Unexpected positional argument. Quote message bodies and use --body.');
    }
    const db = await openAgentStore();
    try {
      if (command === 'register') {
        const agent = registerAgent(db, { runtime: runtime as AgentRuntime, sessionId: requireValue(sessionId, '--session'),
          name: values.name, role: values.role, project: values.project });
        emit({ status: 'registered', agent });
        return;
      }
      if (command === 'list') {
        emit({ status: 'ok', agents: listAgents(db, { all: values.all, project: values.project,
          maxAgeMs: values['max-age-ms'] === undefined ? undefined : Number(values['max-age-ms']) }) });
        return;
      }
      const selector = values.agent ?? process.env['MORS_AGENT_ID'];
      const agent = selector ? getAgent(db, selector) : findSessionAgent(db, runtime, requireValue(sessionId, 'Registered session or --agent'));
      heartbeatAgent(db, agent.id);
      const bodyOptions = () => ({ body: requireValue(values.body, '--body'),
        subject: values.summary === undefined ? values.subject : requireValue(values.summary, '--summary'),
        dedupeKey: values['dedupe-key'], traceId: values['trace-id'] });
      switch (command) {
        case 'send':
          emit({ status: 'sent', ...sendAgentMessage(db, agent.id, { ...bodyOptions(), to: requireValue(values.to, '--to') }) });
          return;
        case 'reply':
          emit({ status: 'sent', ...replyAgentMessage(db, agent.id, requireValue(messageId, 'Parent message ID'), { ...bodyOptions(), ack: values.ack }) });
          return;
        case 'wait': {
          const messages = await waitForAgentMessages(db, agent.id, {
            timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
            limit: values.limit === undefined ? undefined : Number(values.limit),
          });
          emit({ status: messages.length ? 'messages' : 'timeout', count: messages.length, messages });
          return;
        }
        case 'read':
          emit({ status: 'ok', message: readAgentMessage(db, agent.id, requireValue(messageId, 'Message ID')) });
          return;
        case 'ack':
          emit({ status: 'acked', ...ackAgentMessage(db, agent.id, requireValue(messageId, 'Message ID')) });
          return;
        case 'leave':
          stopAgent(db, agent.id);
          emit({ status: 'offline', agent: agent.id });
          return;
        default: {
          const messages = command === 'inbox' ? agentInbox(db, agent.id, { unreadOnly: values.unread, pendingOnly: values.pending })
            : command === 'outbox' ? agentOutbox(db, agent.id)
              : command === 'thread' ? agentThread(db, agent.id, requireValue(messageId, 'Thread ID'))
                : pollAgentMessages(db, agent.id, values.limit === undefined ? undefined : Number(values.limit));
          emit({ status: 'ok', count: messages.length, messages });
        }
      }
    } finally {
      db.close();
    }
  } catch (error) {
    process.exitCode = 1;
    const message = error instanceof Error ? error.message : String(error);
    if (json) emit({ status: 'error', error: 'agent_error', message });
    else console.error(`Error: ${message}`);
  }
}
