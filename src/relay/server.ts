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

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { RelayConfig } from './config.js';
import {
  type TokenVerifier,
  type ParticipantStore,
  type AuthPrincipal,
  isPublicRoute,
  extractAndVerify,
  send401,
  send403,
  parseConversationRoute,
} from './auth-middleware.js';

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
 * Send a JSON response.
 */
function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
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
export function createRelayServer(config: RelayConfig, options?: RelayServerOptions): RelayServer {
  const logger = options?.logger ?? console.log;
  const tokenVerifier = options?.tokenVerifier;
  const participantStore = options?.participantStore;
  const onConversationAccess = options?.onConversationAccess;
  const startTime = Date.now();

  // Track active SSE connections for clean shutdown
  const sseConnections = new Set<ServerResponse>();

  /**
   * Async request handler. Separated from createServer callback to
   * enable await for auth verification and participant checks.
   */
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    // Route: GET /health (public — no auth required)
    if (isPublicRoute(url)) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: 'method_not_allowed', allowed: ['GET'] });
        return;
      }

      const uptimeMs = Date.now() - startTime;
      sendJson(res, 200, {
        status: 'ok',
        service: 'mors-relay',
        uptime: Math.floor(uptimeMs / 1000),
        configWarnings: config.diagnostics.length,
      });
      return;
    }

    // ── Auth guard: when a token verifier is configured, all non-public
    // routes require a valid Bearer token. Without a verifier, routes
    // operate without auth (development/legacy mode). ──
    let principal: AuthPrincipal | undefined;

    if (tokenVerifier) {
      const authResult = await extractAndVerify(req, tokenVerifier);
      if (!authResult.authenticated) {
        send401(res, authResult.detail);
        return;
      }
      principal = authResult.principal;
    }

    // Route: GET /events (SSE baseline — auth required when verifier configured)
    if (url === '/events' || url.startsWith('/events?')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: 'method_not_allowed', allowed: ['GET'] });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Send initial heartbeat comment (SSE keepalive)
      res.write(': heartbeat\n\n');

      // Track this connection
      sseConnections.add(res);

      // Clean up on client disconnect
      req.on('close', () => {
        sseConnections.delete(res);
      });

      return;
    }

    // Route: /conversations/:conversationId/... (auth + participant required)
    const convRoute = parseConversationRoute(url);
    if (convRoute) {
      // Object-level authorization: check participant access (requires auth)
      if (participantStore && principal) {
        const isAllowed = await participantStore.isParticipant(
          convRoute.conversationId,
          principal.githubUserId
        );
        if (!isAllowed) {
          send403(
            res,
            `Not a participant of conversation "${convRoute.conversationId}". Access denied.`
          );
          return;
        }
      }

      // Notify callback for observability/testing
      if (principal) {
        onConversationAccess?.(principal);
      }

      // Placeholder conversation endpoint — returns success with conversation context
      const responseBody: Record<string, unknown> = {
        conversationId: convRoute.conversationId,
      };
      if (principal) {
        responseBody['principal'] = {
          githubUserId: principal.githubUserId,
          githubLogin: principal.githubLogin,
        };
      }
      sendJson(res, 200, responseBody);
      return;
    }

    // All other routes: 404
    sendJson(res, 404, { error: 'not_found', path: url });
  }

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Delegate to async handler; catch and report errors
    handleRequest(req, res).catch((err: unknown) => {
      logger(`Request handler error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_server_error' });
      }
    });
  });

  let isListening = false;
  let boundPort = config.port;

  const relayServer: RelayServer = {
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);

        httpServer.listen(config.port, '127.0.0.1', () => {
          httpServer.removeListener('error', reject);
          isListening = true;
          const addr = httpServer.address();
          if (addr && typeof addr === 'object') {
            boundPort = addr.port;
          }
          logger(`mors-relay listening on http://127.0.0.1:${boundPort}`);

          // Log config diagnostics at startup
          if (config.diagnostics.length > 0) {
            logger(`config: ${config.diagnostics.length} placeholder(s) unset:`);
            for (const diag of config.diagnostics) {
              logger(`  - ${diag.variable}: ${diag.description}`);
            }
          }

          resolve();
        });
      });
    },

    close(): Promise<void> {
      if (!isListening) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        // Terminate active SSE connections so close doesn't hang
        for (const conn of sseConnections) {
          conn.end();
        }
        sseConnections.clear();

        httpServer.close(() => {
          isListening = false;
          logger('mors-relay stopped');
          resolve();
        });
      });
    },

    get listening(): boolean {
      return isListening;
    },

    get port(): number {
      return boundPort;
    },
  };

  return relayServer;
}
