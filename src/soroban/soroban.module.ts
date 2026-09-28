import { Module, forwardRef } from "@nestjs/common";
import { EventIngestionService } from "./event-ingestion.service";
import { ShadowController } from "./shadow.controller";
import { ShadowService } from "./shadow.service";
import { SorobanController } from "./soroban.controller";
import { SorobanService } from "./soroban.service";
import { SolverRegistryService } from "./solver-registry.service";
import { SignerService } from "./signer.service";
import { StellarTxService } from "./stellar-tx.service";
import { SolversModule } from "../solvers/solvers.module";
import { IntentsModule } from "../intents/intents.module";

// MetricsModule is @Global() and registered in AppModule, so the MetricsService
// that ShadowService emits its counters through needs no import here.
@Module({
  // `forwardRef` is required on both sides: EventIngestionService reads an
  // Intent back to date its confirmation metric, so SorobanModule needs
  // IntentsModule, and IntentsModule already needs ShadowService from here.
  imports: [forwardRef(() => IntentsModule), SolversModule],
  controllers: [SorobanController, ShadowController],
  providers: [
    SorobanService,
    SolverRegistryService,
    SignerService,
    StellarTxService,
    EventIngestionService,
    // Issue #401 — shadow-mode divergence monitor. Exported so IntentsService
    // can report off-chain transitions to it without importing Soroban internals.
    ShadowService,
  ],
  exports: [
    SorobanService,
    SolverRegistryService,
    SignerService,
    StellarTxService,
    EventIngestionService,
    ShadowService,
  ],
})
export class SorobanModule {}
