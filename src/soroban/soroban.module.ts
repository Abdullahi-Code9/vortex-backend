import { forwardRef, Module } from "@nestjs/common";
import { EventIngestionService } from "./event-ingestion.service";
import { SorobanController } from "./soroban.controller";
import { SorobanService } from "./soroban.service";
import { SolverRegistryService } from "./solver-registry.service";
import { SignerService } from "./signer.service";
import { StellarTxService } from "./stellar-tx.service";

@Module({
  // SorobanModule <-> SolversModule <-> IntentsModule (which imports this
  // module) form a CommonJS cycle. SolversModule must be resolved lazily so
  // that evaluating this file never triggers IntentsModule's module decorator
  // while SorobanModule is still partially initialised.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  imports: [forwardRef(() => require("../solvers/solvers.module").SolversModule)],
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
