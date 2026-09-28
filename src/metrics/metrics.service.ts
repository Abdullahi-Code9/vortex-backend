import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import client from "prom-client";
import { AppConfig } from "../config/configuration";

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly register: client.Registry;
  public readonly httpRequestDuration: client.Histogram<string>;
  public readonly httpRequestTotal: client.Counter<string>;
  public readonly httpRequestErrors: client.Counter<string>;
  public readonly intentStateTransitions: client.Counter<string>;
  public readonly wsConnections: client.Gauge<string>;
  public readonly intentCreateDuration: client.Histogram<string>;
  public readonly wsDeliveryDuration: client.Histogram<string>;
  public readonly eventIngestionLag: client.Gauge<string>;
  public readonly txConfirmationDuration: client.Histogram<string>;

  /**
   * Shadow-mode divergence monitor (issue #401).
   *
   * `vortex_shadow_comparisons_total{transition,outcome}` counts every
   * (expected, simulated) pair the monitor resolved, and
   * `vortex_shadow_divergences_total{transition,reason}` counts the subset the
   * classifier flagged. `vortex_shadow_dropped_total` and
   * `vortex_shadow_queue_depth` expose monitor health so a starved monitor is
   * never mistaken for a healthy one — the on-chain cutover runbook's go/no-go
   * threshold is only meaningful while these are being exercised.
   */
  public readonly shadowComparisons: client.Counter<string>;
  public readonly shadowDivergences: client.Counter<string>;
  public readonly shadowDropped: client.Counter<string>;
  public readonly shadowQueueDepth: client.Gauge<string>;

  /**
   * Sweeper metrics — these replace the retired src/common/metrics.ts
   * MetricsRegistry.sweeper namespace (see issue #259).
   *
   * The on-call runbook (docs/runbooks/on-call.md) references these names
   * directly. Any change here must be reflected there.
   */
  public readonly sweeperExpiredTotal: client.Counter<string>;
  public readonly sweeperSweepDurationMs: client.Histogram<string>;

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
    // These replace the retired MetricsRegistry.sweeper namespace from
    // src/common/metrics.ts. They are Prometheus-backed so they appear in
    // GET /metrics and in any Prometheus/Grafana dashboards without further
    // adaptation.

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

    // ── Shadow-mode divergence monitor (issue #401) ──────────────────────────
    this.shadowComparisons = new client.Counter({
      name: `${prefix}shadow_comparisons_total`,
      help: "Shadow-mode (expected, simulated) outcome pairs resolved, by transition, expected outcome and simulated outcome",
      labelNames: ["transition", "expected", "outcome"],
      registers: [this.register],
    });

    this.shadowDivergences = new client.Counter({
      name: `${prefix}shadow_divergences_total`,
      help: "Shadow-mode divergences between the off-chain and simulated on-chain outcome, by transition and reason",
      labelNames: ["transition", "reason"],
      registers: [this.register],
    });

    this.shadowDropped = new client.Counter({
      name: `${prefix}shadow_dropped_total`,
      help: "Shadow-mode observations dropped because the bounded queue was full",
      registers: [this.register],
    });

    this.shadowQueueDepth = new client.Gauge({
      name: `${prefix}shadow_queue_depth`,
      help: "Current number of queued shadow-mode observations awaiting simulation",
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

  /**
   * Record one resolved shadow-mode comparison (issue #401).
   *
   * `expected` is the off-chain verdict and `outcome` the simulated one, so
   * the pair required by the issue stays queryable from PromQL:
   * `...{expected="ok",outcome="rejected"}` is the "contract would have
   * refused a transition we committed" case, and the reverse label pair is the
   * "we refused something the contract allows" case. Cardinality is bounded at
   * 5 transitions x 2 expected x 4 outcomes.
   *
   * `outcome` is `"unavailable"` when the simulation never produced a verdict
   * (unconfigured contract, RPC unreachable) so that case stays
   * distinguishable in PromQL from a contract that actively said no.
   */
  recordShadowComparison(transition: string, expected: string, outcome: string): void {
    this.shadowComparisons.inc({ transition, expected, outcome });
  }

  /** Record one classified shadow-mode divergence (issue #401). */
  recordShadowDivergence(transition: string, reason: string): void {
    this.shadowDivergences.inc({ transition, reason });
  }

  /** Record one shadow-mode observation dropped by the bounded queue. */
  recordShadowDrop(): void {
    this.shadowDropped.inc();
  }

  /** Publish the current shadow queue depth. */
  setShadowQueueDepth(depth: number): void {
    this.shadowQueueDepth.set(depth);
  }
}
