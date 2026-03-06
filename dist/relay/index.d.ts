/**
 * Entry point for the mors relay service.
 *
 * Usage: PORT=3100 npm run relay:dev
 *
 * Loads config from environment, bootstraps persistence dependencies,
 * starts the HTTP server, and handles graceful shutdown on SIGINT/SIGTERM.
 *
 * Exports `createProductionServerOptions` for test verification that the
 * production wiring includes messageStore and participant authorization.
 */
import { type RelayServerOptions } from './server.js';
import type { RelayPersistenceContext } from './persistence.js';
/**
 * Create the production server options including all wired dependencies.
 *
 * Assembles auth, authorization, and messaging dependencies for the relay
 * server. Extracted as a named export so tests can verify the production
 * wiring without running the full entrypoint lifecycle.
 *
 * @returns RelayServerOptions with tokenVerifier, participantStore, and messageStore.
 */
export declare function createProductionServerOptions(options?: {
    persistence?: RelayPersistenceContext;
}): RelayServerOptions;
//# sourceMappingURL=index.d.ts.map