import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Account,
  Address,
  BASE_FEE,
  FeeBumpTransaction,
  nativeToScVal,
  Networks,
  Operation,
  SorobanRpc,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { AppConfig, FeePercentile, NETWORK_PASSPHRASES } from "../config/configuration";
import { classifySimulationResponse } from "./shadow-divergence";
import { SorobanService } from "./soroban.service";
import { SignerService } from "./signer.service";
import { KillSwitchService } from "../killswitch/killswitch.service";
import {
  assertNotPaused,
  KillSwitchActiveException,
} from "../killswitch/killswitch.guard";
import { STELLAR_CHAIN } from "../intents/intents.types";

/**
 * Assumed per-simulation RPC latency, used to size the envelope's ledger
 * validity window.
 *
 * The window has to outlast the *whole* queue, not one item: a simulation
 * enqueued behind `queueMax / concurrency` slow RPCs must not have expired by
 * the time it is asked, or it comes back as a divergence and inflates the very
 * ratio the cutover runbook reads as a pass.
 */
const ASSUMED_SIMULATION_RPC_MS = 3_000;

/** Floor for the validity window, in seconds. */
const MIN_SIMULATION_TIMEOUT_SECONDS = 300;

/** Ceiling for the validity window, in seconds (Stellar rejects absurd values). */
const MAX_SIMULATION_TIMEOUT_SECONDS = 3_600;

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
}

/** Parameters for a read-only, never-broadcast contract simulation. */
export interface SimulateContractParams {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  /**
   * Public key used as the transaction source for the simulation.
   *
   * The key is used only to satisfy the envelope's source-account field; the
   * envelope is never signed and never submitted, so the key needs no balance,
   * no sequence of its own and is never charged a fee. Leaving it empty
   * short-circuits to a "cannot simulate" result rather than guessing.
   */
  sourceAccount?: string;
}

/**
 * Verdict from a simulated contract call.
 *
 * - `ok` — the contract would have accepted the call.
 * - `rejected` — the contract was reached and refused it (a `require!` guard
 *   tripped, an invariant failed, the method refused the state transition).
 * - `error` — the contract was reached and failed: the call was made and the
 *   contract did not complete it. This is a statement about the contract.
 * - `unavailable` — no verdict was obtained at all: the RPC was unreachable,
 *   the envelope could not be built, or the response was empty. This is a
 *   statement about us, and the monitor reports it as `simulation_exception`
 *   rather than blaming the contract for our outage.
 * - `skipped` — the simulation was not attempted (no source account / contract
 *   configured). Never reported as agreement.
 */
export type SimulateContractOutcome = "ok" | "rejected" | "error" | "unavailable" | "skipped";

export interface SimulateContractResult {
  outcome: SimulateContractOutcome;
  /** Log-safe explanation. Never contains keys or raw XDR. */
  detail?: string;
}


@Injectable()
export class StellarTxService {
  private readonly logger = new Logger(StellarTxService.name);
  private readonly feePercentile: FeePercentile;
  private readonly dryRun: boolean;
  private readonly networkPassphrase: string;
  /**
   * Ledger validity window for simulation envelopes, in seconds.
   *
   * Sized from the shadow queue's worst-case drain time so an observation that
   * waited at the back of the queue still simulates against valid ledger state.
   */
  private readonly simulationTimeoutSeconds: number;

