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
export declare function connectRemoteWatch(options: RemoteWatchOptions): RemoteWatchHandle;
//# sourceMappingURL=remote-watch.d.ts.map