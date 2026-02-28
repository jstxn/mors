/**
 * Vitest global setup — ensures dist/ is fresh before any tests run.
 *
 * Several test files execute `node dist/index.js` (CLI integration tests for
 * auth-gating, setup-shell, install-matrix, etc.).  When source changes are
 * made without a subsequent `npm run build`, those tests fail with confusing
 * stale-artifact errors (missing exports, SyntaxError, etc.).
 *
 * This setup compares the most-recent mtime in src/ against the mtime of
 * dist/index.js.  If any source file is newer — or dist/index.js doesn't
 * exist — it runs `npm run build` automatically before the suite starts.
 */

import { execSync } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** Recursively find the newest mtime (ms) among all .ts files under `dir`. */
function newestMtime(dir: string): number {
  let newest = 0;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else if (entry.name.endsWith('.ts')) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }

  return newest;
}

export async function setup(): Promise<void> {
  const distEntry = join(ROOT, 'dist', 'index.js');

  const needsBuild =
    !existsSync(distEntry) || newestMtime(join(ROOT, 'src')) > statSync(distEntry).mtimeMs;

  if (needsBuild) {
    console.log('[global-setup] dist/ is stale — rebuilding…');
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
    console.log('[global-setup] dist/ rebuilt successfully.');
  }
}
