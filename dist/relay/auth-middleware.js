/**
 * Relay auth middleware for request authentication and authorization.
 *
 * Provides:
 * - Token extraction from Authorization: Bearer <token> header
 * - Pluggable token verification (GitHub API in production, stub in tests)
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
 * Default token verifier that calls the GitHub API.
 *
 * Uses the access token to fetch /user and extract the stable numeric ID.
 * Returns null for invalid/expired tokens (401 from GitHub).
 */
export function createGitHubTokenVerifier(apiBaseUrl) {
    const baseUrl = apiBaseUrl ?? 'https://api.github.com';
    return async (token) => {
        try {
            const response = await fetch(`${baseUrl}/user`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                    'User-Agent': 'mors-relay/0.1.0',
                },
            });
            if (response.status === 401)
                return null;
            if (!response.ok)
                return null;
            const data = await response.json();
            if (typeof data['id'] !== 'number' || typeof data['login'] !== 'string') {
                return null;
            }
            return {
                githubUserId: data['id'],
                githubLogin: data['login'],
            };
        }
        catch {
            return null;
        }
    };
}
//# sourceMappingURL=auth-middleware.js.map