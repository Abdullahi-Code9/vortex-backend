import { Module, forwardRef } from "@nestjs/common";
import { EventIngestionService } from "./event-ingestion.service";
import { SorobanController } from "./soroban.controller";
import { SorobanService } from "./soroban.service";
import { SolverRegistryService } from "./solver-registry.service";
import { SignerService } from "./signer.service";
import { StellarTxService } from "./stellar-tx.service";
import { IntentsModule } from "../intents/intents.module";
import { SolversModule } from "../solvers/solvers.module";

@Module({
  // IntentsModule → SorobanModule (IntentsService submits settlement writes)
  // and SorobanModule → IntentsModule (EventIngestionService reconciles
  // intents from on-chain events). The cycle is broken with forwardRef.
  // SolversModule supplies SolversService to EventIngestionService and, via
  // IntentsModule, also participates in the cycle — so it is deferred too.
  imports: [forwardRef(() => IntentsModule), forwardRef(() => SolversModule)],
  controllers: [SorobanController],
  providers: [
    SorobanService,
    SolverRegistryService,
    SignerService,
    StellarTxService,
    EventIngestionService,
  ],
  exports: [
    SorobanService,
    SolverRegistryService,
    SignerService,
    StellarTxService,
    EventIngestionService,
  ],
})
export class SorobanModule {}
