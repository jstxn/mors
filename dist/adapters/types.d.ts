/**
 * Adapter type definitions for Phase 2 transport and integration contracts.
 *
 * These types define the extension seams for future relay transport and
 * external integration (GitHub, Linear, Jira, email) without introducing
 * any active remote behavior in the MVP.
 *
 * Design principles:
 * - TransportEnvelope reuses MessageEnvelope for zero-friction composition.
 * - Interfaces are minimal (send/receive for transport, poll/transform for integrations).
 * - All methods are async to accommodate future network I/O.
 * - AdapterMetadata provides runtime introspection for adapter discovery.
 * - Capability constants enable feature-gating by adapter type.
 */
import type { MessageEnvelope } from '../contract/index.js';
/** All recognized adapter capabilities. */
export declare const ADAPTER_CAPABILITIES: readonly ["send", "receive", "poll", "transform", "none"];
/** A single adapter capability value. */
export type AdapterCapability = (typeof ADAPTER_CAPABILITIES)[number];
/** All recognized integration event types. */
export declare const INTEGRATION_EVENT_TYPES: readonly ["issue_created", "issue_comment", "pull_request", "email_received", "ticket_update", "mention"];
/** A single integration event type value. */
export type IntegrationEventType = (typeof INTEGRATION_EVENT_TYPES)[number];
/**
 * Runtime metadata returned by any adapter for identification and
 * capability introspection.
 */
export interface AdapterMetadata {
    /** Short adapter name (e.g. 'noop', 'github', 'smtp-relay'). */
    name: string;
    /** Semver version string. */
    version: string;
    /** Human-readable description of the adapter. */
    description: string;
    /** Capabilities this adapter supports. */
    capabilities: AdapterCapability[];
}
/**
 * Transport envelope is the canonical message shape that flows through
 * transport adapters. It reuses MessageEnvelope directly so that local
 * and remote messages share the same contract.
 */
export type TransportEnvelope = MessageEnvelope;
/**
 * Result of a transport send operation.
 *
 * In the noop implementation `delivered` is always false; a real relay
 * adapter would set it to true on successful remote delivery.
 */
export interface TransportResult {
    /** Whether the message was delivered to the remote target. */
    delivered: boolean;
    /** Local message ID echoed back for correlation. */
    localId: string;
    /** Remote-side ID assigned by the target system (null if undelivered). */
    remoteId: string | null;
    /** Human-readable reason when delivery fails or is skipped. */
    reason: string | null;
}
/**
 * Contract for message transport adapters.
 *
 * A transport adapter is responsible for relaying messages to and from
 * remote peers. In the MVP, only the noop stub is provided. Future
 * implementations may include WebSocket relay, libp2p, or HTTP bridge.
 */
export interface TransportAdapter {
    /**
     * Attempt to send an envelope to a remote destination.
     * Noop adapters resolve immediately with `delivered: false`.
     */
    send(envelope: TransportEnvelope): Promise<TransportResult>;
    /**
     * Poll for inbound messages from a remote source.
     * Noop adapters resolve immediately with an empty array.
     */
    receive(): Promise<TransportEnvelope[]>;
    /** Return adapter metadata for runtime introspection. */
    metadata(): AdapterMetadata;
}
/**
 * An external event ingested from an integration source (GitHub issue
 * comment, Linear ticket update, Jira transition, inbound email, etc.).
 *
 * The `payload` is intentionally loosely typed (`Record<string, unknown>`)
 * because each integration produces a different native schema. The
 * `transform` method on IntegrationAdapter is responsible for mapping
 * the payload into a TransportEnvelope.
 */
export interface IntegrationEvent {
    /** Integration source identifier (e.g. 'github', 'jira'). */
    source: string;
    /** Unique event ID from the external system. */
    externalId: string;
    /** Classified event type for routing. */
    eventType: IntegrationEventType;
    /** Raw payload from the external system. */
    payload: Record<string, unknown>;
    /** ISO-8601 timestamp when the event was received. */
    receivedAt: string;
}
/**
 * Contract for external integration adapters.
 *
 * An integration adapter polls or receives events from an external
 * system and transforms them into mors envelopes for local ingestion.
 *
 * In the MVP, only noop stubs are provided. Future implementations will
 * include GitHub (webhooks/API), Linear (webhook), Jira (REST/webhook),
 * and email (IMAP/SMTP) adapters.
 */
export interface IntegrationAdapter {
    /**
     * Poll the external system for new events.
     * Noop adapters resolve immediately with an empty array.
     */
    poll(): Promise<IntegrationEvent[]>;
    /**
     * Transform an integration event into a mors transport envelope.
     * Returns null if the event cannot be mapped (e.g. unsupported type).
     * Noop adapters always return null.
     */
    transform(event: IntegrationEvent): Promise<TransportEnvelope | null>;
    /** Return adapter metadata for runtime introspection. */
    metadata(): AdapterMetadata;
}
//# sourceMappingURL=types.d.ts.map