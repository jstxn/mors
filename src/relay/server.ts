/**
 * HTTP server scaffold for the mors relay service.
 *
 * Provides:
 * - Health endpoint for readiness checks
 * - SSE baseline endpoint for future event streaming
 * - Deterministic startup/shutdown with clean process lifecycle
 * - Configurable logger for test observability
 *
 * Uses Node.js built-in http module (no external framework dependency).
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { RelayConfig } from './config.js';

/** Logger function type. */
export type RelayLogger = (message: string) => void;

/** Options for creating the relay server. */
export interface RelayServerOptions {
  /** Custom logger. Defaults to console.log. */
  logger?: RelayLogger;
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
 * - GET /health — readiness check endpoint
 * - GET /events — SSE baseline endpoint
 * - All other routes return 404
 *
 * @param config - Relay configuration.
 * @param options - Optional server options (logger, etc.).
 * @returns A RelayServer handle for lifecycle management.
 */
export function createRelayServer(config: RelayConfig, options?: RelayServerOptions): RelayServer {
  const logger = options?.logger ?? console.log;
  const startTime = Date.now();

  // Track active SSE connections for clean shutdown
  const sseConnections = new Set<ServerResponse>();

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    // Route: GET /health
    if (url === '/health') {
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

    // Route: GET /events (SSE baseline)
    if (url === '/events' || url.startsWith('/events?')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: 'method_not_allowed', allowed: ['GET'] });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
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

    // All other routes: 404
    sendJson(res, 404, { error: 'not_found', path: url });
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
