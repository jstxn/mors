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

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { MorsError } from '../errors.js';

/** Default session-token lifetime: 30 days. */
export const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Constant-time comparison of two hex-encoded signatures.
 *
 * Returns false for length mismatches or empty inputs, and otherwise compares
 * in constant time via {@link timingSafeEqual} so verification does not leak
 * signature bytes through timing.
 */
function signaturesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, 'hex');
  const bBuf = Buffer.from(b, 'hex');
  if (aBuf.length === 0 || aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// ── Error types ──────────────────────────────────────────────────────

/** Thrown when an invite token is missing, invalid, or expired. */
export class InvalidInviteTokenError extends MorsError {
  constructor(detail?: string) {
    super(
      'Invalid or missing invite token. ' +
        'A valid invite token is required to activate your mors account. ' +
        'Obtain an invite token from an existing mors user or admin.' +
        (detail ? ` (${detail})` : '')
    );
    this.name = 'InvalidInviteTokenError';
  }
}

/** Thrown when device-key bootstrap has not been completed. */
export class DeviceKeyNotBootstrappedError extends MorsError {
  constructor() {
    super(
      'Device encryption keys have not been bootstrapped. ' +
        'Run "mors init" to generate device keys before authenticating. ' +
        'Device key bootstrap is required for secure messaging.'
    );
    this.name = 'DeviceKeyNotBootstrappedError';
  }
}

/** Thrown when native auth prerequisites are not met. */
export class NativeAuthPrerequisiteError extends MorsError {
  readonly missing: string[];

  constructor(missing: string[]) {
    const list = missing.join(', ');
    super(
      `Missing required authentication prerequisites: ${list}. ` +
        'Complete the following before authenticating:\n' +
        missing
          .map((m) => {
            switch (m) {
              case 'invite_token':
                return '  - Provide a valid invite token (--invite-token <token>)';
              case 'device_keys':
                return '  - Run "mors init" to bootstrap device encryption keys';
              case 'initialized':
                return '  - Run "mors init" to initialize your mors instance';
              default:
                return `  - ${m}`;
            }
          })
          .join('\n')
    );
    this.name = 'NativeAuthPrerequisiteError';
    this.missing = missing;
  }
}

// ── Types ────────────────────────────────────────────────────────────

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
  /** Optional relay scopes for restricted sandbox or VM direct-access tokens. */
  scopes?: string[];
  /**
   * Token lifetime in seconds. Defaults to {@link DEFAULT_SESSION_TTL_SECONDS}.
   * Values <= 0 fall back to the default; tokens always carry an expiry.
   */
  expiresInSeconds?: number;
}

/** Parsed and verified session token payload. */
export interface SessionTokenPayload {
  /** Account ID (stable identity key). */
  accountId: string;
  /** Device ID. */
  deviceId: string;
  /** Token issue timestamp (ISO-8601). */
  issuedAt: string;
  /** Token expiry timestamp (ISO-8601). Absent only on legacy pre-expiry tokens. */
  expiresAt?: string;
  /** Token ID (unique per token). */
  tokenId: string;
  /** Optional relay scopes. Absence means a full session token. */
  scopes?: string[];
}

// ── Invite token validation ──────────────────────────────────────────

/**
 * Invite token format: `mors-invite-<random-hex>` (at least 32 hex chars).
 *
 * In the current bootstrap phase, any well-formed invite token is accepted.
 * Future iterations will validate against an issuer registry or relay API.
 */
const INVITE_TOKEN_PATTERN = /^mors-invite-[0-9a-f]{32,}$/;

/**
 * Validate an invite token.
 *
 * Checks format and, in the current bootstrap phase, accepts any well-formed
 * token. Returns an account ID derived from the invite token.
 *
 * @param token - The invite token string to validate.
 * @returns Validation result with account ID on success.
 */
export function validateInviteToken(token: string | undefined | null): InviteValidationResult {
  if (!token || typeof token !== 'string' || token.trim() === '') {
    return {
      valid: false,
      accountId: '',
      reason: 'Invite token is required but was not provided.',
    };
  }

  const trimmed = token.trim();

  if (!INVITE_TOKEN_PATTERN.test(trimmed)) {
    return {
      valid: false,
      accountId: '',
      reason:
        'Invite token format is invalid. Expected format: mors-invite-<hex> (at least 32 hex characters).',
    };
  }

  // Derive a stable account ID from the invite token.
  // In bootstrap phase, the account ID is a hash of the invite token.
  const accountId = createHmac('sha256', 'mors-account-derivation')
    .update(trimmed)
    .digest('hex')
    .slice(0, 32);

  return {
    valid: true,
    accountId,
  };
}

/**
 * Generate a new invite token.
 *
 * Used by admin/bootstrap flows to create invite tokens.
 *
 * @returns A fresh invite token string.
 */
export function generateInviteToken(): string {
  return `mors-invite-${randomBytes(32).toString('hex')}`;
}

