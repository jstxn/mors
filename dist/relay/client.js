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
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateDedupeKey } from '../contract/ids.js';
import { encryptMessage, decryptMessage } from '../e2ee/cipher.js';
import { CipherError } from '../errors.js';
// ── Errors ───────────────────────────────────────────────────────────
/** Thrown when a non-transient client error occurs (4xx). */
export class RelayClientError extends Error {
    statusCode;
    responseBody;
    constructor(statusCode, responseBody) {
        const detail = typeof responseBody === 'object' && responseBody !== null
            ? (responseBody['detail'] ?? JSON.stringify(responseBody))
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
    baseUrl;
    token;
    maxRetries;
    initialRetryDelayMs;
    retryBackoffMultiplier;
    requestTimeoutMs;
    logger;
    fetchFn;
    offlineQueue = [];
    queueStorePath;
    flushRetries;
    flushRetryDelayMs;
    flushRetryBackoffMultiplier;
    constructor(options) {
        this.baseUrl = options.baseUrl;
        this.token = options.token;
        this.maxRetries = options.maxRetries ?? 3;
        this.initialRetryDelayMs = options.initialRetryDelayMs ?? 500;
        this.retryBackoffMultiplier = options.retryBackoffMultiplier ?? 2;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 10000;
        this.logger = options.logger ?? (() => { });
        this.fetchFn = options.fetchFn ?? fetch;
        this.queueStorePath = options.queueStorePath;
        this.flushRetries = options.flushRetries ?? 0;
        this.flushRetryDelayMs = options.flushRetryDelayMs ?? 500;
        this.flushRetryBackoffMultiplier = options.flushRetryBackoffMultiplier ?? 2;
        // Load persisted queue from disk if queueStorePath is configured
        if (this.queueStorePath) {
            const loaded = loadOfflineQueue(this.queueStorePath);
            this.offlineQueue.push(...loaded);
        }
    }
    /** Number of entries waiting in the offline queue. */
    get queueSize() {
        return this.offlineQueue.length;
    }
    /** Read-only snapshot of pending queue entries for inspection. */
    get pendingEntries() {
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
    async send(options) {
        const dedupeKey = options.dedupeKey ?? generateDedupeKey();
        const payload = {
            recipientId: options.recipientId,
            body: options.body,
            subject: options.subject,
            inReplyTo: options.inReplyTo,
            dedupeKey,
        };
        try {
            const message = await this.sendWithRetry(payload);
            return { queued: false, dedupeKey, message };
        }
        catch (err) {
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
            this.persistQueue();
            this.logger(`send queued offline (dedupe_key=${dedupeKey}): ${this.describeError(err)}`);
            return { queued: true, dedupeKey };
        }
    }
    /**
     * Flush the offline queue by sending all queued entries to the relay.
     *
     * Each entry is attempted with bounded retry/backoff for transient failures.
     * Non-transient errors (4xx) are not retried. Successfully sent entries are
     * removed from the queue; failed entries remain for a subsequent flush attempt.
     *
     * The queue is persisted to disk after flush completes (if queueStorePath is set).
     */
    async flush() {
        let sent = 0;
        let failed = 0;
        const remaining = [];
        for (const entry of this.offlineQueue) {
            try {
                await this.doSendWithFlushRetry(entry.payload);
                sent++;
                this.logger(`flush: delivered queued message (dedupe_key=${entry.payload.dedupeKey})`);
            }
            catch {
                failed++;
                remaining.push(entry);
            }
        }
        this.offlineQueue.length = 0;
        this.offlineQueue.push(...remaining);
        this.persistQueue();
        return { sent, failed };
    }
    /**
     * Read a message by ID with transient failure retry.
     */
    async read(messageId) {
        const response = await this.requestWithRetry('POST', `/messages/${messageId}/read`);
        const body = (await response.json());
        return {
            message: body['message'],
            firstRead: body['first_read'],
        };
    }
    /**
     * Ack a message by ID with transient failure retry.
     */
    async ack(messageId) {
        const response = await this.requestWithRetry('POST', `/messages/${messageId}/ack`);
        const body = (await response.json());
        return {
            message: body['message'],
            firstAck: body['first_ack'],
        };
    }
    /**
     * Get one relay message by ID.
     */
    async get(messageId) {
        const response = await this.requestWithRetry('GET', `/messages/${encodeURIComponent(messageId)}`);
        const body = (await response.json());
        return body['message'];
    }
    /**
     * List inbox messages for the authenticated relay account.
     */
    async inbox(options = {}) {
        const unreadParam = options.unreadOnly ? '?unread=true' : '';
        const response = await this.requestWithRetry('GET', `/inbox${unreadParam}`);
        const body = (await response.json());
        return {
            count: body['count'],
            messages: body['messages'],
        };
    }
    /**
     * Publish the current device's public key bundle to the relay.
     */
    async publishDeviceBundle(bundle) {
        const response = await this.requestWithRetry('PUT', '/accounts/me/device-bundle', {
            device_id: bundle.deviceId,
            fingerprint: bundle.fingerprint,
            x25519_public_key: bundle.x25519PublicKey,
            ed25519_public_key: bundle.ed25519PublicKey,
            created_at: bundle.createdAt,
        });
        return (await response.json());
    }
    /**
     * Fetch a peer device's public key bundle from the relay device directory.
     *
     * Returns null when the relay reports the device bundle is not available.
     */
    async fetchDeviceBundle(accountId, deviceId) {
        try {
            const response = await this.requestWithRetry('GET', `/accounts/${encodeURIComponent(accountId)}/device-bundles/${encodeURIComponent(deviceId)}`);
            return (await response.json());
        }
        catch (err) {
            if (err instanceof RelayClientError && err.statusCode === 404) {
                return null;
            }
            throw err;
        }
    }
    // ── E2EE Transport Integration ─────────────────────────────────────
    /**
     * Send an encrypted message via the relay.
     *
     * Encrypts the plaintext body using the shared secret from key exchange
     * before sending. The wire payload contains only ciphertext (serialized
     * EncryptedPayload JSON) — no plaintext body is ever transmitted.
     *
     * The relay server stores the ciphertext body as-is. Only the intended
     * recipient with the matching shared secret can decrypt.
     *
     * @param options - Encrypted send options including body and shared secret.
     * @returns SendResult with the relay message (body field contains ciphertext JSON).
     * @throws CipherError if the shared secret is invalid or encryption fails.
     */
    async sendEncrypted(options) {
        const { recipientId, body, subject, inReplyTo, sharedSecret } = options;
        // Encrypt the plaintext body into an EncryptedPayload
        const encrypted = encryptMessage(sharedSecret, body);
        // Serialize the EncryptedPayload as the body field on the wire.
        // The relay stores this ciphertext JSON string — no plaintext leaves the client.
        const ciphertextBody = JSON.stringify(encrypted);
        return this.send({
            recipientId,
            body: ciphertextBody,
            subject,
            inReplyTo,
        });
    }
    /**
     * Read and decrypt a message from the relay.
     *
     * Reads the message via the relay read endpoint, then decrypts the
     * ciphertext body using the shared secret from key exchange.
     *
     * Tampered ciphertext, wrong shared secret, or malformed payloads
     * will cause decryption to fail with a CipherError.
     *
     * @param messageId - Message ID to read and decrypt.
     * @param sharedSecret - Shared secret from key exchange (32 bytes).
     * @returns DecryptedReadResult with the decrypted plaintext body.
     * @throws CipherError if decryption fails (tampered, wrong key, malformed).
     */
    async readDecrypted(messageId, sharedSecret) {
        const readResult = await this.read(messageId);
        const msg = readResult.message;
        // Parse the ciphertext body (stored as EncryptedPayload JSON)
        let encrypted;
        try {
            encrypted = JSON.parse(msg.body);
        }
        catch {
            throw new CipherError('Failed to parse encrypted payload from relay message body. ' +
                'The message may not have been encrypted or the payload is corrupted.');
        }
        // Decrypt using the shared secret
        const decryptedBody = decryptMessage(sharedSecret, encrypted);
        return {
            decryptedBody,
            message: msg,
            firstRead: readResult.firstRead,
        };
    }
    // ── Internal ──────────────────────────────────────────────────────
    /**
     * Send a payload to the relay with retry logic.
     * Throws RelayClientError for non-transient errors (4xx).
     * Throws the last transient error if all retries are exhausted.
     */
    async sendWithRetry(payload) {
        const response = await this.requestWithRetry('POST', '/messages', {
            recipient_id: payload.recipientId,
            body: payload.body,
            subject: payload.subject,
            in_reply_to: payload.inReplyTo,
            dedupe_key: payload.dedupeKey,
        });
        return (await response.json());
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
    async requestWithRetry(method, path, body) {
        let lastError;
        let delayMs = this.initialRetryDelayMs;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (attempt > 0) {
                this.logger(`relay request retry attempt ${attempt}/${this.maxRetries} for ${method} ${path} (delay=${delayMs}ms)`);
                await this.delay(delayMs);
                delayMs = Math.round(delayMs * this.retryBackoffMultiplier);
            }
            try {
                const headers = {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.token}`,
                    Connection: 'close',
                };
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
                let response;
                try {
                    response = await this.fetchFn(`${this.baseUrl}${path}`, {
                        method,
                        headers,
                        body: body ? JSON.stringify(body) : undefined,
                        signal: controller.signal,
                    });
                }
                finally {
                    clearTimeout(timeoutId);
                }
                // 2xx/3xx — success
                if (response.ok) {
                    return response;
                }
                // 4xx — non-transient client error, do not retry
                if (response.status >= 400 && response.status < 500) {
                    let responseBody;
                    try {
                        responseBody = await response.json();
                    }
                    catch {
                        responseBody = await response.text();
                    }
                    throw new RelayClientError(response.status, responseBody);
                }
                // 5xx — transient server error, retry
                lastError = new Error(`Server error: ${response.status}`);
                this.logger(`relay request ${method} ${path} returned ${response.status}, will retry`);
            }
            catch (err) {
                // RelayClientError (4xx) should not be retried
                if (err instanceof RelayClientError) {
                    throw err;
                }
                // Network/abort errors are transient, retry
                lastError = err;
                if (attempt < this.maxRetries) {
                    this.logger(`relay request ${method} ${path} failed: ${this.describeError(err)}, will retry`);
                }
            }
        }
        // All retries exhausted
        throw lastError;
    }
    /**
     * Perform a send request with bounded retry/backoff for flush reconciliation.
     *
     * Retries transient failures (network errors, 5xx) up to flushRetries times
     * with exponential backoff. Non-transient errors (4xx) are not retried.
     */
    async doSendWithFlushRetry(payload) {
        let lastError;
        let delayMs = this.flushRetryDelayMs;
        for (let attempt = 0; attempt <= this.flushRetries; attempt++) {
            if (attempt > 0) {
                this.logger(`flush: retry attempt ${attempt}/${this.flushRetries} for dedupe_key=${payload.dedupeKey} (delay=${delayMs}ms)`);
                await this.delay(delayMs);
                delayMs = Math.round(delayMs * this.flushRetryBackoffMultiplier);
            }
            try {
                return await this.doSend(payload);
            }
            catch (err) {
                // Non-transient errors (4xx) should not be retried
                if (this.isNonTransientFlushError(err)) {
                    throw err;
                }
                lastError = err;
                if (attempt < this.flushRetries) {
                    this.logger(`flush: send failed for dedupe_key=${payload.dedupeKey}: ${this.describeError(err)}, will retry`);
                }
            }
        }
        throw lastError;
    }
    /**
     * Check if an error from flush send is non-transient (should not be retried).
     * 4xx responses result in errors containing status codes in the 400-499 range.
     */
    isNonTransientFlushError(err) {
        if (err instanceof Error) {
            // The doSend method throws "Send failed: <status>" for non-ok responses
            const match = err.message.match(/Send failed: (\d+)/);
            if (match) {
                const status = parseInt(match[1], 10);
                return status >= 400 && status < 500;
            }
        }
        return false;
    }
    /**
     * Persist the offline queue to disk (if queueStorePath is configured).
     */
    persistQueue() {
        if (this.queueStorePath) {
            saveOfflineQueue(this.queueStorePath, this.offlineQueue);
        }
    }
    /**
     * Perform a single send request without retry logic (used by flush).
     */
    async doSend(payload) {
        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.token}`,
            Connection: 'close',
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
        return (await response.json());
    }
    /** Describe an error for logging without leaking sensitive info. */
    describeError(err) {
        if (err instanceof Error) {
            return err.message;
        }
        return String(err);
    }
    /** Delay for the given number of milliseconds. */
    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
// ── Durable Queue Persistence ───────────────────────────────────────
/** Owner-only file permissions for queue persistence. */
const QUEUE_FILE_MODE = 0o600;
/** Owner-only directory permissions. */
const QUEUE_DIR_MODE = 0o700;
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
export function saveOfflineQueue(filePath, entries) {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true, mode: QUEUE_DIR_MODE });
    const data = JSON.stringify(entries, null, 2) + '\n';
    writeFileSync(filePath, data, { mode: QUEUE_FILE_MODE });
    chmodSync(filePath, QUEUE_FILE_MODE);
}
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
export function loadOfflineQueue(filePath) {
    if (!existsSync(filePath)) {
        return [];
    }
    let raw;
    try {
        raw = readFileSync(filePath, 'utf-8');
    }
    catch {
        return [];
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return [];
    }
    if (!Array.isArray(parsed)) {
        return [];
    }
    // Basic structural validation: ensure each entry has required fields
    return parsed.filter((entry) => typeof entry === 'object' &&
        entry !== null &&
        'type' in entry &&
        'payload' in entry &&
        'queuedAt' in entry);
}
//# sourceMappingURL=client.js.map