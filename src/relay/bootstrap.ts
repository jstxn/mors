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

/** Logger function type matching relay server convention. */
export type BootstrapLogger = (message: string) => void;

/** Options for the bootstrap process. */
export interface BootstrapOptions {
  /** Custom logger. Defaults to console.log. */
  logger?: BootstrapLogger;
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
  const persistenceStatus = await initPersistence(logger);

  const services = [persistenceStatus];
  const allReady = services.every((s) => s.ready);

  if (allReady) {
    logger('relay bootstrap: all services ready');
  } else {
    const failed = services.filter((s) => !s.ready).map((s) => s.name);
    logger(`relay bootstrap: services not ready: ${failed.join(', ')}`);
  }

  return { ready: allReady, services };
}

/**
 * Initialize the persistence layer.
 *
 * Currently a no-op scaffold that reports ready. When real persistence
 * is added (SQLite/Postgres message store, account store, etc.), this
 * function will perform schema migrations and connection setup.
 */
async function initPersistence(logger: BootstrapLogger): Promise<BootstrapServiceStatus> {
  logger('relay bootstrap: persistence layer initialized (scaffold)');
  return { name: 'persistence', ready: true };
}
