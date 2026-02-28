/**
 * In-memory message store for the relay service.
 *
 * Provides server-side message persistence for cross-developer async messaging.
 * Messages are stored in memory for this phase; future milestones will wire
 * real persistence (SQLite/Postgres).
 *
 * Invariants preserved:
 * - read and ack are separate operations (read does not imply ack)
 * - State transitions follow: delivered → acked (relay messages start as delivered)
 * - Dedupe key prevents duplicate message creation
 * - Actor identity comes from validated auth context, never client payload
 *
 * Covers:
 * - VAL-RELAY-001: Cross-developer send/inbox delivery
 * - VAL-RELAY-002: Read state independent from ack state
 * - VAL-RELAY-003: Ack state convergence across views
 */

import { generateMessageId, generateThreadId, generateEventId } from '../contract/ids.js';
import { DedupeConflictError } from '../errors.js';

// ── Types ────────────────────────────────────────────────────────────

/** A relay message stored server-side. */
export interface RelayMessage {
  /** Message ID (msg_ prefixed). */
  id: string;
  /** Thread ID (thr_ prefixed). */
  thread_id: string;
  /** Parent message ID if this is a reply, null for root messages. */
  in_reply_to: string | null;
  /** Sender account ID (from auth principal). */
  sender_id: string;
  /** Sender display name (informational). */
  sender_login: string;
  /** Recipient account ID. */
  recipient_id: string;
  /** Message body (markdown). */
  body: string;
  /** Optional subject line. */
  subject: string | null;
  /** Delivery state: delivered or acked. */
  state: 'delivered' | 'acked';
  /** ISO-8601 timestamp when the message was read, or null. */
  read_at: string | null;
  /** ISO-8601 timestamp when the message was acked, or null. */
  acked_at: string | null;
  /** ISO-8601 creation timestamp. */
  created_at: string;
  /** ISO-8601 last-updated timestamp. */
  updated_at: string;
}

/** Options for sending a message via relay. */
export interface RelaySendOptions {
  /** Recipient account ID. */
  recipientId: string;
  /** Message body (markdown). */
  body: string;
  /** Optional subject line. */
  subject?: string;
  /** Parent message ID for replies. */
  inReplyTo?: string;
  /**
   * Client-provided dedupe key for idempotent send/reply.
   * If provided, repeated sends with the same key from the same sender
   * return the canonical message without creating a duplicate.
   * Scope: per-sender (sender_id + dedupe_key).
   */
  dedupeKey?: string;
}

/** Result of a send operation, indicating whether a new message was created or deduped. */
export interface RelaySendResult {
  /** The relay message (canonical, whether new or deduped). */
  message: RelayMessage;
  /** Whether this send created a new message (true) or returned an existing one (false, deduped). */
  created: boolean;
}

/** Options for listing inbox messages. */
export interface RelayInboxOptions {
  /** If true, only return unread messages. */
  unreadOnly?: boolean;
}

/** Result of a read operation. */
export interface RelayReadResult {
  message: RelayMessage;
  /** Whether this read was the first read (vs idempotent re-read). */
  firstRead: boolean;
}

/** Result of an ack operation. */
export interface RelayAckResult {
  message: RelayMessage;
  /** Whether this ack was the first ack (vs idempotent re-ack). */
  firstAck: boolean;
}

// ── Stream Event Types ───────────────────────────────────────────────

/** Event types emitted by the relay message store for SSE streaming. */
export type RelayStreamEventType =
  | 'message_created'
  | 'reply_created'
  | 'message_read'
  | 'message_acked';

/** A relay stream event emitted when a message lifecycle transition occurs. */
export interface RelayStreamEvent {
  /** Unique event ID (evt_ prefixed) for SSE cursor/Last-Event-ID support. */
  event_id: string;
  /** The event type. */
  event_type: RelayStreamEventType;
  /** The message ID involved in the event. */
  message_id: string;
  /** The thread ID the message belongs to. */
  thread_id: string;
  /** Parent message ID (present for replies, null otherwise). */
  in_reply_to: string | null;
  /** Sender account ID. */
  sender_id: string;
  /** Recipient account ID. */
  recipient_id: string;
  /** ISO-8601 timestamp of when the event occurred. */
  timestamp: string;
}

/** Listener callback for relay stream events. */
export type RelayStreamListener = (event: RelayStreamEvent) => void;

// ── Persistence Snapshot ─────────────────────────────────────────────

/**
 * JSON-serializable snapshot of the relay message store state.
 *
 * Used to persist store state across process restarts or deploys.
 * All fields are plain values (no Map/Set) so the snapshot survives
 * a JSON.stringify → JSON.parse round-trip.
 */
