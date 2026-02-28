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
async function main() {
    const config = loadRelayConfig();
    // Initialize persistence and other dependencies before accepting requests
    const bootstrap = await bootstrapRelay();
    if (!bootstrap.ready) {
        const failed = bootstrap.services.filter((s) => !s.ready).map((s) => s.name);
        console.error(`relay bootstrap failed: services not ready: ${failed.join(', ')}`);
        process.exit(1);
    }
    const server = createRelayServer(config);
    // Graceful shutdown handler
    const shutdown = async (signal) => {
        console.log(`\nReceived ${signal}, shutting down...`);
        await server.close();
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    await server.start();
}
main().catch((err) => {
    console.error('Failed to start mors relay:', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map