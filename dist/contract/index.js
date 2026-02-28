/**
 * Contract module barrel export.
 *
 * This module is the single entry point for all envelope/state contract
 * types, validators, ID generators, and errors. It is designed to be
 * imported by all CLI commands (send, read, reply, ack, inbox, watch)
 * to enforce consistent message handling.
 *
 * Usage:
 *   import { MessageEnvelope, validateEnvelope, generateMessageId } from './contract/index.js';
 */
// ── Envelope validation ────────────────────────────────────────────────
export { validateEnvelope, validateEnvelopeForSend, validateEnvelopeForReply, validateMessageId, } from './envelope.js';
// ── ID generation & validation ─────────────────────────────────────────
export { generateMessageId, generateThreadId, generateTraceId, generateDedupeKey, isValidId, isValidOptionalId, isValidPrefixedId, ID_PREFIXES, } from './ids.js';
// ── Delivery states ────────────────────────────────────────────────────
export { DELIVERY_STATES, ALLOWED_TRANSITIONS, isValidDeliveryState, validateStateTransition, } from './states.js';
// ── Contract errors ────────────────────────────────────────────────────
export { ContractValidationError, InvalidStateTransitionError } from './errors.js';
//# sourceMappingURL=index.js.map