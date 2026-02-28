/**
 * Mors-native authentication primitives.
 *
 * Implements invite-token validation and session token generation/verification
 * for the mors-native auth system (replacing GitHub OAuth device flow).
 *
 * Auth flow:
 * 1. User provides an invite token (issued by admin or bootstrap flow)
 * 2. System validates the invite token
 * 3. Device key bootstrap is verified (E2EE device keys must exist)
 * 4. A session token is generated (HMAC-SHA256 based) and persisted
 * 5. Session token is used as Bearer token for relay API calls
 *
 * Covers:
 * - VAL-AUTH-001: Native auth flow (no GitHub dependency)
 * - VAL-AUTH-007: Missing prerequisites fail with actionable guidance
 * - VAL-AUTH-011: Invite-token + device-key bootstrap required
 */
import { MorsError } from '../errors.js';
/** Thrown when an invite token is missing, invalid, or expired. */
export declare class InvalidInviteTokenError extends MorsError {
    constructor(detail?: string);
}
/** Thrown when device-key bootstrap has not been completed. */
export declare class DeviceKeyNotBootstrappedError extends MorsError {
    constructor();
}
/** Thrown when native auth prerequisites are not met. */
export declare class NativeAuthPrerequisiteError extends MorsError {
    readonly missing: string[];
    constructor(missing: string[]);
}
/** Result of validating an invite token. */
export interface InviteValidationResult {
    /** Whether the invite token is valid. */
    valid: boolean;
    /** Account ID assigned by the invite. */
    accountId: string;
    /** Optional handle hint from the invite. */
    handleHint?: string;
    /** Reason for invalidity (if !valid). */
    reason?: string;
}
/** Options for session token generation. */
export interface SessionTokenOptions {
    /** Account ID to bind the token to. */
    accountId: string;
    /** Device ID to bind the token to. */
    deviceId: string;
    /** Secret key for HMAC signing. */
    signingKey: string;
}
/** Parsed and verified session token payload. */
export interface SessionTokenPayload {
    /** Account ID (stable identity key). */
    accountId: string;
    /** Device ID. */
    deviceId: string;
    /** Token issue timestamp (ISO-8601). */
    issuedAt: string;
    /** Token ID (unique per token). */
    tokenId: string;
}
/**
 * Validate an invite token.
 *
 * Checks format and, in the current bootstrap phase, accepts any well-formed
 * token. Returns an account ID derived from the invite token.
 *
 * @param token - The invite token string to validate.
 * @returns Validation result with account ID on success.
 */
export declare function validateInviteToken(token: string | undefined | null): InviteValidationResult;
/**
 * Generate a new invite token.
 *
 * Used by admin/bootstrap flows to create invite tokens.
 *
 * @returns A fresh invite token string.
 */
export declare function generateInviteToken(): string;
/**
 * Session token format: `mors-session.<base64url-payload>.<hex-signature>`
 *
 * The payload is a JSON object with:
 * - accountId: stable account identifier
 * - deviceId: device identifier
 * - issuedAt: ISO-8601 timestamp
 * - tokenId: unique token identifier
 *
 * The signature is HMAC-SHA256 of the payload using the signing key.
 */
/**
 * Generate a session token.
 *
 * Creates an HMAC-signed session token binding an account to a device.
 *
 * @param options - Token generation options.
 * @returns The signed session token string.
 */
export declare function generateSessionToken(options: SessionTokenOptions): string;
/**
 * Verify a session token and extract its payload.
 *
 * Validates the HMAC signature and returns the decoded payload.
 *
 * @param token - The session token to verify.
 * @param signingKey - The key used for HMAC verification.
 * @returns The verified token payload, or null if invalid.
 */
export declare function verifySessionToken(token: string, signingKey: string): SessionTokenPayload | null;
/**
 * Generate or load a signing key for session tokens.
 *
 * The signing key is stored in the config directory. If one exists, it is loaded.
 * Otherwise, a new random key is generated and persisted.
 *
 * @returns The hex-encoded signing key.
 */
export declare function generateSigningKey(): string;
//# sourceMappingURL=native.d.ts.map