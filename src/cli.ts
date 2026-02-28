/**
 * CLI dispatcher for the mors command.
 * Commands will be added here as features are implemented.
 */

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

  console.error(`Unknown command: ${command}`);
  console.error('Run "mors --help" for usage information.');
  process.exitCode = 1;
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
