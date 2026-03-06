/**
 * In-memory contact store for the relay service.
 *
 * Tracks first-contact approval state per account. This is the core
 * data structure for the autonomy-permissions model where:
 * - Message delivery always succeeds (never gated by contact state)
 * - Autonomous actions (auto-reply, auto-ack, auto-exec) are gated
 *   until the recipient explicitly approves the sender
 * - Approval is remembered permanently (within store lifecycle)
 *
 * The store is directional: A approving B does not imply B approves A.
 * Contact status is per-account scoped (not global).
 *
 * Covers:
 * - VAL-RELAY-011: Delivery to inbox is always allowed
 * - VAL-RELAY-012: First-contact permission gates autonomous actions only
 * - VAL-RELAY-013: Unknown senders in non-interactive mode remain pending
 */
/** Contact approval status. */
export type ContactStatus = 'pending' | 'approved';
/** A stored contact entry. */
export interface ContactEntry {
    contactAccountId: string;
    status: ContactStatus;
}
/**
 * In-memory contact store tracking first-contact approval per account.
 *
 * Key model: ownerAccountId → contactAccountId → status
 *
 * - 'pending': Contact has been recorded but not approved. Autonomous
 *   actions are not allowed for messages from this sender.
 * - 'approved': Contact has been explicitly approved. Autonomous
 *   actions are allowed for messages from this sender.
 *
 * Thread-safe for single-process use (JavaScript event loop).
 */
export declare class ContactStore {
    /**
     * Map from owner account ID to their contact map.
     * Each contact map is: contactAccountId → ContactStatus.
     */
    private readonly contacts;
    /**
     * Get the contact status for a specific sender from the perspective
     * of a specific owner/recipient.
     *
     * Returns 'pending' if the contact is unknown or has been recorded
     * but not approved. Returns 'approved' if explicitly approved.
     *
     * @param ownerAccountId - The account checking contact status (recipient).
     * @param contactAccountId - The account being checked (sender).
     * @returns The contact status.
     */
    getContactStatus(ownerAccountId: string, contactAccountId: string): ContactStatus;
    /**
     * Check if a contact has been approved by the owner.
     *
     * This is a convenience method equivalent to:
     * `getContactStatus(owner, contact) === 'approved'`
     *
     * @param ownerAccountId - The account that would have approved (recipient).
     * @param contactAccountId - The account being checked (sender).
     * @returns true if the contact is approved, false otherwise.
     */
    isApprovedContact(ownerAccountId: string, contactAccountId: string): boolean;
    /**
     * Record a contact without approving it.
     *
     * Creates a 'pending' entry for the sender under the owner's contact list.
     * If the contact is already recorded (pending or approved), this is a no-op.
     *
     * Used by the relay server when a first-contact message is delivered to
     * track that the sender exists in the owner's contact space.
     *
     * @param ownerAccountId - The account receiving the contact record (recipient).
     * @param contactAccountId - The account being recorded (sender).
     */
    recordContact(ownerAccountId: string, contactAccountId: string): void;
    /**
     * Approve a contact. Autonomous actions are allowed after approval.
     *
     * Idempotent — re-approving an already-approved contact is a no-op.
     * Approval is remembered permanently within the store lifecycle.
     *
     * @param ownerAccountId - The account granting approval (recipient).
     * @param contactAccountId - The account being approved (sender).
     */
    approveContact(ownerAccountId: string, contactAccountId: string): void;
    /**
     * List all contacts that are in pending state for an owner.
     *
     * Returns an array of contact account IDs that have been recorded
     * but not yet approved.
     *
     * @param ownerAccountId - The account to list pending contacts for.
     * @returns Array of pending contact account IDs.
     */
    listPendingContacts(ownerAccountId: string): string[];
    /**
     * List all stored contacts for an owner.
     *
     * Returns both pending and approved contacts in insertion order.
     */
    listContacts(ownerAccountId: string): ContactEntry[];
    /**
     * Evaluate the first-contact autonomy policy for a message.
     *
     * Returns a policy result indicating:
     * - `firstContact`: Whether this is a first-contact (unknown sender)
     * - `autonomyAllowed`: Whether autonomous actions are permitted
     *
     * Delivery is ALWAYS allowed (not part of this evaluation —
     * messages always land in inbox regardless of contact state).
     *
     * @param recipientAccountId - The message recipient's account ID.
     * @param senderAccountId - The message sender's account ID.
     * @returns Policy evaluation result.
     */
    evaluatePolicy(recipientAccountId: string, senderAccountId: string): {
        firstContact: boolean;
        autonomyAllowed: boolean;
    };
}
//# sourceMappingURL=contact-store.d.ts.map