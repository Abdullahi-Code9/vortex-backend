import { Module, forwardRef } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventIngestionService } from "./event-ingestion.service";
import { SorobanController } from "./soroban.controller";
import { SorobanService } from "./soroban.service";
import { SolverRegistryService } from "./solver-registry.service";
import { SignerService } from "./signer.service";
import { StellarTxService } from "./stellar-tx.service";
import { TxConfirmationService } from "./tx-confirmation.service";
import { SolverRegistryEventsService } from "./events/solver-registry-events.service";
import { SIGNER_TOKEN, signerFactory } from "./signers/signer.factory";
import { SolversModule } from "../solvers/solvers.module";
import { MetricsService } from "../metrics/metrics.service";
import { AppConfig } from "../config/configuration";

@Module({
  imports: [forwardRef(() => SolversModule)],
  controllers: [SorobanController],
  providers: [
    SorobanService,

    // ── Pluggable signer backend (issue #400) ─────────────────────────────
    // Factory selects LocalKeypairSigner (SIGNER_BACKEND=local, default) or
    // VaultTransitSigner (SIGNER_BACKEND=vault) at bootstrap. All other
    // services inject SignerService and are unaware of the active backend.
    {
      provide: SIGNER_TOKEN,
      inject: [ConfigService, MetricsService],
      useFactory: signerFactory,
    },
    SignerService,

    // ── On-chain tx pipeline (issue #394) ─────────────────────────────────
    TxConfirmationService,
    StellarTxService,

    SolverRegistryService,
    EventIngestionService,

    // ── Solver-registry event ingestion (issue #399) ──────────────────────
    SolverRegistryEventsService,
  ],
  exports: [
    SorobanService,
    SolverRegistryService,
    SignerService,
    StellarTxService,
    TxConfirmationService,
    EventIngestionService,
    SolverRegistryEventsService,
  ],
})
export class SorobanModule {}
