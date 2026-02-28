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
export class ContractValidationError extends MorsError {
    constructor(message) {
        super(message);
        this.name = 'ContractValidationError';
    }
}
/**
 * Thrown when a delivery state transition is not allowed.
 * Exposes `from` and `to` states for programmatic handling.
 */
export class InvalidStateTransitionError extends MorsError {
    from;
    to;
    constructor(from, to) {
        super(`Invalid state transition from "${from}" to "${to}". ` +
            `Allowed transitions: queued → delivered|failed, delivered → acked|failed.`);
        this.name = 'InvalidStateTransitionError';
        this.from = from;
        this.to = to;
    }
}
//# sourceMappingURL=errors.js.map