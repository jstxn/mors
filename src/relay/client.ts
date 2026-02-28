/**
 * Relay client with offline queue and transient failure retry.
 *
 * Provides a client-side abstraction for relay HTTP API calls with:
 * - Automatic retry with exponential backoff for transient failures
 *   (network errors, timeouts, 5xx server errors)
 * - Offline queue for buffering operations when relay is unreachable
 * - Dedupe key generation for idempotent send convergence
 * - Observable/deterministic retry logging for CLI output
 *
 * Non-transient errors (4xx) are not retried and propagate immediately.
 *
 * Covers:
 * - VAL-RELAY-006: Offline-to-online sync converges without loss or duplication
 * - VAL-RELAY-007: Transient relay failure recovery preserves single logical delivery
 */

import { generateDedupeKey } from '../contract/ids.js';

// ── Types ────────────────────────────────────────────────────────────

/** Logger function for observable retry/queue behavior. */
export type ClientLogger = (message: string) => void;

/** Custom fetch function type for dependency injection (testing). */
export type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Options for creating a relay client. */
export interface RelayClientOptions {
  /** Base URL of the relay server (e.g. http://127.0.0.1:3100). */
  baseUrl: string;
  /** Bearer token for authentication. */
  token: string;
  /** Maximum number of retry attempts for transient failures. Default: 3. */
  maxRetries?: number;
  /** Initial delay in ms before first retry. Default: 500. */
  initialRetryDelayMs?: number;
  /** Multiplier for exponential backoff between retries. Default: 2. */
  retryBackoffMultiplier?: number;
  /** Request timeout in ms. Default: 10000. */
  requestTimeoutMs?: number;
  /** Logger for retry/queue observability. */
  logger?: ClientLogger;
  /** Custom fetch implementation for testing. */
  fetchFn?: FetchFn;
}

/** Payload for a send operation queued offline. */
export interface SendPayload {
  recipientId: number;
  body: string;
  subject?: string;
  inReplyTo?: string;
  dedupeKey: string;
}

/** An entry in the offline queue. */
export interface OfflineQueueEntry {
  /** Queue entry type. */
  type: 'send';
  /** The send payload. */
  payload: SendPayload;
  /** ISO-8601 timestamp when the entry was queued. */
  queuedAt: string;
}

/** Relay message as returned by the server. */
export interface RelayMessageResponse {
  id: string;
  thread_id: string;
  in_reply_to: string | null;
  sender_id: number;
  sender_login: string;
  recipient_id: number;
  body: string;
  subject: string | null;
  state: string;
  read_at: string | null;
  acked_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Result of a send operation. */
export interface SendResult {
  /** Whether the message was queued offline (true) or delivered immediately (false). */
  queued: boolean;
  /** The dedupe key used for this send. */
  dedupeKey: string;
  /** The relay message, if delivery was immediate (not queued). */
  message?: RelayMessageResponse;
}

/** Result of a flush operation. */
export interface FlushResult {
  /** Number of entries successfully sent. */
  sent: number;
  /** Number of entries that failed to send (remain in queue). */
  failed: number;
}

/** Result of a read operation. */
export interface ReadResult {
  message: RelayMessageResponse;
  firstRead: boolean;
}

/** Result of an ack operation. */
export interface AckResult {
  message: RelayMessageResponse;
  firstAck: boolean;
}

// ── Errors ───────────────────────────────────────────────────────────

/** Thrown when a non-transient client error occurs (4xx). */
export class RelayClientError extends Error {
  readonly statusCode: number;
  readonly responseBody: unknown;

