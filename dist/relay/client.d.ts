/**
 * Relay client with offline queue and transient failure retry.
 *
 * Provides a client-side abstraction for relay HTTP API calls with:
 * - Automatic retry with exponential backoff for transient failures
 *   (network errors, timeouts, 5xx server errors)
 * - Durable offline queue for buffering operations when relay is unreachable
 *   (persisted to disk so queued sends survive process restart)
 * - Flush reconciliation with bounded retry/backoff for each queued entry
 * - Dedupe key generation for idempotent send convergence
 * - Observable/deterministic retry logging for CLI output
 *
 * Non-transient errors (4xx) are not retried and propagate immediately.
 *
 * Covers:
 * - VAL-RELAY-006: Offline-to-online sync converges without loss or duplication
 * - VAL-RELAY-007: Transient relay failure recovery preserves single logical delivery
 */
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
    /**
     * Path to a JSON file for durable offline queue persistence.
     * When set, the queue is loaded from this file on construction and
     * saved after every queue mutation (send queued, flush success/fail).
     * Enables offline queued sends to survive process restart.
     */
    queueStorePath?: string;
    /** Maximum number of retry attempts per entry during flush. Default: 0 (single attempt). */
    flushRetries?: number;
    /** Initial delay in ms before first flush retry. Default: 500. */
    flushRetryDelayMs?: number;
    /** Multiplier for exponential backoff between flush retries. Default: 2. */
    flushRetryBackoffMultiplier?: number;
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
/** Thrown when a non-transient client error occurs (4xx). */
export declare class RelayClientError extends Error {
    readonly statusCode: number;
    readonly responseBody: unknown;
    constructor(statusCode: number, responseBody: unknown);
}
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
export declare class RelayClient {
    private readonly baseUrl;
    private readonly token;
    private readonly maxRetries;
    private readonly initialRetryDelayMs;
    private readonly retryBackoffMultiplier;
    private readonly requestTimeoutMs;
    private readonly logger;
    private readonly fetchFn;
    private readonly offlineQueue;
    private readonly queueStorePath;
    private readonly flushRetries;
    private readonly flushRetryDelayMs;
    private readonly flushRetryBackoffMultiplier;
    constructor(options: RelayClientOptions);
    /** Number of entries waiting in the offline queue. */
    get queueSize(): number;
    /** Read-only snapshot of pending queue entries for inspection. */
    get pendingEntries(): ReadonlyArray<OfflineQueueEntry>;
    /**
     * Send a message via the relay.
     *
     * Attempts delivery with retry for transient failures. If all retries
     * are exhausted, the message is queued offline for later flush.
     *
     * A dedupe key is always generated to ensure idempotent convergence
     * across retries, queue flushes, and reconnects.
     */
    send(options: {
        recipientId: number;
        body: string;
        subject?: string;
        inReplyTo?: string;
    }): Promise<SendResult>;
    /**
     * Flush the offline queue by sending all queued entries to the relay.
     *
     * Each entry is attempted with bounded retry/backoff for transient failures.
     * Non-transient errors (4xx) are not retried. Successfully sent entries are
     * removed from the queue; failed entries remain for a subsequent flush attempt.
     *
     * The queue is persisted to disk after flush completes (if queueStorePath is set).
     */
    flush(): Promise<FlushResult>;
    /**
     * Read a message by ID with transient failure retry.
     */
    read(messageId: string): Promise<ReadResult>;
    /**
     * Ack a message by ID with transient failure retry.
     */
    ack(messageId: string): Promise<AckResult>;
    /**
     * Send a payload to the relay with retry logic.
     * Throws RelayClientError for non-transient errors (4xx).
     * Throws the last transient error if all retries are exhausted.
     */
    private sendWithRetry;
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
    private requestWithRetry;
    /**
     * Perform a send request with bounded retry/backoff for flush reconciliation.
     *
     * Retries transient failures (network errors, 5xx) up to flushRetries times
     * with exponential backoff. Non-transient errors (4xx) are not retried.
     */
    private doSendWithFlushRetry;
    /**
     * Check if an error from flush send is non-transient (should not be retried).
     * 4xx responses result in errors containing status codes in the 400-499 range.
     */
    private isNonTransientFlushError;
    /**
     * Persist the offline queue to disk (if queueStorePath is configured).
     */
    private persistQueue;
    /**
     * Perform a single send request without retry logic (used by flush).
     */
    private doSend;
    /** Describe an error for logging without leaking sensitive info. */
    private describeError;
    /** Delay for the given number of milliseconds. */
    private delay;
}
/**
 * Save offline queue entries to a JSON file.
 *
 * Creates the parent directory if it doesn't exist.
 * Uses owner-only permissions to prevent credential leakage
 * (queue entries may contain auth-adjacent context).
 *
 * @param filePath - Path to the queue JSON file.
 * @param entries - Queue entries to persist.
 */
export declare function saveOfflineQueue(filePath: string, entries: ReadonlyArray<OfflineQueueEntry>): void;
/**
 * Load offline queue entries from a JSON file.
 *
 * Returns an empty array if:
 * - The file does not exist
 * - The file contains invalid JSON
 * - The file contents are not an array
 *
 * Graceful degradation ensures corrupt queue files do not
 * prevent the client from starting.
 *
 * @param filePath - Path to the queue JSON file.
 * @returns Array of queue entries, or empty array on failure.
 */
export declare function loadOfflineQueue(filePath: string): OfflineQueueEntry[];
//# sourceMappingURL=client.d.ts.map