  constructor(
    private readonly sorobanService: SorobanService,
    configService: ConfigService<AppConfig, true>,
    private readonly killSwitch: KillSwitchService,
  ) {
    this.feePercentile = configService.get("stellar.feePercentile", { infer: true });
    this.dryRun = configService.get("onchainDryRun", { infer: true });
    this.networkPassphrase =
      NETWORK_PASSPHRASES[configService.get("stellar.network", { infer: true })] ??
      Networks.TESTNET;

    // NaN-safe on purpose: a missing or unparseable queue setting must not
    // propagate into the ledger validity window, where it would produce a
    // transaction that cannot be encoded at all.
    const configuredQueueMax = Number(configService.get("shadow.queueMax", { infer: true }));
    const queueMax =
      Number.isFinite(configuredQueueMax) && configuredQueueMax > 0 ? configuredQueueMax : 256;
    const configuredConcurrency = Number(configService.get("shadow.concurrency", { infer: true }));
    const concurrency =
      Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
        ? Math.floor(configuredConcurrency)
        : 4;
    const batchesToDrain = Math.ceil(queueMax / concurrency);
    this.simulationTimeoutSeconds = Math.min(
      MAX_SIMULATION_TIMEOUT_SECONDS,
      Math.max(
        MIN_SIMULATION_TIMEOUT_SECONDS,
        Math.ceil((batchesToDrain * ASSUMED_SIMULATION_RPC_MS) / 1000) + 60,
      ),
    );
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
      // Issue #300 — keep the log message operational but avoid leaking raw keys.
      // SDK errors can include XDR/transaction detail, so we only include the
      // sanitized error summary here rather than serializing the whole object.
      this.logger.warn(
        `Failed to fetch Soroban fee stats, falling back to base fee ${BASE_FEE}: ${(err as Error).message}`,
      );
      return BASE_FEE;
    }
  }

  /**
   * Estimates the total fee (base + resource) required to submit `transaction`
   * by simulating it against the network, instead of hardcoding a fee value.
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
   * Invokes a Soroban contract method.
   *
   * When ONCHAIN_DRY_RUN is true (the default outside production), the
   * call is simulated and logged but never submitted — no funds move and no
   * ledger state changes. The returned result carries dryRun: true so callers
   * can distinguish simulate-only from live submissions.
   *
   * When ONCHAIN_DRY_RUN is false, the call builds, signs, and submits the
   * actual Soroban transaction. This path requires SOROBAN_SIGNING_KEY and
   * the relevant contract IDs to be configured (see env.validation.ts).
   *
   * Used by IntentsService when ONCHAIN_INTENTS_ENABLED is true.
   * Full submit implementation is pending once the on-chain settlement
   * contract interface is finalised (see docs/architecture/onchain-settlement.md).
   */
  async invokeContract(params: InvokeContractParams): Promise<InvokeContractResult> {
    // Issue #477 — the last gate before anything touches the chain. Checking
    // here rather than only in controllers also covers background callers (the
    // sweeper, event ingestion) that never pass through an HTTP guard.
    //
    // Evaluated before the dry-run branch so a pause is visible in logs even
    // while on-chain writes are simulated.
    this.assertOnChainWriteAllowed(params.method);

    if (this.dryRun) {
      this.logger.log(
        `[dry-run] invokeContract contractId=${params.contractId} method=${params.method} ` +
        `— simulating only, ONCHAIN_DRY_RUN=true (no transaction submitted)`,
      );
      // Dry-run: return a placeholder result without touching the network.
      return {
        hash: "dry-run-no-hash",
        status: "DRY_RUN",
        dryRun: true,
      };
    }

    this.logger.log(
      `invokeContract contractId=${params.contractId} method=${params.method}`,
    );

    // TODO: Build, simulate, sign, and submit the actual Soroban transaction
    // once SignerService is wired here and the contract bindings are finalised.
    // For now, throw a clear error so callers know this isn't implemented yet.
    throw new Error(
      `invokeContract not yet implemented for method=${params.method} on contract=${params.contractId}`,
    );
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

  /**
   * Throws when an emergency pause covers this on-chain write.
   *
   * `onchain` is evaluated rather than the caller's nominal operation, because
   * this is the single point every chain write funnels through — pausing
   * `onchain` must stop all of them, whichever method they use.
   */
  private assertOnChainWriteAllowed(method: string): void {
    try {
      assertNotPaused(this.killSwitch, {
        // Deliberately the protocol chain, not `stellar.network`. Switch scopes
        // are addressed with the chain an intent names ("stellar"); the network
        // ("testnet"/"mainnet") selects a Soroban endpoint and would never match
        // a `chain=stellar` pause.
        chain: STELLAR_CHAIN,
        token: null,
        operation: "onchain",
      });
    } catch (err) {
      if (err instanceof KillSwitchActiveException) {
        this.logger.warn(
          `On-chain write blocked by kill-switch: method=${method} ` +
            `scope=${err.scope} reason=${err.reasonCode}`,
        );
      }
      throw err;
    }
   * Simulates a contract invocation **without ever submitting it** (issue #401).
   *
   * This is the only RPC call the shadow-mode divergence monitor is allowed to
   * make. `SorobanRpc.Server.simulateTransaction` runs the contract in a
   * sandboxed copy of ledger state and returns a result without a transaction
   * ever entering the mempool, so:
   *
   * - No transaction is signed, so no channel account sequence is consumed.
   * - No fee is charged.
   * - Ledger state is untouched.
   *
   * It is therefore safe to call regardless of the value of `ONCHAIN_DRY_RUN`:
   * the flag governs *broadcast*, and this method never broadcasts. Calling it
   * from a request path is still forbidden by the monitor's own contract (see
   * `ShadowService.observe`), but the primitive itself is unconditionally
   * read-only.
   *
   * Every failure mode is folded into a {@link SimulateContractResult} rather
   * than a thrown error, so a caller draining a queue never has to distinguish
   * "the contract said no" from "the RPC was down" by catching.
   */
  async simulateContract(params: SimulateContractParams): Promise<SimulateContractResult> {
    const sourceAccount = params.sourceAccount?.trim();
    if (!sourceAccount) {
      return {
        outcome: "skipped",
        detail: "no simulation source account configured (SHADOW_SOURCE_ACCOUNT)",
      };
    }
    if (!params.contractId?.trim()) {
      return {
        outcome: "skipped",
        detail: "no settlement contract configured (SETTLEMENT_CONTRACT_ID)",
      };
    }

    let transaction: Transaction;
    try {
      transaction = await this.buildSimulationTransaction(params, sourceAccount);
    } catch (err) {
      // Building failed (bad contract ID, unparseable args, unreachable RPC for
      // the sequence number). Nothing was broadcast, so this is safe to report —
      // and it is `unavailable`, not `error`: the contract was never asked.
      return {
        outcome: "unavailable",
        detail: `could not build simulation transaction: ${(err as Error).message}`,
      };
    }

    let response: SorobanRpc.Api.SimulateTransactionResponse;
    try {
      response = await this.sorobanService.simulateTransaction(transaction);
    } catch (err) {
      // Transport failure: the contract was never asked, so this is our outage
      // and not a disagreement with the contract.
      return {
        outcome: "unavailable",
        detail: `simulation request failed: ${(err as Error).message}`,
      };
    }

    if (!response) {
      return { outcome: "unavailable", detail: "empty simulation response" };
    }

    // The RPC's success response has no `error` member; its error response has
    // one. Reading it structurally keeps the shared classifier independent of
    // the SDK's union type, and means the revert-vs-hard-error rule that decides
    // `rejected` vs `error` is the single copy covered by
    // `shadow-divergence.spec.ts` rather than a second one here.
    const errorText =
      "error" in response && typeof (response as { error?: unknown }).error === "string"
        ? (response as { error: string }).error
        : undefined;
    const classification = classifySimulationResponse({ error: errorText });

    if (classification.outcome === "ok" && !classification.threw) {
      return { outcome: "ok" };
    }

    return {
      outcome: classification.outcome === "rejected" ? "rejected" : "error",
      ...(classification.detail ? { detail: classification.detail } : {}),
    };
  }

  /**
   * Assemble an unsigned, submit-shaped envelope for a contract invocation.
   *
   * The sequence number comes from the source account when it exists on chain.
   * A simulation does not need a *correct* sequence — nothing is signed, so
   * nothing is sequenced — but it does need the envelope to decode, and a
   * contract that checks its own caller's sequence would answer a fabricated
   * number differently than it answers the real one, manufacturing divergences
   * out of nothing.
   *
   * A key that has never been on chain has no sequence, which is a legitimate
   * configuration (a throwaway key is enough to build an envelope), so the
   * latest ledger sequence is used as the fallback.
   */
  private async buildSimulationTransaction(
    params: SimulateContractParams,
    sourceAccount: string,
  ): Promise<Transaction> {
    const baseFee = await this.estimateBaseFee();
    const sequence = await this.resolveSimulationSequence(sourceAccount);
    const contract = Address.fromString(params.contractId);

    return new TransactionBuilder(new Account(sourceAccount, sequence), {
      fee: baseFee,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunctionType.hostFunctionTypeInvokeContract,
          args: [
            contract.toScAddress(),
            // The method name is a symbol in the Soroban ABI, not a string.
            nativeToScVal(params.method, { type: "symbol" }),
            params.args,
            // Token the call is denominated in. `native` is XLM; the settlement
            // contract's own token is a distinct `ScAddress` entry point. The
            // value is irrelevant to a simulation, but it must be a well-formed
            // ScVal for the envelope to decode.
            nativeToScVal("native", { type: "symbol" }),
          ],
        }),
      )
      .setTimeout(this.simulationTimeoutSeconds)
      .build();
  }

  /**
   * Best available sequence number for a simulation envelope.
   *
   * Tries the account first (exact), then the latest ledger (plausible), and
   * finally `"0"`. Each fallback is logged at warn/debug so an operator reading
   * the logs can tell a legitimate throwaway key from an RPC that is not
   * answering.
   */
  private async resolveSimulationSequence(sourceAccount: string): Promise<string> {
    try {
      const account = await this.sorobanService.getAccount(sourceAccount);
      const sequence = account.sequenceNumber();
      if (sequence) return String(sequence);
    } catch (err) {
      this.logger.warn(
        `Could not load source account ${sourceAccount} for shadow simulation: ${
          (err as Error).message
        }`,
      );
    }

    try {
      const ledger = await this.sorobanService.getLatestLedger();
      const latest = (ledger as unknown as { sequence?: string | number }).sequence;
      const parsed = typeof latest === "string" ? Number(latest) : latest;
      if (typeof parsed === "number" && Number.isFinite(parsed)) {
        return String(parsed + 1);
      }
    } catch (err) {
      this.logger.warn(
        `Could not read latest ledger for shadow simulation, falling back to sequence 0: ${
          (err as Error).message
        }`,
      );
    }

    return "0";
  }
}
