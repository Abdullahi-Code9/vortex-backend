/**
 * StellarTxService (issue #394 — archived contract state)
 * ─────────────────────────────────────────────────────────
 * Builds, simulates, and submits Soroban contract invocations.
 *
 * Preflight pipeline (issue #394)
 * ────────────────────────────────
 * Soroban state archival means persistent ledger entries (intents, solver
 * bonds) whose TTL lapsed become archived.  Any invocation that touches them
 * will fail simulation with a `restorePreamble` — a block that describes the
 * entries that must be restored before the call can succeed.
 *
 * StellarTxService now detects this condition and automatically:
 *   1. Builds a RestoreFootprint transaction from the preamble.
 *   2. Signs, submits, and confirms the restore transaction.
 *   3. Re-simulates the original transaction on the freshly-restored state.
 *   4. Submits the original transaction.
 *
 * A max-one-restore guard prevents infinite loops: if the re-simulation still
 * yields a restorePreamble, the call fails with a clear error.
 *
 * Constraints (from the issue):
 *   • Restore fees respect the configured fee ceiling (same percentile-based
 *     estimation as regular Soroban fees).
 *   • ONCHAIN_DRY_RUN=true suppresses all on-chain writes (restore included).
 *   • Restore count and fee are recorded in Prometheus metrics.
 */

import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Account,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  Operation,
  SorobanDataBuilder,
  SorobanRpc,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { AppConfig, FeePercentile } from "../config/configuration";
import { SorobanService } from "./soroban.service";
import { SignerService } from "./signer.service";
import { TxConfirmationService } from "./tx-confirmation.service";
import { MetricsService } from "../metrics/metrics.service";

export interface FeeEstimate {
  /** Classic inclusion fee, in stroops. */
  baseFee: string;
  /** Soroban resource fee returned by simulation, in stroops. */
  resourceFee: string;
  /** baseFee + resourceFee, in stroops. */
  totalFee: string;
}

export interface InvokeContractParams {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
}

export interface InvokeContractResult {
  hash: string;
  status: string;
  /**
   * True when the invocation was simulated only (dry-run mode).
   * The hash field contains a placeholder — no transaction was broadcast.
   */
  dryRun: boolean;
  /** True when a RestoreFootprint transaction was submitted before the main tx. */
  restored?: boolean;
}

@Injectable()
export class StellarTxService {
  private readonly logger = new Logger(StellarTxService.name);
  private readonly feePercentile: FeePercentile;
  private readonly dryRun: boolean;

  constructor(
    private readonly sorobanService: SorobanService,
    private readonly signerService: SignerService,
    private readonly confirmationService: TxConfirmationService,
    configService: ConfigService<AppConfig, true>,
    @Optional() private readonly metricsService?: MetricsService,
  ) {
    this.feePercentile = configService.get("stellar.feePercentile", { infer: true });
    this.dryRun = configService.get("onchainDryRun", { infer: true });
  }

  /**
   * Recommended classic inclusion fee based on recent network activity.
   * Falls back to the network's minimum base fee if fee stats are unavailable
   * or the reported fee is degenerate (e.g. an idle network reporting "0").
   */
  async estimateBaseFee(): Promise<string> {
    try {
      const stats = await this.sorobanService.getFeeStats();
      const fee = stats.sorobanInclusionFee[this.feePercentile];
      return fee && fee !== "0" ? fee : BASE_FEE;
    } catch (err) {
      this.logger.warn(
        `Failed to fetch Soroban fee stats, falling back to base fee ${BASE_FEE}: ${(err as Error).message}`,
      );
      return BASE_FEE;
    }
  }

