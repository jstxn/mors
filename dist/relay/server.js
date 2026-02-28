/**
 * HTTP server scaffold for the mors relay service.
 *
 * Provides:
 * - Health endpoint for readiness checks (public, no auth)
 * - SSE baseline endpoint for event streaming (auth required)
 * - Conversation API endpoints with auth + participant authorization
 * - Deterministic startup/shutdown with clean process lifecycle
 * - Configurable logger for test observability
 *
 * Auth enforcement:
 * - All routes except /health require a valid Bearer token (VAL-AUTH-003)
 * - Conversation routes additionally require participant authorization (VAL-AUTH-004)
 * - Actor identity is always derived from validated token, never from client payload
 *
 * Uses Node.js built-in http module (no external framework dependency).
 */
import { createServer } from 'node:http';
import { isPublicRoute, extractAndVerify, send401, send403, parseConversationRoute, } from './auth-middleware.js';
import { RelayMessageStore, RelayMessageNotFoundError, RelayUnauthorizedError, } from './message-store.js';
/**
 * Read and parse JSON body from a request.
 * Returns null if body is empty or cannot be parsed.
 */
async function readJsonBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw.trim()) {
                resolve(null);
                return;
            }
            try {
                const parsed = JSON.parse(raw);
                if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                    resolve(parsed);
                }
                else {
                    resolve(null);
                }
            }
            catch {
                resolve(null);
            }
        });
        req.on('error', () => resolve(null));
    });
}
function parseMessageRoute(url, method) {
    // POST /messages (send) — handled separately
    if (url === '/messages' && method === 'POST')
        return null;
    // /messages/:id/read
    const readMatch = url.match(/^\/messages\/([^/]+)\/read$/);
    if (readMatch)
        return { messageId: readMatch[1], action: 'read' };
    // /messages/:id/ack
    const ackMatch = url.match(/^\/messages\/([^/]+)\/ack$/);
    if (ackMatch)
        return { messageId: ackMatch[1], action: 'ack' };
    // /messages/:id (get single message)
    const getMatch = url.match(/^\/messages\/([^/]+)$/);
    if (getMatch)
        return { messageId: getMatch[1], action: 'get' };
    return null;
}
/**
 * Send a JSON response.
 */
function sendJson(res, statusCode, body) {
    const json = JSON.stringify(body);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
}
/**
 * Create a relay server instance.
 *
 * The server exposes:
 * - GET /health — readiness check endpoint (public, no auth)
 * - GET /events — SSE baseline endpoint (auth required)
 * - /conversations/:id/messages — conversation API (auth + participant required)
 * - All other routes return 404
 *
 * @param config - Relay configuration.
 * @param options - Optional server options (logger, auth, etc.).
 * @returns A RelayServer handle for lifecycle management.
 */
