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
// ── Capability & Event Constants ───────────────────────────────────────
/** All recognized adapter capabilities. */
export const ADAPTER_CAPABILITIES = [
    'send',
    'receive',
    'poll',
    'transform',
    'none',
];
/** All recognized integration event types. */
export const INTEGRATION_EVENT_TYPES = [
    'issue_created',
    'issue_comment',
    'pull_request',
    'email_received',
    'ticket_update',
    'mention',
];
//# sourceMappingURL=types.js.map