/**
 * `mors setup-shell` implementation.
 *
 * Detects shell profile target, previews PATH edits, prompts for
 * confirmation, applies only approved edits, and remains idempotent
 * across repeated runs.
 *
 * Fulfills: VAL-INSTALL-002, VAL-INSTALL-003, VAL-INSTALL-004
 */
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
export declare function detectShellProfile(options: DetectOptions): ShellProfile;
/**
 * Build the PATH export line to be added to the RC file.
 * Includes the mors marker comment for idempotency detection.
 */
export declare function buildPathLine(binDir: string): string;
/**
 * Check whether the RC file content already contains the mors PATH line.
 * Detects both exact match and marker-based match for idempotency.
 */
export declare function rcAlreadyContainsPathLine(content: string, binDir: string): boolean;
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
export declare function applyRcEdit(rcFile: string, binDir: string): ApplyResult;
/**
 * Format the preview message shown to the user before confirmation.
 */
export declare function formatPreview(rcFile: string, binDir: string): string;
/**
 * Resolve the npm global bin directory where mors is installed.
 *
 * Checks MORS_SETUP_SHELL_BIN_DIR environment variable first (for testing),
 * then falls back to detecting via `npm prefix -g` or dirname of process.argv[1].
 */
export declare function resolveBinDir(): string;
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
export declare function runSetupShell(options?: SetupShellOptions): Promise<void>;
//# sourceMappingURL=setup-shell.d.ts.map