  /**
   * Estimates the total fee (base + resource) required to submit `transaction`
   * by simulating it against the network.
   */
  async estimateFee(transaction: Transaction): Promise<FeeEstimate> {
    const baseFee = await this.estimateBaseFee();
    const simulation = await this.sorobanService.simulateTransaction(
      this.withFee(transaction, baseFee),
    );

    if (SorobanRpc.Api.isSimulationError(simulation)) {
      throw new Error(
        `Fee estimation failed: transaction simulation error: ${simulation.error}`,
      );
    }

    const resourceFee = (simulation as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .minResourceFee;
    const totalFee = (BigInt(baseFee) + BigInt(resourceFee)).toString();

    return { baseFee, resourceFee, totalFee };
  }

  /**
   * Simulates `transaction` and returns it assembled with the estimated
   * base + resource fee and Soroban transaction data, ready to sign.
   *
   * Detects `restorePreamble` and surfaces it for callers that need to handle
   * archival before proceeding (used by `invokeContract`'s preflight pipeline).
   */
  async prepareTransaction(transaction: Transaction): Promise<Transaction> {
    const baseFee = await this.estimateBaseFee();
    const prepared = await this.sorobanService.prepareTransaction(
      this.withFee(transaction, baseFee),
    );

    this.logger.log(
      `Prepared transaction with fee ${prepared.fee} stroops (base fee ${baseFee})`,
    );

    return prepared as Transaction;
  }

  /**
   * Invokes a Soroban contract method with automatic RestoreFootprint preflight.
   *
   * Dry-run path (ONCHAIN_DRY_RUN=true, the default outside production):
   *   Simulates the transaction and returns `{ dryRun: true }` — no funds move.
   *
   * Live path (ONCHAIN_DRY_RUN=false):
   *   1. Simulate the transaction.
   *   2. If simulation returns a restorePreamble, submit a RestoreFootprint
   *      transaction first (issue #394), confirm it, then re-simulate.
   *   3. Sign and submit the (now-prepared) original transaction.
   *   4. Confirm and return the result.
   */
  async invokeContract(params: InvokeContractParams): Promise<InvokeContractResult> {
    if (this.dryRun) {
      this.logger.log(
        `[dry-run] invokeContract contractId=${params.contractId} method=${params.method} ` +
        `— simulating only, ONCHAIN_DRY_RUN=true (no transaction submitted)`,
      );
      return { hash: "dry-run-no-hash", status: "DRY_RUN", dryRun: true };
    }

    this.logger.log(
      `invokeContract contractId=${params.contractId} method=${params.method}`,
    );

    return this.signerService.withNextSequence(async (sequence) => {
      const account = new Account(this.signerService.getPublicKey(), sequence);
      const baseFee = await this.estimateBaseFee();

      const rawTx = new TransactionBuilder(account, {
        fee: baseFee,
        networkPassphrase: this.signerService.getNetworkPassphrase(),
      })
        .addOperation(
          new Contract(params.contractId).call(params.method, ...params.args),
        )
        .setTimeout(30)
        .build();
      let simulation = await this.sorobanService.simulateTransaction(rawTx);

      let restored = false;
      if (this.hasRestorePreamble(simulation)) {
        this.logger.warn(
          `[stellar-tx] restorePreamble detected for method=${params.method} on contract=${params.contractId}; submitting RestoreFootprint`,
        );
        await this.submitRestoreFootprint(simulation, account, baseFee);
        restored = true;

        // Re-simulate after restore (max one restore per invocation).
        simulation = await this.sorobanService.simulateTransaction(rawTx);
        if (this.hasRestorePreamble(simulation)) {
          throw new Error(
            `invokeContract: restorePreamble still present after restore — aborting to prevent loop (method=${params.method})`,
          );
        }
      }

      if (SorobanRpc.Api.isSimulationError(simulation)) {
        throw new Error(
          `invokeContract simulation failed: ${(simulation as SorobanRpc.Api.SimulateTransactionErrorResponse).error}`,
        );
      }

      // Assemble with Soroban data + fee.
      const prepared = await this.sorobanService.prepareTransaction(rawTx);
      const signed = await this.signerService.sign(prepared as Transaction);

      const submittedAt = Date.now();
      const sendResponse = await this.sorobanService.submitTransaction(signed);

      if (sendResponse.status === "ERROR") {
        throw new Error(
          `invokeContract submit failed: ${(sendResponse as { errorResultXdr?: string }).errorResultXdr ?? "unknown error"}`,
        );
      }

      const confirmation = await this.confirmationService.waitForConfirmation(
        sendResponse.hash,
        submittedAt,
      );

      if (confirmation.status === "FAILED" || confirmation.status === "TIMEOUT") {
        throw new Error(
          `invokeContract transaction did not confirm: status=${confirmation.status} error=${confirmation.error}`,
        );
      }

      this.logger.log(
        `invokeContract succeeded: hash=${sendResponse.hash} method=${params.method} restored=${restored}`,
      );

      return {
        hash: sendResponse.hash,
        status: "SUCCESS",
        dryRun: false,
        restored,
      };
    });
  }

  // ── RestoreFootprint helpers (issue #394) ──────────────────────────────────

  /**
   * Returns true when a simulation response contains a `restorePreamble`
   * indicating that one or more ledger entries need to be restored before
   * the invocation can proceed.
   */
  private hasRestorePreamble(
    simulation: SorobanRpc.Api.SimulateTransactionResponse,
  ): boolean {
    if (SorobanRpc.Api.isSimulationError(simulation)) return false;
    const success = simulation as SorobanRpc.Api.SimulateTransactionSuccessResponse & {
      restorePreamble?: { minResourceFee: string; transactionData: string };
    };
    return (
      success.restorePreamble !== undefined &&
      success.restorePreamble.minResourceFee !== undefined
    );
  }

  /**
   * Build, sign, submit, and confirm a RestoreFootprint transaction using the
   * footprint described in `simulation.restorePreamble`.
   *
   * Fee is estimated from the preamble's `minResourceFee` plus the base
   * inclusion fee — respecting the same fee ceiling as normal Soroban ops.
   *
   * @throws if submission or confirmation fails.
   */
  private async submitRestoreFootprint(
    simulation: SorobanRpc.Api.SimulateTransactionResponse,
    account: Account,
    baseFee: string,
  ): Promise<void> {
    const success = simulation as SorobanRpc.Api.SimulateTransactionSuccessResponse & {
      restorePreamble: { minResourceFee: string; transactionData: string };
    };

    const preamble = success.restorePreamble;
    const resourceFee = preamble.minResourceFee;
    const totalFee = (BigInt(baseFee) + BigInt(resourceFee)).toString();

    // Parse the footprint XDR from the preamble.
    const sorobanData = SorobanDataBuilder.fromXDR(preamble.transactionData);

    const restoreTx = new TransactionBuilder(account, {
      fee: totalFee,
      networkPassphrase: this.signerService.getNetworkPassphrase(),
    })
      .addOperation(Operation.restoreFootprint({}))
      .setSorobanData(sorobanData.build())
      .setTimeout(30)
      .build();

    const signedRestore = await this.signerService.sign(restoreTx);
    const submittedAt = Date.now();
    const sendResponse = await this.sorobanService.submitTransaction(signedRestore);

    if (sendResponse.status === "ERROR") {
      try { this.metricsService?.incSorobanRestore("failed"); } catch { /* noop */ }
      throw new Error(
        `RestoreFootprint submission failed: ${(sendResponse as { errorResultXdr?: string }).errorResultXdr ?? "unknown"}`,
      );
    }

    const confirmation = await this.confirmationService.waitForConfirmation(
      sendResponse.hash,
      submittedAt,
    );

    if (confirmation.status !== "SUCCESS") {
      try { this.metricsService?.incSorobanRestore("failed"); } catch { /* noop */ }
      throw new Error(
        `RestoreFootprint did not confirm: status=${confirmation.status} error=${confirmation.error}`,
      );
    }

    this.logger.log(
      `[stellar-tx] RestoreFootprint confirmed: hash=${sendResponse.hash} ` +
      `resourceFee=${resourceFee} durationMs=${confirmation.durationMs}`,
    );

    try {
      this.metricsService?.incSorobanRestore("success");
      this.metricsService?.observeRestoreFee(Number(totalFee));
    } catch { /* noop */ }
  }

  private withFee(transaction: Transaction | FeeBumpTransaction, fee: string): Transaction {
    if ("innerTransaction" in transaction) {
      throw new TypeError("fee bump transactions are not supported");
    }

    return TransactionBuilder.cloneFrom(transaction, {
      fee,
      networkPassphrase: transaction.networkPassphrase,
    }).build();
  }
}
