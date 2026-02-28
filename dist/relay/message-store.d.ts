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
     * Send a message through the relay.
     *
     * The sender identity is derived from the authenticated principal
     * (never from client payload). Messages start in 'delivered' state
     * since relay delivery is synchronous in this phase.
     *
     * @param senderId - Authenticated sender's GitHub user ID.
     * @param senderLogin - Authenticated sender's GitHub login.
     * @param options - Send options.
     * @returns The created relay message.
     */
    send(senderId: number, senderLogin: string, options: RelaySendOptions): RelayMessage;
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
    /** Generate a conversation key from a thread ID. */
    private conversationKey;
    /** Clear all stored data (for testing). */
    clear(): void;
}
//# sourceMappingURL=message-store.d.ts.map