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
import {
  RelayMessageStore,
  RelayMessageNotFoundError,
  RelayUnauthorizedError,
  type RelaySendResult,
  type RelayStreamEvent,
} from './message-store.js';
import { DedupeConflictError } from '../errors.js';
import { generateEventId } from '../contract/ids.js';

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
 * Read and parse JSON body from a request.
 * Returns null if body is empty or cannot be parsed.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          resolve(parsed as Record<string, unknown>);
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** Parse a message action route: /messages/:id, /messages/:id/read, /messages/:id/ack */
interface MessageRoute {
  messageId: string;
  action: 'get' | 'read' | 'ack' | null;
}

function parseMessageRoute(url: string, method: string): MessageRoute | null {
  // POST /messages (send) — handled separately
  if (url === '/messages' && method === 'POST') return null;

  // /messages/:id/read
  const readMatch = url.match(/^\/messages\/([^/]+)\/read$/);
  if (readMatch) return { messageId: readMatch[1], action: 'read' };

  // /messages/:id/ack
  const ackMatch = url.match(/^\/messages\/([^/]+)\/ack$/);
  if (ackMatch) return { messageId: ackMatch[1], action: 'ack' };

  // /messages/:id (get single message)
  const getMatch = url.match(/^\/messages\/([^/]+)$/);
  if (getMatch) return { messageId: getMatch[1], action: 'get' };

  return null;
}

/**
 * Write an SSE event to a response stream.
 *
 * Formats the event according to the SSE protocol:
 * - id: <event_id>\n (for Last-Event-ID cursor resume)
 * - event: <event_type>\n (named event)
 * - data: <json_payload>\n\n (event data)
 */
