/**
 * File-backed persistence for relay runtime stores.
 *
 * Persists message, account, and contact state to a single JSON snapshot
 * so hosted sessions survive process restarts and deploy rehydrates.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AccountStore,
  type AccountStoreSnapshot,
} from './account-store.js';
import {
  ContactStore,
  type ContactStoreSnapshot,
} from './contact-store.js';
import {
  RelayMessageStore,
  type RelayMessageStoreSnapshot,
} from './message-store.js';

const STATE_FILE_MODE = 0o600;
const STATE_DIR_MODE = 0o700;
const STATE_VERSION = 1;
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

export function resolveRelayStatePath(
  env: Record<string, string | undefined> = process.env
): string | null {
  const configured = env['MORS_RELAY_STATE_PATH']?.trim();
  return configured && configured.length > 0 ? configured : null;
}

export function loadRelayPersistenceSnapshot(statePath: string): RelayPersistenceSnapshot | null {
  if (!existsSync(statePath)) {
    return null;
  }

  const raw = readFileSync(statePath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  if (parsed['version'] !== STATE_VERSION) {
    throw new Error(
      `Unsupported relay persistence version in ${statePath}. Expected ${STATE_VERSION}.`
    );
  }

  return {
    version: STATE_VERSION,
    messageStore: parsed['messageStore'] as RelayMessageStoreSnapshot,
    accountStore: parsed['accountStore'] as AccountStoreSnapshot,
    contactStore: parsed['contactStore'] as ContactStoreSnapshot,
  };
}

export function saveRelayPersistenceSnapshot(
  statePath: string,
  snapshot: RelayPersistenceSnapshot
): void {
  const dir = dirname(statePath);
  mkdirCreatedDirectoryOwnerOnly(dir);

  const tempPath = `${statePath}.tmp`;
  const data = JSON.stringify(snapshot, null, 2) + '\n';

  writeFileSync(tempPath, data, { mode: STATE_FILE_MODE });
  chmodSync(tempPath, STATE_FILE_MODE);
  renameSync(tempPath, statePath);
  chmodSync(statePath, STATE_FILE_MODE);
}

function mkdirCreatedDirectoryOwnerOnly(dir: string): void {
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
  if (!existed) {
    chmodSync(dir, STATE_DIR_MODE);
  }
}

export function createRelayPersistenceContext(
  options: RelayPersistenceOptions = {}
): RelayPersistenceContext {
  const logger = options.logger ?? (() => {});
  const statePath = options.statePath ?? resolveRelayStatePath();

  let messageStore!: RelayMessageStore;
  let accountStore!: AccountStore;
  let contactStore!: ContactStore;

  if (!statePath) {
    logger('relay persistence: file-backed state disabled (MORS_RELAY_STATE_PATH not set)');
    return {
      statePath: 'memory',
      messageStore: new RelayMessageStore(),
      accountStore: new AccountStore(),
      contactStore: new ContactStore(),
      save: () => {},
    };
  }

  const save = (): void => {
    saveRelayPersistenceSnapshot(statePath, {
      version: STATE_VERSION,
      messageStore: messageStore.snapshot(),
      accountStore: accountStore.snapshot(),
      contactStore: contactStore.snapshot(),
    });
  };

  const snapshot = loadRelayPersistenceSnapshot(statePath);
  if (snapshot) {
    messageStore = RelayMessageStore.fromSnapshot(snapshot.messageStore, save);
    accountStore = AccountStore.fromSnapshot(snapshot.accountStore, save);
    contactStore = ContactStore.fromSnapshot(snapshot.contactStore, save);
    logger(`relay persistence: loaded state from ${statePath}`);
  } else {
    messageStore = new RelayMessageStore(save);
    accountStore = new AccountStore(save);
    contactStore = new ContactStore(save);
    logger(`relay persistence: starting with empty state at ${statePath}`);
  }

  return {
    statePath,
    messageStore,
    accountStore,
    contactStore,
    save,
  };
}
