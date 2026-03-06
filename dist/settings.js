import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const DIR_MODE = 0o700;
const SETTINGS_FILE = 'settings.json';
export const DEFAULT_HOSTED_RELAY_BASE_URL = 'https://mors.fly.dev';
export function getSettingsPath(configDir) {
    return join(configDir, SETTINGS_FILE);
}
export function loadClientSettings(configDir) {
    const settingsPath = getSettingsPath(configDir);
    if (!existsSync(settingsPath)) {
        return {};
    }
    try {
        const raw = readFileSync(settingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        const relayMode = parsed['relayMode'] === 'hosted' || parsed['relayMode'] === 'custom'
            ? parsed['relayMode']
            : undefined;
        const relayBaseUrl = typeof parsed['relayBaseUrl'] === 'string' && parsed['relayBaseUrl'].trim().length > 0
            ? parsed['relayBaseUrl'].trim()
            : undefined;
        const updatedAt = typeof parsed['updatedAt'] === 'string' ? parsed['updatedAt'] : undefined;
        return { relayMode, relayBaseUrl, updatedAt };
    }
    catch {
        return {};
    }
}
export function saveClientSettings(configDir, settings) {
    mkdirSync(configDir, { recursive: true, mode: DIR_MODE });
    chmodSync(configDir, DIR_MODE);
    const payload = {
        relayMode: settings.relayMode,
        relayBaseUrl: settings.relayBaseUrl,
        updatedAt: new Date().toISOString(),
    };
    writeFileSync(getSettingsPath(configDir), JSON.stringify(payload, null, 2) + '\n', {
        mode: 0o644,
    });
}
export function resolveRelayBaseUrl(configDir) {
    const envRelay = process.env['MORS_RELAY_BASE_URL']?.trim();
    if (envRelay) {
        return envRelay;
    }
    return loadClientSettings(configDir).relayBaseUrl ?? DEFAULT_HOSTED_RELAY_BASE_URL;
}
export function resolveConfiguredRelayBaseUrl(configDir) {
    const envRelay = process.env['MORS_RELAY_BASE_URL']?.trim();
    if (envRelay) {
        return envRelay;
    }
    return loadClientSettings(configDir).relayBaseUrl ?? null;
}
//# sourceMappingURL=settings.js.map