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
import { RelayMessageStore } from './message-store.js';
import { AccountStore } from './account-store.js';
import { ContactStore } from './contact-store.js';
/** Logger function type. */
export type RelayLogger = (message: string) => void;
/** Options for creating the relay server. */
export interface RelayServerOptions {
    /** Custom logger. Defaults to console.log. */
    logger?: RelayLogger;
    /**
     * Token verifier for auth. Fail-closed: if not provided, all protected
     * routes return 401 (no fail-open path).
     */
    tokenVerifier?: TokenVerifier;
    /**
     * Participant store for object-level authorization on conversation routes.
     * Fail-closed: if not provided, conversation routes return 403.
     */
    participantStore?: ParticipantStore;
    /** Optional callback invoked on successful conversation access (for testing/observability). */
    onConversationAccess?: (principal: AuthPrincipal) => void;
    /**
     * Message store for relay async messaging.
     * When provided, enables /messages, /inbox, and /messages/:id routes.
     */
    messageStore?: RelayMessageStore;
    /**
     * Interval in milliseconds for periodic SSE token revalidation.
     * During an active SSE connection, the server re-verifies the bearer token
     * at this interval. If the token is no longer valid, an `auth_expired` event
     * is sent and the connection is closed (VAL-STREAM-006).
     *
     * Default: 60000 (60 seconds). Set to 0 to disable revalidation.
     */
    sseAuthRevalidateMs?: number;
    /**
     * Account store for handle registration and profile management.
     * When provided, enables /accounts/register, /accounts/me routes.
     * Enforces globally unique, immutable handles (VAL-AUTH-008, VAL-AUTH-012).
     */
    accountStore?: AccountStore;
    /**
     * Contact store for first-contact autonomy policy.
     * When provided, enables /contacts/* routes and annotates messages
     * with first_contact and autonomy_allowed fields.
     *
     * Delivery to inbox is always allowed regardless of contact state.
     * Autonomous actions are gated until first-contact approval.
     *
     * Covers VAL-RELAY-011, VAL-RELAY-012, VAL-RELAY-013.
     */
    contactStore?: ContactStore;
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
 * - GET /.well-known/agent-card.json — A2A Agent Card discovery (public, no auth)
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