// ── Session token generation and verification ────────────────────────

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
export function generateSessionToken(options: SessionTokenOptions): string {
  const issuedAt = new Date();
  const ttlSeconds =
    options.expiresInSeconds !== undefined && options.expiresInSeconds > 0
      ? options.expiresInSeconds
      : DEFAULT_SESSION_TTL_SECONDS;
  const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1000);

  const payload: SessionTokenPayload = {
    accountId: options.accountId,
    deviceId: options.deviceId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    tokenId: randomUUID(),
    ...(options.scopes ? { scopes: options.scopes } : {}),
  };

  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', options.signingKey).update(payloadStr).digest('hex');

  return `mors-session.${payloadStr}.${signature}`;
}

/**
 * Verify a session token and extract its payload.
 *
 * Validates the HMAC signature and returns the decoded payload.
 *
 * @param token - The session token to verify.
 * @param signingKey - The key used for HMAC verification.
 * @returns The verified token payload, or null if invalid.
 */
export function verifySessionToken(
  token: string,
  signingKey: string,
  options: { now?: number } = {}
): SessionTokenPayload | null {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'mors-session') return null;

  const [, payloadStr, signature] = parts;
  if (!payloadStr || !signature) return null;

  // Verify HMAC signature in constant time to avoid leaking signature bytes.
  const expectedSignature = createHmac('sha256', signingKey).update(payloadStr).digest('hex');
  if (!signaturesMatch(signature, expectedSignature)) return null;

  // Decode payload
  try {
    const decoded = Buffer.from(payloadStr, 'base64url').toString('utf-8');
    const payload = JSON.parse(decoded) as Record<string, unknown>;

    if (
      typeof payload['accountId'] !== 'string' ||
      typeof payload['deviceId'] !== 'string' ||
      typeof payload['issuedAt'] !== 'string' ||
      typeof payload['tokenId'] !== 'string'
    ) {
      return null;
    }

    // Enforce expiry when present. Tokens issued by generateSessionToken always
    // carry expiresAt; a captured token stops being accepted once it lapses.
    const expiresAt = typeof payload['expiresAt'] === 'string' ? payload['expiresAt'] : undefined;
    if (expiresAt !== undefined) {
      const expiresMs = Date.parse(expiresAt);
      const now = options.now ?? Date.now();
      if (!Number.isFinite(expiresMs) || now >= expiresMs) return null;
    }

    const scopes = Array.isArray(payload['scopes'])
      ? payload['scopes'].filter((scope): scope is string => typeof scope === 'string')
      : undefined;

    return {
      accountId: payload['accountId'] as string,
      deviceId: payload['deviceId'] as string,
      issuedAt: payload['issuedAt'] as string,
      tokenId: payload['tokenId'] as string,
      ...(expiresAt ? { expiresAt } : {}),
      ...(scopes ? { scopes } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Check whether a token is a structurally valid mors session token
 * (correct prefix, decodable payload with required fields) but has
 * an invalid signature for the given key.
 *
 * Returns true when the token looks like a legitimate mors-session token
 * that was signed with a different key — i.e., a signing-key mismatch.
 * Returns false for malformed tokens, non-mors tokens, or tokens
 * with corrupted/undecodable payloads.
 *
 * This enables distinguishing "wrong key" from "garbage token" in error
 * reporting, so users get actionable remediation guidance.
 */
export function isSigningKeyMismatch(token: string, signingKey: string): boolean {
  if (!token || typeof token !== 'string') return false;

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'mors-session') return false;

  const [, payloadStr, signature] = parts;
  if (!payloadStr || !signature) return false;

  // Check that the payload decodes to valid JSON with required fields
  try {
    const decoded = Buffer.from(payloadStr, 'base64url').toString('utf-8');
    const payload = JSON.parse(decoded) as Record<string, unknown>;

    if (
      typeof payload['accountId'] !== 'string' ||
      typeof payload['deviceId'] !== 'string' ||
      typeof payload['issuedAt'] !== 'string' ||
      typeof payload['tokenId'] !== 'string'
    ) {
      return false;
    }
  } catch {
    // Payload is not decodable — not a key mismatch, just garbage
    return false;
  }

  // Payload is structurally valid. Now check if the signature mismatches.
  const expectedSignature = createHmac('sha256', signingKey).update(payloadStr).digest('hex');

  // If the signature matches, this is NOT a mismatch (token is actually valid).
  if (signaturesMatch(signature, expectedSignature)) return false;

  // Structurally valid payload but wrong signature → signing-key mismatch
  return true;
}

/**
 * Generate or load a signing key for session tokens.
 *
 * The signing key is stored in the config directory. If one exists, it is loaded.
 * Otherwise, a new random key is generated and persisted.
 *
 * @returns The hex-encoded signing key.
 */
export function generateSigningKey(): string {
  return randomBytes(32).toString('hex');
}
