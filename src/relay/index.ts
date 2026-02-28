/**
 * Entry point for the mors relay service.
 *
 * Usage: PORT=3100 npm run relay:dev
 *
 * Loads config from environment, starts the HTTP server,
 * and handles graceful shutdown on SIGINT/SIGTERM.
 */

import { loadRelayConfig } from './config.js';
import { createRelayServer } from './server.js';

async function main(): Promise<void> {
  const config = loadRelayConfig();
  const server = createRelayServer(config);

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.start();
}

main().catch((err: unknown) => {
  console.error('Failed to start mors relay:', err);
  process.exit(1);
});
