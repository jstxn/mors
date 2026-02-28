/**
 * Watch stream for the mors messaging system.
 *
 * Provides real-time event streaming for message lifecycle transitions:
 * - message_created  — A new message was sent
 * - reply_created    — A reply was sent
 * - message_acked    — A message was acknowledged
 *
 * Design:
 * - Polling-based approach against the SQLCipher database
 * - Deterministic startup: only emits events after subscription starts
 * - Runtime dedupe: each event_type+message_id is emitted at most once per session
 * - Clean SIGINT shutdown: closes DB, removes listeners, exits cleanly
 *
 * Fulfills: VAL-WATCH-001, VAL-WATCH-002, VAL-WATCH-003, VAL-WATCH-004
 */
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
/** Event types emitted by the watch stream. */
export type WatchEventType = 'message_created' | 'reply_created' | 'message_acked';
/** A watch stream event. */
export interface WatchEvent {
    /** The type of lifecycle event. */
    event_type: WatchEventType;
    /** The message ID involved in the event. */
    message_id: string;
    /** The thread ID the message belongs to. */
    thread_id: string;
    /** The parent message ID (only present for reply events). */
    in_reply_to: string | null;
    /** The sender of the message. */
    sender: string;
    /** The recipient of the message. */
    recipient: string;
    /** Current delivery state. */
    state: string;
    /** ISO-8601 timestamp of when the event occurred. */
    timestamp: string;
}
/** Options for starting the watch stream. */
export interface WatchOptions {
    /** Polling interval in milliseconds (default: 500). */
    pollIntervalMs?: number;
    /** Callback for each event. */
    onEvent: (event: WatchEvent) => void;
    /** Callback when the watch stream is shutting down. */
    onShutdown?: () => void;
    /** AbortSignal for external cancellation. */
    signal?: AbortSignal;
}
/** Handle returned by startWatch for lifecycle management. */
export interface WatchHandle {
    /** Stop the watch stream. */
    stop: () => void;
    /** Promise that resolves when the watch stream has fully stopped. */
    done: Promise<void>;
}
/**
 * Start a watch stream that polls the database for new lifecycle events.
 *
 * The watch stream uses a high-water mark based on `updated_at` to only
 * emit new events since the last poll. At startup, it captures the current
 * max timestamp to establish a baseline — no historical events are emitted.
 *
 * Runtime dedupe uses an in-memory Set keyed on `event_type:message_id`
 * to ensure no event is emitted more than once per session, even if the
 * same row is seen in multiple polls.
 *
 * @param db - Open encrypted database handle.
 * @param options - Watch options including callbacks and interval.
 * @returns A WatchHandle for stopping the stream.
 */
export declare function startWatch(db: BetterSqlite3.Database, options: WatchOptions): WatchHandle;
//# sourceMappingURL=watch.d.ts.map