import type { Readable, Writable } from 'node:stream';
import { type HostedContact, type HostedSignupResult } from './hosted.js';
import { type PublishDeviceBundleOptions, type RelayDeviceBundleResponse, type RelayMessageResponse, type SendResult } from './relay/client.js';
interface Prompt {
    question(prompt: string): Promise<string>;
    close(): void;
}
interface StartIo {
    input?: Readable;
    output?: Writable;
    error?: Writable;
}
interface StartRuntime {
    signup(relayBaseUrl: string, options: {
        handle: string;
        displayName: string;
        deviceId: string;
    }): Promise<HostedSignupResult>;
    listContacts(relayBaseUrl: string, token: string): Promise<HostedContact[]>;
    addContact(relayBaseUrl: string, token: string, handle: string): Promise<HostedContact>;
    listPending(relayBaseUrl: string, token: string): Promise<HostedContact[]>;
    approveContact(relayBaseUrl: string, token: string, accountId: string): Promise<void>;
    listInbox(relayBaseUrl: string, token: string): Promise<RelayMessageResponse[]>;
    publishDeviceBundle?(relayBaseUrl: string, token: string, queueStorePath: string, bundle: PublishDeviceBundleOptions): Promise<void>;
    fetchDeviceBundle?(relayBaseUrl: string, token: string, queueStorePath: string, accountId: string, deviceId: string): Promise<RelayDeviceBundleResponse | null>;
    sendMessage(relayBaseUrl: string, token: string, queueStorePath: string, recipientId: string, body: string): Promise<SendResult>;
    sendEncryptedMessage?(relayBaseUrl: string, token: string, queueStorePath: string, recipientId: string, body: string, sharedSecret: Buffer, inReplyTo?: string): Promise<SendResult>;
}
export interface RunStartCommandOptions extends StartIo {
    configDir?: string;
    prompt?: Prompt;
    runtime?: StartRuntime;
}
export declare function runStartCommand(args: string[], options?: RunStartCommandOptions): Promise<void>;
export {};
//# sourceMappingURL=start.d.ts.map