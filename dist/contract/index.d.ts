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
export type { MessageEnvelope } from './envelope.js';
export type { DeliveryState } from './states.js';
export { validateEnvelope, validateEnvelopeForSend, validateEnvelopeForReply, validateMessageId, } from './envelope.js';
export { generateMessageId, generateThreadId, generateTraceId, generateDedupeKey, isValidId, isValidOptionalId, isValidPrefixedId, ID_PREFIXES, } from './ids.js';
export type { IdType } from './ids.js';
export { DELIVERY_STATES, ALLOWED_TRANSITIONS, isValidDeliveryState, validateStateTransition, } from './states.js';
export { ContractValidationError, InvalidStateTransitionError } from './errors.js';
//# sourceMappingURL=index.d.ts.map