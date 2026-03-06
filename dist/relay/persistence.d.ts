/**
 * File-backed persistence for relay runtime stores.
 *
 * Persists message, account, and contact state to a single JSON snapshot
 * so hosted sessions survive process restarts and deploy rehydrates.
 */
import { AccountStore, type AccountStoreSnapshot } from './account-store.js';
import { ContactStore, type ContactStoreSnapshot } from './contact-store.js';
import { RelayMessageStore, type RelayMessageStoreSnapshot } from './message-store.js';
export interface RelayPersistenceSnapshot {
    version: number;
    messageStore: RelayMessageStoreSnapshot;
    accountStore: AccountStoreSnapshot;
    contactStore: ContactStoreSnapshot;
}
export interface RelayPersistenceContext {
    statePath: string;
    messageStore: RelayMessageStore;
    accountStore: AccountStore;
    contactStore: ContactStore;
    save(): void;
}
export interface RelayPersistenceOptions {
    statePath?: string;
    logger?: (message: string) => void;
}
export declare function resolveRelayStatePath(env?: Record<string, string | undefined>): string | null;
export declare function loadRelayPersistenceSnapshot(statePath: string): RelayPersistenceSnapshot | null;
export declare function saveRelayPersistenceSnapshot(statePath: string, snapshot: RelayPersistenceSnapshot): void;
export declare function createRelayPersistenceContext(options?: RelayPersistenceOptions): RelayPersistenceContext;
//# sourceMappingURL=persistence.d.ts.map