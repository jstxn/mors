import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Single source of truth for the package version.
 *
 * Read from package.json at runtime so the CLI `--version` output and the init
 * sentinel never drift from the published version.
 * Both the compiled entrypoint (dist/version.js) and the tsx dev path
 * (src/version.ts) sit one directory below package.json, so the relative
 * lookup resolves in either context.
 */
function readPackageVersion(): string {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const raw = readFileSync(fileURLToPath(pkgUrl), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to the fallback below when package.json is unreadable.
  }
  return '0.0.0';
}

export const MORS_VERSION = readPackageVersion();
