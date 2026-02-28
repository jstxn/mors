/**
 * `mors setup-shell` implementation.
 *
 * Detects shell profile target, previews PATH edits, prompts for
 * confirmation, applies only approved edits, and remains idempotent
 * across repeated runs.
 *
 * Fulfills: VAL-INSTALL-002, VAL-INSTALL-003, VAL-INSTALL-004
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { createInterface } from 'node:readline';

/** Comment marker used to identify mors-managed PATH lines for idempotency. */
const MORS_MARKER = '# mors';

export interface ShellProfile {
  /** Detected shell name (e.g., 'zsh', 'bash'). */
  shellName: string;
  /** Absolute path to the RC file that will be edited. */
  rcFile: string;
}

export interface DetectOptions {
  /** Value of $SHELL environment variable. */
  shell: string | undefined;
  /** Home directory path. */
  home: string;
  /** Platform override (defaults to process.platform). */
  platform?: string;
}

/**
 * Detect the user's shell and determine the appropriate RC file target.
 *
 * Resolution logic:
 * - Extracts shell name from $SHELL (basename, e.g., '/bin/zsh' → 'zsh').
 * - For zsh: targets `~/.zshrc`.
 * - For bash on macOS: prefers `~/.bash_profile` if it already exists,
 *   otherwise `~/.bashrc`.
 * - For bash on other platforms: targets `~/.bashrc`.
 * - Falls back to zsh/.zshrc if $SHELL is unset or unrecognized.
 */
export function detectShellProfile(options: DetectOptions): ShellProfile {
  const { home, platform } = options;
  const shellPath = options.shell;

  // Extract shell basename (e.g., '/usr/local/bin/zsh' → 'zsh')
  const shellName = shellPath ? basename(shellPath) : 'zsh';

  if (shellName === 'bash') {
    // On macOS, bash login shells source .bash_profile, not .bashrc.
    // Prefer .bash_profile if it already exists; otherwise use .bashrc.
    const effectivePlatform = platform ?? process.platform;
    if (effectivePlatform === 'darwin') {
      const bashProfile = join(home, '.bash_profile');
      if (existsSync(bashProfile)) {
        return { shellName: 'bash', rcFile: bashProfile };
      }
    }
    return { shellName: 'bash', rcFile: join(home, '.bashrc') };
  }

  // Default to zsh for zsh, fish->zsh fallback, or unrecognized shells
  return { shellName: 'zsh', rcFile: join(home, '.zshrc') };
}

/**
 * Build the PATH export line to be added to the RC file.
 * Includes the mors marker comment for idempotency detection.
 */
export function buildPathLine(binDir: string): string {
  return `export PATH="${binDir}:$PATH" ${MORS_MARKER}`;
}

/**
 * Check whether the RC file content already contains the mors PATH line.
 * Detects both exact match and marker-based match for idempotency.
 */
export function rcAlreadyContainsPathLine(content: string, binDir: string): boolean {
  // Check for exact path line match
  const exactLine = buildPathLine(binDir);
  if (content.includes(exactLine)) {
    return true;
  }

  // Check for marker-based match: any line with the mors marker
  // that also references the same bin directory
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.includes(MORS_MARKER) && line.includes(binDir)) {
      return true;
    }
  }

  return false;
}

export interface ApplyResult {
  /** Whether the edit was applied (false if already present). */
  applied: boolean;
  /** Whether the path line was already present. */
  alreadyPresent: boolean;
}

/**
 * Apply the PATH edit to the RC file.
 *
 * - Creates the file if it doesn't exist.
 * - Appends the PATH line if not already present.
 * - Returns without modification if already present (idempotent).
 */
export function applyRcEdit(rcFile: string, binDir: string): ApplyResult {
  // Check existing content
  let existingContent = '';
  if (existsSync(rcFile)) {
    existingContent = readFileSync(rcFile, 'utf-8');
  }

  // Idempotency check
  if (rcAlreadyContainsPathLine(existingContent, binDir)) {
    return { applied: false, alreadyPresent: true };
  }

  const pathLine = buildPathLine(binDir);

  if (!existingContent) {
    // Create new file
    writeFileSync(rcFile, pathLine + '\n', { mode: 0o644 });
  } else {
    // Append to existing file with proper newline handling
    const separator = existingContent.endsWith('\n') ? '' : '\n';
    appendFileSync(rcFile, `${separator}${pathLine}\n`);
  }

  return { applied: true, alreadyPresent: false };
}

/**
 * Format the preview message shown to the user before confirmation.
 */
export function formatPreview(rcFile: string, binDir: string): string {
  const pathLine = buildPathLine(binDir);
  return [
    '',
    `mors setup-shell will add the following to ${rcFile}:`,
    '',
    `  ${pathLine}`,
    '',
    'This adds the mors binary directory to your PATH so you can run',
    '`mors` directly from your terminal.',
    '',
  ].join('\n');
}

/**
 * Resolve the npm global bin directory where mors is installed.
 *
 * Checks MORS_SETUP_SHELL_BIN_DIR environment variable first (for testing),
 * then falls back to detecting via `npm prefix -g` or dirname of process.argv[1].
 */
