/**
 * Relay persistence bootstrap.
 *
 * Initializes required dependencies (persistence layer, etc.) before
 * the relay server begins accepting requests. Must be called in the
 * relay entrypoint before server.start().
 *
 * Currently provides a readiness scaffold that future milestones will
 * wire to real persistence stores (message store, account store, etc.).
 * The bootstrap contract is intentionally stable so that callers do not
 * need to change when real persistence is added.
 */

import {
  createRelayPersistenceContext,
  type RelayPersistenceContext,
} from './persistence.js';

/** Logger function type matching relay server convention. */
export type BootstrapLogger = (message: string) => void;

/** Options for the bootstrap process. */
export interface BootstrapOptions {
  /** Custom logger. Defaults to console.log. */
  logger?: BootstrapLogger;
  /** Optional state file path for file-backed relay persistence. */
  statePath?: string;
}

/** Status of an individual bootstrapped service. */
export interface BootstrapServiceStatus {
  /** Service name (e.g. 'persistence'). */
  name: string;
  /** Whether this service initialized successfully. */
  ready: boolean;
}

/** Result of the bootstrap process. */
export interface BootstrapResult {
  /** Whether all required services are ready. */
  ready: boolean;
  /** Individual service initialization statuses. */
  services: BootstrapServiceStatus[];
  /** File-backed persistence context when initialization succeeds. */
  persistence?: RelayPersistenceContext;
}

/**
 * Bootstrap the relay service dependencies.
 *
 * Initializes persistence and other required subsystems before the
 * relay server starts accepting requests. Idempotent — safe to call
 * multiple times.
 *
 * @param options - Optional bootstrap configuration.
 * @returns Bootstrap result indicating readiness state.
 */
export async function bootstrapRelay(options?: BootstrapOptions): Promise<BootstrapResult> {
  const logger = options?.logger ?? console.log;

  logger('relay bootstrap: initializing dependencies...');

  // Initialize persistence layer (placeholder — future milestones wire real stores)
  const persistence = await initPersistence(logger, options?.statePath);
  const persistenceStatus = persistence.status;

  const services = [persistenceStatus];
  const allReady = services.every((s) => s.ready);

  if (allReady) {
    logger('relay bootstrap: all services ready');
  } else {
    const failed = services.filter((s) => !s.ready).map((s) => s.name);
    logger(`relay bootstrap: services not ready: ${failed.join(', ')}`);
  }

  return { ready: allReady, services, persistence: persistence.context };
}

async function initPersistence(
  logger: BootstrapLogger,
  statePath?: string
): Promise<{ status: BootstrapServiceStatus; context?: RelayPersistenceContext }> {
  try {
    const context = createRelayPersistenceContext({ logger, statePath });
    logger(`relay bootstrap: persistence layer initialized at ${context.statePath}`);
    return {
      status: { name: 'persistence', ready: true },
      context,
    };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    logger(`relay bootstrap: persistence layer failed: ${detail}`);
    return {
      status: { name: 'persistence', ready: false },
    };
  }
}
