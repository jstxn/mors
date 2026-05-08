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
export const RELAY_SCOPES = [
    'messages:read',
    'messages:write',
    'messages:state',
    'events:read',
    'accounts:read',
    'accounts:write',
    'contacts:read',
    'contacts:write',
];
// ── Token structure inspection ────────────────────────────────────────
/**
 * Check whether a token has the structure of a well-formed mors session token.
 *
 * Returns true if the token has the `mors-session.<base64url>.<hex>` format
 * with a decodable JSON payload containing the required fields (accountId,
 * deviceId, issuedAt, tokenId). This does NOT verify the signature — it only
 * checks structural validity.
 *
 * Used to distinguish signing-key mismatch (well-formed token, wrong signature)
 * from truly invalid/malformed tokens in error reporting.
 */
function isWellFormedMorsSessionToken(token) {
    if (!token || typeof token !== 'string')
        return false;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'mors-session')
        return false;
    const payloadStr = parts[1];
    if (!payloadStr)
        return false;
    try {
        const decoded = Buffer.from(payloadStr, 'base64url').toString('utf-8');
        const payload = JSON.parse(decoded);
        return (typeof payload['accountId'] === 'string' &&
            typeof payload['deviceId'] === 'string' &&
            typeof payload['issuedAt'] === 'string' &&
            typeof payload['tokenId'] === 'string');
    }
    catch {
        return false;
    }
}
// ── Public routes (no auth required) ─────────────────────────────────
/** Routes that are publicly accessible without authentication. */
const PUBLIC_ROUTES = new Set(['/health', '/auth/signup']);
/** Route path prefixes that are publicly accessible (matches path before query string). */
const PUBLIC_ROUTE_PREFIXES = ['/.well-known/agent-card.json'];
/**
 * Check whether a given URL path is a public route (no auth required).
 *
 * Matches exact paths in PUBLIC_ROUTES and prefix-based matches for
 * routes that accept query parameters (e.g., /.well-known/agent-card.json?handle=x).
 */
export function isPublicRoute(url) {
    if (PUBLIC_ROUTES.has(url))
        return true;
    // Strip query string for prefix matching
    const pathOnly = url.split('?')[0];
    return PUBLIC_ROUTE_PREFIXES.some((prefix) => pathOnly === prefix);
}
// ── Token extraction ─────────────────────────────────────────────────
/**
 * Extract the bearer token from an Authorization header value.
 *
 * Returns the token string, or null if the header is missing, malformed,
 * or uses a non-Bearer scheme.
 */
export function extractBearerToken(authHeader) {
    if (!authHeader)
        return null;
    // Must be "Bearer <token>" format
    if (!authHeader.startsWith('Bearer '))
        return null;
    const token = authHeader.slice(7).trim();
    if (!token)
        return null;
    return token;
}
// ── Auth middleware ──────────────────────────────────────────────────
/**
 * Extract and verify the bearer token from a request.
 *
 * @param req - Incoming HTTP request.
 * @param verifier - Token verification function.
 * @returns Auth result with principal on success, or error details on failure.
 */
export async function extractAndVerify(req, verifier) {
    const authHeader = req.headers['authorization'];
    const token = extractBearerToken(authHeader);
    if (!token) {
        return {
            authenticated: false,
            error: 'unauthorized',
            detail: 'Missing or malformed Authorization header. A Bearer token is required.',
        };
    }
    const principal = await verifier(token);
    if (!principal) {
        // Distinguish signing-key mismatch from generic invalid token on the relay side.
        // A well-formed mors-session token (valid prefix + decodable payload) that fails
        // verification likely means the CLI and relay are using different signing keys.
        if (isWellFormedMorsSessionToken(token)) {
            return {
                authenticated: false,
                error: 'unauthorized',
                detail: 'Token signature mismatch — the session token appears valid but was signed with a different key. ' +
                    'Ensure MORS_RELAY_SIGNING_KEY is the same value used by both CLI and relay, ' +
                    'then run "mors login" to re-authenticate.',
            };
        }
        return {
            authenticated: false,
            error: 'unauthorized',
            detail: 'Invalid or expired token. Run "mors login" to re-authenticate.',
        };
    }
    return { authenticated: true, principal };
}
/**
 * Send a 401 Unauthorized JSON response.
 * Never includes the token value in the response body.
 */
export function send401(res, detail) {
    const json = JSON.stringify({ error: 'unauthorized', detail });
    res.writeHead(401, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
        'WWW-Authenticate': 'Bearer',
    });
    res.end(json);
}
/**
 * Send a 403 Forbidden JSON response.
 */
export function send403(res, detail) {
    const json = JSON.stringify({ error: 'forbidden', detail });
    res.writeHead(403, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
}
export function principalHasScope(principal, scope) {
    if (principal.scopes === undefined)
        return true;
    return principal.scopes.includes(scope);
}
export function requireScope(res, principal, scope) {
    if (principalHasScope(principal, scope))
        return true;
    send403(res, `Token scope "${scope}" is required for this relay action.`);
    return false;
}
/**
 * Parse a URL to extract conversation route parameters.
 *
 * Matches: /conversations/:conversationId/...
 * Returns null if the URL is not a conversation route.
 */
export function parseConversationRoute(url) {
    const match = url.match(/^\/conversations\/([^/]+)(\/.*)?$/);
    if (!match)
        return null;
    return {
        conversationId: match[1],
        subpath: match[2] ?? '',
    };
}
/**
 * Create a native token verifier that validates HMAC-signed session tokens.
 *
 * Uses the signing key to verify the session token signature and extract
 * the principal identity (accountId + deviceId).
 *
 * @param signingKey - The HMAC signing key for token verification.
 * @returns A TokenVerifier function.
 */
export function createNativeTokenVerifier(signingKey) {
    // Lazy import to avoid circular dependency at module level
    let _verifySessionToken = null;
    // Fail-closed: an empty or whitespace-only signing key must never verify tokens.
    // This prevents token forgery by ensuring HMAC verification always uses a real key.
    const effectiveKey = signingKey.trim();
    return async (token) => {
        // Reject all tokens when the signing key is empty — fail-closed guard.
        if (!effectiveKey)
            return null;
        try {
            if (!_verifySessionToken) {
                const mod = await import('../auth/native.js');
                _verifySessionToken = mod.verifySessionToken;
            }
            const payload = _verifySessionToken(token, effectiveKey);
            if (!payload)
                return null;
            return {
                accountId: payload.accountId,
                deviceId: payload.deviceId,
                ...(payload.scopes ? { scopes: payload.scopes } : {}),
            };
        }
        catch {
            return null;
        }
    };
}
/**
 * @deprecated Use createNativeTokenVerifier instead. Kept for backward compatibility
 * during transition period only.
 */
export function createGitHubTokenVerifier(_apiBaseUrl) {
    // Return a verifier that always rejects — GitHub auth is no longer supported
    return async (_token) => {
        return null;
    };
}
//# sourceMappingURL=auth-middleware.js.map