import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_HOSTED_RELAY_BASE_URL,
  loadClientSettings,
  resolveRelayBaseUrl,
  saveClientSettings,
} from '../src/settings.js';

describe('client settings', () => {
  it('persists and reloads relay settings', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mors-settings-'));

    try {
      saveClientSettings(configDir, {
        relayMode: 'hosted',
        relayBaseUrl: DEFAULT_HOSTED_RELAY_BASE_URL,
      });

      expect(loadClientSettings(configDir)).toMatchObject({
        relayMode: 'hosted',
        relayBaseUrl: DEFAULT_HOSTED_RELAY_BASE_URL,
      });
      expect(resolveRelayBaseUrl(configDir)).toBe(DEFAULT_HOSTED_RELAY_BASE_URL);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('prefers the env relay override over saved settings', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mors-settings-'));
    const original = process.env['MORS_RELAY_BASE_URL'];

    try {
      saveClientSettings(configDir, {
        relayMode: 'hosted',
        relayBaseUrl: DEFAULT_HOSTED_RELAY_BASE_URL,
      });
      process.env['MORS_RELAY_BASE_URL'] = 'https://override.example.com';

      expect(resolveRelayBaseUrl(configDir)).toBe('https://override.example.com');
    } finally {
      if (original === undefined) {
        delete process.env['MORS_RELAY_BASE_URL'];
      } else {
        process.env['MORS_RELAY_BASE_URL'] = original;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
