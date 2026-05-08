export { MaildirSpool, MaildirSpoolError, MaildirEntryError, relayMessageToSpoolMessage, } from './maildir.js';
export { SpoolValidationError, parseSpoolCommand, processSpoolOnce, reconcileInbox, runSpoolBridge, } from './bridge.js';
export type { SpoolBridgeHandle, SpoolBridgeOptions, SpoolBridgeResult, } from './bridge.js';
export type { MaildirEntry, MaildirZone, RelayInboxResult, SpoolBody, SpoolCommand, SpoolCommandKind, SpoolControlCommand, SpoolMaterializedMessage, SpoolMailbox, SpoolRelayClient, SpoolSendCommand, SpoolToolRequest, } from './types.js';
export { SPOOL_COMMAND_KINDS, SPOOL_SCHEMA } from './types.js';
//# sourceMappingURL=index.d.ts.map