function writeSSE(res: ServerResponse, event: { id?: string; event: string; data: string }): void {
  let frame = '';
  if (event.id) {
    frame += `id: ${event.id}\n`;
  }
  frame += `event: ${event.event}\n`;
  frame += `data: ${event.data}\n\n`;
  res.write(frame);
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
  const messageStore = options?.messageStore;
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

    // ── Auth guard: all non-public routes require a valid Bearer token.
    // Fail-closed: if no token verifier is configured, protected routes
    // return 401 (never fall through to 200). ──

    if (!tokenVerifier) {
      send401(res, 'Authentication service unavailable. Token verifier is not configured.');
      return;
    }

    const authResult = await extractAndVerify(req, tokenVerifier);
    if (!authResult.authenticated) {
      send401(res, authResult.detail);
      return;
    }
    const principal: AuthPrincipal = authResult.principal;

    // Route: GET /events (SSE stream — auth required)
    // Provides real-time event streaming for message lifecycle transitions.
    // Events are filtered to only include those relevant to the authenticated principal
    // (messages where the user is sender or recipient).
    //
    // Covers: VAL-STREAM-001 (authenticated connection), VAL-STREAM-002 (event shape),
    //         VAL-STREAM-003 (cursor resume), VAL-STREAM-004 (deterministic startup),
    //         VAL-STREAM-005 (duplicate replay → stable event IDs for dedup)
    if (url === '/events' || url.startsWith('/events?')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: 'method_not_allowed', allowed: ['GET'] });
        return;
      }

      // Extract Last-Event-ID from header for reconnect resume (VAL-STREAM-003)
      const lastEventId = req.headers['last-event-id'] as string | undefined;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Send initial heartbeat comment (SSE keepalive)
      res.write(': heartbeat\n\n');

      // Send connected event with authenticated principal info (VAL-STREAM-001)
      const connectedEventId = generateEventId();
      writeSSE(res, {
        id: connectedEventId,
        event: 'connected',
        data: JSON.stringify({
          github_user_id: principal.githubUserId,
          github_login: principal.githubLogin,
        }),
      });

      // Register the connected event's ID as a valid cursor position
      // so clients can use it as Last-Event-ID on reconnect (VAL-STREAM-003/005)
      if (messageStore) {
        messageStore.registerCursorPosition(connectedEventId);
      }

      // Track this connection
      sseConnections.add(res);

      // Replay missed events from cursor (VAL-STREAM-003).
      // If no Last-Event-ID, this is a fresh connection — no replay (VAL-STREAM-004).
      // Unknown cursor also results in no replay (graceful fallback).
      // Events are filtered to only include those relevant to the authenticated principal.
      // Replayed events use their original stable event IDs (VAL-STREAM-005).
      if (lastEventId && messageStore) {
        const missedEvents = messageStore.getEventsSince(lastEventId);
        for (const streamEvent of missedEvents) {
          // Filter: only deliver events relevant to this principal
          if (
            streamEvent.sender_id !== principal.githubUserId &&
            streamEvent.recipient_id !== principal.githubUserId
          ) {
            continue;
          }

          writeSSE(res, {
            id: streamEvent.event_id,
            event: streamEvent.event_type,
            data: JSON.stringify({
              message_id: streamEvent.message_id,
              thread_id: streamEvent.thread_id,
              in_reply_to: streamEvent.in_reply_to,
              sender_id: streamEvent.sender_id,
              recipient_id: streamEvent.recipient_id,
              timestamp: streamEvent.timestamp,
            }),
          });
        }
      }

      // Subscribe to message store stream events for live delivery (if available)
      let unsubscribe: (() => void) | undefined;
      if (messageStore) {
        unsubscribe = messageStore.onStreamEvent((streamEvent: RelayStreamEvent) => {
          // Filter: only deliver events relevant to this principal.
          // A user sees events for messages where they are sender or recipient.
          if (
            streamEvent.sender_id !== principal.githubUserId &&
            streamEvent.recipient_id !== principal.githubUserId
          ) {
            return;
          }

          writeSSE(res, {
            id: streamEvent.event_id,
            event: streamEvent.event_type,
            data: JSON.stringify({
              message_id: streamEvent.message_id,
              thread_id: streamEvent.thread_id,
              in_reply_to: streamEvent.in_reply_to,
              sender_id: streamEvent.sender_id,
              recipient_id: streamEvent.recipient_id,
              timestamp: streamEvent.timestamp,
            }),
          });
        });
      }

      // Clean up on client disconnect
      req.on('close', () => {
        sseConnections.delete(res);
        if (unsubscribe) {
          unsubscribe();
        }
      });

      return;
    }

    // ── Messaging routes (require messageStore) ─────────────────────

    // Route: POST /messages (send a message)
    if (url === '/messages' && method === 'POST' && messageStore) {
      const body = await readJsonBody(req);
      if (!body) {
        sendJson(res, 400, { error: 'invalid_body', detail: 'Request body must be valid JSON.' });
        return;
      }

      // ── Sender spoofing prevention (VAL-RELAY-008) ──────────────
      // Actor identity is always derived from the authenticated principal.
      // If the client provides sender_id or sender_login fields with valid
      // types that don't match the auth principal, reject as a spoof attempt.
      // Invalid types (e.g. string sender_id) are silently ignored as junk.
      const clientSenderId = body['sender_id'];
      if (typeof clientSenderId === 'number' && clientSenderId !== principal.githubUserId) {
        send403(
          res,
          'Sender identity mismatch. The sender_id field does not match the authenticated principal. Sender identity is derived from your auth token.'
        );
        return;
      }

      const clientSenderLogin = body['sender_login'];
      if (typeof clientSenderLogin === 'string' && clientSenderLogin !== principal.githubLogin) {
        send403(
          res,
          'Sender identity mismatch. The sender_login field does not match the authenticated principal. Sender identity is derived from your auth token.'
        );
        return;
      }

      const recipientId = body['recipient_id'];
      const messageBody = body['body'];
      const subject = body['subject'];
      const inReplyTo = body['in_reply_to'];
      const dedupeKey = body['dedupe_key'];

      if (typeof recipientId !== 'number') {
        sendJson(res, 400, {
          error: 'validation_error',
          detail: 'recipient_id is required and must be a number.',
        });
        return;
      }
      if (typeof messageBody !== 'string' || messageBody.trim().length === 0) {
        sendJson(res, 400, {
          error: 'validation_error',
          detail: 'body is required and must be a non-empty string.',
        });
        return;
      }

      let result: RelaySendResult;
      try {
        result = messageStore.send(principal.githubUserId, principal.githubLogin, {
          recipientId,
          body: messageBody,
          subject: typeof subject === 'string' ? subject : undefined,
          inReplyTo: typeof inReplyTo === 'string' ? inReplyTo : undefined,
          dedupeKey: typeof dedupeKey === 'string' ? dedupeKey : undefined,
        });
      } catch (err: unknown) {
        if (err instanceof RelayMessageNotFoundError) {
          sendJson(res, 404, { error: 'not_found', detail: err.message });
          return;
        }
        if (err instanceof DedupeConflictError) {
          sendJson(res, 409, { error: 'dedupe_conflict', detail: err.message });
          return;
        }
        throw err;
      }

      // 201 for newly created, 200 for idempotent dedupe hit
      sendJson(res, result.created ? 201 : 200, result.message);
      return;
    }

    // Route: GET /inbox (list inbox for authenticated user)
    if ((url === '/inbox' || url.startsWith('/inbox?')) && method === 'GET' && messageStore) {
      const urlObj = new URL(url, `http://localhost`);
      const unreadOnly = urlObj.searchParams.get('unread') === 'true';

      const messages = messageStore.inbox(principal.githubUserId, { unreadOnly });
      sendJson(res, 200, { count: messages.length, messages });
      return;
    }

    // Routes: /messages/:id, /messages/:id/read, /messages/:id/ack
    if (messageStore) {
      const msgRoute = parseMessageRoute(url, method);
      if (msgRoute) {
        const { messageId, action } = msgRoute;

        if (action === 'read') {
          if (method !== 'POST') {
            sendJson(res, 405, { error: 'method_not_allowed', allowed: ['POST'] });
            return;
          }
          try {
            const result = messageStore.read(messageId, principal.githubUserId);
            sendJson(res, 200, { message: result.message, first_read: result.firstRead });
          } catch (err: unknown) {
            if (err instanceof RelayMessageNotFoundError) {
              sendJson(res, 404, { error: 'not_found', detail: err.message });
            } else if (err instanceof RelayUnauthorizedError) {
              send403(res, err.message);
            } else {
              throw err;
            }
          }
          return;
        }

        if (action === 'ack') {
          if (method !== 'POST') {
            sendJson(res, 405, { error: 'method_not_allowed', allowed: ['POST'] });
            return;
          }
          try {
            const result = messageStore.ack(messageId, principal.githubUserId);
            sendJson(res, 200, { message: result.message, first_ack: result.firstAck });
          } catch (err: unknown) {
            if (err instanceof RelayMessageNotFoundError) {
              sendJson(res, 404, { error: 'not_found', detail: err.message });
            } else if (err instanceof RelayUnauthorizedError) {
              send403(res, err.message);
            } else {
              throw err;
            }
          }
          return;
        }

        if (action === 'get') {
          if (method !== 'GET') {
            sendJson(res, 405, { error: 'method_not_allowed', allowed: ['GET'] });
            return;
          }

          const message = messageStore.get(messageId);
          if (!message) {
            sendJson(res, 404, { error: 'not_found', detail: `Message not found: ${messageId}` });
            return;
          }

          // Authorization: only sender or recipient can view
          if (!messageStore.isMessageParticipant(messageId, principal.githubUserId)) {
            send403(res, 'Not a participant of this conversation. Access denied.');
            return;
          }

          sendJson(res, 200, { message });
          return;
        }
      }
    }

    // Route: /conversations/:conversationId/... (auth + participant required)
    const convRoute = parseConversationRoute(url);
    if (convRoute) {
      // Object-level authorization: fail-closed when participant store is absent.
      // If no participant store is configured, deny access (never fall through to 200).
      if (!participantStore) {
        send403(res, 'Authorization service unavailable. Participant store is not configured.');
        return;
      }

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

      // Notify callback for observability/testing
      onConversationAccess?.(principal);

      // Placeholder conversation endpoint — returns success with conversation context
      sendJson(res, 200, {
        conversationId: convRoute.conversationId,
        principal: {
          githubUserId: principal.githubUserId,
          githubLogin: principal.githubLogin,
        },
      });
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

        httpServer.listen(config.port, config.host, () => {
          httpServer.removeListener('error', reject);
          isListening = true;
          const addr = httpServer.address();
          if (addr && typeof addr === 'object') {
            boundPort = addr.port;
          }
          logger(`mors-relay listening on http://${config.host}:${boundPort}`);

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
