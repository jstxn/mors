import { requireInit } from '../init.js';
import { requireAuth, NotAuthenticatedError } from '../auth/guards.js';
import { loadSession } from '../auth/session.js';
import { MorsError } from '../errors.js';
import { RelayClient, RelayClientError } from '../relay/client.js';
import { resolveRelayBaseUrl } from '../settings.js';
import { MaildirSpool } from './maildir.js';
import { processSpoolOnce, runSpoolBridge } from './bridge.js';
class SpoolCliError extends MorsError {
    constructor(message) {
        super(message);
        this.name = 'SpoolCliError';
    }
}
export async function runSpoolCommand(args) {
    const subcommand = args[0];
    const subArgs = args.slice(1);
    const { flags } = parseArgs(subArgs);
    const json = 'json' in flags;
    if (!subcommand || subcommand === '--help' || subcommand === '-h' || 'help' in flags) {
        printSpoolUsage();
        return;
    }
    try {
        if (subcommand === 'init') {
            const spool = createSpoolFromFlags(flags);
            spool.init();
            if (json) {
                console.log(JSON.stringify({
                    status: 'initialized',
                    root: spool.root,
                    agent_id: spool.agentId,
                    agent_root: spool.agentRoot,
                }));
            }
            else {
                console.log(`Spool initialized for ${spool.agentId}: ${spool.agentRoot}`);
            }
            return;
        }
        if (subcommand === 'bridge') {
            const spool = createSpoolFromFlags(flags);
            const runtime = createRuntimeClient();
            const once = 'once' in flags;
            if (once) {
                const result = await processSpoolOnce(spool, runtime.client);
                if (json) {
                    console.log(JSON.stringify({ status: 'processed', ...result }));
                }
                else {
                    console.log(`Processed ${result.processed} spool entr${result.processed === 1 ? 'y' : 'ies'}; sent=${result.sent}, queued=${result.queued}, read=${result.read}, acked=${result.acked}, materialized=${result.materialized}, failed=${result.failed}, deferred=${result.deferred}`);
                }
                return;
            }
            const pollIntervalMs = parsePollInterval(flags['poll-interval']);
            const controller = new AbortController();
            process.once('SIGINT', () => controller.abort());
            process.once('SIGTERM', () => controller.abort());
            const handle = runSpoolBridge({
                spool,
                client: runtime.client,
                pollIntervalMs,
                signal: controller.signal,
                logger: (message) => {
                    if (!json)
                        console.error(message);
                },
                watch: {
                    baseUrl: runtime.baseUrl,
                    token: runtime.token,
                },
            });
            if (!json) {
                console.log(`Spool bridge running for ${spool.agentId}. Press Ctrl+C to stop.`);
            }
            await handle.done;
            if (json) {
                console.log(JSON.stringify({ status: 'stopped', agent_id: spool.agentId }));
            }
            return;
        }
        throw new SpoolCliError(`Unknown spool subcommand: ${subcommand}`);
    }
    catch (err) {
        process.exitCode = 1;
        formatSpoolError(err, json);
    }
}
function createSpoolFromFlags(flags) {
    const root = readRequiredFlag(flags, 'root');
    const agentId = readRequiredFlag(flags, 'agent');
    return new MaildirSpool({ root, agentId });
}
function createRuntimeClient() {
    const configDir = requireInit();
    requireAuth(configDir);
    const session = loadSession(configDir);
    if (!session) {
        throw new NotAuthenticatedError();
    }
    const baseUrl = resolveRelayBaseUrl(configDir);
    if (!baseUrl) {
        throw new SpoolCliError('Remote relay is not configured. Run "mors start" or set MORS_RELAY_BASE_URL.');
    }
    return {
        client: new RelayClient({
            baseUrl,
            token: session.accessToken,
            queueStorePath: `${configDir}/offline-queue.json`,
        }),
        baseUrl,
        token: session.accessToken,
    };
}
function readRequiredFlag(flags, name) {
    const value = flags[name];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new SpoolCliError(`spool requires --${name} <value>.`);
    }
    return value;
}
function parsePollInterval(value) {
    if (value === undefined || value === true)
        return 1000;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 100) {
        throw new SpoolCliError('--poll-interval must be an integer >= 100.');
    }
    return parsed;
}
function formatSpoolError(err, json) {
    const message = err instanceof Error ? err.message : String(err);
    let error = 'spool_error';
    if (err instanceof NotAuthenticatedError)
        error = 'not_authenticated';
    if (err instanceof RelayClientError)
        error = 'relay_error';
    if (err instanceof SpoolCliError)
        error = 'validation_error';
    if (json) {
        console.log(JSON.stringify({ status: 'error', error, message }));
    }
    else {
        console.error(`Error: ${message}`);
    }
}
function parseArgs(args) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const eqIndex = arg.indexOf('=');
            if (eqIndex >= 0) {
                flags[arg.slice(2, eqIndex)] = arg.slice(eqIndex + 1);
            }
            else {
                const key = arg.slice(2);
                const next = args[i + 1];
                if (next !== undefined && !next.startsWith('--')) {
                    flags[key] = next;
                    i++;
                }
                else {
                    flags[key] = true;
                }
            }
        }
        else {
            positional.push(arg);
        }
    }
    return { positional, flags };
}
function printSpoolUsage() {
    console.log(`mors spool - Maildir-style agent communication spool

Usage:
  mors spool init --root <path> --agent <agent-id> [--json]
  mors spool bridge --root <path> --agent <agent-id> [--once] [--poll-interval <ms>] [--json]

Commands:
  init     Create the per-agent outbox, inbox, control, and failed Maildir folders
  bridge   Drain outbound spool entries, reconcile inbound relay messages, and run continuously

Options:
  --root <path>          Spool root directory
  --agent <agent-id>     Local agent spool identity
  --once                 Process one bridge iteration and exit
  --poll-interval <ms>   Continuous bridge polling interval, min 100 ms, default 1000
  --json                 Output JSON`);
}
//# sourceMappingURL=cli.js.map