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
// ── Public routes (no auth required) ─────────────────────────────────
/** Routes that are publicly accessible without authentication. */
const PUBLIC_ROUTES = new Set(['/health']);
/**
 * Check whether a given URL path is a public route (no auth required).
 */
export function isPublicRoute(url) {
    return PUBLIC_ROUTES.has(url);
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
    return async (token) => {
        try {
            if (!_verifySessionToken) {
                const mod = await import('../auth/native.js');
                _verifySessionToken = mod.verifySessionToken;
            }
            const payload = _verifySessionToken(token, signingKey);
            if (!payload)
                return null;
            return {
                accountId: payload.accountId,
                deviceId: payload.deviceId,
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