export interface RelayMessageStoreSnapshot {
  /** All messages keyed by ID. */
  messages: Array<[string, RelayMessage]>;
  /** Inbox index: recipient accountId → array of message IDs. */
  inboxIndex: Array<[string, string[]]>;
  /** Sender index: sender accountId → array of message IDs. */
  senderIndex: Array<[string, string[]]>;
  /** Conversation participants: conversationKey → array of account IDs. */
  participants: Array<[string, string[]]>;
  /** Dedupe index: compositeKey → message ID. */
  dedupeIndex: Array<[string, string]>;
  /** Ordered event log for SSE cursor resume. */
  eventLog: RelayStreamEvent[];
  /** Event ID → position index for cursor lookup. */
  eventIdIndex: Array<[string, number]>;
}

// ── Errors ───────────────────────────────────────────────────────────

/** Thrown when a message is not found in the relay store. */
export class RelayMessageNotFoundError extends Error {
  constructor(id: string) {
    super(`Message not found: ${id}`);
    this.name = 'RelayMessageNotFoundError';
  }
}

/** Thrown when an invalid state transition is attempted. */
export class RelayInvalidStateError extends Error {
  constructor(from: string, to: string) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = 'RelayInvalidStateError';
  }
}

/** Thrown when the caller is not authorized for a message operation. */
export class RelayUnauthorizedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'RelayUnauthorizedError';
  }
}

// ── Store ────────────────────────────────────────────────────────────

/**
 * In-memory relay message store.
 *
 * Stores messages keyed by ID with indexes for inbox lookup.
 * Thread-safe for single-process use (Node.js event loop).
 */
export class RelayMessageStore {
  /** All messages by ID. */
  private messages = new Map<string, RelayMessage>();
  /** Messages by recipient_id for inbox queries. */
  private inboxIndex = new Map<string, Set<string>>();
  /** Messages by sender_id for sender view queries. */
  private senderIndex = new Map<string, Set<string>>();
  /** Conversation participants: conversationKey → Set<accountId>. */
  private participants = new Map<string, Set<string>>();
  /**
   * Dedupe index: maps (sender_id, dedupe_key) → message_id.
   * Key format: `${senderId}:${dedupeKey}` for account-scoped deduplication.
   */
  private dedupeIndex = new Map<string, string>();
  /** Listeners for stream events. */
  private streamListeners = new Set<RelayStreamListener>();
  /**
   * Ordered event log for SSE cursor/Last-Event-ID resume support.
   * Events are appended in order and retained for replay during reconnect.
   * Each event has a stable event_id that never changes across replays.
   */
  private eventLog: RelayStreamEvent[] = [];
  /** Index from event_id → position in eventLog for fast cursor lookup. */
  private eventIdIndex = new Map<string, number>();

  /** Build a dedupe index key scoped to the sender. */
  private dedupeIndexKey(senderId: string, dedupeKey: string): string {
    return `${senderId}:${dedupeKey}`;
  }

