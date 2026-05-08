import { readFileSync } from 'node:fs';
export const SPOOL_POLICY_SCHEMA = 'mors.spool.policy.v1';
export class SpoolPolicyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SpoolPolicyError';
    }
}
export const DEFAULT_SPOOL_POLICY = {
    schema: SPOOL_POLICY_SCHEMA,
    quotas: {
        maxEntryBytes: 1024 * 1024,
        maxPendingEntries: 1000,
        maxPendingBytes: 64 * 1024 * 1024,
        maxInboxEntries: 10000,
        maxFailedEntries: 1000,
    },
    tools: {
        allowRequests: false,
        allowedNames: [],
        maxArgsBytes: 64 * 1024,
    },
};
export function loadSpoolPolicy(path) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new SpoolPolicyError(`Could not load spool policy ${path}: ${detail}`);
    }
    return normalizeSpoolPolicy(parsed);
}
export function mergeSpoolPolicy(base = DEFAULT_SPOOL_POLICY, overrides = {}) {
    return {
        schema: SPOOL_POLICY_SCHEMA,
        quotas: {
            ...base.quotas,
            ...withoutUndefined(overrides.quotas ?? {}),
        },
        tools: {
            ...base.tools,
            ...withoutUndefined(overrides.tools ?? {}),
        },
    };
}
export function normalizeSpoolPolicy(value) {
    const record = requireRecord(value, 'Spool policy');
    if (record['schema'] !== SPOOL_POLICY_SCHEMA) {
        throw new SpoolPolicyError(`Spool policy schema must be ${SPOOL_POLICY_SCHEMA}.`);
    }
    const quotas = parseQuotaPolicy(record['quotas']);
    const tools = parseToolPolicy(record['tools']);
    return mergeSpoolPolicy(DEFAULT_SPOOL_POLICY, { quotas, tools });
}
export function validateSpoolCommandPolicy(command, policy) {
    if (command.kind !== 'tool_request')
        return;
    if (!policy.tools.allowRequests) {
        throw new SpoolPolicyError('Tool requests are disabled by spool policy. Add an explicit allowed tool policy on the host to enable them.');
    }
    if (!command.tool) {
        throw new SpoolPolicyError('tool_request entries must include a tool object.');
    }
    const allowedNames = policy.tools.allowedNames ?? [];
    if (allowedNames.length > 0 && !allowedNames.includes(command.tool.name)) {
        throw new SpoolPolicyError(`Tool "${command.tool.name}" is not allowed by spool policy.`);
    }
    const argsBytes = Buffer.byteLength(JSON.stringify(command.tool.args ?? {}), 'utf8');
    const maxArgsBytes = policy.tools.maxArgsBytes ?? DEFAULT_SPOOL_POLICY.tools.maxArgsBytes;
    if (maxArgsBytes !== undefined && argsBytes > maxArgsBytes) {
        throw new SpoolPolicyError(`Tool args exceed max size (${maxArgsBytes} bytes): ${argsBytes} bytes.`);
    }
}
function parseQuotaPolicy(value) {
    if (value === undefined)
        return {};
    const record = requireRecord(value, 'quotas');
    return {
        maxEntryBytes: optionalPositiveInteger(record['max_entry_bytes'], 'quotas.max_entry_bytes'),
        maxPendingEntries: optionalPositiveInteger(record['max_pending_entries'], 'quotas.max_pending_entries'),
        maxPendingBytes: optionalPositiveInteger(record['max_pending_bytes'], 'quotas.max_pending_bytes'),
        maxInboxEntries: optionalPositiveInteger(record['max_inbox_entries'], 'quotas.max_inbox_entries'),
        maxFailedEntries: optionalPositiveInteger(record['max_failed_entries'], 'quotas.max_failed_entries'),
    };
}
function parseToolPolicy(value) {
    if (value === undefined)
        return {};
    const record = requireRecord(value, 'tools');
    const allowedNamesRaw = record['allowed_names'];
    let allowedNames;
    if (allowedNamesRaw !== undefined) {
        if (!Array.isArray(allowedNamesRaw)) {
            throw new SpoolPolicyError('tools.allowed_names must be an array of strings.');
        }
        allowedNames = allowedNamesRaw.map((name) => {
            if (typeof name !== 'string' || name.trim().length === 0) {
                throw new SpoolPolicyError('tools.allowed_names entries must be non-empty strings.');
            }
            return name;
        });
    }
    return {
        allowRequests: optionalBoolean(record['allow_requests'], 'tools.allow_requests'),
        allowedNames,
        maxArgsBytes: optionalPositiveInteger(record['max_args_bytes'], 'tools.max_args_bytes'),
    };
}
function requireRecord(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new SpoolPolicyError(`${label} must be a JSON object.`);
    }
    return value;
}
function optionalPositiveInteger(value, field) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new SpoolPolicyError(`${field} must be a positive integer when provided.`);
    }
    return value;
}
function optionalBoolean(value, field) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'boolean') {
        throw new SpoolPolicyError(`${field} must be a boolean when provided.`);
    }
    return value;
}
function withoutUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined));
}
//# sourceMappingURL=policy.js.map