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

// ── Types ────────────────────────────────────────────────────────────

/** State of the remote watch connection. */
export type RemoteWatchState = 'connecting' | 'connected' | 'fallback' | 'stopped';

/** A parsed SSE event from the remote watch stream. */
export interface RemoteWatchEvent {
  /** SSE event ID (for cursor resume). */
  id?: string;
  /** SSE event type (e.g. connected, message_created, auth_expired, fallback). */
  event: string;
  /** Parsed JSON data payload. */
  data: Record<string, unknown>;
}

/** Options for connecting a remote watch. */
export interface RemoteWatchOptions {
  /** Base URL of the relay server (e.g. http://127.0.0.1:3100). */
  baseUrl: string;
  /** Bearer token for authentication. */
  token: string;
  /** Last-Event-ID for cursor resume on reconnect. */
  lastEventId?: string;
  /** Callback for each event received. */
  onEvent?: (event: RemoteWatchEvent) => void;
  /** Callback when state changes. */
  onStateChange?: (state: RemoteWatchState, reason?: string) => void;
  /** Connection timeout in ms. Default: 10000. */
  connectTimeoutMs?: number;
}

/** Handle returned by connectRemoteWatch for lifecycle management. */
export interface RemoteWatchHandle {
  /** Current connection state. */
  state: RemoteWatchState;
  /** Reason for fallback (only set when state is 'fallback'). */
  fallbackReason?: string;
  /** All events received so far. */
  events: RemoteWatchEvent[];
  /** The last event ID received (for cursor resume). */
  lastEventId?: string;
  /** Stop the remote watch connection. */
  stop: () => void;
  /** Promise that resolves when the connection is fully stopped. */
  done: Promise<void>;
}

// ── SSE parsing ──────────────────────────────────────────────────────

/** Parse raw SSE text into structured events. */
function parseSSEChunk(raw: string): Array<{ id?: string; event?: string; data?: string }> {
  const events: Array<{ id?: string; event?: string; data?: string }> = [];
  const blocks = raw.split('\n\n').filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const lines = block.split('\n');
    const isCommentOnly = lines.every((l) => l.startsWith(':') || l.trim() === '');
    if (isCommentOnly) continue;

    const event: { id?: string; event?: string; data?: string } = {};
    for (const line of lines) {
      if (line.startsWith(':')) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const field = line.slice(0, colonIdx);
      const value = line.slice(colonIdx + 1).trimStart();

      if (field === 'id') event.id = value;
      if (field === 'event') event.event = value;
      if (field === 'data') event.data = event.data ? event.data + '\n' + value : value;
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
export function connectRemoteWatch(options: RemoteWatchOptions): RemoteWatchHandle {
  const {
    baseUrl,
    token,
    lastEventId: initialLastEventId,
    onEvent,
    onStateChange,
    connectTimeoutMs = 10000,
  } = options;

  let state: RemoteWatchState = 'connecting';
  let fallbackReason: string | undefined;
  const events: RemoteWatchEvent[] = [];
  let currentLastEventId: string | undefined = initialLastEventId;
  let req: http.ClientRequest | null = null;
  let res: http.IncomingMessage | null = null;
  let stopped = false;

  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  function setState(newState: RemoteWatchState, reason?: string): void {
    state = newState;
    if (reason !== undefined) {
      fallbackReason = reason;
    }
    onStateChange?.(newState, reason);
  }

  function emitEvent(evt: RemoteWatchEvent): void {
    events.push(evt);
    if (evt.id) {
      currentLastEventId = evt.id;
    }
    onEvent?.(evt);
  }

  function enterFallback(reason: string): void {
    if (stopped) return;
    setState('fallback', reason);
    const fallbackEvent: RemoteWatchEvent = {
      event: 'fallback',
      data: {
        mode: 'degraded',
        reason,
      },
    };
    emitEvent(fallbackEvent);
    cleanup();
  }

  function cleanup(): void {
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

  function stop(): void {
    if (stopped) return;
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

  const headers: Record<string, string> = {
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

  req = httpModule.request(
    {
      hostname: url.hostname,
      port,
      path: '/events',
      method: 'GET',
      headers,
    },
    (response) => {
      clearTimeout(connectTimeout);
      res = response;
      const statusCode = response.statusCode ?? 0;

      // Handle non-200 responses → fallback
      if (statusCode === 401) {
        enterFallback(
          'Authentication failed (401 Unauthorized). Run "mors login" to re-authenticate. Realtime watch is running in degraded mode.'
        );
        return;
      }

      if (statusCode >= 500) {
        enterFallback(
          `Relay returned ${statusCode} — SSE service temporarily unavailable. Realtime watch is running in degraded mode.`
        );
        return;
      }

      if (statusCode !== 200) {
        enterFallback(
          `Unexpected response (${statusCode}) from relay SSE endpoint. Realtime watch is running in degraded mode.`
        );
        return;
      }

      // Successful SSE connection — process the stream
      response.setEncoding('utf8');

      // Buffer for incomplete SSE frames across chunks
      let sseBuffer = '';

      response.on('data', (chunk: string) => {
        if (stopped) return;

        sseBuffer += chunk;

        // Process complete SSE frames (separated by double newlines)
        // Keep any trailing incomplete frame in the buffer
        const lastDoubleNewline = sseBuffer.lastIndexOf('\n\n');
        if (lastDoubleNewline === -1) return; // No complete frame yet

        const complete = sseBuffer.slice(0, lastDoubleNewline + 2);
        sseBuffer = sseBuffer.slice(lastDoubleNewline + 2);

        const parsed = parseSSEChunk(complete);

        for (const raw of parsed) {
          if (!raw.event && !raw.data) continue;

          let data: Record<string, unknown> = {};
          if (raw.data) {
            try {
              data = JSON.parse(raw.data) as Record<string, unknown>;
            } catch {
              data = { raw: raw.data };
            }
          }

          const evt: RemoteWatchEvent = {
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
          enterFallback(
            'SSE connection error. Realtime watch is running in degraded mode.'
          );
        }
      });
    }
  );

  req.on('error', (err: NodeJS.ErrnoException) => {
    clearTimeout(connectTimeout);
    if (stopped) return;

    if (err.code === 'ECONNREFUSED') {
      enterFallback(
        'Connection refused — relay SSE endpoint is unavailable. Realtime watch is running in degraded mode.'
      );
    } else {
      enterFallback(
        `SSE connection failed: ${err.message}. Realtime watch is running in degraded mode.`
      );
    }
  });

  req.end();

  const handle: RemoteWatchHandle = {
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