  /**
   * Send a message through the relay.
   *
   * The sender identity is derived from the authenticated principal
   * (never from client payload). Messages start in 'delivered' state
   * since relay delivery is synchronous in this phase.
   *
   * When a dedupe key is provided, repeated sends from the same sender
   * with the same key return the canonical message without creating a
   * duplicate. The dedupe scope is per-sender (sender_id + dedupe_key).
   *
   * @param senderId - Authenticated sender's account ID.
   * @param senderLogin - Authenticated sender's display name.
   * @param options - Send options.
   * @returns A RelaySendResult with the message and whether it was newly created.
   */
  send(senderId: string, senderLogin: string, options: RelaySendOptions): RelaySendResult {
    const { recipientId, body, subject, inReplyTo, dedupeKey } = options;

    // Check dedupe index first — if this key was already used by this sender,
    // verify context compatibility before returning the canonical message.
    // Incompatible reuse (different recipient, thread, or reply-parent) is rejected.
    if (dedupeKey) {
      const indexKey = this.dedupeIndexKey(senderId, dedupeKey);
      const existingId = this.dedupeIndex.get(indexKey);
      if (existingId) {
        const existing = this.messages.get(existingId);
        if (existing) {
          // Context compatibility checks (VAL-RELAY-009):
          // 1. Recipient must match
          if (existing.recipient_id !== recipientId) {
            throw new DedupeConflictError(
              dedupeKey,
              existing.id,
              `Expected recipient_id=${recipientId} but found recipient_id=${existing.recipient_id}.`
            );
          }
          // 2. in_reply_to must match (null for root, parent ID for reply)
          const requestedReplyTo = inReplyTo ?? null;
          if (existing.in_reply_to !== requestedReplyTo) {
            const existingReplyTo = existing.in_reply_to ?? 'null (top-level message)';
            const requestedReplyToDesc = requestedReplyTo ?? 'null (top-level message)';
            throw new DedupeConflictError(
              dedupeKey,
              existing.id,
              `Expected in_reply_to="${requestedReplyToDesc}" but found in_reply_to="${existingReplyTo}".`
            );
          }
          // Context is compatible — return canonical message (idempotent retry)
          return { message: existing, created: false };
        }
      }
    }

    // Resolve thread_id: inherit from parent if reply, or generate new
    let threadId: string;
    if (inReplyTo) {
      const parent = this.messages.get(inReplyTo);
      if (!parent) {
        throw new RelayMessageNotFoundError(inReplyTo);
      }
      threadId = parent.thread_id;
    } else {
      threadId = generateThreadId();
    }

    const now = new Date().toISOString();
    const message: RelayMessage = {
      id: generateMessageId(),
      thread_id: threadId,
      in_reply_to: inReplyTo ?? null,
      sender_id: senderId,
      sender_login: senderLogin,
      recipient_id: recipientId,
      body,
      subject: subject ?? null,
      state: 'delivered',
      read_at: null,
      acked_at: null,
      created_at: now,
      updated_at: now,
    };

    // Store message
    this.messages.set(message.id, message);

    // Register in dedupe index if key was provided
    if (dedupeKey) {
      const indexKey = this.dedupeIndexKey(senderId, dedupeKey);
      this.dedupeIndex.set(indexKey, message.id);
    }

    // Update inbox index
    const inboxSet = this.inboxIndex.get(recipientId) ?? new Set<string>();
    if (!this.inboxIndex.has(recipientId)) {
      this.inboxIndex.set(recipientId, inboxSet);
    }
    inboxSet.add(message.id);

    // Update sender index
    const senderSet = this.senderIndex.get(senderId) ?? new Set<string>();
    if (!this.senderIndex.has(senderId)) {
      this.senderIndex.set(senderId, senderSet);
    }
    senderSet.add(message.id);

    // Auto-register both sender and recipient as conversation participants
    const convKey = this.conversationKey(message.thread_id);
    const convSet = this.participants.get(convKey) ?? new Set<string>();
    if (!this.participants.has(convKey)) {
      this.participants.set(convKey, convSet);
    }
    convSet.add(senderId);
    convSet.add(recipientId);

    // Emit stream event for the new message
    const eventType: RelayStreamEventType = inReplyTo ? 'reply_created' : 'message_created';
    this.emitStreamEvent(eventType, message);

    return { message, created: true };
  }

  /**
   * List inbox messages for a user.
   *
   * Returns messages where the user is the recipient, ordered by
   * created_at descending (newest first).
   *
   * @param userId - Account ID to list inbox for.
   * @param options - Optional inbox filter options.
   * @returns Array of relay messages.
   */
  inbox(userId: string, options?: RelayInboxOptions): RelayMessage[] {
    const messageIds = this.inboxIndex.get(userId);
    if (!messageIds) return [];

    let messages = Array.from(messageIds)
      .map((id) => this.messages.get(id))
      .filter((m): m is RelayMessage => m !== undefined);

    if (options?.unreadOnly) {
      messages = messages.filter((m) => m.read_at === null);
    }

    // Sort by created_at descending (newest first)
    messages.sort((a, b) => b.created_at.localeCompare(a.created_at));

    return messages;
  }

