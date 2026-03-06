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
type FocusPane = 'contacts' | 'activity';
type ActivityView = 'inbox' | 'pending';
export interface StartScreenState {
    handle: string;
    relayBaseUrl: string;
    status: string;
    contacts: HostedContact[];
    pending: HostedContact[];
    inbox: RelayMessageResponse[];
    selectedContactIndex: number;
    selectedActivityIndex: number;
    focus: FocusPane;
    activityView: ActivityView;
    previewTitle: string;
    previewBody: string[];
    composerOpen: boolean;
    draft: string;
}
export declare function runStartCommand(args: string[], options?: RunStartCommandOptions): Promise<void>;
export declare function shouldUseFullScreenStartApp(options: {
    input?: Readable;
    output?: Writable;
    promptOverride?: boolean;
}): boolean;
export declare function buildStartScreen(state: StartScreenState, options?: {
    width?: number;
    height?: number;
}): string;
export {};
//# sourceMappingURL=start.d.ts.map