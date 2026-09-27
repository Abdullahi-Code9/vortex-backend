import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import client from "prom-client";
import { AppConfig } from "../config/configuration";

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly register: client.Registry;

  // ── HTTP ───────────────────────────────────────────────────────────────────
  public readonly httpRequestDuration: client.Histogram<string>;
  public readonly httpRequestTotal: client.Counter<string>;
  public readonly httpRequestErrors: client.Counter<string>;

  // ── Intent / WS general ───────────────────────────────────────────────────
  public readonly intentStateTransitions: client.Counter<string>;
  public readonly wsConnections: client.Gauge<string>;
  public readonly intentCreateDuration: client.Histogram<string>;
  public readonly wsDeliveryDuration: client.Histogram<string>;
  public readonly eventIngestionLag: client.Gauge<string>;

  /**
   * Sweeper metrics — these replace the retired src/common/metrics.ts
   * MetricsRegistry.sweeper namespace (see issue #259).
   *
   * The on-call runbook (docs/runbooks/on-call.md) references these names
   * directly. Any change here must be reflected there.
   */
  public readonly sweeperExpiredTotal: client.Counter<string>;
  public readonly sweeperSweepDurationMs: client.Histogram<string>;

  // ── SLO SLIs (issue #480) ─────────────────────────────────────────────────
  public readonly txConfirmationDuration: client.Histogram<string>;

  // ── WS capability-filter metrics (issue #436) ────────────────────────────
  /**
   * WS events delivered to an authenticated solver after capability filtering.
   * Label `solver` is truncated to 12 chars to bound Prometheus label cardinality.
   */
  public readonly wsEventsDeliveredTotal: client.Counter<string>;
  /**
   * WS events suppressed by the capability filter (intent outside solver's
   * supported chains/tokens or solver bond = 0).
   */
  public readonly wsEventsFilteredTotal: client.Counter<string>;

  // ── Restore-transaction metrics (issue #394) ─────────────────────────────
  public readonly sorobanRestoreTotal: client.Counter<string>;
  public readonly sorobanRestoreFeeStroops: client.Histogram<string>;

  // ── Remote signer call latency (issue #400) ───────────────────────────────
  public readonly signerCallDurationSeconds: client.Histogram<string>;

  // ── Solver-registry event ingestion (issue #399) ──────────────────────────
  public readonly solverRegistryEventsTotal: client.Counter<string>;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    this.register = new client.Registry();
    const prefix = "vortex_";

    this.httpRequestDuration = new client.Histogram({
      name: `${prefix}http_request_duration_seconds`,
      help: "HTTP request duration in seconds",
      labelNames: ["method", "route", "status_code"],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.register],
    });

    this.httpRequestTotal = new client.Counter({
      name: `${prefix}http_requests_total`,
      help: "Total number of HTTP requests",
      labelNames: ["method", "route", "status_code"],
      registers: [this.register],
    });

    this.httpRequestErrors = new client.Counter({
      name: `${prefix}http_request_errors_total`,
      help: "Total number of HTTP request errors (5xx)",
      labelNames: ["method", "route", "status_code"],
      registers: [this.register],
    });

    this.intentStateTransitions = new client.Counter({
      name: `${prefix}intent_state_transitions_total`,
      help: "Total number of intent state transitions",
      labelNames: ["from_state", "to_state"],
      registers: [this.register],
    });

    this.wsConnections = new client.Gauge({
      name: `${prefix}ws_connections_active`,
      help: "Number of active WebSocket connections",
      registers: [this.register],
    });

    // ── Sweeper metrics (issue #259) ─────────────────────────────────────────
    this.sweeperExpiredTotal = new client.Counter({
      name: `${prefix}sweeper_expired_total`,
      help: "Total number of intents expired across all sweeps",
      registers: [this.register],
    });

    this.sweeperSweepDurationMs = new client.Histogram({
      name: `${prefix}sweeper_sweep_duration_ms`,
      help: "Duration of each IntentsSweeperService.sweep() execution in milliseconds",
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
      registers: [this.register],
    });

    // ── SLO SLIs (issue #480) ───────────────────────────────────────────────
    this.intentCreateDuration = new client.Histogram({
      name: `${prefix}intent_create_duration_seconds`,
      help: "Intent-create handler latency in seconds",
      labelNames: ["route"],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.register],
    });

    this.wsDeliveryDuration = new client.Histogram({
      name: `${prefix}ws_delivery_duration_seconds`,
      help: "WS end-to-end delivery latency (broadcast to send) in seconds",
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.register],
    });

    this.eventIngestionLag = new client.Gauge({
      name: `${prefix}event_ingestion_lag_seconds`,
      help: "Event-ingestion lag: now minus newest ingested event timestamp",
      registers: [this.register],
    });

    this.txConfirmationDuration = new client.Histogram({
      name: `${prefix}tx_confirmation_duration_seconds`,
      help: "Fill submission to on-chain confirmation latency in seconds",
      buckets: [1, 5, 15, 30, 60, 120, 300],
      registers: [this.register],
    });

    // ── WS capability-filter metrics (issue #436) ──────────────────────────
    this.wsEventsDeliveredTotal = new client.Counter({
      name: `${prefix}ws_events_delivered_total`,
      help: "WS events delivered to authenticated solvers after capability filtering",
      labelNames: ["solver"],
      registers: [this.register],
    });

    this.wsEventsFilteredTotal = new client.Counter({
      name: `${prefix}ws_events_filtered_total`,
      help: "WS events suppressed by capability filter (intent outside solver's chains/tokens)",
      labelNames: ["solver"],
      registers: [this.register],
    });

    // ── Restore-transaction metrics (issue #394) ───────────────────────────
    this.sorobanRestoreTotal = new client.Counter({
      name: `${prefix}soroban_restore_total`,
      help: "Total RestoreFootprint transactions submitted",
      labelNames: ["result"],
      registers: [this.register],
    });

    this.sorobanRestoreFeeStroops = new client.Histogram({
      name: `${prefix}soroban_restore_fee_stroops`,
      help: "Fee paid for RestoreFootprint transactions in stroops",
      buckets: [1000, 5000, 10000, 50000, 100000, 500000, 1000000],
      registers: [this.register],
    });

    // ── Remote signer latency (issue #400) ────────────────────────────────
    this.signerCallDurationSeconds = new client.Histogram({
      name: `${prefix}signer_call_duration_seconds`,
      help: "Remote signer call latency in seconds",
      labelNames: ["backend", "operation"],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.register],
    });

    // ── Solver-registry event ingestion (issue #399) ──────────────────────
    this.solverRegistryEventsTotal = new client.Counter({
      name: `${prefix}solver_registry_events_total`,
      help: "Solver-registry contract events ingested by type",
      labelNames: ["event_type"],
      registers: [this.register],
    });
  }

  onModuleInit() {
    const prefix = "vortex_";
    client.collectDefaultMetrics({ register: this.register, prefix });
  }

  async metrics(): Promise<string> {
    return this.register.metrics();
  }

  contentType(): string {
    return this.register.contentType;
  }

  incIntentStateTransition(from: string, to: string) {
    this.intentStateTransitions.inc({ from_state: from, to_state: to });
  }

  incWsConnection() {
    this.wsConnections.inc();
  }

  decWsConnection() {
    this.wsConnections.dec();
  }

  /**
   * Record one sweeper cycle's expired count and duration.
   * Called by IntentsSweeperService at the end of every sweep() invocation.
   */
  recordSweep(expiredCount: number, durationMs: number): void {
    this.sweeperExpiredTotal.inc(expiredCount);
    this.sweeperSweepDurationMs.observe(durationMs);
  }

  /**
   * Observe intent-create latency (SLO SLI, issue #480).
   * Call from the create path with handler duration in seconds.
   */
  observeIntentCreate(durationSeconds: number, route = "POST /api/v1/intents"): void {
    this.intentCreateDuration.observe({ route }, durationSeconds);
  }

  /**
   * Observe WS end-to-end delivery latency (SLO SLI, issue #480).
   * Call from the gateway broadcast path with queue-to-send duration.
   */
  observeWsDelivery(durationSeconds: number): void {
    this.wsDeliveryDuration.observe(durationSeconds);
  }

  /** Set current event-ingestion lag in seconds (SLO SLI, issue #480). */
  setIngestionLag(lagSeconds: number): void {
    this.eventIngestionLag.set(lagSeconds);
  }

  /** Observe fill-to-confirmation latency in seconds (SLO SLI, issue #480). */
  observeTxConfirmation(durationSeconds: number): void {
    this.txConfirmationDuration.observe(durationSeconds);
  }

  // ── WS capability-filter helpers (issue #436) ────────────────────────────

  /** Record a WS event delivered to an authenticated solver (post-filter). */
  incWsDelivered(solverAddress: string): void {
    this.wsEventsDeliveredTotal.inc({ solver: solverAddress.slice(0, 12) });
  }

  /** Record a WS event suppressed for a solver by the capability filter. */
  incWsFiltered(solverAddress: string): void {
    this.wsEventsFilteredTotal.inc({ solver: solverAddress.slice(0, 12) });
  }

  // ── Restore-transaction helpers (issue #394) ──────────────────────────────

  incSorobanRestore(result: "success" | "failed"): void {
    this.sorobanRestoreTotal.inc({ result });
  }

  observeRestoreFee(stroops: number): void {
    this.sorobanRestoreFeeStroops.observe(stroops);
  }

  // ── Remote signer helpers (issue #400) ────────────────────────────────────

  observeSignerCall(backend: string, operation: string, durationSeconds: number): void {
    this.signerCallDurationSeconds.observe({ backend, operation }, durationSeconds);
  }

  // ── Solver-registry event ingestion helpers (issue #399) ─────────────────

  incSolverRegistryEvent(eventType: string): void {
    this.solverRegistryEventsTotal.inc({ event_type: eventType });
  }
}