  constructor(statusCode: number, responseBody: unknown) {
    const detail =
      typeof responseBody === 'object' && responseBody !== null
        ? ((responseBody as Record<string, unknown>)['detail'] ?? JSON.stringify(responseBody))
        : String(responseBody);
    super(`Relay client error (${statusCode}): ${detail}`);
    this.name = 'RelayClientError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

// ── Client ───────────────────────────────────────────────────────────

/**
 * Relay client with offline queue and retry logic.
 *
 * Sends operations are attempted with retry for transient failures.
 * When all retries are exhausted, operations are queued offline for
 * later flush when connectivity is restored.
 *
 * All sends automatically get a dedupe key to ensure idempotent
 * convergence across retries, offline queue flushes, and reconnects.
 */
export class RelayClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly maxRetries: number;
  private readonly initialRetryDelayMs: number;
  private readonly retryBackoffMultiplier: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: ClientLogger;
  private readonly fetchFn: FetchFn;
  private readonly offlineQueue: OfflineQueueEntry[] = [];

  constructor(options: RelayClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.maxRetries = options.maxRetries ?? 3;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 500;
    this.retryBackoffMultiplier = options.retryBackoffMultiplier ?? 2;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10000;
    this.logger = options.logger ?? (() => {});
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** Number of entries waiting in the offline queue. */
  get queueSize(): number {
    return this.offlineQueue.length;
  }

  /** Read-only snapshot of pending queue entries for inspection. */
  get pendingEntries(): ReadonlyArray<OfflineQueueEntry> {
    return [...this.offlineQueue];
  }

  /**
   * Send a message via the relay.
   *
   * Attempts delivery with retry for transient failures. If all retries
   * are exhausted, the message is queued offline for later flush.
   *
   * A dedupe key is always generated to ensure idempotent convergence
   * across retries, queue flushes, and reconnects.
   */
  async send(options: {
    recipientId: number;
    body: string;
    subject?: string;
    inReplyTo?: string;
  }): Promise<SendResult> {
    const dedupeKey = generateDedupeKey();
    const payload: SendPayload = {
      recipientId: options.recipientId,
      body: options.body,
      subject: options.subject,
      inReplyTo: options.inReplyTo,
      dedupeKey,
    };

    try {
      const message = await this.sendWithRetry(payload);
      return { queued: false, dedupeKey, message };
    } catch (err: unknown) {
      // Non-transient errors propagate immediately
      if (err instanceof RelayClientError) {
        throw err;
      }

      // Transient failure exhausted retries — queue offline
      this.offlineQueue.push({
        type: 'send',
        payload,
        queuedAt: new Date().toISOString(),
      });
      this.logger(`send queued offline (dedupe_key=${dedupeKey}): ${this.describeError(err)}`);
      return { queued: true, dedupeKey };
    }
  }

  /**
   * Flush the offline queue by sending all queued entries to the relay.
   *
   * Each entry is attempted once per flush call (no extra retries within flush).
   * Successfully sent entries are removed from the queue; failed entries remain
   * for a subsequent flush attempt.
   */
  async flush(): Promise<FlushResult> {
    let sent = 0;
    let failed = 0;
    const remaining: OfflineQueueEntry[] = [];

    for (const entry of this.offlineQueue) {
      try {
        await this.doSend(entry.payload);
        sent++;
        this.logger(`flush: delivered queued message (dedupe_key=${entry.payload.dedupeKey})`);
      } catch {
        failed++;
        remaining.push(entry);
      }
    }

    this.offlineQueue.length = 0;
    this.offlineQueue.push(...remaining);

    return { sent, failed };
  }

  /**
   * Read a message by ID with transient failure retry.
   */
  async read(messageId: string): Promise<ReadResult> {
    const response = await this.requestWithRetry('POST', `/messages/${messageId}/read`);

    const body = (await response.json()) as Record<string, unknown>;
    return {
      message: body['message'] as RelayMessageResponse,
      firstRead: body['first_read'] as boolean,
    };
  }

  /**
   * Ack a message by ID with transient failure retry.
   */
  async ack(messageId: string): Promise<AckResult> {
    const response = await this.requestWithRetry('POST', `/messages/${messageId}/ack`);

    const body = (await response.json()) as Record<string, unknown>;
    return {
      message: body['message'] as RelayMessageResponse,
      firstAck: body['first_ack'] as boolean,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────

  /**
   * Send a payload to the relay with retry logic.
   * Throws RelayClientError for non-transient errors (4xx).
   * Throws the last transient error if all retries are exhausted.
   */
  private async sendWithRetry(payload: SendPayload): Promise<RelayMessageResponse> {
    const response = await this.requestWithRetry('POST', '/messages', {
      recipient_id: payload.recipientId,
      body: payload.body,
      subject: payload.subject,
      in_reply_to: payload.inReplyTo,
      dedupe_key: payload.dedupeKey,
    });

    return (await response.json()) as RelayMessageResponse;
  }

  /**
   * Make an HTTP request to the relay with retry for transient errors.
   *
   * Retries on:
   * - Network errors (TypeError from fetch)
   * - Abort/timeout errors (AbortError)
   * - 5xx server errors
   *
   * Does NOT retry on:
   * - 4xx client errors (throws RelayClientError immediately)
   * - 2xx/3xx responses (returns immediately)
   */
  private async requestWithRetry(method: string, path: string, body?: unknown): Promise<Response> {
    let lastError: unknown;
    let delayMs = this.initialRetryDelayMs;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        this.logger(
          `relay request retry attempt ${attempt}/${this.maxRetries} for ${method} ${path} (delay=${delayMs}ms)`
        );
        await this.delay(delayMs);
        delayMs = Math.round(delayMs * this.retryBackoffMultiplier);
      }

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

        let response: Response;
        try {
          response = await this.fetchFn(`${this.baseUrl}${path}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        // 2xx/3xx — success
        if (response.ok) {
          return response;
        }

        // 4xx — non-transient client error, do not retry
        if (response.status >= 400 && response.status < 500) {
          let responseBody: unknown;
          try {
            responseBody = await response.json();
          } catch {
            responseBody = await response.text();
          }
          throw new RelayClientError(response.status, responseBody);
        }

        // 5xx — transient server error, retry
        lastError = new Error(`Server error: ${response.status}`);
        this.logger(`relay request ${method} ${path} returned ${response.status}, will retry`);
      } catch (err: unknown) {
        // RelayClientError (4xx) should not be retried
        if (err instanceof RelayClientError) {
          throw err;
        }

        // Network/abort errors are transient, retry
        lastError = err;
        if (attempt < this.maxRetries) {
          this.logger(
            `relay request ${method} ${path} failed: ${this.describeError(err)}, will retry`
          );
        }
      }
    }

    // All retries exhausted
    throw lastError;
  }

  /**
   * Perform a single send request without retry logic (used by flush).
   */
  private async doSend(payload: SendPayload): Promise<RelayMessageResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    };

    const response = await this.fetchFn(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        recipient_id: payload.recipientId,
        body: payload.body,
        subject: payload.subject,
        in_reply_to: payload.inReplyTo,
        dedupe_key: payload.dedupeKey,
      }),
    });

    if (!response.ok) {
      throw new Error(`Send failed: ${response.status}`);
    }

    return (await response.json()) as RelayMessageResponse;
  }

  /** Describe an error for logging without leaking sensitive info. */
  private describeError(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }

  /** Delay for the given number of milliseconds. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
