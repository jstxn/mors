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
import type { TransportAdapter, TransportEnvelope, TransportResult, IntegrationAdapter, IntegrationEvent, AdapterMetadata } from './types.js';
/**
 * Noop transport adapter. All operations resolve immediately with
 * no-op results. No network I/O, no state mutation, no side effects.
 */
export declare class NoopTransportAdapter implements TransportAdapter {
    /**
     * Returns a noop result — message is NOT delivered remotely.
     * The local message ID is echoed back for correlation.
     */
    send(envelope: TransportEnvelope): Promise<TransportResult>;
    /**
     * Returns an empty array — no remote messages to receive.
     */
    receive(): Promise<TransportEnvelope[]>;
    /** Returns noop adapter metadata. */
    metadata(): AdapterMetadata;
}
/**
 * Noop integration adapter parameterized by source type.
 * Supports GitHub, Linear, Jira, and email integration stubs.
 * All operations resolve immediately with no external I/O.
 */
export declare class NoopIntegrationAdapter implements IntegrationAdapter {
    private readonly source;
    /**
     * @param source - Integration source identifier (e.g. 'github', 'linear', 'jira', 'email').
     */
    constructor(source: string);
    /**
     * Returns an empty array — no external events to ingest.
     */
    poll(): Promise<IntegrationEvent[]>;
    /**
     * Returns null — no event transformation in noop mode.
     */
    transform(_event: IntegrationEvent): Promise<TransportEnvelope | null>;
    /** Returns metadata identifying this noop adapter by source. */
    metadata(): AdapterMetadata;
}
//# sourceMappingURL=noop.d.ts.map