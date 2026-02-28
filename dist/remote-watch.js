/**
 * Remote watch SSE client for the mors CLI.
 *
 * Provides a client-side SSE connection to the relay /events endpoint
 * with authenticated session, reconnect support using Last-Event-ID
 * cursor, and explicit degraded fallback indication when SSE is
 * unavailable.
 *
 * Covers:
 * - VAL-STREAM-001: watch --remote connects to relay SSE with auth session
 * - VAL-STREAM-003: Reconnect resumes from cursor/Last-Event-ID
 * - VAL-STREAM-007: Fallback mode works when SSE is unavailable
 */
import http from 'node:http';
import https from 'node:https';
// ── SSE parsing ──────────────────────────────────────────────────────
/** Parse raw SSE text into structured events. */
function parseSSEChunk(raw) {
    const events = [];
    const blocks = raw.split('\n\n').filter((b) => b.trim().length > 0);
    for (const block of blocks) {
        const lines = block.split('\n');
        const isCommentOnly = lines.every((l) => l.startsWith(':') || l.trim() === '');
        if (isCommentOnly)
            continue;
        const event = {};
        for (const line of lines) {
            if (line.startsWith(':'))
                continue;
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1)
                continue;
            const field = line.slice(0, colonIdx);
            const value = line.slice(colonIdx + 1).trimStart();
            if (field === 'id')
                event.id = value;
            if (field === 'event')
                event.event = value;
            if (field === 'data')
                event.data = event.data ? event.data + '\n' + value : value;
        }
        if (event.event || event.data || event.id) {
            events.push(event);
        }
    }
    return events;
}
// ── Connection ───────────────────────────────────────────────────────
/**
 * Connect to the relay SSE /events endpoint for remote watch.
 *
 * Establishes an authenticated SSE connection with the relay server.
 * Supports cursor resume via Last-Event-ID for reconnect semantics.
 * When SSE is unavailable (connection refused, auth failure, server error),
 * enters explicit fallback/degraded mode with a descriptive reason.
 *
 * @param options - Remote watch connection options.
 * @returns A RemoteWatchHandle for lifecycle management.
 */
export function connectRemoteWatch(options) {
    const { baseUrl, token, lastEventId: initialLastEventId, onEvent, onStateChange, connectTimeoutMs = 10000, } = options;
    let state = 'connecting';
    let fallbackReason;
    const events = [];
    let currentLastEventId = initialLastEventId;
    let req = null;
    let res = null;
    let stopped = false;
    let resolveDone;
    const done = new Promise((resolve) => {
        resolveDone = resolve;
    });
    function setState(newState, reason) {
        state = newState;
        if (reason !== undefined) {
            fallbackReason = reason;
        }
        onStateChange?.(newState, reason);
    }
    function emitEvent(evt) {
        events.push(evt);
        if (evt.id) {
            currentLastEventId = evt.id;
        }
        onEvent?.(evt);
    }
    function enterFallback(reason) {
        if (stopped)
            return;
        setState('fallback', reason);
        const fallbackEvent = {
            event: 'fallback',
            data: {
                mode: 'degraded',
                reason,
            },
        };
        emitEvent(fallbackEvent);
        cleanup();
    }
    function cleanup() {
        if (res) {
            res.destroy();
            res = null;
        }
        if (req) {
            req.destroy();
            req = null;
        }
        resolveDone();
    }
    function stop() {
        if (stopped)
            return;
        stopped = true;
        setState('stopped');
        cleanup();
    }
    // Parse the URL to determine http vs https
    const url = new URL(baseUrl);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;
    const port = url.port ? parseInt(url.port, 10) : defaultPort;
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
    };
    if (initialLastEventId) {
        headers['Last-Event-ID'] = initialLastEventId;
    }
    // Set up connection timeout
    const connectTimeout = setTimeout(() => {
        if (state === 'connecting' && !stopped) {
            enterFallback('Connection timed out — relay SSE endpoint may be unavailable. Realtime watch is running in degraded mode.');
            if (req) {
                req.destroy();
                req = null;
            }
        }
    }, connectTimeoutMs);
    req = httpModule.request({
        hostname: url.hostname,
        port,
        path: '/events',
        method: 'GET',
        headers,
    }, (response) => {
        clearTimeout(connectTimeout);
        res = response;
        const statusCode = response.statusCode ?? 0;
        // Handle non-200 responses → fallback
        if (statusCode === 401) {
            enterFallback('Authentication failed (401 Unauthorized). Run "mors login" to re-authenticate. Realtime watch is running in degraded mode.');
            return;
        }
        if (statusCode >= 500) {
            enterFallback(`Relay returned ${statusCode} — SSE service temporarily unavailable. Realtime watch is running in degraded mode.`);
            return;
        }
        if (statusCode !== 200) {
            enterFallback(`Unexpected response (${statusCode}) from relay SSE endpoint. Realtime watch is running in degraded mode.`);
            return;
        }
        // Successful SSE connection — process the stream
        response.setEncoding('utf8');
        // Buffer for incomplete SSE frames across chunks
        let sseBuffer = '';
        response.on('data', (chunk) => {
            if (stopped)
                return;
            sseBuffer += chunk;
            // Process complete SSE frames (separated by double newlines)
            // Keep any trailing incomplete frame in the buffer
            const lastDoubleNewline = sseBuffer.lastIndexOf('\n\n');
            if (lastDoubleNewline === -1)
                return; // No complete frame yet
            const complete = sseBuffer.slice(0, lastDoubleNewline + 2);
            sseBuffer = sseBuffer.slice(lastDoubleNewline + 2);
            const parsed = parseSSEChunk(complete);
            for (const raw of parsed) {
                if (!raw.event && !raw.data)
                    continue;
                let data = {};
                if (raw.data) {
                    try {
                        data = JSON.parse(raw.data);
                    }
                    catch {
                        data = { raw: raw.data };
                    }
                }
                const evt = {
                    id: raw.id,
                    event: raw.event ?? 'message',
                    data,
                };
                // Update state based on event type
                if (evt.event === 'connected' && state !== 'connected') {
                    setState('connected');
                }
                if (evt.event === 'auth_expired') {
                    // Auth expired mid-stream — emit the event and let the caller handle it
                    emitEvent(evt);
                    return;
                }
                emitEvent(evt);
            }
        });
        response.on('end', () => {
            if (!stopped && state === 'connected') {
                // Server closed the connection
                cleanup();
            }
        });
        response.on('error', () => {
            if (!stopped) {
                enterFallback('SSE connection error. Realtime watch is running in degraded mode.');
            }
        });
    });
    req.on('error', (err) => {
        clearTimeout(connectTimeout);
        if (stopped)
            return;
        if (err.code === 'ECONNREFUSED') {
            enterFallback('Connection refused — relay SSE endpoint is unavailable. Realtime watch is running in degraded mode.');
        }
        else {
            enterFallback(`SSE connection failed: ${err.message}. Realtime watch is running in degraded mode.`);
        }
    });
    req.end();
    const handle = {
        get state() {
            return state;
        },
        get fallbackReason() {
            return fallbackReason;
        },
        events,
        get lastEventId() {
            return currentLastEventId;
        },
        stop,
        done,
    };
    return handle;
}
//# sourceMappingURL=remote-watch.js.map