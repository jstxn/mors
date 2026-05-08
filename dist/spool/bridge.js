import { RelayClientError } from '../relay/client.js';
import { connectRemoteWatch } from '../remote-watch.js';
import { MaildirEntryError, MaildirQuotaError, MaildirSpool } from './maildir.js';
import { DEFAULT_SPOOL_POLICY, SpoolPolicyError, validateSpoolCommandPolicy, } from './policy.js';
import {} from './state.js';
import { runSpoolTool } from './tool-runner.js';
import { SPOOL_COMMAND_KINDS, SPOOL_SCHEMA, } from './types.js';
export class SpoolValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SpoolValidationError';
    }
}
export async function processSpoolOnce(spool, client, options = {}) {
    spool.init();
    const result = emptyResult();
    const policy = options.policy ?? DEFAULT_SPOOL_POLICY;
    try {
        for (const entry of [...spool.listNew('outbox'), ...spool.listNew('control')]) {
            result.processed++;
            try {
                const parsed = parseSpoolCommand(spool.readJson(entry));
                validateSpoolCommandPolicy(parsed, policy);
                if (parsed.kind === 'read') {
                    await client.read(parsed.message_id);
                    spool.moveToCur(entry);
                    result.read++;
                }
                else if (parsed.kind === 'ack') {
                    await client.ack(parsed.message_id);
                    spool.moveToCur(entry);
                    result.acked++;
                }
                else if (parsed.kind === 'tool_request' && parsed.tool) {
                    const runner = policy.tools.runners?.[parsed.tool.name];
                    if (runner) {
                        const toolResult = await runSpoolTool(parsed, runner);
                        spool.writeJson('inbox', toolRunResultToSpoolCommand(spool.agentId, parsed, toolResult));
                        spool.moveToCur(entry);
                        result.tools_run++;
                    }
                    else {
                        const sendResult = await client.send(commandToSendOptions(parsed));
                        spool.moveToCur(entry);
                        if (sendResult.queued) {
                            result.queued++;
                        }
                        else {
                            result.sent++;
                        }
                    }
                }
                else {
                    const sendResult = await client.send(commandToSendOptions(parsed));
                    spool.moveToCur(entry);
                    if (sendResult.queued) {
                        result.queued++;
                    }
                    else {
                        result.sent++;
                    }
                }
            }
            catch (err) {
                if (isPermanentFailure(err)) {
                    spool.moveToFailed(entry, err instanceof Error ? err.message : String(err));
                    result.failed++;
                    if (err instanceof SpoolPolicyError)
                        result.policy_rejected++;
                    if (err instanceof MaildirQuotaError)
                        result.quota_rejected++;
                }
                else {
                    result.deferred++;
                }
            }
        }
        result.materialized += await reconcileInbox(spool, client, options);
        options.stateStore?.recordResult(result, {
            nextRetryAt: result.deferred > 0 ? new Date(Date.now() + 1000).toISOString() : undefined,
        });
        return result;
    }
    catch (err) {
        options.stateStore?.recordError(err);
        throw err;
    }
}
export async function reconcileInbox(spool, client, options = {}) {
    if (!client.inbox)
        return 0;
    const inbox = await client.inbox();
    let materialized = 0;
    for (const message of inbox.messages) {
        const entry = spool.materializeInboxMessage(message);
        if (entry) {
            materialized++;
            options.onInboxMessage?.(message, entry);
        }
    }
    return materialized;
}
export function runSpoolBridge(options) {
    const { spool, client, pollIntervalMs = 1000, signal, logger } = options;
    let stopped = false;
    let timer = null;
    let remoteWatch = null;
    let resolveDone;
    const done = new Promise((resolve) => {
        resolveDone = resolve;
    });
    function stop() {
        if (stopped)
            return;
        stopped = true;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (remoteWatch) {
            remoteWatch.stop();
            remoteWatch = null;
        }
        resolveDone();
    }
    async function tick() {
        if (stopped)
            return;
        try {
            await processSpoolOnce(spool, client, options);
        }
        catch (err) {
            options.stateStore?.recordError(err, {
                nextRetryAt: new Date(Date.now() + pollIntervalMs).toISOString(),
            });
            logger?.(`spool bridge iteration failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!stopped) {
            timer = setTimeout(() => {
                void tick();
            }, pollIntervalMs);
        }
    }
    if (signal) {
        if (signal.aborted) {
            stop();
            return { stop, done };
        }
        signal.addEventListener('abort', stop, { once: true });
    }
    if (options.watch && client.get) {
        remoteWatch = connectRemoteWatch({
            baseUrl: options.watch.baseUrl,
            token: options.watch.token,
            onEvent: (event) => {
                void materializeWatchEvent(spool, client, event, options);
            },
            onStateChange: (state, reason) => {
                if (state === 'fallback' && reason) {
                    logger?.(`spool bridge SSE fallback: ${reason}`);
                }
            },
        });
    }
    void tick();
    return { stop, done };
}
export function parseSpoolCommand(value) {
    const record = requireRecord(value, 'Spool entry');
    if (record['schema'] !== SPOOL_SCHEMA) {
        throw new SpoolValidationError(`Spool entry schema must be ${SPOOL_SCHEMA}.`);
    }
    rejectAuthorityFields(record);
    const kind = record['kind'];
    if (typeof kind !== 'string' || !SPOOL_COMMAND_KINDS.includes(kind)) {
        throw new SpoolValidationError('Spool entry kind is not supported.');
    }
    if (kind === 'read' || kind === 'ack') {
        const messageId = requirePrefixedString(record['message_id'], 'message_id', 'msg_');
        return {
            schema: SPOOL_SCHEMA,
            kind,
            message_id: messageId,
            dedupe_key: optionalPrefixedString(record['dedupe_key'], 'dedupe_key', 'dup_'),
        };
    }
    const sendKind = kind;
    const command = {
        schema: SPOOL_SCHEMA,
        kind: sendKind,
        recipient_id: requireString(record['recipient_id'], 'recipient_id'),
        body: parseSpoolBody(record['body']),
        subject: optionalString(record['subject'], 'subject'),
        in_reply_to: record['in_reply_to'] === null
            ? null
            : optionalPrefixedString(record['in_reply_to'], 'in_reply_to', 'msg_'),
        dedupe_key: optionalPrefixedString(record['dedupe_key'], 'dedupe_key', 'dup_'),
        trace_id: optionalPrefixedString(record['trace_id'], 'trace_id', 'trc_'),
        tool: parseTool(record['tool']),
    };
    return command;
}
function commandToSendOptions(command) {
    return {
        recipientId: command.recipient_id,
        body: encodeCommandBody(command),
        subject: command.subject,
        inReplyTo: command.in_reply_to ?? undefined,
        dedupeKey: command.dedupe_key,
    };
}
function encodeCommandBody(command) {
    if (command.kind === 'message' && !command.tool) {
        return command.body.content;
    }
    return JSON.stringify({
        schema: SPOOL_SCHEMA,
        kind: command.kind,
        body: command.body,
        ...(command.tool ? { tool: command.tool } : {}),
        ...(command.trace_id ? { trace_id: command.trace_id } : {}),
    });
}
function toolRunResultToSpoolCommand(agentId, request, result) {
    return {
        schema: SPOOL_SCHEMA,
        kind: 'tool_result',
        recipient_id: agentId,
        body: {
            format: 'application/json',
            content: JSON.stringify(result, null, 2),
        },
        subject: `Tool result: ${result.tool_name}`,
        in_reply_to: request.in_reply_to ?? null,
        trace_id: request.trace_id,
        tool: {
            name: result.tool_name,
            args: {
                request: request.tool?.args ?? {},
                result,
            },
        },
    };
}
async function materializeWatchEvent(spool, client, event, options) {
    if (!client.get)
        return;
    if (event.event !== 'message_created' && event.event !== 'reply_created')
        return;
    const messageId = event.data['message_id'];
    if (typeof messageId !== 'string')
        return;
    try {
        const message = await client.get(messageId);
        const entry = spool.materializeInboxMessage(message);
        if (entry) {
            options.onInboxMessage?.(message, entry);
        }
        if (event.id) {
            options.stateStore?.recordEventCursor(event.id);
        }
    }
    catch (err) {
        options.logger?.(`spool bridge failed to materialize ${messageId}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function parseSpoolBody(value) {
    if (typeof value === 'string' && value.trim().length > 0) {
        return { format: 'text/markdown', content: value };
    }
    const record = requireRecord(value, 'body');
    return {
        format: optionalString(record['format'], 'body.format') ?? 'text/markdown',
        content: requireString(record['content'], 'body.content'),
    };
}
function parseTool(value) {
    if (value === undefined)
        return undefined;
    if (value === null)
        return null;
    const record = requireRecord(value, 'tool');
    const args = record['args'];
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
        throw new SpoolValidationError('tool.args must be an object when provided.');
    }
    return {
        name: requireString(record['name'], 'tool.name'),
        args: args,
    };
}
function rejectAuthorityFields(record) {
    for (const field of ['sender', 'sender_id', 'sender_device_id', 'sender_login', 'account_id']) {
        if (field in record) {
            throw new SpoolValidationError(`Spool entry must not provide authority field "${field}".`);
        }
    }
}
function requireRecord(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new SpoolValidationError(`${label} must be a JSON object.`);
    }
    return value;
}
function requireString(value, field) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new SpoolValidationError(`${field} is required and must be a non-empty string.`);
    }
    return value;
}
function requirePrefixedString(value, field, prefix) {
    const text = requireString(value, field);
    if (!text.startsWith(prefix)) {
        throw new SpoolValidationError(`${field} must start with "${prefix}".`);
    }
    return text;
}
function optionalString(value, field) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new SpoolValidationError(`${field} must be a non-empty string when provided.`);
    }
    return value;
}
function optionalPrefixedString(value, field, prefix) {
    const text = optionalString(value, field);
    if (text !== undefined && !text.startsWith(prefix)) {
        throw new SpoolValidationError(`${field} must start with "${prefix}".`);
    }
    return text;
}
function isPermanentFailure(err) {
    if (err instanceof SpoolValidationError ||
        err instanceof SpoolPolicyError ||
        err instanceof MaildirEntryError ||
        err instanceof MaildirQuotaError) {
        return true;
    }
    return err instanceof RelayClientError && err.statusCode >= 400 && err.statusCode < 500;
}
function emptyResult() {
    return {
        processed: 0,
        sent: 0,
        queued: 0,
        read: 0,
        acked: 0,
        materialized: 0,
        failed: 0,
        deferred: 0,
        policy_rejected: 0,
        quota_rejected: 0,
        tools_run: 0,
    };
}
//# sourceMappingURL=bridge.js.map