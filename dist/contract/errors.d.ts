/**
 * Contract-specific error types for envelope and state validation.
 *
 * These errors are thrown when contract invariants are violated,
 * providing deterministic, actionable error messages.
 */
import { MorsError } from '../errors.js';
/**
 * Thrown when an envelope or field fails contract validation.
 * Provides a deterministic error identifying the invalid field/value.
 */
export declare class ContractValidationError extends MorsError {
    constructor(message: string);
}
/**
 * Thrown when a delivery state transition is not allowed.
 * Exposes `from` and `to` states for programmatic handling.
 */
export declare class InvalidStateTransitionError extends MorsError {
    readonly from: string;
    readonly to: string;
    constructor(from: string, to: string);
}
//# sourceMappingURL=errors.d.ts.map