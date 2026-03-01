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
import { loadRelayConfig } from './config.js';
import { bootstrapRelay } from './bootstrap.js';
import { createRelayServer } from './server.js';
import { createNativeTokenVerifier } from './auth-middleware.js';
import { RelayMessageStore } from './message-store.js';
import { AccountStore } from './account-store.js';
import { ContactStore } from './contact-store.js';
/**
 * Create the production server options including all wired dependencies.
 *
 * Assembles auth, authorization, and messaging dependencies for the relay
 * server. Extracted as a named export so tests can verify the production
 * wiring without running the full entrypoint lifecycle.
 *
 * @returns RelayServerOptions with tokenVerifier, participantStore, and messageStore.
 */
export function createProductionServerOptions() {
    // Wire production auth dependencies — fail-closed by design.
    // Token verification uses HMAC-signed native session tokens.
    // The signing key MUST be explicitly configured — an empty/missing key
    // would allow trivial token forgery, so we fail at startup instead.
    const signingKey = (process.env['MORS_RELAY_SIGNING_KEY'] ?? '').trim();
    if (!signingKey) {
        throw new Error('MORS_RELAY_SIGNING_KEY is not set or is empty. ' +
            'The relay cannot start without a signing key — an empty key would allow token forgery. ' +
            'Set MORS_RELAY_SIGNING_KEY to a secure random value. ' +
            "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    }
    const tokenVerifier = createNativeTokenVerifier(signingKey);
    // Wire the in-memory message store for async messaging routes.
    // This ensures /messages, /inbox, and /messages/:id routes are active
    // in the production relay, not only in test-only server construction.
    const messageStore = new RelayMessageStore();
    // Wire the in-memory account store for handle registration and profile management.
    // Enforces globally unique, immutable handles (VAL-AUTH-008, VAL-AUTH-012).
    const accountStore = new AccountStore();
    // Wire the in-memory contact store for first-contact autonomy policy.
    // Ensures /contacts/* routes are active and messages are annotated with
    // first_contact / autonomy_allowed fields in the production relay.
    // Delivery always succeeds; autonomous actions are gated until approval.
    // Covers VAL-RELAY-011, VAL-RELAY-012, VAL-RELAY-013.
    const contactStore = new ContactStore();
    // Participant store backed by the message store's conversation tracking.
    // When a message is sent, both sender and recipient are registered as
    // participants in the thread, enabling object-level authorization checks.
    const participantStore = {
        async isParticipant(conversationId, accountId) {
            return messageStore.isParticipant(conversationId, accountId);
        },
    };
    return {
        tokenVerifier,
        participantStore,
        messageStore,
        accountStore,
        contactStore,
    };
}
async function main() {
    const config = loadRelayConfig();
    // Initialize persistence and other dependencies before accepting requests
    const bootstrap = await bootstrapRelay();
    if (!bootstrap.ready) {
        const failed = bootstrap.services.filter((s) => !s.ready).map((s) => s.name);
        console.error(`relay bootstrap failed: services not ready: ${failed.join(', ')}`);
        process.exit(1);
    }
    const serverOptions = createProductionServerOptions();
    const server = createRelayServer(config, serverOptions);
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
// Only run main() when executed as the entrypoint (not when imported by tests).
// When loaded via vitest or other test runners, the module is imported for its
// exports — running main() would start a real server and block the process.
const isTestEnvironment = typeof process !== 'undefined' &&
    (process.env['VITEST'] === 'true' ||
        process.env['NODE_ENV'] === 'test' ||
        process.env['JEST_WORKER_ID'] !== undefined);
if (!isTestEnvironment) {
    main().catch((err) => {
        console.error('Failed to start mors relay:', err);
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map