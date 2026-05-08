/**
 * Relay auth middleware for request authentication and authorization.
 *
 * Provides:
 * - Token extraction from Authorization: Bearer <token> header
 * - Pluggable token verification (native HMAC tokens in production, stub in tests)
 * - Principal identity extraction from validated tokens
 * - Object-level authorization via participant store
 *
 * Auth is enforced on all routes except explicitly public ones (/health).
 * Token verification returns the authenticated principal or null for
 * invalid/expired tokens. The middleware never trusts client-provided
 * identity — actor is always derived from validated auth context
 * per architecture invariant.
 *
 * Covers:
 * - VAL-AUTH-003: Missing/invalid/expired credentials return 401
 * - VAL-AUTH-004: Non-participant access returns 403 without mutation
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** Authenticated principal identity derived from a validated token. */
export interface AuthPrincipal {
    /** Stable mors account ID (identity key). */
    accountId: string;
    /** Device ID from the session token. */
    deviceId: string;
    /** Optional relay scopes. Undefined means an unrestricted full session. */
    scopes?: string[];
}
/**
 * Token verifier function.
 *
 * Given a bearer token, returns the authenticated principal identity
 * or null if the token is invalid/expired/revoked.
 *
 * In production, this verifies HMAC-signed native session tokens.
 * In tests, this is a stub that maps tokens to principals.
 */
export type TokenVerifier = (token: string) => Promise<AuthPrincipal | null>;
/**
 * Participant store for object-level authorization.
 *
 * Checks whether a given user is a participant of a conversation.
 * Returns true if the user has access, false otherwise.
 */
export interface ParticipantStore {
    isParticipant(conversationId: string, accountId: string): Promise<boolean>;
}
/** Auth result from extractAndVerify. */
export type AuthResult = {
    authenticated: true;
    principal: AuthPrincipal;
} | {
    authenticated: false;
    error: string;
    detail: string;
};
export declare const RELAY_SCOPES: readonly ["messages:read", "messages:write", "messages:state", "events:read", "accounts:read", "accounts:write", "contacts:read", "contacts:write"];
export type RelayScope = (typeof RELAY_SCOPES)[number];
/**
 * Check whether a given URL path is a public route (no auth required).
 *
 * Matches exact paths in PUBLIC_ROUTES and prefix-based matches for
 * routes that accept query parameters (e.g., /.well-known/agent-card.json?handle=x).
 */
export declare function isPublicRoute(url: string): boolean;
/**
 * Extract the bearer token from an Authorization header value.
 *
 * Returns the token string, or null if the header is missing, malformed,
 * or uses a non-Bearer scheme.
 */
export declare function extractBearerToken(authHeader: string | undefined): string | null;
/**
 * Extract and verify the bearer token from a request.
 *
 * @param req - Incoming HTTP request.
 * @param verifier - Token verification function.
 * @returns Auth result with principal on success, or error details on failure.
 */
export declare function extractAndVerify(req: IncomingMessage, verifier: TokenVerifier): Promise<AuthResult>;
/**
 * Send a 401 Unauthorized JSON response.
 * Never includes the token value in the response body.
 */
export declare function send401(res: ServerResponse, detail: string): void;
/**
 * Send a 403 Forbidden JSON response.
 */
export declare function send403(res: ServerResponse, detail: string): void;
export declare function principalHasScope(principal: AuthPrincipal, scope: RelayScope): boolean;
export declare function requireScope(res: ServerResponse, principal: AuthPrincipal, scope: RelayScope): boolean;
/** Parsed conversation route. */
export interface ConversationRoute {
    conversationId: string;
    subpath: string;
}
/**
 * Parse a URL to extract conversation route parameters.
 *
 * Matches: /conversations/:conversationId/...
 * Returns null if the URL is not a conversation route.
 */
export declare function parseConversationRoute(url: string): ConversationRoute | null;
/**
 * Create a native token verifier that validates HMAC-signed session tokens.
 *
 * Uses the signing key to verify the session token signature and extract
 * the principal identity (accountId + deviceId).
 *
 * @param signingKey - The HMAC signing key for token verification.
 * @returns A TokenVerifier function.
 */
export declare function createNativeTokenVerifier(signingKey: string): TokenVerifier;
/**
 * @deprecated Use createNativeTokenVerifier instead. Kept for backward compatibility
 * during transition period only.
 */
export declare function createGitHubTokenVerifier(_apiBaseUrl?: string): TokenVerifier;
//# sourceMappingURL=auth-middleware.d.ts.map