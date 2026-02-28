/**
 * Delivery state definitions and transition validation for the mors envelope contract.
 *
 * Lifecycle: queued → delivered → acked
 *                  ↘ failed    ↘ failed
 *
 * Terminal states: acked, failed (no further transitions allowed).
 *
 * Key invariant: queued → acked is NOT allowed (must go through delivered).
 * This ensures that read (delivered) and ack are always separate operations.
 */

import { InvalidStateTransitionError } from './errors.js';

/** All valid delivery states in lifecycle order. */
export const DELIVERY_STATES = ['queued', 'delivered', 'acked', 'failed'] as const;

/** A valid delivery state string. */
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/**
 * Map of allowed state transitions.
 * Each key is a current state; its value is the list of valid next states.
 */
export const ALLOWED_TRANSITIONS: Record<DeliveryState, readonly DeliveryState[]> = {
  queued: ['delivered', 'failed'],
  delivered: ['acked', 'failed'],
  acked: [],
  failed: [],
} as const;

/**
 * Check whether a string is a valid delivery state.
 */
export function isValidDeliveryState(value: unknown): value is DeliveryState {
  return typeof value === 'string' && (DELIVERY_STATES as readonly string[]).includes(value);
}

/**
 * Validate that a state transition is allowed.
 *
 * @param from - Current delivery state.
 * @param to - Target delivery state.
 * @throws InvalidStateTransitionError if the transition is not in ALLOWED_TRANSITIONS.
 */
export function validateStateTransition(from: DeliveryState, to: DeliveryState): void {
  if (!isValidDeliveryState(from) || !isValidDeliveryState(to)) {
    throw new InvalidStateTransitionError(from, to);
  }

  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}
