/**
 * HTTP server scaffold for the mors relay service.
 *
 * Provides:
 * - Health endpoint for readiness checks (public, no auth)
 * - SSE baseline endpoint for event streaming (auth required)
 * - Conversation API endpoints with auth + participant authorization
 * - Deterministic startup/shutdown with clean process lifecycle
 * - Configurable logger for test observability
 *
 * Auth enforcement:
 * - All routes except /health require a valid Bearer token (VAL-AUTH-003)
 * - Conversation routes additionally require participant authorization (VAL-AUTH-004)
 * - Actor identity is always derived from validated token, never from client payload
 *
 * Uses Node.js built-in http module (no external framework dependency).
 */
import type { RelayConfig } from './config.js';
import { type TokenVerifier, type ParticipantStore, type AuthPrincipal } from './auth-middleware.js';
/** Logger function type. */
export type RelayLogger = (message: string) => void;
/** Options for creating the relay server. */
export interface RelayServerOptions {
    /** Custom logger. Defaults to console.log. */
    logger?: RelayLogger;
    /** Token verifier for auth. If not provided, all protected routes return 401. */
    tokenVerifier?: TokenVerifier;
    /** Participant store for object-level authorization on conversation routes. */
    participantStore?: ParticipantStore;
    /** Optional callback invoked on successful conversation access (for testing/observability). */
    onConversationAccess?: (principal: AuthPrincipal) => void;
}
/** Relay server handle with lifecycle methods. */
export interface RelayServer {
    /** Start listening. Resolves when the server is bound and ready. */
    start(): Promise<void>;
    /** Gracefully close the server. Resolves when all connections are terminated. */
    close(): Promise<void>;
    /** Whether the server is currently listening. */
    readonly listening: boolean;
    /** The port the server is bound to (valid after start). */
    readonly port: number;
}
/**
 * Create a relay server instance.
 *
 * The server exposes:
 * - GET /health — readiness check endpoint (public, no auth)
 * - GET /events — SSE baseline endpoint (auth required)
 * - /conversations/:id/messages — conversation API (auth + participant required)
 * - All other routes return 404
 *
 * @param config - Relay configuration.
 * @param options - Optional server options (logger, auth, etc.).
 * @returns A RelayServer handle for lifecycle management.
 */
export declare function createRelayServer(config: RelayConfig, options?: RelayServerOptions): RelayServer;
//# sourceMappingURL=server.d.ts.map