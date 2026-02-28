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
/** A relay message stored server-side. */
export interface RelayMessage {
    /** Message ID (msg_ prefixed). */
    id: string;
    /** Thread ID (thr_ prefixed). */
    thread_id: string;
    /** Parent message ID if this is a reply, null for root messages. */
    in_reply_to: string | null;
    /** Sender GitHub user ID (from auth principal). */
    sender_id: number;
    /** Sender GitHub login (informational). */
    sender_login: string;
    /** Recipient GitHub user ID. */
    recipient_id: number;
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
    /** Recipient GitHub user ID. */
    recipientId: number;
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
/** Event types emitted by the relay message store for SSE streaming. */
export type RelayStreamEventType = 'message_created' | 'reply_created' | 'message_read' | 'message_acked';
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
    /** Sender GitHub user ID. */
    sender_id: number;
    /** Recipient GitHub user ID. */
    recipient_id: number;
    /** ISO-8601 timestamp of when the event occurred. */
    timestamp: string;
}
/** Listener callback for relay stream events. */
export type RelayStreamListener = (event: RelayStreamEvent) => void;
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
    /** Inbox index: recipient userId → array of message IDs. */
    inboxIndex: Array<[number, string[]]>;
    /** Sender index: sender userId → array of message IDs. */
    senderIndex: Array<[number, string[]]>;
    /** Conversation participants: conversationKey → array of user IDs. */
    participants: Array<[string, number[]]>;
    /** Dedupe index: compositeKey → message ID. */
    dedupeIndex: Array<[string, string]>;
    /** Ordered event log for SSE cursor resume. */
    eventLog: RelayStreamEvent[];
    /** Event ID → position index for cursor lookup. */
    eventIdIndex: Array<[string, number]>;
}
/** Thrown when a message is not found in the relay store. */
export declare class RelayMessageNotFoundError extends Error {
    constructor(id: string);
}
/** Thrown when an invalid state transition is attempted. */
export declare class RelayInvalidStateError extends Error {
    constructor(from: string, to: string);
}
/** Thrown when the caller is not authorized for a message operation. */
export declare class RelayUnauthorizedError extends Error {
    constructor(detail: string);
}
/**
 * In-memory relay message store.
 *
 * Stores messages keyed by ID with indexes for inbox lookup.
 * Thread-safe for single-process use (Node.js event loop).
 */
export declare class RelayMessageStore {
    /** All messages by ID. */
    private messages;
    /** Messages by recipient_id for inbox queries. */
    private inboxIndex;
    /** Messages by sender_id for sender view queries. */
    private senderIndex;
    /** Conversation participants: conversationKey → Set<githubUserId>. */
    private participants;
    /**
     * Dedupe index: maps (sender_id, dedupe_key) → message_id.
     * Key format: `${senderId}:${dedupeKey}` for account-scoped deduplication.
     */
    private dedupeIndex;
    /** Listeners for stream events. */
    private streamListeners;
    /**
     * Ordered event log for SSE cursor/Last-Event-ID resume support.
     * Events are appended in order and retained for replay during reconnect.
     * Each event has a stable event_id that never changes across replays.
     */
    private eventLog;
    /** Index from event_id → position in eventLog for fast cursor lookup. */
    private eventIdIndex;
    /** Build a dedupe index key scoped to the sender. */
    private dedupeIndexKey;
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
     * @param senderId - Authenticated sender's GitHub user ID.
     * @param senderLogin - Authenticated sender's GitHub login.
     * @param options - Send options.
     * @returns A RelaySendResult with the message and whether it was newly created.
     */
    send(senderId: number, senderLogin: string, options: RelaySendOptions): RelaySendResult;
    /**
     * List inbox messages for a user.
     *
     * Returns messages where the user is the recipient, ordered by
     * created_at descending (newest first).
     *
     * @param userId - GitHub user ID to list inbox for.
     * @param options - Optional inbox filter options.
     * @returns Array of relay messages.
     */
    inbox(userId: number, options?: RelayInboxOptions): RelayMessage[];
    /**
     * Get messages sent by a user (sender view).
     *
     * @param userId - GitHub user ID.
     * @returns Array of relay messages sent by this user.
     */
    sentBy(userId: number): RelayMessage[];
    /**
     * Read a message by ID.
     *
     * Sets read_at if not already set. Does NOT affect ack state.
     * Idempotent: re-reading returns the same message without re-setting read_at.
     *
     * @param messageId - Message ID to read.
     * @param userId - GitHub user ID performing the read (for authorization).
     * @returns Read result with the message and whether this was the first read.
     * @throws RelayMessageNotFoundError if message doesn't exist.
     * @throws RelayUnauthorizedError if user is not the recipient.
     */
    read(messageId: string, userId: number): RelayReadResult;
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
     * @param userId - GitHub user ID performing the ack (for authorization).
     * @returns Ack result with the message and whether this was the first ack.
     * @throws RelayMessageNotFoundError if message doesn't exist.
     * @throws RelayUnauthorizedError if user is not the recipient.
     */
    ack(messageId: string, userId: number): RelayAckResult;
    /**
     * Get a message by ID (for any authorized viewer).
     *
     * @param messageId - Message ID.
     * @returns The message, or undefined if not found.
     */
    get(messageId: string): RelayMessage | undefined;
    /**
     * Check if a user is a participant in a conversation (thread).
     *
     * @param threadId - Thread ID to check.
     * @param userId - GitHub user ID to check.
     * @returns true if the user is a participant.
     */
    isParticipant(threadId: string, userId: number): boolean;
    /**
     * Check if a user is a participant in a message's conversation.
     *
     * @param messageId - Message ID.
     * @param userId - GitHub user ID.
     * @returns true if the user is a participant of the message's thread.
     */
    isMessageParticipant(messageId: string, userId: number): boolean;
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
    onStreamEvent(listener: RelayStreamListener): () => void;
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
    registerCursorPosition(eventId: string): void;
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
    getEventsSince(lastEventId: string): RelayStreamEvent[];
    /** Emit a stream event to all registered listeners and append to event log. */
    private emitStreamEvent;
    /** Generate a conversation key from a thread ID. */
    private conversationKey;
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
    snapshot(): RelayMessageStoreSnapshot;
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
    static fromSnapshot(data: RelayMessageStoreSnapshot): RelayMessageStore;
    /** Clear all stored data (for testing). */
    clear(): void;
}
//# sourceMappingURL=message-store.d.ts.map