export function resolveBinDir(): string {
  // Testing hook: allow override via environment variable
  const override = process.env['MORS_SETUP_SHELL_BIN_DIR'];
  if (override) {
    return override;
  }

  // Try to determine from the running binary's location
  // When installed globally via npm, process.argv[1] will be in the npm bin dir
  const scriptPath = process.argv[1];
  if (scriptPath) {
    return dirname(scriptPath);
  }

  // Fallback: use a common default
  return '/usr/local/bin';
}

export interface SetupShellOptions {
  /** Override home directory (for testing). */
  home?: string;
  /** Override $SHELL (for testing). */
  shell?: string;
  /** Override bin directory (for testing). */
  binDir?: string;
  /** Whether to auto-confirm without prompting (--confirm flag). */
  autoConfirm?: boolean;
  /** Whether to auto-decline without prompting (--decline flag). */
  autoDecline?: boolean;
  /** Whether to output JSON. */
  json?: boolean;
  /** Input stream for confirmation prompt. */
  input?: NodeJS.ReadableStream;
  /** Output stream for messages. */
  output?: NodeJS.WritableStream;
}

/**
 * Run the setup-shell interactive flow.
 *
 * 1. Detects shell and RC file target.
 * 2. Checks if PATH is already configured (idempotent).
 * 3. Previews the edit.
 * 4. Prompts for confirmation (unless --confirm/--decline).
 * 5. Applies only approved edits.
 */
export async function runSetupShell(options: SetupShellOptions = {}): Promise<void> {
  const home = options.home ?? process.env['HOME'] ?? process.cwd();
  const shell = options.shell ?? process.env['SHELL'];
  const binDir = options.binDir ?? resolveBinDir();
  const json = options.json ?? false;

  // Step 1: Detect shell profile
  const profile = detectShellProfile({ shell, home });

  // Step 2: Check if already configured
  let existingContent = '';
  if (existsSync(profile.rcFile)) {
    existingContent = readFileSync(profile.rcFile, 'utf-8');
  }

  const alreadyConfigured = rcAlreadyContainsPathLine(existingContent, binDir);

  if (alreadyConfigured) {
    if (json) {
      console.log(
        JSON.stringify({
          status: 'already_configured',
          shell: profile.shellName,
          rcFile: profile.rcFile,
          binDir,
          message: 'PATH is already configured for mors. No changes needed.',
        })
      );
    } else {
      console.log(`Already configured: ${profile.rcFile} already contains mors PATH entry.`);
      console.log('No changes needed.');
    }
    return;
  }

  // Step 3: Preview
  if (!json) {
    const preview = formatPreview(profile.rcFile, binDir);
    console.log(preview);
  }

  // Step 4: Determine confirmation
  let confirmed: boolean;
  if (options.autoConfirm) {
    confirmed = true;
  } else if (options.autoDecline) {
    confirmed = false;
  } else {
    // Interactive prompt — use stderr for prompt text when in JSON mode
    // to keep stdout clean for machine-readable output.
    const promptOutput = json
      ? (options.output ?? process.stderr)
      : (options.output ?? process.stdout);
    confirmed = await promptConfirmation(
      'Apply this change? (y/N) ',
      options.input ?? process.stdin,
      promptOutput
    );
  }

  // Step 5: Apply or decline
  if (confirmed) {
    const result = applyRcEdit(profile.rcFile, binDir);
    if (json) {
      console.log(
        JSON.stringify({
          status: result.alreadyPresent ? 'already_configured' : 'applied',
          shell: profile.shellName,
          rcFile: profile.rcFile,
          binDir,
          applied: result.applied,
        })
      );
    } else {
      if (result.alreadyPresent) {
        console.log('Already configured. No changes needed.');
      } else {
        console.log(`Done! Updated ${profile.rcFile}`);
        console.log(`Restart your terminal or run: source ${profile.rcFile}`);
      }
    }
  } else {
    if (json) {
      console.log(
        JSON.stringify({
          status: 'declined',
          shell: profile.shellName,
          rcFile: profile.rcFile,
          binDir,
          applied: false,
        })
      );
    } else {
      console.log('No changes applied.');
    }
  }
}

/**
 * Prompt the user for yes/no confirmation.
 * Returns true for 'y'/'yes', false for anything else (including empty/EOF).
 */
async function promptConfirmation(
  prompt: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream
): Promise<boolean> {
  const rl = createInterface({ input, output, terminal: false });

  return new Promise<boolean>((resolve) => {
    let resolved = false;
    output.write(prompt);
    rl.once('line', (answer: string) => {
      if (!resolved) {
        resolved = true;
        rl.close();
        const trimmed = answer.trim().toLowerCase();
        resolve(trimmed === 'y' || trimmed === 'yes');
      }
    });
    rl.once('close', () => {
      if (!resolved) {
        // If closed without a line (e.g., piped empty stdin), treat as decline
        resolved = true;
        resolve(false);
      }
    });
  });
}
