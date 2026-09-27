export type FeePercentile =
  | "min"
  | "mode"
  | "p10"
  | "p20"
  | "p30"
  | "p40"
  | "p50"
  | "p60"
  | "p70"
  | "p80"
  | "p90"
  | "p95"
  | "p99"
  | "max";

/**
 * Default open-intent deadline in seconds per source chain.
 *
 * Controls how long after creation an intent can be accepted by a solver.
 * Values are intentionally generous — chains with slower finality get more
 * time so solvers can confidently assess liquidity before committing.
 */
export const CHAIN_DEADLINE_DEFAULTS: Record<string, number> = {
  stellar: 900,    // ~15 min — fast finality
  base: 1800,      // ~30 min
  optimism: 1800,
  arbitrum: 1800,
  ethereum: 3600,  // ~1 hr — slower finality
  polygon: 2700,   // ~45 min
  avalanche: 1800,
};

/** Fallback open-intent deadline when chain is not in the map. */
export const DEFAULT_DEADLINE_SECONDS = 1800;

/**
 * Per-chain fill-window in seconds: the time a solver has from accept to fill.
 *
 * Design rationale
 * ────────────────
 * The fill window is intentionally shorter than the full open-intent deadline
 * (CHAIN_DEADLINE_DEFAULTS) because accept-to-fill should always be a strict
 * subset of the total time budget.  Values are chosen to give solvers
 * realistic execution time on each chain while keeping the slashing window
 * fair:
 *
 *   stellar   120 s  — 5-second ledger time; a solver has plenty of margin.
 *   base      600 s  — 2-second blocks; ~5-min window comfortable for bridging.
 *   optimism  600 s  — same as Base (same block cadence).
 *   arbitrum  600 s  — sub-second blocks but finality waits for L1 batch.
 *   ethereum  1800 s — 12-second slots + confirmation depth = larger window.
 *   polygon   900 s  — ~2-second blocks; moderate finality.
 *   avalanche 600 s  — 1-2 second finality; similar profile to Base/Optimism.
 *
 * These defaults can be overridden at deploy-time via the corresponding
 * FILL_WINDOW_<CHAIN> environment variables (e.g. FILL_WINDOW_ETHEREUM=3600),
 * following the same override mechanism as CHAIN_DEADLINE_DEFAULTS.
 * They are intentionally not exposed as AppConfig fields — like
 * CHAIN_DEADLINE_DEFAULTS they are module-level constants that callers import
 * directly, keeping configuration.ts the single source of truth without
 * forcing every consumer to inject ConfigService for a plain number lookup.
 */
export const CHAIN_FILL_WINDOW_DEFAULTS: Record<string, number> = {
  stellar: 120,    // 2 min — fast finality; solver has ample time
  base: 600,       // 10 min
  optimism: 600,   // 10 min
  arbitrum: 600,   // 10 min — L1 batch delay makes this realistic
  ethereum: 1800,  // 30 min — slower slot + confirmation depth
  polygon: 900,    // 15 min
  avalanche: 600,  // 10 min — fast finality, bridge latency dominates
};

/** Fallback fill-window when chain is not in the map. */
export const DEFAULT_FILL_WINDOW_SECONDS = 600;

export interface AppConfig {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  stellar: {
    network: "testnet" | "futurenet" | "mainnet";
    sorobanRpcUrl: string;
    settlementContractId: string;
    solverRegistryContractId: string;
    signerSecretKey: string;
    // Secret key for the backend's Soroban signer. Empty outside production
    // (no on-chain write path exists yet); envValidationSchema requires and
    // format-checks it in production so it can never silently fall back to
    // a placeholder. Never log this value.
    signingKey: string;
    /** Fee percentile to use when estimating Soroban inclusion fees. */
    feePercentile: FeePercentile;
  };
  onchainIntentsEnabled: boolean;
  intentRetentionDays: number;
  intentRetentionSweepMs: number;
  /**
   * Dry-run flag for on-chain write paths (issue #260).
   *
   * When true every write path (invokeContract, slashSolver) simulates and
   * logs but never broadcasts a transaction.  Defaults to true outside
   * production; must be explicitly set in production (validated by
   * envValidationSchema — see src/config/env.validation.ts).
   *
   * Note: this flag takes effect on the next process restart; there is no
   * hot-reload mechanism for this iteration.  See
   * docs/runbooks/onchain-cutover.md for the staged rollout procedure.
   */
  onchainDryRun: boolean;
  corsOrigin: string;
  /** Maximum concurrent WebSocket connections (0 = unlimited). */
  wsMaxConnections: number;
  wsBackplane: "memory" | "redis";
  redisUrl: string;

