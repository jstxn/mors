export {
  MaildirSpool,
  MaildirSpoolError,
  MaildirEntryError,
  MaildirQuotaError,
  relayMessageToSpoolMessage,
} from './maildir.js';
export {
  DEFAULT_SPOOL_POLICY,
  SPOOL_POLICY_SCHEMA,
  SpoolPolicyError,
  loadSpoolPolicy,
  mergeSpoolPolicy,
  normalizeSpoolPolicy,
  validateSpoolCommandPolicy,
} from './policy.js';
export {
  SPOOL_BRIDGE_STATE_SCHEMA,
  SpoolBridgeStateStore,
  defaultSpoolBridgeStatePath,
} from './state.js';
export { runSpoolTool } from './tool-runner.js';
export {
  SpoolValidationError,
  parseSpoolCommand,
  processSpoolOnce,
  reconcileInbox,
  runSpoolBridge,
} from './bridge.js';
export type {
  SpoolBridgeHandle,
  SpoolBridgeOptions,
  SpoolBridgeResult,
} from './bridge.js';
export type {
  MaildirEntrySummary,
  MaildirMailboxStats,
  MaildirSpoolStats,
} from './maildir.js';
export type {
  MaildirEntry,
  MaildirZone,
  RelayInboxResult,
  SpoolBody,
  SpoolCommand,
  SpoolCommandKind,
  SpoolControlCommand,
  SpoolMaterializedMessage,
  SpoolMailbox,
  SpoolRelayClient,
  SpoolSendCommand,
  SpoolToolRequest,
} from './types.js';
export type {
  SpoolPolicy,
  SpoolQuotaPolicy,
  SpoolToolPolicy,
  SpoolToolRunnerPolicy,
} from './policy.js';
export type { SpoolBridgeState } from './state.js';
export type { SpoolToolRunResult } from './tool-runner.js';
export { SPOOL_COMMAND_KINDS, SPOOL_SCHEMA } from './types.js';
