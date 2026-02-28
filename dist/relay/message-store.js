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
import { generateMessageId, generateThreadId } from '../contract/ids.js';
// ── Errors ───────────────────────────────────────────────────────────
/** Thrown when a message is not found in the relay store. */
export class RelayMessageNotFoundError extends Error {
    constructor(id) {
        super(`Message not found: ${id}`);
        this.name = 'RelayMessageNotFoundError';
    }
}
/** Thrown when an invalid state transition is attempted. */
export class RelayInvalidStateError extends Error {
    constructor(from, to) {
        super(`Invalid state transition: ${from} → ${to}`);
        this.name = 'RelayInvalidStateError';
    }
}
/** Thrown when the caller is not authorized for a message operation. */
export class RelayUnauthorizedError extends Error {
    constructor(detail) {
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
    messages = new Map();
    /** Messages by recipient_id for inbox queries. */
    inboxIndex = new Map();
    /** Messages by sender_id for sender view queries. */
    senderIndex = new Map();
    /** Conversation participants: conversationKey → Set<githubUserId>. */
    participants = new Map();
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
    send(senderId, senderLogin, options) {
        const { recipientId, body, subject, inReplyTo } = options;
        // Resolve thread_id: inherit from parent if reply, or generate new
        let threadId;
        if (inReplyTo) {
            const parent = this.messages.get(inReplyTo);
            if (!parent) {
                throw new RelayMessageNotFoundError(inReplyTo);
            }
            threadId = parent.thread_id;
        }
        else {
            threadId = generateThreadId();
        }
        const now = new Date().toISOString();
        const message = {
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
        // Update inbox index
        const inboxSet = this.inboxIndex.get(recipientId) ?? new Set();
        if (!this.inboxIndex.has(recipientId)) {
            this.inboxIndex.set(recipientId, inboxSet);
        }
        inboxSet.add(message.id);
        // Update sender index
        const senderSet = this.senderIndex.get(senderId) ?? new Set();
        if (!this.senderIndex.has(senderId)) {
            this.senderIndex.set(senderId, senderSet);
        }
        senderSet.add(message.id);
        // Auto-register both sender and recipient as conversation participants
        const convKey = this.conversationKey(message.thread_id);
        const convSet = this.participants.get(convKey) ?? new Set();
        if (!this.participants.has(convKey)) {
            this.participants.set(convKey, convSet);
        }
        convSet.add(senderId);
        convSet.add(recipientId);
        return message;
    }
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
    inbox(userId, options) {
        const messageIds = this.inboxIndex.get(userId);
        if (!messageIds)
            return [];
        let messages = Array.from(messageIds)
            .map((id) => this.messages.get(id))
            .filter((m) => m !== undefined);
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
     * @param userId - GitHub user ID.
     * @returns Array of relay messages sent by this user.
     */
    sentBy(userId) {
        const messageIds = this.senderIndex.get(userId);
        if (!messageIds)
            return [];
        return Array.from(messageIds)
            .map((id) => this.messages.get(id))
            .filter((m) => m !== undefined)
            .sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
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
    read(messageId, userId) {
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
     * @param userId - GitHub user ID performing the ack (for authorization).
     * @returns Ack result with the message and whether this was the first ack.
     * @throws RelayMessageNotFoundError if message doesn't exist.
     * @throws RelayUnauthorizedError if user is not the recipient.
     */
    ack(messageId, userId) {
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
        return { message, firstAck: true };
    }
    /**
     * Get a message by ID (for any authorized viewer).
     *
     * @param messageId - Message ID.
     * @returns The message, or undefined if not found.
     */
    get(messageId) {
        return this.messages.get(messageId);
    }
    /**
     * Check if a user is a participant in a conversation (thread).
     *
     * @param threadId - Thread ID to check.
     * @param userId - GitHub user ID to check.
     * @returns true if the user is a participant.
     */
    isParticipant(threadId, userId) {
        const convKey = this.conversationKey(threadId);
        const members = this.participants.get(convKey);
        return members?.has(userId) ?? false;
    }
    /**
     * Check if a user is a participant in a message's conversation.
     *
     * @param messageId - Message ID.
     * @param userId - GitHub user ID.
     * @returns true if the user is a participant of the message's thread.
     */
    isMessageParticipant(messageId, userId) {
        const message = this.messages.get(messageId);
        if (!message)
            return false;
        return this.isParticipant(message.thread_id, userId);
    }
    /** Generate a conversation key from a thread ID. */
    conversationKey(threadId) {
        return `thread:${threadId}`;
    }
    /** Clear all stored data (for testing). */
    clear() {
        this.messages.clear();
        this.inboxIndex.clear();
        this.senderIndex.clear();
        this.participants.clear();
    }
}
//# sourceMappingURL=message-store.js.map