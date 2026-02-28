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

// ── Types ──────────────────────────────────────────────────────────────

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

/** Internal row shape from database query. */
interface MessageRow {
  id: string;
  thread_id: string;
  in_reply_to: string | null;
  sender: string;
  recipient: string;
  state: string;
  created_at: string;
  updated_at: string;
}

// ── Core watch implementation ──────────────────────────────────────────

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
export function startWatch(db: BetterSqlite3.Database, options: WatchOptions): WatchHandle {
  const {
    pollIntervalMs = 500,
    onEvent,
    onShutdown,
    signal,
  } = options;

  // ── Determine startup high-water mark ─────────────────────────────
  // We capture the current max updated_at so that only events created
  // *after* this point are emitted. This ensures deterministic startup
  // (VAL-WATCH-003).
  const startRow = db
    .prepare('SELECT MAX(updated_at) as max_ts FROM messages')
    .get() as { max_ts: string | null } | undefined;
  let highWaterMark: string = startRow?.max_ts ?? new Date(0).toISOString();

  // ── Runtime dedupe set (VAL-WATCH-004) ────────────────────────────
  const emitted = new Set<string>();

  // ── Track acked states at startup to avoid emitting for pre-existing acked messages ──
  const preExistingAcked = new Set<string>();
  const ackedRows = db
    .prepare("SELECT id FROM messages WHERE state = 'acked'")
    .all() as { id: string }[];
  for (const row of ackedRows) {
    preExistingAcked.add(row.id);
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Resolve when fully stopped.
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (onShutdown) {
      onShutdown();
    }
    resolveDone();
  }

  // Wire up external abort signal.
  if (signal) {
    if (signal.aborted) {
      stop();
      return { stop, done };
    }
    signal.addEventListener('abort', () => stop(), { once: true });
  }

  function poll(): void {
    if (stopped) return;

    try {
      // Query for messages updated after the high-water mark.
      const rows = db
        .prepare(
          `SELECT id, thread_id, in_reply_to, sender, recipient, state, created_at, updated_at
           FROM messages
           WHERE updated_at > ?
           ORDER BY updated_at ASC, id ASC`
        )
        .all(highWaterMark) as MessageRow[];

      for (const row of rows) {
        // Determine event type(s) for this row.
        const events = classifyEvents(row, emitted, preExistingAcked);

        for (const evt of events) {
          const dedupeKey = `${evt.event_type}:${row.id}`;
          if (emitted.has(dedupeKey)) continue;
          emitted.add(dedupeKey);

          onEvent({
            event_type: evt.event_type,
            message_id: row.id,
            thread_id: row.thread_id,
            in_reply_to: row.in_reply_to,
            sender: row.sender,
            recipient: row.recipient,
            state: row.state,
            timestamp: row.updated_at,
          });
        }

        // Advance high-water mark.
        if (row.updated_at > highWaterMark) {
          highWaterMark = row.updated_at;
        }
      }
    } catch {
      // If the DB is closed or an error occurs, stop gracefully.
      if (!stopped) {
        stop();
        return;
      }
    }

    // Schedule next poll if still running.
    if (!stopped) {
      timer = setTimeout(poll, pollIntervalMs);
    }
  }

  // Start polling on the next tick to ensure the handle is returned first.
  timer = setTimeout(poll, 0);

  return { stop, done };
}

/**
 * Classify what events should be emitted for a given message row.
 * Uses the emitted set and pre-existing acked set to avoid duplicates.
 */
function classifyEvents(
  row: MessageRow,
  emitted: Set<string>,
  preExistingAcked: Set<string>,
): { event_type: WatchEventType }[] {
  const events: { event_type: WatchEventType }[] = [];

  // Determine if this is a new message or reply creation event.
  const createKey = row.in_reply_to
    ? `reply_created:${row.id}`
    : `message_created:${row.id}`;

  if (!emitted.has(createKey)) {
    events.push({
      event_type: row.in_reply_to ? 'reply_created' : 'message_created',
    });
  }

  // Determine if this is an ack event.
  if (row.state === 'acked' && !preExistingAcked.has(row.id)) {
    const ackKey = `message_acked:${row.id}`;
    if (!emitted.has(ackKey)) {
      events.push({ event_type: 'message_acked' });
    }
  }

  return events;
}