  // ── Resource-exhaustion limits (issue #476) ───────────────────────────────
  /** Maximum JSON nesting depth accepted by the body parser middleware. */
  jsonMaxDepth: number;
  /** Maximum chain-filter values in a single WS subscribe message. */
  wsMaxFilterChains: number;
  /** Maximum concurrent active subscriptions per WS connection. */
  wsMaxSubscriptions: number;
  /** Default Postgres statement_timeout (ms) for standard route queries. */
  dbQueryTimeoutMs: number;
  /** Postgres statement_timeout (ms) for batch-lookup queries. */
  dbBatchQueryTimeoutMs: number;
  /** Postgres statement_timeout (ms) for stats/aggregate queries. */
  dbStatsQueryTimeoutMs: number;

  // ── Emergency kill-switch (issue #477) ─────────────────────────────────────
  killswitch: {
    /**
     * Shared secret for the operator control plane (`/api/v1/ops/killswitch`).
     * Empty disables those routes entirely — the control plane is never open.
     */
    operatorToken: string;
    /**
     * Redis URL used for cross-replica pause propagation. Empty falls back to
     * database polling only, which still meets the propagation budget.
     */
    redisUrl: string;
    /**
     * Interval (ms) for the `max_updated_at` probe that backstops Redis pub/sub.
     * Worst-case propagation delay is roughly this value, so it must stay
     * comfortably under the 5 s propagation requirement.
     */
    pollMs: number;
  };
}

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parseInt(process.env.PORT ?? "4000", 10),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://vortex:vortex@localhost:5432/vortex?schema=public",
  stellar: {
    network: (process.env.STELLAR_NETWORK ?? "testnet") as AppConfig["stellar"]["network"],
    sorobanRpcUrl: process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
    settlementContractId: process.env.SETTLEMENT_CONTRACT_ID ?? "",
    solverRegistryContractId: process.env.SOLVER_REGISTRY_CONTRACT_ID ?? "",
    signerSecretKey: process.env.STELLAR_SIGNER_SECRET_KEY ?? "",
    signingKey: process.env.SOROBAN_SIGNING_KEY ?? "",
    feePercentile: (process.env.SOROBAN_FEE_PERCENTILE ?? "p50") as FeePercentile,
  },
  onchainIntentsEnabled: (process.env.ONCHAIN_INTENTS_ENABLED ?? "false") === "true",
  intentRetentionDays: parseInt(process.env.INTENT_RETENTION_DAYS ?? "30", 10),
  intentRetentionSweepMs: parseInt(process.env.INTENT_RETENTION_SWEEP_MS ?? "60000", 10),
  // Default to dry-run (true) outside production; in production the value must
  // be explicitly set (validated by envValidationSchema).
  onchainDryRun: process.env.ONCHAIN_DRY_RUN !== undefined
    ? process.env.ONCHAIN_DRY_RUN === "true"
    : process.env.NODE_ENV !== "production",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  wsMaxConnections: parseInt(process.env.WS_MAX_CONNECTIONS ?? "1000", 10),
  wsBackplane: (process.env.WS_BACKPLANE ?? "memory") as "memory" | "redis",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  // ── Resource-exhaustion limits (issue #476) ───────────────────────────────
  jsonMaxDepth: parseInt(process.env.JSON_MAX_DEPTH ?? "10", 10),
  wsMaxFilterChains: parseInt(process.env.WS_MAX_FILTER_CHAINS ?? "20", 10),
  wsMaxSubscriptions: parseInt(process.env.WS_MAX_SUBSCRIPTIONS ?? "10", 10),
  dbQueryTimeoutMs: parseInt(process.env.DB_QUERY_TIMEOUT_MS ?? "5000", 10),
  dbBatchQueryTimeoutMs: parseInt(process.env.DB_BATCH_QUERY_TIMEOUT_MS ?? "10000", 10),
  dbStatsQueryTimeoutMs: parseInt(process.env.DB_STATS_QUERY_TIMEOUT_MS ?? "15000", 10),

  // ── Emergency kill-switch (issue #477) ─────────────────────────────────────
  killswitch: {
    operatorToken: process.env.KILLSWITCH_OPERATOR_TOKEN ?? "",
    // Reuse the WS backplane URL when set; an explicit empty value opts out of
    // Redis entirely and leaves propagation to database polling.
    redisUrl:
      process.env.KILLSWITCH_REDIS_URL ??
      (process.env.REDIS_URL && process.env.WS_BACKPLANE === "redis" ? process.env.REDIS_URL : ""),
    // 2000 ms + request latency stays well inside the 5 s propagation budget
    // even when Redis is unavailable.
    pollMs: parseInt(process.env.KILLSWITCH_POLL_MS ?? "2000", 10),
  },
});