export function createRelayServer(config, options) {
    const logger = options?.logger ?? console.log;
    const tokenVerifier = options?.tokenVerifier;
    const participantStore = options?.participantStore;
    const onConversationAccess = options?.onConversationAccess;
    const messageStore = options?.messageStore;
    const startTime = Date.now();
    // Track active SSE connections for clean shutdown
    const sseConnections = new Set();
    /**
     * Async request handler. Separated from createServer callback to
     * enable await for auth verification and participant checks.
     */
    async function handleRequest(req, res) {
        const method = req.method ?? 'GET';
        const url = req.url ?? '/';
        // Route: GET /health (public — no auth required)
        if (isPublicRoute(url)) {
            if (method !== 'GET' && method !== 'HEAD') {
                sendJson(res, 405, { error: 'method_not_allowed', allowed: ['GET'] });
                return;
            }
            const uptimeMs = Date.now() - startTime;
            sendJson(res, 200, {
                status: 'ok',
                service: 'mors-relay',
                uptime: Math.floor(uptimeMs / 1000),
                configWarnings: config.diagnostics.length,
            });
            return;
        }
        // ── Auth guard: all non-public routes require a valid Bearer token.
        // Fail-closed: if no token verifier is configured, protected routes
        // return 401 (never fall through to 200). ──
        if (!tokenVerifier) {
            send401(res, 'Authentication service unavailable. Token verifier is not configured.');
            return;
        }
        const authResult = await extractAndVerify(req, tokenVerifier);
        if (!authResult.authenticated) {
            send401(res, authResult.detail);
            return;
        }
        const principal = authResult.principal;
        // Route: GET /events (SSE baseline — auth required when verifier configured)
        if (url === '/events' || url.startsWith('/events?')) {
            if (method !== 'GET' && method !== 'HEAD') {
                sendJson(res, 405, { error: 'method_not_allowed', allowed: ['GET'] });
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
            });
            // Send initial heartbeat comment (SSE keepalive)
            res.write(': heartbeat\n\n');
            // Track this connection
            sseConnections.add(res);
            // Clean up on client disconnect
            req.on('close', () => {
                sseConnections.delete(res);
            });
            return;
        }
        // ── Messaging routes (require messageStore) ─────────────────────
        // Route: POST /messages (send a message)
        if (url === '/messages' && method === 'POST' && messageStore) {
            const body = await readJsonBody(req);
            if (!body) {
                sendJson(res, 400, { error: 'invalid_body', detail: 'Request body must be valid JSON.' });
                return;
            }
            const recipientId = body['recipient_id'];
            const messageBody = body['body'];
            const subject = body['subject'];
            const inReplyTo = body['in_reply_to'];
            const dedupeKey = body['dedupe_key'];
            if (typeof recipientId !== 'number') {
                sendJson(res, 400, {
                    error: 'validation_error',
                    detail: 'recipient_id is required and must be a number.',
                });
                return;
            }
            if (typeof messageBody !== 'string' || messageBody.trim().length === 0) {
                sendJson(res, 400, {
                    error: 'validation_error',
                    detail: 'body is required and must be a non-empty string.',
                });
                return;
            }
            let result;
            try {
                result = messageStore.send(principal.githubUserId, principal.githubLogin, {
                    recipientId,
                    body: messageBody,
                    subject: typeof subject === 'string' ? subject : undefined,
                    inReplyTo: typeof inReplyTo === 'string' ? inReplyTo : undefined,
                    dedupeKey: typeof dedupeKey === 'string' ? dedupeKey : undefined,
                });
            }
            catch (err) {
                if (err instanceof RelayMessageNotFoundError) {
                    sendJson(res, 404, { error: 'not_found', detail: err.message });
                    return;
                }
                throw err;
            }
            // 201 for newly created, 200 for idempotent dedupe hit
            sendJson(res, result.created ? 201 : 200, result.message);
            return;
        }
        // Route: GET /inbox (list inbox for authenticated user)
        if ((url === '/inbox' || url.startsWith('/inbox?')) && method === 'GET' && messageStore) {
            const urlObj = new URL(url, `http://localhost`);
            const unreadOnly = urlObj.searchParams.get('unread') === 'true';
            const messages = messageStore.inbox(principal.githubUserId, { unreadOnly });
            sendJson(res, 200, { count: messages.length, messages });
            return;
        }
        // Routes: /messages/:id, /messages/:id/read, /messages/:id/ack
        if (messageStore) {
            const msgRoute = parseMessageRoute(url, method);
            if (msgRoute) {
                const { messageId, action } = msgRoute;
                if (action === 'read') {
                    if (method !== 'POST') {
                        sendJson(res, 405, { error: 'method_not_allowed', allowed: ['POST'] });
                        return;
                    }
                    try {
                        const result = messageStore.read(messageId, principal.githubUserId);
                        sendJson(res, 200, { message: result.message, first_read: result.firstRead });
                    }
                    catch (err) {
                        if (err instanceof RelayMessageNotFoundError) {
                            sendJson(res, 404, { error: 'not_found', detail: err.message });
                        }
                        else if (err instanceof RelayUnauthorizedError) {
                            send403(res, err.message);
                        }
                        else {
                            throw err;
                        }
                    }
                    return;
                }
                if (action === 'ack') {
                    if (method !== 'POST') {
                        sendJson(res, 405, { error: 'method_not_allowed', allowed: ['POST'] });
                        return;
                    }
                    try {
                        const result = messageStore.ack(messageId, principal.githubUserId);
                        sendJson(res, 200, { message: result.message, first_ack: result.firstAck });
                    }
                    catch (err) {
                        if (err instanceof RelayMessageNotFoundError) {
                            sendJson(res, 404, { error: 'not_found', detail: err.message });
                        }
                        else if (err instanceof RelayUnauthorizedError) {
                            send403(res, err.message);
                        }
                        else {
                            throw err;
                        }
                    }
                    return;
                }
                if (action === 'get') {
                    if (method !== 'GET') {
                        sendJson(res, 405, { error: 'method_not_allowed', allowed: ['GET'] });
                        return;
                    }
                    const message = messageStore.get(messageId);
                    if (!message) {
                        sendJson(res, 404, { error: 'not_found', detail: `Message not found: ${messageId}` });
                        return;
                    }
                    // Authorization: only sender or recipient can view
                    if (!messageStore.isMessageParticipant(messageId, principal.githubUserId)) {
                        send403(res, 'Not a participant of this conversation. Access denied.');
                        return;
                    }
                    sendJson(res, 200, { message });
                    return;
                }
            }
        }
        // Route: /conversations/:conversationId/... (auth + participant required)
        const convRoute = parseConversationRoute(url);
        if (convRoute) {
            // Object-level authorization: fail-closed when participant store is absent.
            // If no participant store is configured, deny access (never fall through to 200).
            if (!participantStore) {
                send403(res, 'Authorization service unavailable. Participant store is not configured.');
                return;
            }
            const isAllowed = await participantStore.isParticipant(convRoute.conversationId, principal.githubUserId);
            if (!isAllowed) {
                send403(res, `Not a participant of conversation "${convRoute.conversationId}". Access denied.`);
                return;
            }
            // Notify callback for observability/testing
            onConversationAccess?.(principal);
            // Placeholder conversation endpoint — returns success with conversation context
            sendJson(res, 200, {
                conversationId: convRoute.conversationId,
                principal: {
                    githubUserId: principal.githubUserId,
                    githubLogin: principal.githubLogin,
                },
            });
            return;
        }
        // All other routes: 404
        sendJson(res, 404, { error: 'not_found', path: url });
    }
    const httpServer = createServer((req, res) => {
        // Delegate to async handler; catch and report errors
        handleRequest(req, res).catch((err) => {
            logger(`Request handler error: ${err instanceof Error ? err.message : String(err)}`);
            if (!res.headersSent) {
                sendJson(res, 500, { error: 'internal_server_error' });
            }
        });
    });
    let isListening = false;
    let boundPort = config.port;
    const relayServer = {
        start() {
            return new Promise((resolve, reject) => {
                httpServer.once('error', reject);
                httpServer.listen(config.port, config.host, () => {
                    httpServer.removeListener('error', reject);
                    isListening = true;
                    const addr = httpServer.address();
                    if (addr && typeof addr === 'object') {
                        boundPort = addr.port;
                    }
                    logger(`mors-relay listening on http://${config.host}:${boundPort}`);
                    // Log config diagnostics at startup
                    if (config.diagnostics.length > 0) {
                        logger(`config: ${config.diagnostics.length} placeholder(s) unset:`);
                        for (const diag of config.diagnostics) {
                            logger(`  - ${diag.variable}: ${diag.description}`);
                        }
                    }
                    resolve();
                });
            });
        },
        close() {
            if (!isListening) {
                return Promise.resolve();
            }
            return new Promise((resolve) => {
                // Terminate active SSE connections so close doesn't hang
                for (const conn of sseConnections) {
                    conn.end();
                }
                sseConnections.clear();
                httpServer.close(() => {
                    isListening = false;
                    logger('mors-relay stopped');
                    resolve();
                });
            });
        },
        get listening() {
            return isListening;
        },
        get port() {
            return boundPort;
        },
    };
    return relayServer;
}
//# sourceMappingURL=server.js.map