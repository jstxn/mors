/**
 * Entry point for the mors relay service.
 *
 * Usage: PORT=3100 npm run relay:dev
 *
 * Loads config from environment, bootstraps persistence dependencies,
 * starts the HTTP server, and handles graceful shutdown on SIGINT/SIGTERM.
 */

import { loadRelayConfig } from './config.js';
import { bootstrapRelay } from './bootstrap.js';
import { createRelayServer } from './server.js';
import { createGitHubTokenVerifier } from './auth-middleware.js';

async function main(): Promise<void> {
  const config = loadRelayConfig();

  // Initialize persistence and other dependencies before accepting requests
  const bootstrap = await bootstrapRelay();
  if (!bootstrap.ready) {
    const failed = bootstrap.services.filter((s) => !s.ready).map((s) => s.name);
    console.error(`relay bootstrap failed: services not ready: ${failed.join(', ')}`);
    process.exit(1);
  }

  // Wire production auth dependencies — fail-closed by default.
  // Token verification uses the GitHub API to validate bearer tokens.
  // Participant store is a scaffold that denies all access until
  // real persistence is wired in a future milestone.
  const tokenVerifier = createGitHubTokenVerifier();
  const participantStore = {
    async isParticipant(_conversationId: string, _githubUserId: number): Promise<boolean> {
      // Scaffold: deny all until real persistence is wired.
      // This ensures fail-closed authz on conversation routes.
      return false;
    },
  };

  const server = createRelayServer(config, {
    tokenVerifier,
    participantStore,
  });

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
