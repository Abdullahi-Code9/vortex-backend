import * as Joi from "joi";

// Stellar secret seeds ("S..." strkeys) are 56-char base32: prefix + 32-byte
// payload + checksum. This rejects placeholders like "changeme" outright —
// it does not by itself prove the key is a *real, funded* signer.
const STELLAR_SECRET_KEY_PATTERN = /^S[A-Z2-7]{55}$/;

// One message for both "absent" and "empty". Joi's .required() alone accepts an
// empty string, which for the kill-switch would be a silently disabled control
// plane — the exact condition this rule exists to prevent, so both cases must
// produce the same actionable error.
const KILLSWITCH_TOKEN_REQUIRED_MESSAGE =
  "KILLSWITCH_OPERATOR_TOKEN must be a non-empty secret in production so the " +
  "emergency pause control plane (/api/v1/ops/killswitch) is usable. Generate " +
  "one with `openssl rand -hex 32`. See docs/runbooks/killswitch.md.";

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

  // ── Resource-exhaustion limits (issue #476) ───────────────────────────────
  // These values are consumed by src/config/limits.config.ts at startup and
  // override the compile-time defaults when set.  All have safe defaults so
  // the service can boot without them.

  /** Max JSON nesting depth before the body is rejected (default 10). */
  JSON_MAX_DEPTH: Joi.number().integer().min(1).max(100).default(10),

  /** Max WS chain-filter values per subscribe message (default 20). */
  WS_MAX_FILTER_CHAINS: Joi.number().integer().min(1).max(100).default(20),

  /** Max active subscriptions per WS connection (default 10). */
  WS_MAX_SUBSCRIPTIONS: Joi.number().integer().min(1).max(100).default(10),

  /** Default Postgres statement_timeout in ms for standard route queries (default 5000). */
  DB_QUERY_TIMEOUT_MS: Joi.number().integer().min(100).max(60000).default(5000),

  /** Postgres statement_timeout in ms for batch-lookup queries (default 10000). */
  DB_BATCH_QUERY_TIMEOUT_MS: Joi.number().integer().min(100).max(60000).default(10000),

  /** Postgres statement_timeout in ms for stats/aggregate queries (default 15000). */
  DB_STATS_QUERY_TIMEOUT_MS: Joi.number().integer().min(100).max(60000).default(15000),

  // ── Emergency kill-switch (issue #477) ─────────────────────────────────────
  // Shared secret for the operator control plane. Empty (the default) leaves
  // /api/v1/ops/killswitch disabled — fail closed, never open.
  //
  // The kill-switch is the only way to stop writes at runtime, so a production
  // deploy without a token ships a protocol that cannot be paused. Requiring it
  // in production fails validation rather than silently running with the
  // control plane disabled.
  KILLSWITCH_OPERATOR_TOKEN: Joi.string()
    .when("NODE_ENV", {
      is: Joi.valid("production"),
      then: Joi.string()
        .required()
        .invalid("")
        .messages({
          "any.required": KILLSWITCH_TOKEN_REQUIRED_MESSAGE,
          "string.empty": KILLSWITCH_TOKEN_REQUIRED_MESSAGE,
          "any.invalid": KILLSWITCH_TOKEN_REQUIRED_MESSAGE,
        }),
      otherwise: Joi.string().allow("").default(""),
    }),

  /**
   * Redis URL for cross-replica pause propagation. Empty means "polling only",
   * which still meets the 5 s budget. Defaults to reusing REDIS_URL when
   * WS_BACKPLANE=redis, so existing deployments propagate without new config.
   */
  KILLSWITCH_REDIS_URL: Joi.string().allow("").optional(),

  /**
   * DB change-probe interval (ms) that backstops Redis pub/sub. Capped at 5000
   * so the worst-case propagation delay cannot exceed the requirement, however
   * misconfigured.
   */
  KILLSWITCH_POLL_MS: Joi.number().integer().min(100).max(5000).default(2000),

  // Same adapter-selection convention as the other repositories.
  KILLSWITCH_PERSISTENCE: Joi.string().valid("memory", "prisma").default("memory"),

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
});
