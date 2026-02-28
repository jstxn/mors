/**
 * Adapter module barrel export.
 *
 * This module provides the Phase 2 extension seams for transport and
 * integration adapters. In the MVP, only noop stubs are exported.
 *
 * Usage:
 *   import { NoopTransportAdapter, NoopIntegrationAdapter } from './adapters/index.js';
 *   import type { TransportAdapter, IntegrationAdapter } from './adapters/index.js';
 */

// ── Types ──────────────────────────────────────────────────────────────
export type {
  TransportAdapter,
  TransportEnvelope,
  TransportResult,
  IntegrationAdapter,
  IntegrationEvent,
  IntegrationEventType,
  AdapterMetadata,
  AdapterCapability,
} from './types.js';

// ── Constants ──────────────────────────────────────────────────────────
export { ADAPTER_CAPABILITIES, INTEGRATION_EVENT_TYPES } from './types.js';

// ── Noop Implementations ───────────────────────────────────────────────
export { NoopTransportAdapter, NoopIntegrationAdapter } from './noop.js';
