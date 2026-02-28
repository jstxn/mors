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
import { isPublicRoute, extractAndVerify, extractBearerToken, send401, send403, parseConversationRoute, } from './auth-middleware.js';
import { RelayMessageStore, RelayMessageNotFoundError, RelayUnauthorizedError, } from './message-store.js';
import { AccountStore, DuplicateHandleError, ImmutableHandleError, InvalidHandleError, } from './account-store.js';
import { DedupeConflictError } from '../errors.js';
import { generateEventId } from '../contract/ids.js';
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
 * Write an SSE event to a response stream.
 *
 * Formats the event according to the SSE protocol:
 * - id: <event_id>\n (for Last-Event-ID cursor resume)
 * - event: <event_type>\n (named event)
 * - data: <json_payload>\n\n (event data)
 */
function writeSSE(res, event) {
    let frame = '';
    if (event.id) {
        frame += `id: ${event.id}\n`;
    }
    frame += `event: ${event.event}\n`;
    frame += `data: ${event.data}\n\n`;
    res.write(frame);
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
    const accountStore = options?.accountStore;
    const sseAuthRevalidateMs = options?.sseAuthRevalidateMs ?? 60000;
    const startTime = Date.now();
    // Track active SSE connections for clean shutdown
    const sseConnections = new Set();
    // Track revalidation timers for clean shutdown
    const sseRevalidationTimers = new Set();
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
        // Route: GET /events (SSE stream — auth required)
        // Provides real-time event streaming for message lifecycle transitions.
        // Events are filtered to only include those relevant to the authenticated principal
        // (messages where the user is sender or recipient).
        //
        // Covers: VAL-STREAM-001 (authenticated connection), VAL-STREAM-002 (event shape),
        //         VAL-STREAM-003 (cursor resume), VAL-STREAM-004 (deterministic startup),
        //         VAL-STREAM-005 (duplicate replay → stable event IDs for dedup)
        if (url === '/events' || url.startsWith('/events?')) {
            if (method !== 'GET' && method !== 'HEAD') {
                sendJson(res, 405, { error: 'method_not_allowed', allowed: ['GET'] });
                return;
            }
            // Auto-register device identity on SSE connection (VAL-AUTH-009).
            // SSE connections return early before the general auto-registration path,
            // so we must register the device explicitly here to ensure watch-only
            // clients are represented in device listings.
            if (accountStore) {
                accountStore.registerDevice(principal.accountId, principal.deviceId);
            }
            // Extract Last-Event-ID from header for reconnect resume (VAL-STREAM-003)
            const lastEventId = req.headers['last-event-id'];
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
            });
            // Send initial heartbeat comment (SSE keepalive)
            res.write(': heartbeat\n\n');
            // Send connected event with authenticated principal info (VAL-STREAM-001)
            const connectedEventId = generateEventId();
            writeSSE(res, {
                id: connectedEventId,
                event: 'connected',
                data: JSON.stringify({
                    account_id: principal.accountId,
                    device_id: principal.deviceId,
                }),
            });
            // Track this connection
            sseConnections.add(res);
            // Track the last event ID sent to this connection for auth expiry recovery.
            // Initialized to the connected event ID; advances as replay and live events
            // are delivered so the auth_expired event can report the correct resume cursor.
            let lastSentEventId = connectedEventId;
            // Replay missed events from cursor (VAL-STREAM-003).
            // If no Last-Event-ID, this is a fresh connection — no replay (VAL-STREAM-004).
            // Unknown cursor also results in no replay (graceful fallback).
            // Events are filtered to only include those relevant to the authenticated principal.
            // Replayed events use their original stable event IDs (VAL-STREAM-005).
            if (lastEventId && messageStore) {
                const missedEvents = messageStore.getEventsSince(lastEventId);
                for (const streamEvent of missedEvents) {
                    // Filter: only deliver events relevant to this principal
                    if (streamEvent.sender_id !== principal.accountId &&
                        streamEvent.recipient_id !== principal.accountId) {
                        continue;
                    }
                    writeSSE(res, {
                        id: streamEvent.event_id,
                        event: streamEvent.event_type,
                        data: JSON.stringify({
                            message_id: streamEvent.message_id,
                            thread_id: streamEvent.thread_id,
                            in_reply_to: streamEvent.in_reply_to,
                            sender_id: streamEvent.sender_id,
                            recipient_id: streamEvent.recipient_id,
                            timestamp: streamEvent.timestamp,
                        }),
                    });
                    // Update lastSentEventId to track replayed events consistently
                    // so auth_expired recovery and cursor bookkeeping reflect the
                    // actual last delivered event, not just the connected event.
                    lastSentEventId = streamEvent.event_id;
                }
            }
            // Register the connected event's ID as a valid cursor position
            // so clients can use it as Last-Event-ID on reconnect (VAL-STREAM-003/005).
            // This is done AFTER replay so the cursor position reflects the end of
            // the replay window — reconnecting with this connected event ID will not
            // re-replay events that were already delivered during the replay phase.
            if (messageStore) {
                messageStore.registerCursorPosition(connectedEventId);
            }
            // Subscribe to message store stream events for live delivery (if available)
            let unsubscribe;
            let authExpired = false; // Guard against delivering events after auth expiry
            if (messageStore) {
                unsubscribe = messageStore.onStreamEvent((streamEvent) => {
                    // Do not deliver events after auth has expired (VAL-STREAM-006)
                    if (authExpired)
                        return;
                    // Filter: only deliver events relevant to this principal.
                    // A user sees events for messages where they are sender or recipient.
                    if (streamEvent.sender_id !== principal.accountId &&
                        streamEvent.recipient_id !== principal.accountId) {
                        return;
                    }
                    writeSSE(res, {
                        id: streamEvent.event_id,
                        event: streamEvent.event_type,
                        data: JSON.stringify({
                            message_id: streamEvent.message_id,
                            thread_id: streamEvent.thread_id,
                            in_reply_to: streamEvent.in_reply_to,
                            sender_id: streamEvent.sender_id,
                            recipient_id: streamEvent.recipient_id,
                            timestamp: streamEvent.timestamp,
                        }),
                    });
                    lastSentEventId = streamEvent.event_id;
                });
            }
            // ── Periodic token revalidation (VAL-STREAM-006) ──────────────
            // Re-verify the bearer token at configured intervals during the SSE
            // connection. If the token becomes invalid (expired, revoked), send
            // an auth_expired event with recovery guidance and close the stream.
            // This ensures mid-stream auth expiry is surfaced explicitly rather
            // than leaving the client in a silently stale state.
            let revalidationTimer = null;
            const bearerToken = extractBearerToken(req.headers['authorization']);
            if (sseAuthRevalidateMs > 0 && tokenVerifier && bearerToken) {
                revalidationTimer = setInterval(async () => {
                    if (authExpired)
                        return;
                    try {
                        const revalidated = await tokenVerifier(bearerToken);
                        if (!revalidated) {
                            // Token is no longer valid — send auth_expired event and close
                            authExpired = true;
                            // Unsubscribe from live events immediately to prevent further delivery
                            if (unsubscribe) {
                                unsubscribe();
                                unsubscribe = undefined;
                            }
                            const authExpiredEventId = generateEventId();
                            writeSSE(res, {
                                id: authExpiredEventId,
                                event: 'auth_expired',
                                data: JSON.stringify({
                                    error: 'token_expired',
                                    detail: 'Your authentication token has expired or been revoked. Run "mors login" to re-authenticate.',
                                    last_event_id: lastSentEventId,
                                }),
                            });
                            // Register the auth_expired event as a cursor position for completeness
                            if (messageStore) {
                                messageStore.registerCursorPosition(authExpiredEventId);
                            }
                            // Clean up timer
                            if (revalidationTimer) {
                                clearInterval(revalidationTimer);
                                sseRevalidationTimers.delete(revalidationTimer);
                                revalidationTimer = null;
                            }
                            // Close the connection
                            res.end();
                        }
                    }
                    catch {
                        // Revalidation errors are transient — do not close the stream.
                        // The next interval will retry.
                        logger('SSE auth revalidation check failed (transient), will retry');
                    }
                }, sseAuthRevalidateMs);
                sseRevalidationTimers.add(revalidationTimer);
            }
            // Clean up on client disconnect
            req.on('close', () => {
                sseConnections.delete(res);
                if (unsubscribe) {
                    unsubscribe();
                }
                if (revalidationTimer) {
                    clearInterval(revalidationTimer);
                    sseRevalidationTimers.delete(revalidationTimer);
                }
            });
            return;
        }
        // ── Auto-register device identity on authenticated access (VAL-AUTH-009) ──
        // Every authenticated request with an accountStore auto-registers the
        // device, enabling multi-device tracking without explicit device-registration calls.
        if (accountStore) {
            accountStore.registerDevice(principal.accountId, principal.deviceId);
        }
        // ── Account routes (require accountStore) ─────────────────────
        // Route: POST /accounts/register (register handle + profile)
        // Enforces globally unique, immutable handles (VAL-AUTH-008, VAL-AUTH-012).
        if (url === '/accounts/register' && method === 'POST' && accountStore) {
            const body = await readJsonBody(req);
            if (!body) {
                sendJson(res, 400, { error: 'invalid_body', detail: 'Request body must be valid JSON.' });
                return;
            }
            const handle = body['handle'];
            const displayName = body['display_name'];
            if (typeof handle !== 'string' || handle.trim().length === 0) {
                sendJson(res, 400, {
                    error: 'validation_error',
                    detail: 'handle is required and must be a non-empty string.',
                });
                return;
            }
            if (typeof displayName !== 'string' || displayName.trim().length === 0) {
                sendJson(res, 400, {
                    error: 'validation_error',
                    detail: 'display_name is required and must be a non-empty string.',
                });
                return;
            }
            try {
                const profile = accountStore.register({
                    accountId: principal.accountId,
                    handle,
                    displayName,
                });
                sendJson(res, 201, {
                    account_id: profile.accountId,
                    handle: profile.handle,
                    display_name: profile.displayName,
                    created_at: profile.createdAt,
                });
            }
            catch (err) {
                if (err instanceof InvalidHandleError) {
                    sendJson(res, 400, { error: 'invalid_handle', detail: err.message });
                }
                else if (err instanceof DuplicateHandleError) {
                    sendJson(res, 409, { error: 'duplicate_handle', detail: err.message });
                }
                else if (err instanceof ImmutableHandleError) {
                    sendJson(res, 409, { error: 'immutable_handle', detail: err.message });
                }
                else {
                    throw err;
                }
            }
            return;
        }
        // Route: GET /accounts/me (get own profile)
        if (url === '/accounts/me' && method === 'GET' && accountStore) {
            const profile = accountStore.getByAccountId(principal.accountId);
            if (!profile) {
                sendJson(res, 404, {
                    error: 'not_onboarded',
                    detail: 'Account has not completed onboarding. Run "mors onboard" to register your handle and profile.',
                });
                return;
            }
            sendJson(res, 200, {
                account_id: profile.accountId,
                handle: profile.handle,
                display_name: profile.displayName,
                created_at: profile.createdAt,
            });
            return;
        }
        // Route: GET /accounts/me/devices (list registered device identities, VAL-AUTH-009)
        if (url === '/accounts/me/devices' && method === 'GET' && accountStore) {
            const devices = accountStore.listDevices(principal.accountId);
            sendJson(res, 200, {
                account_id: principal.accountId,
                devices: devices.map((d) => ({
                    device_id: d.deviceId,
                    registered_at: d.registeredAt,
                })),
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
            // ── Sender spoofing prevention (VAL-RELAY-008) ──────────────
            // Actor identity is always derived from the authenticated principal.
            // If the client provides sender_id fields with valid
            // types that don't match the auth principal, reject as a spoof attempt.
            const clientSenderId = body['sender_id'];
            if (typeof clientSenderId === 'string' && clientSenderId !== principal.accountId) {
                send403(res, 'Sender identity mismatch. The sender_id field does not match the authenticated principal. Sender identity is derived from your auth token.');
                return;
            }
            const recipientId = body['recipient_id'];
            const messageBody = body['body'];
            const subject = body['subject'];
            const inReplyTo = body['in_reply_to'];
            const dedupeKey = body['dedupe_key'];
            if (typeof recipientId !== 'string' || recipientId.trim().length === 0) {
                sendJson(res, 400, {
                    error: 'validation_error',
                    detail: 'recipient_id is required and must be a non-empty string.',
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
                result = messageStore.send(principal.accountId, principal.accountId, {
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
                if (err instanceof DedupeConflictError) {
                    sendJson(res, 409, { error: 'dedupe_conflict', detail: err.message });
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
            const messages = messageStore.inbox(principal.accountId, { unreadOnly });
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
                        const result = messageStore.read(messageId, principal.accountId);
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
                        const result = messageStore.ack(messageId, principal.accountId);
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
                    if (!messageStore.isMessageParticipant(messageId, principal.accountId)) {
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
            const isAllowed = await participantStore.isParticipant(convRoute.conversationId, principal.accountId);
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
                    accountId: principal.accountId,
                    deviceId: principal.deviceId,
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
                // Clear all revalidation timers first
                for (const timer of sseRevalidationTimers) {
                    clearInterval(timer);
                }
                sseRevalidationTimers.clear();
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