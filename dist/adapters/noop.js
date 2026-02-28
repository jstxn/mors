/**
 * Noop (no-operation) adapter implementations for Phase 2 stubs.
 *
 * These implementations satisfy the TransportAdapter and IntegrationAdapter
 * contracts without introducing any active remote relay or integration behavior.
 * They serve as:
 * - Default stubs for the MVP local-only mode.
 * - Reference implementations showing the expected method signatures.
 * - Extension seams that can be replaced with real adapters in Phase 2.
 */
/**
 * Noop transport adapter. All operations resolve immediately with
 * no-op results. No network I/O, no state mutation, no side effects.
 */
export class NoopTransportAdapter {
    /**
     * Returns a noop result — message is NOT delivered remotely.
     * The local message ID is echoed back for correlation.
     */
    async send(envelope) {
        return {
            delivered: false,
            localId: envelope.id,
            remoteId: null,
            reason: 'noop',
        };
    }
    /**
     * Returns an empty array — no remote messages to receive.
     */
    async receive() {
        return [];
    }
    /** Returns noop adapter metadata. */
    metadata() {
        return {
            name: 'noop',
            version: '0.0.0',
            description: 'No-operation transport adapter (Phase 2 stub)',
            capabilities: ['none'],
        };
    }
}
/**
 * Noop integration adapter parameterized by source type.
 * Supports GitHub, Linear, Jira, and email integration stubs.
 * All operations resolve immediately with no external I/O.
 */
export class NoopIntegrationAdapter {
    source;
    /**
     * @param source - Integration source identifier (e.g. 'github', 'linear', 'jira', 'email').
     */
    constructor(source) {
        this.source = source;
    }
    /**
     * Returns an empty array — no external events to ingest.
     */
    async poll() {
        return [];
    }
    /**
     * Returns null — no event transformation in noop mode.
     */
    async transform(_event) {
        return null;
    }
    /** Returns metadata identifying this noop adapter by source. */
    metadata() {
        return {
            name: this.source,
            version: '0.0.0',
            description: `No-operation ${this.source} integration adapter (Phase 2 stub)`,
            capabilities: ['none'],
        };
    }
}
//# sourceMappingURL=noop.js.map