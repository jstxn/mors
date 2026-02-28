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
/** All valid delivery states in lifecycle order. */
export declare const DELIVERY_STATES: readonly ["queued", "delivered", "acked", "failed"];
/** A valid delivery state string. */
export type DeliveryState = (typeof DELIVERY_STATES)[number];
/**
 * Map of allowed state transitions.
 * Each key is a current state; its value is the list of valid next states.
 */
export declare const ALLOWED_TRANSITIONS: Record<DeliveryState, readonly DeliveryState[]>;
/**
 * Check whether a string is a valid delivery state.
 */
export declare function isValidDeliveryState(value: unknown): value is DeliveryState;
/**
 * Validate that a state transition is allowed.
 *
 * @param from - Current delivery state.
 * @param to - Target delivery state.
 * @throws InvalidStateTransitionError if the transition is not in ALLOWED_TRANSITIONS.
 */
export declare function validateStateTransition(from: DeliveryState, to: DeliveryState): void;
//# sourceMappingURL=states.d.ts.map