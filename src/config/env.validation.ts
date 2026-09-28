import * as Joi from "joi";

// Stellar secret seeds ("S..." strkeys) are 56-char base32: prefix + 32-byte
// payload + checksum. This rejects placeholders like "changeme" outright —
// it does not by itself prove the key is a *real, funded* signer.
const STELLAR_SECRET_KEY_PATTERN = /^S[A-Z2-7]{55}$/;

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid("development", "production", "test").default("development"),
  PORT: Joi.number().port().default(4000),

  // Prisma requires DATABASE_URL in production; optional (with a default) in
  // development/test so the app can boot without a live database for unit tests.
  DATABASE_URL: Joi.string()
    .uri({ scheme: ["postgresql", "postgres"] })
    .default("postgresql://vortex:vortex@localhost:5432/vortex?schema=public"),

  STELLAR_NETWORK: Joi.string().valid("testnet", "futurenet", "mainnet").default("testnet"),
  SOROBAN_RPC_URL: Joi.string().uri().default("https://soroban-testnet.stellar.org"),
  SETTLEMENT_CONTRACT_ID: Joi.string().allow("").default(""),
  SOLVER_REGISTRY_CONTRACT_ID: Joi.string().allow("").default(""),
  STELLAR_SIGNER_SECRET_KEY: Joi.string().allow("").default(""),

  // Secret key for the backend's own Soroban signer (submits on-chain writes
  // such as settlement and slashing calls). No default is provided anywhere
  // in this schema — an unset value fails closed (empty string) rather than
  // ever falling back to a placeholder that could be mistaken for a real key.
  SOROBAN_SIGNING_KEY: Joi.string()
    .pattern(STELLAR_SECRET_KEY_PATTERN)
    .messages({
      "string.pattern.base":
        'SOROBAN_SIGNING_KEY must be a valid Stellar secret seed (starts with "S", 56 base32 characters). ' +
        "Generate a throwaway testnet key for local dev — see README's Signing Key section — never commit a real one.",
    })
    .when("NODE_ENV", {
      is: "production",
      then: Joi.required(),
      otherwise: Joi.string().allow("").default(""),
    }),

  ONCHAIN_INTENTS_ENABLED: Joi.boolean().default(false),
  CORS_ORIGIN: Joi.string().default("*"),
  WS_MAX_CONNECTIONS: Joi.number().integer().min(0).default(1000),
  SOROBAN_FEE_PERCENTILE: Joi.string()
    .valid(
      "min",
      "mode",
      "p10",
      "p20",
      "p30",
      "p40",
      "p50",
      "p60",
      "p70",
      "p80",
      "p90",
      "p95",
      "p99",
      "max",
    )
    .default("p50"),

  WS_BACKPLANE: Joi.string().valid("memory", "redis").default("memory"),
  REDIS_URL: Joi.string().uri({ scheme: ["redis", "rediss"] }).default("redis://localhost:6379"),

  // ── Persistence adapter selection ─────────────────────────────────────────
  // Controls which repository adapter is used for intents and solvers.
  // "memory" (default) keeps everything in-process — no database required.
  // "prisma" writes to PostgreSQL via Prisma — requires DATABASE_URL to point
  // to a live database.  Intended for production / staging.
  INTENTS_PERSISTENCE: Joi.string().valid("memory", "prisma").default("memory"),
  SOLVERS_PERSISTENCE: Joi.string().valid("memory", "prisma").default("memory"),

  // ── Intent retention (in-memory store hygiene) ─────────────────────────────
  // How long terminal intents are kept in the in-memory adapter, and how often
  // the eviction sweep runs.  Both are read by IntentsService.
  INTENT_RETENTION_DAYS: Joi.number().integer().min(0).default(30),
  INTENT_RETENTION_SWEEP_MS: Joi.number().integer().min(0).default(60000),

  // ── Reference solver bot (scripts/solver-bot.ts) ───────────────────────────
  // Read by the standalone bot process rather than by the server, but declared
  // here so `npm run check:env-drift` sees one consistent variable set across
  // env.validation.ts, configuration.ts and the .env*.example files.
  SOLVER_SECRET: Joi.string().allow("").default(""),
  SOLVER_ADDRESS: Joi.string().allow("").default(""),
  SOLVER_CHAINS: Joi.string().allow("").default(""),

  // ── Observability ─────────────────────────────────────────────────────────
  // Sentry DSN for error alerting.  Omit (or leave blank) to disable Sentry.
  SENTRY_DSN: Joi.string().uri().allow("").default(""),

  // Winston log level.  Defaults to "debug" in dev/test and "info" in production.
  LOG_LEVEL: Joi.string()
    .valid("error", "warn", "info", "http", "verbose", "debug", "silly")
    .default(
      // Joi.ref doesn't evaluate lazily here, so we rely on the logger's own
      // resolveLogLevel() for the runtime default — this schema default acts
      // as a documentation hint and config validation guard only.
      "debug",
    ),

  // Log shipping — off by default so local dev/CI remain stdout-only. When
  // enabled, structured logs are also shipped to LOG_SHIPPING_HOST:PORT.
  LOG_SHIPPING_ENABLED: Joi.boolean().default(false),
  LOG_SHIPPING_HOST: Joi.string().when("LOG_SHIPPING_ENABLED", {
    is: true,
    then: Joi.required(),
    otherwise: Joi.string().allow("").default(""),
  }),
  LOG_SHIPPING_PORT: Joi.number().port().when("LOG_SHIPPING_ENABLED", {
    is: true,
    then: Joi.required(),
    otherwise: Joi.number().optional(),
  }),
  LOG_SHIPPING_PATH: Joi.string().default("/"),
  LOG_SHIPPING_SSL: Joi.boolean().default(false),
  LOG_SERVICE_NAME: Joi.string().default("vortex-backend"),

  // ── On-chain write safety flag (issue #35 / issue #260) ──────────────────
  // When true, every on-chain-write code path (invokeContract, slashSolver)
  // builds and simulates the transaction, logs what it *would* submit, and
  // returns without broadcasting — safe by construction.
  //
  // Default behaviour:
  //   - Outside production: defaults to true (simulate-only, fail closed
  //     toward safety — no real funds moved without an explicit opt-out).
  //   - In production: *required* to be explicitly set.  Omitting it in a
  //     production deploy fails validation so the operator must consciously
  //     decide between dry-run and live mode before traffic reaches
  //     on-chain write paths.  This matches the fail-closed pattern used
  //     for SOROBAN_SIGNING_KEY.
  //
  // Limitations: the flag is config-driven and takes effect on the next
  // process start; there is no HTTP endpoint to flip it at runtime without
  // a restart.  This limitation is documented in onchain-cutover.md and is
  // intentional for this iteration — a hot-reload mechanism is a separate
  // concern.  Set ONCHAIN_DRY_RUN=false only after completing the dry-run
  // soak described in docs/runbooks/onchain-cutover.md.
  ONCHAIN_DRY_RUN: Joi.boolean()
    .when("NODE_ENV", {
      is: "production",
      then: Joi.required().messages({
        "any.required":
          "ONCHAIN_DRY_RUN must be explicitly set in production. " +
          "Set to true to remain in simulate-only mode, or false to enable live on-chain writes. " +
          "See docs/runbooks/onchain-cutover.md for the staged rollout procedure.",
      }),
      otherwise: Joi.boolean().default(true),
    }),

  // ── Shadow-mode divergence monitor (issue #401) ───────────────────────────
  // Runs read-only on-chain simulations of every intent state transition in
  // parallel with the authoritative off-chain path and reports where the two
  // disagree.  Never submits a transaction; see src/soroban/shadow.service.ts.
  //
  // Off by default: a sampled simulation is a real RPC call with a real
  // rate-limit footprint, so it is an explicit per-environment opt-in.
  SHADOW_MODE_ENABLED: Joi.boolean().default(false),

  // Fraction of transitions to simulate, as a probability in [0, 1].
  // 1 (the default) compares every transition; 0 disables sampling entirely
  // while leaving the monitor "enabled" — useful for a canary that only wants
  // the queue/metric plumbing live.
  SHADOW_SAMPLE_RATE: Joi.number().min(0).max(1).default(1),

  // Hard cap on queued observations.  Beyond this, observations are dropped and
  // counted (`vortex_shadow_dropped_total`) rather than queued, so a slow or
  // unreachable RPC degrades the monitor instead of the service.
  SHADOW_QUEUE_MAX: Joi.number().integer().min(1).default(256),

  // How many queued observations the background drain simulates concurrently.
  SHADOW_CONCURRENCY: Joi.number().integer().min(1).max(32).default(4),

  // Public key used as the transaction source for shadow simulations.  A Stellar
  // public key (strkey G...).  It is never signed, never submitted and never
  // charged a fee — it only has to be a valid address for the envelope.
  // Optional: when empty the monitor reports `contract_unconfigured` rather
  // than silently recording zero divergence.
  SHADOW_SOURCE_ACCOUNT: Joi.string().allow("").default(""),
  // ── Governance parameters contract ────────────────────────────────────────
  // When set, ProtocolParamsService reads current + scheduled protocol
  // parameters (fee bps, fill windows, deadlines, exposure ratio, slash
  // amount) from this Soroban contract address.  Leave blank to use code
  // and env defaults.
  PARAMS_CONTRACT_ID: Joi.string().allow("").default(""),

  // How often (ms) to poll the parameters contract.  30 s is the default;
  // lower values increase RPC load; raise in production if rate-limited.
  PARAMS_POLL_INTERVAL_MS: Joi.number().integer().min(5_000).default(30_000),
  // ── Leader election (issue #493) ──────────────────────────────────────────
  // Controls whether Postgres advisory-lock based leader election is enabled
  // for singleton workers (sweeper, event-ingestion).
  //
  // Set LEADER_ELECTION_ENABLED=false in single-instance dev deployments or
  // when no database is available. When disabled, every worker considers
  // itself leader unconditionally — the pre-election behaviour.
  //
  // IMPORTANT: Do NOT route the leader election connection through PgBouncer
  // in transaction-pooling mode. Advisory locks are session-scoped; they are
  // released when the connection is returned to the pool. Use a direct
  // connection or PgBouncer in session mode.
  LEADER_ELECTION_ENABLED: Joi.boolean().default(false),

  // Heartbeat interval in milliseconds — how often non-leaders attempt to
  // acquire the lock and leaders renew it. Lower values reduce failover time
  // but increase DB load. Default 5 s gives ≤ 15 s failover.
  LEADER_ELECTION_HEARTBEAT_MS: Joi.number().integer().min(1000).max(60000).default(5000),
});
