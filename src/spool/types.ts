import type {
  AckResult,
  ReadResult,
  RelayMessageResponse,
  SendResult,
} from '../relay/client.js';

export const SPOOL_SCHEMA = 'mors.spool.v1';

export const SPOOL_COMMAND_KINDS = [
  'message',
  'tool_request',
  'tool_result',
  'read',
  'ack',
] as const;

export type SpoolCommandKind = (typeof SPOOL_COMMAND_KINDS)[number];

export interface SpoolBody {
  format: string;
  content: string;
}

export interface SpoolToolRequest {
  name: string;
  args?: Record<string, unknown>;
}

export interface SpoolSendCommand {
  schema: typeof SPOOL_SCHEMA;
  kind: 'message' | 'tool_request' | 'tool_result';
  recipient_id: string;
  body: SpoolBody;
  subject?: string;
  in_reply_to?: string | null;
  dedupe_key?: string;
  trace_id?: string;
  tool?: SpoolToolRequest | null;
}

export interface SpoolControlCommand {
  schema: typeof SPOOL_SCHEMA;
  kind: 'read' | 'ack';
  message_id: string;
  dedupe_key?: string;
}

export type SpoolCommand = SpoolSendCommand | SpoolControlCommand;

export type SpoolMailbox = 'outbox' | 'inbox' | 'control' | 'failed';
export type MaildirZone = 'tmp' | 'new' | 'cur';

export interface MaildirEntry {
  mailbox: SpoolMailbox;
  zone: MaildirZone;
  name: string;
  path: string;
}

export interface SpoolMaterializedMessage extends RelayMessageResponse {
  schema: typeof SPOOL_SCHEMA;
  kind: 'relay_message';
}

export interface RelayInboxResult {
  count: number;
  messages: RelayMessageResponse[];
}

export interface SpoolRelayClient {
  send(options: {
    recipientId: string;
    body: string;
    subject?: string;
    inReplyTo?: string;
    dedupeKey?: string;
  }): Promise<SendResult>;
  read(messageId: string): Promise<ReadResult>;
  ack(messageId: string): Promise<AckResult>;
  get?(messageId: string): Promise<RelayMessageResponse>;
  inbox?(options?: { unreadOnly?: boolean }): Promise<RelayInboxResult>;
}
