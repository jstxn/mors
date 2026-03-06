export declare const DEFAULT_HOSTED_RELAY_BASE_URL = "https://mors.fly.dev";
export interface ClientSettings {
    relayMode?: 'hosted' | 'custom';
    relayBaseUrl?: string;
    updatedAt?: string;
}
export declare function getSettingsPath(configDir: string): string;
export declare function loadClientSettings(configDir: string): ClientSettings;
export declare function saveClientSettings(configDir: string, settings: ClientSettings): void;
export declare function resolveRelayBaseUrl(configDir: string): string;
export declare function resolveConfiguredRelayBaseUrl(configDir: string): string | null;
//# sourceMappingURL=settings.d.ts.map