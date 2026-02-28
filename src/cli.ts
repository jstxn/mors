/**
 * CLI dispatcher for the mors command.
 *
 * Routes commands, handles init gating (VAL-INIT-005),
 * and formats output with secret redaction (VAL-INIT-004).
 */

import { initCommand } from "./init.js";
import { requireInit } from "./init.js";
import { MorsError, NotInitializedError, SqlCipherUnavailableError } from "./errors.js";

/** Commands that require initialization before use. */
const GATED_COMMANDS = new Set([
  "send",
  "inbox",
  "read",
  "reply",
  "ack",
  "watch",
]);

export function run(args: string[]): void {
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log("mors 0.1.0");
    return;
  }

  if (command === "init") {
    runInit(args.slice(1));
    return;
  }

  // ── Pre-init command gating (VAL-INIT-005) ──────────────────────
  if (GATED_COMMANDS.has(command)) {
    try {
      requireInit();
    } catch (err: unknown) {
      if (err instanceof NotInitializedError) {
        console.error(`Error: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    // Command is gated but not yet implemented — report it.
    console.error(`Command "${command}" is not yet implemented.`);
    process.exitCode = 1;
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error('Run "mors --help" for usage information.');
  process.exitCode = 1;
}

function runInit(_args: string[]): void {
  // Parse --json flag for machine-readable output.
  const json = _args.includes("--json");
  // Parse testing hooks (hidden flags, not shown in help).
  const simulateSqlCipherUnavailable = _args.includes(
    "--simulate-sqlcipher-unavailable"
  );
  const simulateFailureAfterIdentity = _args.includes(
    "--simulate-failure-after-identity"
  );

  // Use a promise to handle the async initCommand.
  initCommand({
    simulateSqlCipherUnavailable,
    simulateFailureAfterIdentity,
  })
    .then((result) => {
      if (json) {
        console.log(
          JSON.stringify({
            status: result.alreadyInitialized
              ? "already_initialized"
              : "initialized",
            fingerprint: result.fingerprint,
            configDir: result.configDir,
          })
        );
      } else if (result.alreadyInitialized) {
        console.log("mors is already initialized.");
        console.log(`Identity fingerprint: ${result.fingerprint}`);
        console.log(`Config directory: ${result.configDir}`);
      } else {
        console.log("mors initialized successfully.");
        console.log(`Identity fingerprint: ${result.fingerprint}`);
        console.log(`Config directory: ${result.configDir}`);
      }
    })
    .catch((err: unknown) => {
      process.exitCode = 1;
      if (err instanceof SqlCipherUnavailableError) {
        if (json) {
          console.log(
            JSON.stringify({
              status: "error",
              error: "sqlcipher_unavailable",
              message: err.message,
            })
          );
        } else {
          console.error(`Error: ${err.message}`);
        }
      } else if (err instanceof MorsError) {
        if (json) {
          console.log(
            JSON.stringify({
              status: "error",
              error: err.name,
              message: err.message,
            })
          );
        } else {
          console.error(`Error: ${err.message}`);
        }
      } else {
        const msg =
          err instanceof Error ? err.message : String(err);
        if (json) {
          console.log(
            JSON.stringify({
              status: "error",
              error: "unknown",
              message: msg,
            })
          );
        } else {
          console.error(`Error: ${msg}`);
        }
      }
    });
}

function printUsage(): void {
  console.log(`mors — markdown-first encrypted local CLI messaging

Usage:
  mors <command> [options]

Commands:
  init       Initialize identity and encrypted store
  send       Send a message
  inbox      List messages
  read       Read a message
  reply      Reply to a message
  ack        Acknowledge a message
  watch      Watch for new messages

Options:
  -h, --help     Show this help
  -v, --version  Show version`);
}
