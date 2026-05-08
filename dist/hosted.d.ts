export interface HostedSignupResult {
    accessToken: string;
    accountId: string;
    deviceId: string;
    handle: string;
    displayName: string;
}
export interface HostedDeviceBundle {
    device_id: string;
    fingerprint: string;
    x25519_public_key: string;
    ed25519_public_key?: string;
}
export interface HostedContact {
    account_id: string;
    handle: string;
    display_name: string;
    status: 'pending' | 'approved';
    autonomy_allowed: boolean;
    first_contact?: boolean;
    device_bundle?: HostedDeviceBundle;
}
export declare function formatHostedRequestError(method: string, url: URL, err: unknown): Error;
export declare function hostedSignup(relayBaseUrl: string, options: {
    handle: string;
    displayName: string;
    deviceId: string;
}): Promise<HostedSignupResult>;
export declare function addHostedContact(relayBaseUrl: string, token: string, handle: string): Promise<HostedContact>;
export declare function listHostedContacts(relayBaseUrl: string, token: string): Promise<HostedContact[]>;
export declare function listPendingContacts(relayBaseUrl: string, token: string): Promise<HostedContact[]>;
export declare function approveHostedContact(relayBaseUrl: string, token: string, accountId: string): Promise<void>;
//# sourceMappingURL=hosted.d.ts.map