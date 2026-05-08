import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export const SPOOL_BRIDGE_STATE_SCHEMA = 'mors.spool.bridge-state.v1';
const STATE_FILE_MODE = 0o600;
const STATE_DIR_MODE = 0o700;
export class SpoolBridgeStateStore {
    path;
    agentId;
    constructor(options) {
        this.path = options.path;
        this.agentId = options.agentId;
    }
    load() {
        if (!existsSync(this.path))
            return null;
        try {
            const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
            if (parsed['schema'] !== SPOOL_BRIDGE_STATE_SCHEMA)
                return null;
            if (parsed['agent_id'] !== this.agentId)
                return null;
            return parsed;
        }
        catch {
            return null;
        }
    }
    recordResult(result, options = {}) {
        const previous = this.load();
        this.save({
            schema: SPOOL_BRIDGE_STATE_SCHEMA,
            agent_id: this.agentId,
            updated_at: new Date().toISOString(),
            consecutive_failures: result.deferred > 0 ? (previous?.consecutive_failures ?? 0) + 1 : 0,
            last_result: result,
            ...(result.deferred > 0 ? { last_error: 'One or more entries deferred.' } : {}),
            ...(options.nextRetryAt ? { next_retry_at: options.nextRetryAt } : {}),
            ...(previous?.last_event_id ? { last_event_id: previous.last_event_id } : {}),
        });
    }
    recordError(err, options = {}) {
        const previous = this.load();
        this.save({
            schema: SPOOL_BRIDGE_STATE_SCHEMA,
            agent_id: this.agentId,
            updated_at: new Date().toISOString(),
            consecutive_failures: (previous?.consecutive_failures ?? 0) + 1,
            ...(previous?.last_result ? { last_result: previous.last_result } : {}),
            last_error: err instanceof Error ? err.message : String(err),
            ...(options.nextRetryAt ? { next_retry_at: options.nextRetryAt } : {}),
            ...(previous?.last_event_id ? { last_event_id: previous.last_event_id } : {}),
        });
    }
    recordEventCursor(eventId) {
        const previous = this.load();
        this.save({
            schema: SPOOL_BRIDGE_STATE_SCHEMA,
            agent_id: this.agentId,
            updated_at: new Date().toISOString(),
            consecutive_failures: previous?.consecutive_failures ?? 0,
            ...(previous?.last_result ? { last_result: previous.last_result } : {}),
            ...(previous?.last_error ? { last_error: previous.last_error } : {}),
            ...(previous?.next_retry_at ? { next_retry_at: previous.next_retry_at } : {}),
            last_event_id: eventId,
        });
    }
    save(state) {
        mkdirOwnerOnly(dirname(this.path));
        const tempPath = `${this.path}.tmp`;
        writeFileSync(tempPath, JSON.stringify(state, null, 2) + '\n', { mode: STATE_FILE_MODE });
        chmodSync(tempPath, STATE_FILE_MODE);
        renameSync(tempPath, this.path);
        chmodSync(this.path, STATE_FILE_MODE);
    }
}
export function defaultSpoolBridgeStatePath(spool) {
    return join(spool.agentRoot, 'bridge-state.json');
}
function mkdirOwnerOnly(path) {
    const existed = existsSync(path);
    mkdirSync(path, { recursive: true, mode: STATE_DIR_MODE });
    if (!existed) {
        chmodSync(path, STATE_DIR_MODE);
    }
}
//# sourceMappingURL=state.js.map