  /**
   * Get messages sent by a user (sender view).
   *
   * @param userId - Account ID.
   * @returns Array of relay messages sent by this user.
   */
  sentBy(userId: string): RelayMessage[] {
    const messageIds = this.senderIndex.get(userId);
    if (!messageIds) return [];

    return Array.from(messageIds)
      .map((id) => this.messages.get(id))
      .filter((m): m is RelayMessage => m !== undefined)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /**
   * Read a message by ID.
   *
   * Sets read_at if not already set. Does NOT affect ack state.
   * Idempotent: re-reading returns the same message without re-setting read_at.
   *
   * @param messageId - Message ID to read.
   * @param userId - Account ID performing the read (for authorization).
   * @returns Read result with the message and whether this was the first read.
   * @throws RelayMessageNotFoundError if message doesn't exist.
   * @throws RelayUnauthorizedError if user is not the recipient.
   */
  read(messageId: string, userId: string): RelayReadResult {
    const message = this.messages.get(messageId);
    if (!message) {
      throw new RelayMessageNotFoundError(messageId);
    }

    // Only the recipient can mark as read
    if (message.recipient_id !== userId) {
      throw new RelayUnauthorizedError(`Only the recipient can mark a message as read.`);
    }

    // Idempotent: already read
    if (message.read_at !== null) {
      return { message, firstRead: false };
    }

    // Set read_at — does NOT change state or acked_at
    const now = new Date().toISOString();
    message.read_at = now;
    message.updated_at = now;

    // Emit stream event for first read
    this.emitStreamEvent('message_read', message);

    return { message, firstRead: true };
  }

  /**
   * Acknowledge a message by ID.
   *
   * Transitions state to 'acked' and sets acked_at. Independent from read.
   * A message can be acked without being read first (ack implies delivery
   * acknowledgement, not necessarily reading).
   *
   * Idempotent: re-acking returns the same result.
   *
   * @param messageId - Message ID to ack.
   * @param userId - Account ID performing the ack (for authorization).
   * @returns Ack result with the message and whether this was the first ack.
   * @throws RelayMessageNotFoundError if message doesn't exist.
   * @throws RelayUnauthorizedError if user is not the recipient.
   */
  ack(messageId: string, userId: string): RelayAckResult {
    const message = this.messages.get(messageId);
    if (!message) {
      throw new RelayMessageNotFoundError(messageId);
    }

    // Only the recipient can ack
    if (message.recipient_id !== userId) {
      throw new RelayUnauthorizedError(`Only the recipient can acknowledge a message.`);
    }

    // Idempotent: already acked
    if (message.state === 'acked') {
      return { message, firstAck: false };
    }

    // Transition to acked
    const now = new Date().toISOString();
    message.state = 'acked';
    message.acked_at = now;
    message.updated_at = now;

    // Emit stream event for first ack
    this.emitStreamEvent('message_acked', message);

    return { message, firstAck: true };
  }

  /**
   * Get a message by ID (for any authorized viewer).
   *
   * @param messageId - Message ID.
   * @returns The message, or undefined if not found.
   */
  get(messageId: string): RelayMessage | undefined {
    return this.messages.get(messageId);
  }

  /**
   * Check if a user is a participant in a conversation (thread).
   *
   * @param threadId - Thread ID to check.
   * @param userId - Account ID to check.
   * @returns true if the user is a participant.
   */
  isParticipant(threadId: string, userId: string): boolean {
    const convKey = this.conversationKey(threadId);
    const members = this.participants.get(convKey);
    return members?.has(userId) ?? false;
  }

  /**
   * Check if a user is a participant in a message's conversation.
   *
   * @param messageId - Message ID.
   * @param userId - Account ID.
   * @returns true if the user is a participant of the message's thread.
   */
  isMessageParticipant(messageId: string, userId: string): boolean {
    const message = this.messages.get(messageId);
    if (!message) return false;
    return this.isParticipant(message.thread_id, userId);
  }

  // ── Stream event subscription ────────────────────────────────────

  /**
   * Subscribe to stream events.
   *
   * Listeners are invoked synchronously when a message lifecycle event
   * occurs (send, read, ack). The server uses this to push SSE events
   * to connected clients.
   *
   * @param listener - Callback invoked for each stream event.
   * @returns Unsubscribe function to remove the listener.
   */
  onStreamEvent(listener: RelayStreamListener): () => void {
    this.streamListeners.add(listener);
    return () => {
      this.streamListeners.delete(listener);
    };
  }

  /**
   * Register an external event ID as a cursor position in the event log.
   *
   * This allows non-message-store events (like the SSE "connected" event)
   * to serve as valid Last-Event-ID cursors. The registered ID points to
   * the current end of the event log, meaning "everything before this
   * point was already delivered to the client."
   *
   * @param eventId - The event ID to register as a cursor position.
   */
  registerCursorPosition(eventId: string): void {
    // Position is the index of the last event in the log.
    // If the log is empty, use -1 (so getEventsSince returns all events).
    // If the log has events, the cursor points to the last one (so
    // getEventsSince returns events after that position).
    const position = this.eventLog.length - 1;
    this.eventIdIndex.set(eventId, position);
  }

  /**
   * Get events from the event log after a given cursor (Last-Event-ID).
   *
   * If the cursor is found, returns all events after that position.
   * If the cursor is not found (e.g. server restarted, unknown ID),
   * returns an empty array (fallback to no replay).
   *
   * Used by the SSE endpoint to replay missed events on reconnect.
   *
   * @param lastEventId - The last event ID the client received.
   * @returns Array of events after the cursor, in order.
   */
  getEventsSince(lastEventId: string): RelayStreamEvent[] {
    const idx = this.eventIdIndex.get(lastEventId);
    if (idx === undefined) {
      // Unknown cursor — treat as fresh connection, no replay
      return [];
    }
    // Return all events after the cursor position
    return this.eventLog.slice(idx + 1);
  }

  /** Emit a stream event to all registered listeners and append to event log. */
  private emitStreamEvent(eventType: RelayStreamEventType, message: RelayMessage): void {
    const event: RelayStreamEvent = {
      event_id: generateEventId(),
      event_type: eventType,
      message_id: message.id,
      thread_id: message.thread_id,
      in_reply_to: message.in_reply_to,
      sender_id: message.sender_id,
      recipient_id: message.recipient_id,
      timestamp: new Date().toISOString(),
    };

    // Append to event log before notifying listeners for consistent replay
    const logIndex = this.eventLog.length;
    this.eventLog.push(event);
    this.eventIdIndex.set(event.event_id, logIndex);

    for (const listener of this.streamListeners) {
      listener(event);
    }
  }

  /** Generate a conversation key from a thread ID. */
  private conversationKey(threadId: string): string {
    return `thread:${threadId}`;
  }

  // ── Persistence (snapshot / rehydrate) ──────────────────────────────

  /**
   * Create a JSON-serializable snapshot of the entire store state.
   *
   * The snapshot captures all messages, indexes, dedupe state, participant
   * tracking, and the SSE event log with its cursor index. It contains
   * only plain values (arrays/objects) so it survives a JSON round-trip.
   *
   * Use together with `RelayMessageStore.fromSnapshot()` to cross a real
   * persistence boundary (persist → new process → rehydrate).
   */
  snapshot(): RelayMessageStoreSnapshot {
    return {
      messages: Array.from(this.messages.entries()).map(([k, v]) => [k, { ...v }]),
      inboxIndex: Array.from(this.inboxIndex.entries()).map(([k, v]) => [k, Array.from(v)]),
      senderIndex: Array.from(this.senderIndex.entries()).map(([k, v]) => [k, Array.from(v)]),
      participants: Array.from(this.participants.entries()).map(([k, v]) => [k, Array.from(v)]),
      dedupeIndex: Array.from(this.dedupeIndex.entries()),
      eventLog: this.eventLog.map((e) => ({ ...e })),
      eventIdIndex: Array.from(this.eventIdIndex.entries()),
    };
  }

  /**
   * Create a new `RelayMessageStore` from a previously-saved snapshot.
   *
   * The returned store is fully independent — it shares no references
   * with the snapshot data. Stream listeners are NOT restored (they are
   * transient per-connection state and must be re-registered).
   *
   * @param data - A `RelayMessageStoreSnapshot`, typically obtained via
   *   `JSON.parse(serialized)` after a restart/deploy.
   */
  static fromSnapshot(data: RelayMessageStoreSnapshot): RelayMessageStore {
    const store = new RelayMessageStore();

    // Restore messages (deep-copy each value)
    for (const [key, msg] of data.messages) {
      store.messages.set(key, { ...msg });
    }

    // Restore inbox index
    for (const [userId, ids] of data.inboxIndex) {
      store.inboxIndex.set(userId, new Set(ids));
    }

    // Restore sender index
    for (const [userId, ids] of data.senderIndex) {
      store.senderIndex.set(userId, new Set(ids));
    }

    // Restore participant tracking
    for (const [convKey, userIds] of data.participants) {
      store.participants.set(convKey, new Set(userIds));
    }

    // Restore dedupe index
    for (const [compositeKey, msgId] of data.dedupeIndex) {
      store.dedupeIndex.set(compositeKey, msgId);
    }

    // Restore event log (deep-copy each event)
    store.eventLog = data.eventLog.map((e) => ({ ...e }));

    // Restore event ID index
    for (const [eventId, position] of data.eventIdIndex) {
      store.eventIdIndex.set(eventId, position);
    }

    return store;
  }

  /** Clear all stored data (for testing). */
  clear(): void {
    this.messages.clear();
    this.inboxIndex.clear();
    this.senderIndex.clear();
    this.participants.clear();
    this.dedupeIndex.clear();
    this.streamListeners.clear();
    this.eventLog.length = 0;
    this.eventIdIndex.clear();
  }
}
