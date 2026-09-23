// @ts-nocheck
import { sha256 } from "@noble/hashes/sha256";
import type { KaspaWasmRuntime } from "./runtime.js";
import {
  DEFAULT_COMPUTE_BUDGET,
  DEFAULT_KCC20_FEE_BPS,
  DEFAULT_KCC20_MIN_PROTOCOL_FEE_SOMPI,
  DEFAULT_KCC20_PRICE_SCALE,
  DEFAULT_TOKEN_OUTPUT_SOMPI,
  KCC20_ORDERBOOK_EXPANDED_SWEEP_OUTPUT_SOMPI,
  KCC20_ORDERBOOK_MAX_SWEEP_BID_LEGS,
  KCC20_ORDERBOOK_MAX_EXPANDED_SWEEP_BID_LEGS,
  KCC20_PLATFORM_PROTOCOL_FEE_RECIPIENT,
  KCC20_ORDERBOOK_PROTOCOL_FEE_RECIPIENT,
  SUBNETWORK_ID_NATIVE,
  SOMPI_PER_TKAS,
  asciiToBytes32,
  buildKcc20FeeTicketScriptForState,
  buildNativeKcc20ScriptForState,
  buildKcc20WrapperScriptForState,
  buildKcc20OrderbookScriptForState,
  buildKcc20V3CreateBidSigScript,
  buildKcc20V3SellIntoBidSigScript,
  buildKcc20OrderbookFillBidFromSellerSweepSigScript,
  buildKcc20OrderbookFillAskSigScript,
  buildKcc20OrderbookFillBidSigScript,
  buildKcc20OrderbookSellIntoBidsSigScript,
  buildKcc20OrderbookSellIntoBids10SigScript,
  buildKcc20OrderbookCrossAskSigScript,
  buildKcc20OrderbookCrossAskLegacySigScript,
  buildKcc20OrderbookCrossBidSigScript,
  buildKcc20OrderbookCrossBidLegacySigScript,
  bytesToHex,
  calculateFeeSplit,
  findOutputIndex,
  hexToBytes,
  kcc20PsktBuilderError,
  mintPolicyName,
  normalizeSignature,
  p2pkScriptPubKey,
  p2shScriptHashHex,
  parseMintPolicy,
  requireHex32,
  selectFundingEntry,
  setVersionOneInputMassFields,
  stateToReceiptFields,
  utxoAmountSompi,
  ZERO_HASH,
} from "./sale-common.js";
import {
  buildKcc20BurnSigScript,
  buildKcc20MintByOwnerSigScript,
  buildKcc20MintPublicSigScript,
  buildKcc20ScriptForState,
  buildKcc20SetPublicMintActiveSigScript,
  buildKcc20TransferSigScript,
  dispatchTagFor,
  encodeKcc20StateRecordArrays,
  holderExtensionCommitment,
  mintExtensionCommitment,
  normalizeSilverScriptArtifact,
  ownerAuthorizationWitness,
} from "./abi.js";
import { KCC20_BUILDER_KEYS } from "./operations.js";
import { splitKcc20MintSupply } from "./protocol.js";
import {
  KCC20_ARTIFACT_SCRIPT_SHA256,
  assertKcc20ArtifactScriptHash,
} from "./artifacts.js";

export interface Kcc20PsktBuilderEngineOptions {
  wasm: KaspaWasmRuntime;
  artifacts: Record<string, unknown>;
  artifactProvider?: (key: string) => Promise<unknown>;
  config?: Record<string, any>;
  sourceProvider?: {
    getUtxosByAddresses(args: { addresses: string[] }): Promise<unknown>;
  };
  rpcClientFactory?: (config: unknown) => any;
  allowBackendOnly?: boolean;
}

export interface FeeTicketBatchCreateCapability {
  recognizedArtifact: boolean;
  batchCreateSupported: boolean;
  maxTicketBatchQuantity: number;
}

/**
 * Low-level protocol helpers used by backend projections, operator adapters,
 * and the package conformance suite. They live on the configured engine
 * because several helpers require the host-supplied WASM runtime or artifacts.
 */
export interface Kcc20PsktProtocolApi {
  readonly [name: string]: any;
}

export interface Kcc20PsktBuilderEngine {
  build(input: unknown): Promise<Record<string, unknown>>;
  buildInProcessPskt(input: unknown): Promise<Record<string, unknown>>;
  resolveFeeTicketBatchCreateCapability(input: {
    rootOwner: string;
    utilityTokenId: string;
    utilityTokenAmount: string;
    rootAddress: string;
    network?: string;
  }): Promise<FeeTicketBatchCreateCapability>;
  protocol: Kcc20PsktProtocolApi;
}

export function createKcc20PsktBuilderEngine(
  options: Kcc20PsktBuilderEngineOptions,
): Kcc20PsktBuilderEngine {
  const env = options.config ?? {};
  class InjectedRpcClient {
    private readonly inner: any;
    constructor(rpcConfig: unknown) {
      // A source provider owns its own transport lifecycle. In the browser it
      // is normally backed by one application-wide RPC connection, so creating
      // and connecting a second client here would defeat that contract and
      // reconnect once per build.
      this.inner = options.sourceProvider
        ? undefined
        : options.rpcClientFactory?.(rpcConfig);
    }
    connect() {
      if (options.sourceProvider) return Promise.resolve();
      return this.inner?.connect?.() ?? Promise.resolve();
    }
    disconnect() {
      if (options.sourceProvider) return Promise.resolve();
      return this.inner?.disconnect?.() ?? Promise.resolve();
    }
    getUtxosByAddresses(args: { addresses: string[] }) {
      if (options.sourceProvider)
        return options.sourceProvider.getUtxosByAddresses(args);
      if (this.inner?.getUtxosByAddresses)
        return this.inner.getUtxosByAddresses(args);
      throw new Error(
        "No source provider or RPC client was supplied to the KCC20 builder",
      );
    }
  }
  const kaspaWasm = new Proxy(options.wasm, {
    get(target, property, receiver) {
      if (property === "RpcClient") return InjectedRpcClient;
      return Reflect.get(target, property, receiver);
    },
  });

  const INPUT_SCHEMA = "kcc20-in-process-pskt-builder-input/v1";
  const OUTPUT_SCHEMA = "kcc20-in-process-pskt-builder-output/v1";
  const DEFAULT_DEPLOY_TKAS = 1;
  const DEFAULT_PRIORITY_FEE = 10_000n;
  const DEFAULT_MATCHER_PRIORITY_FEE = 30_000_000n;
  const DEFAULT_WRAPPER_DEPLOY_PRIORITY_FEE = 10_000_000n;
  const DEFAULT_WRPC_URL = "ws://65.108.107.30:17210";
  const MIN_FILL_GROSS_SOMPI = 50_000_000n;
  const MIN_RELAY_FEE_PER_MASS_SOMPI = 100n;
  const TOCCATA_COMPUTE_BUDGET_MASS_PER_UNIT = 100n;
  const TOCCATA_NORMALIZED_TRANSIENT_MASS_PER_BYTE = 2n;
  const TOCCATA_SIGNATURE_RESERVE_BYTES = 66n;
  const TOCCATA_MAX_STANDARD_TRANSACTION_MASS = 500_000n;
  const CONSOLIDATION_TARGET_TRANSACTION_MASS = 450_000n;
  const TOCCATA_MAX_STANDARD_RELAY_FEE_SOMPI =
    TOCCATA_MAX_STANDARD_TRANSACTION_MASS * MIN_RELAY_FEE_PER_MASS_SOMPI;
  const MIN_FUNDING_CHANGE_SOMPI = 10_000n;
  const SIGNED_FEE_CONVERGENCE_ATTEMPTS = 64;
  const TOCCATA_MASS_PER_TX_BYTE = 1n;
  const TOCCATA_MASS_PER_SCRIPT_PUBLIC_KEY_BYTE = 10n;
  const TOCCATA_TRANSIENT_BYTE_TO_MASS_FACTOR = 4n;
  const TOCCATA_POST_ACTIVATION_TRANSIENT_NORMALIZATION_DIVISOR = 2n;
  const TOCCATA_STORAGE_MASS_PARAMETER = 1_000_000_000_000n;
  const TOCCATA_UTXO_FIXED_STORAGE_BYTES = 63n;
  const TOCCATA_UTXO_STORAGE_UNIT_BYTES = 100n;
  const MIN_SINGLE_FEE_TICKET_OUTPUT_SOMPI = 100_000_000n;
  const MIN_BATCH_FEE_TICKET_OUTPUT_SOMPI = 200_000_000n;
  const MAX_U64 = (1n << 64n) - 1n;
  const GRAMS_PER_COMPUTE_BUDGET_UNIT = 100n;
  const KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE = Object.freeze({
    version: "tn10-v1",
    bidOrder: 200,
    holder: 200,
    feeTicket: 800,
    funding: 30,
  });
  const KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE = Object.freeze({
    version: "tn10-v2",
    askOrder: 200,
    feeTicket: 200,
    funding: 30,
  });
  const SWEEP_BID_CALIBRATED_WRAPPED_ARTIFACT_HASHES = new Set([
    KCC20_ARTIFACT_SCRIPT_SHA256["KCC20Orderbook.placeholder.json"],
  ]);
  const SWEEP_BID_CALIBRATED_FEE_TICKET_ARTIFACT_HASHES = new Set([
    KCC20_ARTIFACT_SCRIPT_SHA256["KCC20FeeTicket.placeholder.json"],
  ]);
  const SWEEP_ASK_CALIBRATED_WRAPPED_ARTIFACT_HASHES = new Set([
    KCC20_ARTIFACT_SCRIPT_SHA256["KCC20Orderbook.placeholder.json"],
  ]);
  const SWEEP_ASK_FEE_TICKET_ARTIFACT_BUDGETS = new Map([
    [
      KCC20_ARTIFACT_SCRIPT_SHA256["KCC20FeeTicket.placeholder.json"],
      KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE.feeTicket,
    ],
  ]);
  const KCC20_ARTIFACT_PATH = "KCC20.placeholder.json";
  const WRAPPER_ARTIFACT_PATH = "KCC20Wrapper.placeholder.json";
  const WRAPPED_ARTIFACT_PATH = "KCC20Orderbook.placeholder.json";
  const FEE_TICKET_ARTIFACT_PATH = "KCC20FeeTicket.placeholder.json";
  const staticArtifactCache = new Map();

  function readStaticArtifact(path) {
    let cached = staticArtifactCache.get(path);
    if (!cached) {
      const supplied = options.artifacts?.[path];
      cached = Promise.resolve(supplied ?? options.artifactProvider?.(path))
        .then((artifact) => {
          if (!artifact)
            throw new Error(`Missing supplied KCC20 artifact: ${path}`);
          const normalized = normalizeSilverScriptArtifact(artifact);
          assertKcc20ArtifactScriptHash(path, normalized);
          return normalized;
        })
        .catch((error) => {
          staticArtifactCache.delete(path);
          throw error;
        });
      staticArtifactCache.set(path, cached);
    }
    return cached;
  }

  function dispatchTagTemplateArg(artifact, entrypoint) {
    return {
      type: "data",
      hex: bytesToHex(artifactEntrypointDispatchTag(artifact, entrypoint)),
    };
  }

  async function resolveKcc20ArtifactForState(state, address, network) {
    const artifact = await readStaticArtifact(KCC20_ARTIFACT_PATH);
    const script = buildKcc20ScriptForState(artifact, state);
    const candidateAddress = kaspaWasm
      .addressFromScriptPublicKey(
        kaspaWasm.payToScriptHashScript(script),
        network,
      )
      .toString();
    if (candidateAddress !== address) {
      throw new Error("KCC20 UTXO address does not match the current artifact");
    }
    return { version: "standard-native-v1", artifact, script };
  }

  function artifactEntrypointDispatchTag(artifact, entrypoint) {
    try {
      return dispatchTagFor(artifact, entrypoint);
    } catch (error) {
      throw kcc20PsktBuilderError(
        `Contract artifact has no ABI entry for ${entrypoint}`,
        "CONTRACT_ARTIFACT_UNSUPPORTED",
        {
          entrypoint,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  async function readFeeTicketArtifacts() {
    const artifact = await readStaticArtifact(FEE_TICKET_ARTIFACT_PATH);
    return [
      {
        supportsBatchCreate: true,
        updateDenominationDispatchTag: artifactEntrypointDispatchTag(
          artifact,
          "updateDenominationByOwnerSig",
        ),
        transferDispatchTag: artifactEntrypointDispatchTag(
          artifact,
          "transferByOwnerSig",
        ),
        burnDispatchTag: artifactEntrypointDispatchTag(
          artifact,
          "burnByOwnerSig",
        ),
        burnTakesRefundOutput: true,
        artifact,
      },
    ];
  }

  async function readWrappedArtifacts() {
    const artifact = await readStaticArtifact(WRAPPED_ARTIFACT_PATH);
    return [
      {
        artifact,
        version: "standard-native-v1",
      },
    ];
  }

  async function readWrapperArtifacts() {
    return [
      {
        artifact: await readStaticArtifact(WRAPPER_ARTIFACT_PATH),
        version: "standard-native-v1",
      },
    ];
  }

  function wrappedArtifactSupportsEntrypoint(info, name) {
    return Array.isArray(info?.artifact?.abi)
      ? info.artifact.abi.some((entry) => entry?.name === name)
      : false;
  }

  function wrappedArtifactEntrypointInputCount(info, name) {
    if (!Array.isArray(info?.artifact?.abi)) {
      return 0;
    }
    const entry = info.artifact.abi.find((item) => item?.name === name);
    const inputs = entry?.inputs ?? entry?.args ?? entry?.parameters;
    return Array.isArray(inputs) ? inputs.length : 0;
  }

  function wrappedArtifactEntrypointTakesInput(info, entrypoint, inputName) {
    if (!Array.isArray(info?.artifact?.abi)) {
      return false;
    }
    const entry = info.artifact.abi.find((item) => item?.name === entrypoint);
    const inputs = entry?.inputs ?? entry?.args ?? entry?.parameters;
    return (
      Array.isArray(inputs) && inputs.some((input) => input?.name === inputName)
    );
  }

  function wrappedArtifactRefundsHolderDeposits(info) {
    return wrappedArtifactEntrypointTakesInput(
      info,
      "unwrapByOwnerSig",
      "refundOutputIndex",
    );
  }

  function wrappedArtifactSupportsCrossFeeTicket(info) {
    return (
      wrappedArtifactEntrypointInputCount(info, "crossAskSide") >= 11 &&
      wrappedArtifactEntrypointInputCount(info, "crossBidSide") >= 11
    );
  }

  function selectWrappedArtifactForUtxo({
    kw,
    artifacts,
    state,
    utxo,
    network,
    label,
  }) {
    const address = requireKaspaAddress(utxo.address);
    const errors = [];
    for (const info of artifacts) {
      const script = buildKcc20OrderbookScriptForState(
        info.artifact.script,
        state,
      );
      try {
        assertScriptAddress(kw, script, address, network, label);
        return { ...info, script, address };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw kcc20PsktBuilderError(
      `${label} was created with an unsupported KCC20Orderbook artifact: ${errors.join("; ")}`,
      "CONTRACT_ARTIFACT_UNSUPPORTED",
      {
        contract: "KCC20Orderbook",
        address,
      },
    );
  }

  function selectWrapperArtifactForUtxo({
    kw,
    artifacts,
    state,
    utxo,
    network,
    label,
  }) {
    const address = requireKaspaAddress(utxo.address);
    const errors = [];
    for (const info of artifacts) {
      const script = buildKcc20WrapperScriptForState(
        info.artifact.script,
        state,
      );
      try {
        assertScriptAddress(kw, script, address, network, label);
        return { ...info, script, address };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw kcc20PsktBuilderError(
      `${label} was created with an unsupported KCC20Wrapper artifact: ${errors.join("; ")}`,
      "CONTRACT_ARTIFACT_UNSUPPORTED",
      {
        contract: "KCC20Wrapper",
        address,
      },
    );
  }

  async function resolveFeeTicketBatchCreateCapability(input: {
    rootOwner: string;
    utilityTokenId: string;
    utilityTokenAmount: string;
    rootAddress: string;
    network?: string;
  }): Promise<FeeTicketBatchCreateCapability> {
    const rootState = {
      ownerIdentifier: hexToBytes(
        requireHex32(input.rootOwner, "FeeTicket root owner"),
      ),
      mode: 1,
      utilityTokenId: hexToBytes(
        requireHex32(input.utilityTokenId, "FeeTicket utility token ID"),
      ),
      denomination: parsePositiveU64(
        input.utilityTokenAmount,
        "FeeTicket utility token amount",
      ),
    };

    try {
      const artifact = selectFeeTicketArtifactForState(
        await readFeeTicketArtifacts(),
        rootState,
        requireKaspaAddress(input.rootAddress),
        input.network || env.KASPA_NETWORK || "testnet-10",
        "active FeeTicket root UTXO address",
      );
      return {
        recognizedArtifact: true,
        batchCreateSupported: artifact.supportsBatchCreate,
        maxTicketBatchQuantity: artifact.supportsBatchCreate ? 10 : 1,
      };
    } catch {
      return {
        recognizedArtifact: false,
        batchCreateSupported: false,
        maxTicketBatchQuantity: 0,
      };
    }
  }

  function encodeCovenantP2shSignatureScript(prefix, script) {
    return kaspaWasm.ScriptBuilder.fromScript(script, {
      flags: { covenantsEnabled: true },
    }).encodePayToScriptHashSignatureScript(prefix);
  }

  function encodeP2pkSignatureScript(signatureHex) {
    const signature = hexToBytes(signatureHex);
    if (signature.length === 66 && signature[0] === 65) {
      return bytesToHex(signature);
    }
    if (signature.length === 65) {
      return bytesToHex(Uint8Array.of(65, ...signature));
    }
    if (signature.length === 64) {
      return bytesToHex(Uint8Array.of(65, ...signature, 1));
    }
    throw new Error(
      `expected 64/65-byte P2PK signature, got ${signature.length}`,
    );
  }

  function covenantScriptBuilder(kw) {
    return new kw.ScriptBuilder({ flags: { covenantsEnabled: true } });
  }

  const psktBuilderByKey = Object.freeze({
    "kcc20.deploy-token": buildKcc20DeployPskt,
    "kcc20.mint": buildKcc20MintPskt,
    "kcc20.set-public-mint-active": buildKcc20SetPublicMintActivePskt,
    "kcc20.transfer": buildKcc20TransferPskt,
    "kcc20.consolidate-holders": buildKcc20ConsolidatePskt,
    "kcc20.reveal-token": buildKcc20RevealPskt,
    "fee-ticket.deploy-root": buildFeeTicketRootDeployPskt,
    "fee-ticket.update-denomination": buildFeeTicketRootUpdatePskt,
    "fee-ticket.create-from-utility-burn": buildFeeTicketCreatePskt,
    "fee-ticket.burn": buildFeeTicketBurnPskt,
    "fee-ticket.transfer": buildFeeTicketTransferPskt,
    "kcc20wrapper.deploy-market": buildWrapperMarketDeployPskt,
    "kcc20wrapper.wrap": buildWrapperWrapPskt,
    "kcc20wrapper.unwrap": buildWrapperUnwrapPskt,
    "kcc20orderbook.create-bid": buildWrappedOrderPskt,
    "kcc20orderbook.create-ask": buildWrappedOrderPskt,
    "kcc20orderbook.fill-ask": buildWrappedFillAskPskt,
    "kcc20orderbook.fill-bid": buildWrappedFillBidPskt,
    "kcc20orderbook.sweep-asks": buildWrappedSweepAsksPskt,
    "kcc20orderbook.sweep-bids": buildWrappedSweepBidsPskt,
    "kcc20orderbook.consolidate-holders": buildWrappedConsolidatePskt,
    "kcc20orderbook.cancel-ask": buildWrappedCancelPskt,
    "kcc20orderbook.cancel-bid": buildWrappedCancelPskt,
    "kcc20orderbook.matcher-settle-crossed": buildWrappedCrossMatchPskt,
  });
  const missingBuilderKeys = KCC20_BUILDER_KEYS.filter(
    (builderKey) => !psktBuilderByKey[builderKey],
  );
  if (missingBuilderKeys.length) {
    throw new Error(
      `shared KCC20 PSKT engine is missing declared builders: ${missingBuilderKeys.join(", ")}`,
    );
  }

  async function buildInProcessPskt(input) {
    if (input.schema !== INPUT_SCHEMA) {
      throw new Error(
        `unsupported in-process PSKT builder input schema: ${input.schema || "missing"}`,
      );
    }

    const builderKey = input.request?.builderKey;

    if (
      builderKey === "kcc20orderbook.matcher-settle-crossed" &&
      !options.allowBackendOnly
    ) {
      throw new Error(
        "matcher/operator PSKT construction is backend-only and is not enabled in the shared user builder",
      );
    }

    const builder = psktBuilderByKey[builderKey];
    if (!builder) {
      throw new Error(
        `unsupported builderKey: ${input.request?.builderKey || "missing"}`,
      );
    }
    return builder(input);
  }

  async function buildFeeTicketRootUpdatePskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const rootUtxo = params.activeRootUtxo;
    if (!rootUtxo) {
      throw new Error("active FeeTicket root UTXO is required");
    }

    const rootId = requireHex32(params.rootId, "FeeTicket root id");
    const rootOwner = requireHex32(
      params.rootOwner || request.owner?.kcc20Owner,
      "FeeTicket root owner",
    );
    const utilityTokenId = requireHex32(
      params.utilityTokenId,
      "FeeTicket utility token id",
    );
    const newDenomination = parsePositiveU64(
      params.utilityTokenAmount,
      "utilityTokenAmount",
    );
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rootAddress = requireKaspaAddress(rootUtxo.address);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const priorityFee = parseU64(
      env.KCC20_FEE_TICKET_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const computeBudget = parsePositiveNumber(
      env.KCC20_FEE_TICKET_COMPUTE_BUDGET || DEFAULT_COMPUTE_BUDGET,
      "computeBudget",
    );

    const currentState = kcc20FeeTicketStateFromUtxo(rootUtxo, request.owner);
    if (currentState.mode !== 1) {
      throw new Error("FeeTicket denomination update requires a root UTXO");
    }
    if (bytesToHex(currentState.ownerIdentifier) !== rootOwner) {
      throw new Error("FeeTicket root is not owned by the connected wallet");
    }
    if (bytesToHex(currentState.utilityTokenId) !== utilityTokenId) {
      throw new Error("FeeTicket root uses a different utility token");
    }

    const artifacts = await readFeeTicketArtifacts();
    const artifactInfo = selectFeeTicketArtifactForState(
      artifacts,
      currentState,
      rootAddress,
      network,
      "active FeeTicket root UTXO address",
    );
    const updatedState = {
      ...currentState,
      denomination: newDenomination,
    };
    const txid = requireHex32(rootUtxo.txidHex, "FeeTicket root txid");
    const vout = parseVout(rootUtxo.vout, "FeeTicket root vout");

    const kw = kaspaWasm;
    const {
      CovenantBinding,
      Encoding,
      Hash,
      RpcClient,
      Transaction,
      TransactionOutput,
      payToAddressScript,
      payToScriptHashScript,
    } = kw;
    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [chainRootUtxos, walletUtxos] = await Promise.all([
        getUtxosByAddresses(rpc, [rootAddress]),
        getUtxosByAddresses(rpc, [walletAddress]),
      ]);
      const rootEntry = findUtxoEntry(chainRootUtxos.entries, txid, vout);
      if (!rootEntry) {
        throw new Error(`active FeeTicket root UTXO ${txid}:${vout} not found`);
      }
      requireMatchingCovenantId(
        rootEntry,
        rootId,
        "active FeeTicket root UTXO",
      );

      const rootOutputIndex = 0;
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        priorityFee + 10_000n,
      );
      const fundingInputIndex = 1;
      const fundingChangeOutputIndex = 1;
      const fundingChange = utxoAmountSompi(fundingEntry) - priorityFee;
      if (fundingChange <= 10_000n) {
        throw new Error("FeeTicket root update funding change is too small");
      }

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          {
            previousOutpoint: rootEntry.outpoint,
            utxo: rootEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs: [
          new TransactionOutput(
            utxoAmountSompi(rootEntry),
            payToScriptHashScript(
              buildKcc20FeeTicketScriptForState(
                artifactInfo.artifact.script,
                updatedState,
              ),
            ),
            new CovenantBinding(0, new Hash(rootId)),
          ),
          new TransactionOutput(
            fundingChange,
            payToAddressScript(walletAddress),
          ),
        ],
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildFeeTicketRootUpdatePayload({
          rootId,
          owner: rootOwner,
          utilityTokenId,
          previousDenomination: currentState.denomination,
          newDenomination,
        }),
      });
      setVersionOneInputMassFields(unsignedTx, computeBudget);
      unsignedTx.inputs[fundingInputIndex].computeBudget = 30;

      const scripts = [
        feeTicketRootUpdateScriptHint(
          0,
          artifactInfo.script,
          newDenomination,
          rootOutputIndex,
          artifactInfo.updateDenominationDispatchTag,
        ),
      ];
      const feeAdjustedTx = transactionWithCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        scripts,
      );
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "FeeTicket root update PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        scripts,
        submitTransactionSupported: true,
        metadata: {
          builderKey: "fee-ticket.update-denomination",
          operation: "update-fee-ticket-denomination",
          action: "updateDenomination",
          contract: "KCC20FeeTicket",
          network,
          walletAddress,
          rootId,
          rootOwner,
          utilityTokenId,
          rootOutputIndex,
          previousDenomination: currentState.denomination.toString(),
          denomination: newDenomination.toString(),
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildFeeTicketCreatePskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const rootUtxo = params.activeRootUtxo;
    const utilityUtxo = params.utilityTokenUtxo;
    if (!rootUtxo) {
      throw new Error("active FeeTicket root UTXO is required");
    }
    if (!utilityUtxo) {
      throw new Error("utility token UTXO is required");
    }

    const ticketId = requireHex32(params.rootId, "FeeTicket root id");
    const utilityTokenId = requireHex32(
      params.utilityTokenId,
      "utility token id",
    );
    const rootOwner = requireHex32(
      params.rootOwner || request.owner?.kcc20Owner,
      "root owner",
    );
    const ticketOwner = requireHex32(
      params.ticketOwner || request.owner?.kcc20Owner,
      "ticket owner",
    );
    const denomination = parsePositiveU64(
      params.utilityTokenAmount,
      "utilityTokenAmount",
    );
    const quantity = parsePositiveNumber(params.quantity ?? 1, "quantity");
    if (quantity > 10) {
      throw new Error("quantity must not be greater than 10");
    }
    const totalDenomination = denomination * BigInt(quantity);
    if (totalDenomination > MAX_U64) {
      throw new Error(
        "FeeTicket batch utility token amount must fit in an unsigned 64-bit integer",
      );
    }
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const tokenOutputSompi =
      configuredFeeTicketOutputSompiForQuantity(quantity);
    const priorityFee = parseU64(
      env.KCC20_FEE_TICKET_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const computeBudget = parsePositiveNumber(
      env.KCC20_FEE_TICKET_COMPUTE_BUDGET || DEFAULT_COMPUTE_BUDGET,
      "computeBudget",
    );

    const feeTicketArtifacts = await readFeeTicketArtifacts();
    const rootState = {
      ownerIdentifier: hexToBytes(rootOwner),
      ownerScheme: 0,
      mode: 1,
      utilityTokenId: hexToBytes(utilityTokenId),
      denomination,
    };
    const utilityState = kcc20StateFromUtxo(utilityUtxo, request.owner);
    const kcc20ArtifactInfo = await resolveKcc20ArtifactForState(
      utilityState,
      requireKaspaAddress(utilityUtxo.address),
      network,
    );
    const kcc20Artifact = kcc20ArtifactInfo.artifact;
    if (utilityState.ownerScheme !== 0) {
      throw new Error(
        "FeeTicket utility burn requires a P2PK Schnorr KCC20 holder",
      );
    }
    if (utilityState.isMintAuthority) {
      throw new Error("FeeTicket utility burn requires a KCC20 holder UTXO");
    }
    if (utilityState.amount < totalDenomination) {
      throw new Error(
        "utility token UTXO amount is below FeeTicket batch cost",
      );
    }
    const utilityRemaining = utilityState.amount - totalDenomination;
    const utilityChangeState = { ...utilityState, amount: utilityRemaining };
    const ticketState = {
      ...rootState,
      ownerIdentifier: hexToBytes(ticketOwner),
      ownerScheme: 0,
      mode: 2,
    };

    const kw = kaspaWasm;
    const {
      CovenantBinding,
      Encoding,
      Hash,
      RpcClient,
      ScriptBuilder,
      Transaction,
      TransactionOutput,
      addressFromScriptPublicKey,
      payToAddressScript,
      payToScriptHashScript,
    } = kw;

    const utilityScript = buildNativeKcc20ScriptForState(
      kcc20Artifact.script,
      utilityState,
    );
    const rootAddress = requireKaspaAddress(rootUtxo.address);
    const utilityAddress = requireKaspaAddress(utilityUtxo.address);
    const rootArtifactInfo = selectFeeTicketArtifactForState(
      feeTicketArtifacts,
      rootState,
      rootAddress,
      network,
      "active FeeTicket root UTXO address",
    );
    if (quantity > 1 && !rootArtifactInfo.supportsBatchCreate) {
      throw new Error("FeeTicket batch creation requires a batch-capable root");
    }
    const rootScript = rootArtifactInfo.script;
    assertScriptAddress(
      kw,
      utilityScript,
      utilityAddress,
      network,
      "utility token UTXO address",
    );

    const rootTxid = requireHex32(rootUtxo.txidHex, "root txid");
    const rootVout = parseVout(rootUtxo.vout, "root vout");
    const utilityTxid = requireHex32(utilityUtxo.txidHex, "utility txid");
    const utilityVout = parseVout(utilityUtxo.vout, "utility vout");

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [rootUtxos, utilityUtxos, walletUtxos] = await Promise.all([
        getUtxosByAddresses(rpc, [rootAddress]),
        getUtxosByAddresses(rpc, [utilityAddress]),
        getUtxosByAddresses(rpc, [walletAddress]),
      ]);
      const rootEntry = findUtxoEntry(rootUtxos.entries, rootTxid, rootVout);
      if (!rootEntry) {
        throw new Error(
          `active FeeTicket root UTXO ${rootTxid}:${rootVout} not found`,
        );
      }
      const utilityEntry = findUtxoEntry(
        utilityUtxos.entries,
        utilityTxid,
        utilityVout,
      );
      if (!utilityEntry) {
        throw new Error(
          `utility token UTXO ${utilityTxid}:${utilityVout} not found`,
        );
      }

      const outputs = [];
      for (let index = 0; index < quantity; index += 1) {
        outputs.push(
          new TransactionOutput(
            tokenOutputSompi,
            payToScriptHashScript(
              buildKcc20FeeTicketScriptForState(
                rootArtifactInfo.artifact.script,
                ticketState,
              ),
            ),
            new CovenantBinding(0, new Hash(ticketId)),
          ),
        );
      }
      const rootOutputIndex = outputs.length;
      outputs.push(
        new TransactionOutput(
          utxoAmountSompi(rootEntry),
          payToScriptHashScript(rootScript),
          new CovenantBinding(0, new Hash(ticketId)),
        ),
      );
      let outputSompi =
        tokenOutputSompi * BigInt(quantity) + utxoAmountSompi(rootEntry);
      let utilityChangeOutputIndex = -1;
      if (utilityRemaining > 0n) {
        utilityChangeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(
            utxoAmountSompi(utilityEntry),
            payToScriptHashScript(
              buildNativeKcc20ScriptForState(
                kcc20Artifact.script,
                utilityChangeState,
              ),
            ),
            new CovenantBinding(1, new Hash(utilityTokenId)),
          ),
        );
        outputSompi += utxoAmountSompi(utilityEntry);
      }

      const rootInputSompi = utxoAmountSompi(rootEntry);
      const utilityInputSompi = utxoAmountSompi(utilityEntry);
      const requiredFunding =
        outputSompi + priorityFee > rootInputSompi + utilityInputSompi
          ? outputSompi +
            priorityFee -
            rootInputSompi -
            utilityInputSompi +
            10_000n
          : priorityFee + 10_000n;
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        requiredFunding,
      );
      const fundingInputIndex = 2;
      const change =
        rootInputSompi +
        utilityInputSompi +
        utxoAmountSompi(fundingEntry) -
        outputSompi -
        priorityFee;
      let fundingChangeOutputIndex = -1;
      if (change > 10_000n) {
        fundingChangeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(change, payToAddressScript(walletAddress)),
        );
      }

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          {
            previousOutpoint: rootEntry.outpoint,
            utxo: rootEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          {
            previousOutpoint: utilityEntry.outpoint,
            utxo: utilityEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: "",
      });
      setVersionOneInputMassFields(unsignedTx, computeBudget);

      const ticketPrefix = buildCreateTicketPrefix(kw, kcc20Artifact, {
        utilityInputIndex: 1,
        utilityChangeOutputIndex,
        ticketOutputIndex: 0,
        rootOutputIndex,
        quantity,
        ticketOwner: hexToBytes(ticketOwner),
        ticketOwnerScheme: 0,
        utilityChangeState,
        feeTicketArtifact: rootArtifactInfo.artifact,
      });
      unsignedTx.inputs[0].signatureScript = encodeCovenantP2shSignatureScript(
        ticketPrefix,
        rootScript,
      );

      const scripts = [
        {
          inputIndex: 1,
          scriptHex: bytesToHex(utilityScript),
          signType: 1,
          signatureScript: {
            mode: "ordered-args",
            args: kcc20BurnOrderedArgs(
              kcc20Artifact,
              utilityRemaining > 0n ? [utilityChangeState] : [],
              totalDenomination,
            ),
          },
        },
      ];
      const feeAdjustedTx = transactionWithCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        scripts,
      );
      const transactionMass = predictedFeeTicketCreateMass(kw, network, {
        transaction: feeAdjustedTx,
        utilityScript,
        utilityState,
        totalDenomination,
        utilityChangeOutputIndex,
        utilityRemaining,
        utilityChangeState,
        utilityArtifact: kcc20Artifact,
        fundingInputIndex,
      });
      if (transactionMass > TOCCATA_MAX_STANDARD_TRANSACTION_MASS) {
        throw kcc20PsktBuilderError(
          `FeeTicket create transaction mass ${transactionMass} exceeds network maximum ${TOCCATA_MAX_STANDARD_TRANSACTION_MASS}`,
          "TRANSACTION_MASS_EXCEEDED",
        );
      }
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "FeeTicket create PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        scripts,
        submitTransactionSupported: true,
        metadata: {
          builderKey: "fee-ticket.create-from-utility-burn",
          contract: "KCC20FeeTicket",
          network,
          walletAddress,
          rootOutpoint: `${rootTxid}:${rootVout}`,
          utilityOutpoint: `${utilityTxid}:${utilityVout}`,
          ticketOutputIndex: 0,
          ticketOutputIndexes: Array.from(
            { length: quantity },
            (_, index) => index,
          ),
          rootOutputIndex,
          utilityChangeOutputIndex,
          covenantId: ticketId,
          utilityTokenId,
          utilityBurnAmount: totalDenomination.toString(),
          utilityBurnAmountPerTicket: denomination.toString(),
          ticketOutputSompi: tokenOutputSompi.toString(),
          totalRefundableCollateralSompi: (
            tokenOutputSompi * BigInt(quantity)
          ).toString(),
          collateralRefundable: true,
          transactionMass: transactionMass.toString(),
          quantity,
          ticketOwner,
          utilityRemaining: utilityRemaining.toString(),
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildFeeTicketBurnPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const ticketUtxos = Array.isArray(params.ticketUtxos)
      ? params.ticketUtxos
      : [];
    if (ticketUtxos.length < 1) {
      throw new Error("FeeTicket burn requires at least one UTXO");
    }

    const ticketId = requireHex32(params.rootId, "FeeTicket root id");
    const owner = requireHex32(
      params.owner || request.owner?.kcc20Owner,
      "FeeTicket owner",
    );
    const sourceOutpoints = ticketUtxos.map((utxo) =>
      String(utxo?.outpoint || `${utxo?.txidHex}:${utxo?.vout}`).toLowerCase(),
    );
    if (new Set(sourceOutpoints).size !== sourceOutpoints.length) {
      throw new Error("FeeTicket burn source outpoints must be unique");
    }

    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const priorityFee = parseU64(
      env.KCC20_FEE_TICKET_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const computeBudget = parsePositiveNumber(
      env.KCC20_FEE_TICKET_COMPUTE_BUDGET || DEFAULT_COMPUTE_BUDGET,
      "computeBudget",
    );
    const artifacts = await readFeeTicketArtifacts();
    const states = ticketUtxos.map((utxo) =>
      kcc20FeeTicketStateFromUtxo(utxo, request.owner),
    );
    for (const state of states) {
      if (state.mode !== 2) {
        throw new Error("FeeTicket burn requires ticket-mode UTXOs");
      }
      if (bytesToHex(state.ownerIdentifier) !== owner) {
        throw new Error("FeeTicket burn source is not owned by sender");
      }
    }

    const kw = kaspaWasm;
    const {
      Encoding,
      RpcClient,
      Transaction,
      TransactionOutput,
      payToAddressScript,
    } = kw;
    const artifactInfos = ticketUtxos.map((utxo, index) =>
      selectFeeTicketArtifactForState(
        artifacts,
        states[index],
        requireKaspaAddress(utxo.address),
        network,
        `FeeTicket UTXO ${sourceOutpoints[index]} address`,
      ),
    );
    const ticketAddresses = ticketUtxos.map((utxo) =>
      requireKaspaAddress(utxo.address),
    );

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [chainTicketUtxos, walletUtxos] = await Promise.all([
        getUtxosByAddresses(rpc, uniqueStrings(ticketAddresses)),
        getUtxosByAddresses(rpc, [walletAddress]),
      ]);
      const entries = ticketUtxos.map((utxo, index) => {
        const txid = requireHex32(utxo.txidHex, "FeeTicket txid");
        const vout = parseVout(utxo.vout, "FeeTicket vout");
        const entry = findUtxoEntry(chainTicketUtxos.entries, txid, vout);
        if (!entry) {
          throw new Error(
            `active FeeTicket UTXO ${sourceOutpoints[index]} not found`,
          );
        }
        requireMatchingCovenantId(
          entry,
          ticketId,
          `FeeTicket UTXO ${sourceOutpoints[index]}`,
        );
        return entry;
      });

      const outputs = entries.map(
        (entry, index) =>
          new TransactionOutput(
            utxoAmountSompi(entry),
            p2pkScriptPubKey(kw, bytesToHex(states[index].ownerIdentifier)),
          ),
      );
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        priorityFee + 10_000n,
      );
      const fundingInputIndex = entries.length;
      const fundingChangeOutputIndex = outputs.length;
      const fundingChange = utxoAmountSompi(fundingEntry) - priorityFee;
      if (fundingChange <= 10_000n) {
        throw new Error("FeeTicket burn funding change is too small");
      }
      outputs.push(
        new TransactionOutput(fundingChange, payToAddressScript(walletAddress)),
      );

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          ...entries.map((entry) => ({
            previousOutpoint: entry.outpoint,
            utxo: entry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          })),
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildFeeTicketBurnPayload({
          rootId: ticketId,
          owner,
          sourceOutpoints,
        }),
      });
      setVersionOneInputMassFields(unsignedTx, computeBudget);
      unsignedTx.inputs[fundingInputIndex].computeBudget = 30;

      const scripts = artifactInfos.map((info, index) =>
        feeTicketBurnScriptHint(
          index,
          info.script,
          info.burnDispatchTag,
          index,
          info.burnTakesRefundOutput,
        ),
      );
      const feeAdjustedTx = transactionWithCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,

        network,
        input.request?.builderKey || "PSKT",
        scripts,
      );
      const transactionMass = predictedFeeTicketBurnMass(kw, network, {
        transaction: feeAdjustedTx,
        artifactInfos,
        fundingInputIndex,
      });
      if (transactionMass > TOCCATA_MAX_STANDARD_TRANSACTION_MASS) {
        throw kcc20PsktBuilderError(
          `FeeTicket burn transaction mass ${transactionMass} exceeds network maximum ${TOCCATA_MAX_STANDARD_TRANSACTION_MASS}`,
          "TRANSACTION_MASS_EXCEEDED",
        );
      }

      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "FeeTicket burn PSKT serialization did not return JSON text",
        );
      }
      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        scripts,
        submitTransactionSupported: true,
        metadata: {
          builderKey: "fee-ticket.burn",
          operation: "burn-fee-ticket",
          action: "burnByOwnerSig",
          contract: "KCC20FeeTicket",
          network,
          walletAddress,
          rootId: ticketId,
          owner,
          sourceOutpoints,
          refundOutputIndexes: entries.map((_, index) => index),
          ticketCount: entries.length,
          totalRefundSompi: entries
            .reduce((sum, entry) => sum + utxoAmountSompi(entry), 0n)
            .toString(),
          transactionMass: transactionMass.toString(),
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildFeeTicketTransferPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const ticketUtxos = Array.isArray(params.ticketUtxos)
      ? params.ticketUtxos
      : [];
    if (ticketUtxos.length < 1 || ticketUtxos.length > 10) {
      throw new Error("FeeTicket transfer requires between 1 and 10 UTXOs");
    }

    const ticketId = requireHex32(params.rootId, "FeeTicket root id");
    const utilityTokenId = requireHex32(
      params.utilityTokenId,
      "FeeTicket utility token id",
    );
    const owner = requireHex32(
      params.owner || request.owner?.kcc20Owner,
      "FeeTicket owner",
    );
    const recipientOwner = requireHex32(
      params.recipientOwner,
      "FeeTicket recipient owner",
    );
    if (recipientOwner === owner) {
      throw new Error(
        "FeeTicket recipient owner must differ from sender owner",
      );
    }

    const sourceOutpoints = ticketUtxos.map((utxo) =>
      String(utxo?.outpoint || `${utxo?.txidHex}:${utxo?.vout}`).toLowerCase(),
    );
    if (new Set(sourceOutpoints).size !== sourceOutpoints.length) {
      throw new Error("FeeTicket transfer source outpoints must be unique");
    }

    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const priorityFee = parseU64(
      env.KCC20_FEE_TICKET_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const computeBudget = parsePositiveNumber(
      env.KCC20_FEE_TICKET_COMPUTE_BUDGET || DEFAULT_COMPUTE_BUDGET,
      "computeBudget",
    );
    const artifacts = await readFeeTicketArtifacts();
    const states = ticketUtxos.map((utxo) =>
      kcc20FeeTicketStateFromUtxo(utxo, request.owner),
    );
    for (const state of states) {
      if (state.mode !== 2) {
        throw new Error("FeeTicket transfer requires ticket-mode UTXOs");
      }
      if (bytesToHex(state.ownerIdentifier) !== owner) {
        throw new Error("FeeTicket transfer source is not owned by sender");
      }
      if (bytesToHex(state.utilityTokenId) !== utilityTokenId) {
        throw new Error(
          "FeeTicket transfer source uses a different utility token",
        );
      }
    }

    const kw = kaspaWasm;
    const {
      CovenantBinding,
      Encoding,
      Hash,
      RpcClient,
      Transaction,
      TransactionOutput,
      payToAddressScript,
      payToScriptHashScript,
    } = kw;
    const artifactInfos = ticketUtxos.map((utxo, index) =>
      selectFeeTicketArtifactForState(
        artifacts,
        states[index],
        requireKaspaAddress(utxo.address),
        network,
        `FeeTicket UTXO ${sourceOutpoints[index]} address`,
      ),
    );
    const ticketAddresses = ticketUtxos.map((utxo) =>
      requireKaspaAddress(utxo.address),
    );

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [chainTicketUtxos, walletUtxos] = await Promise.all([
        getUtxosByAddresses(rpc, uniqueStrings(ticketAddresses)),
        getUtxosByAddresses(rpc, [walletAddress]),
      ]);
      const entries = ticketUtxos.map((utxo, index) => {
        const txid = requireHex32(utxo.txidHex, "FeeTicket txid");
        const vout = parseVout(utxo.vout, "FeeTicket vout");
        const entry = findUtxoEntry(chainTicketUtxos.entries, txid, vout);
        if (!entry) {
          throw new Error(
            `active FeeTicket UTXO ${sourceOutpoints[index]} not found`,
          );
        }
        requireMatchingCovenantId(
          entry,
          ticketId,
          `FeeTicket UTXO ${sourceOutpoints[index]}`,
        );
        return entry;
      });

      const recipientStates = states.map((state) => ({
        ...state,
        ownerIdentifier: hexToBytes(recipientOwner),
      }));
      const outputs = entries.map(
        (entry, index) =>
          new TransactionOutput(
            utxoAmountSompi(entry),
            payToScriptHashScript(
              buildKcc20FeeTicketScriptForState(
                artifactInfos[index].artifact.script,
                recipientStates[index],
              ),
            ),
            new CovenantBinding(index, new Hash(ticketId)),
          ),
      );
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        priorityFee + 10_000n,
      );
      const fundingInputIndex = entries.length;
      const fundingChangeOutputIndex = outputs.length;
      const fundingChange = utxoAmountSompi(fundingEntry) - priorityFee;
      if (fundingChange <= 10_000n) {
        throw new Error("FeeTicket transfer funding change is too small");
      }
      outputs.push(
        new TransactionOutput(fundingChange, payToAddressScript(walletAddress)),
      );

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          ...entries.map((entry) => ({
            previousOutpoint: entry.outpoint,
            utxo: entry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          })),
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildFeeTicketTransferPayload({
          rootId: ticketId,
          owner,
          recipientOwner,
          sourceOutpoints,
        }),
      });
      setVersionOneInputMassFields(unsignedTx, computeBudget);
      unsignedTx.inputs[fundingInputIndex].computeBudget = 30;

      const scripts = artifactInfos.map((info, index) =>
        feeTicketTransferScriptHint(
          index,
          info.script,
          recipientOwner,
          index,
          info.transferDispatchTag,
        ),
      );
      const feeAdjustedTx = transactionWithCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        scripts,
      );
      const transactionMass = predictedFeeTicketTransferMass(kw, network, {
        transaction: feeAdjustedTx,
        recipientOwner,
        artifactInfos,
        fundingInputIndex,
      });
      if (transactionMass > TOCCATA_MAX_STANDARD_TRANSACTION_MASS) {
        throw kcc20PsktBuilderError(
          `FeeTicket transfer transaction mass ${transactionMass} exceeds network maximum ${TOCCATA_MAX_STANDARD_TRANSACTION_MASS}`,
          "TRANSACTION_MASS_EXCEEDED",
        );
      }

      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "FeeTicket transfer PSKT serialization did not return JSON text",
        );
      }
      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        scripts,
        submitTransactionSupported: true,
        metadata: {
          builderKey: "fee-ticket.transfer",
          operation: "transfer-fee-ticket",
          action: "transferByOwnerSig",
          contract: "KCC20FeeTicket",
          network,
          walletAddress,
          rootId: ticketId,
          owner,
          recipientOwner,
          sourceOutpoints,
          recipientOutputIndexes: entries.map((_, index) => index),
          ticketCount: entries.length,
          totalRefundableCollateralSompi: entries
            .reduce((sum, entry) => sum + utxoAmountSompi(entry), 0n)
            .toString(),
          collateralRefundable: true,
          transactionMass: transactionMass.toString(),
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  function feeTicketOutputSompiForQuantity(quantity, configuredOutputSompi) {
    const minimum =
      Number(quantity) === 1
        ? MIN_SINGLE_FEE_TICKET_OUTPUT_SOMPI
        : MIN_BATCH_FEE_TICKET_OUTPUT_SOMPI;
    const configured = BigInt(configuredOutputSompi);
    return configured > minimum ? configured : minimum;
  }

  function configuredFeeTicketOutputSompiForQuantity(
    quantity,
    environment = env,
  ) {
    const configured = parseU64(
      Number(quantity) === 1
        ? environment.KCC20_FEE_TICKET_OUTPUT_SOMPI ||
            DEFAULT_TOKEN_OUTPUT_SOMPI.toString()
        : environment.KCC20_FEE_TICKET_BATCH_OUTPUT_SOMPI ||
            MIN_BATCH_FEE_TICKET_OUTPUT_SOMPI.toString(),
      Number(quantity) === 1 ? "ticketOutputSompi" : "batchTicketOutputSompi",
    );
    return feeTicketOutputSompiForQuantity(quantity, configured);
  }

  function assertKcc20TokenOutputSompi(value, operation) {
    const outputSompi = BigInt(value);
    if (outputSompi < DEFAULT_TOKEN_OUTPUT_SOMPI) {
      throw kcc20PsktBuilderError(
        `${operation} token output ${outputSompi} is below the KCC20 minimum ${DEFAULT_TOKEN_OUTPUT_SOMPI} sompi`,
        "KCC20_TOKEN_OUTPUT_BELOW_MINIMUM",
        {
          operation,
          tokenOutputSompi: outputSompi,
          minimumTokenOutputSompi: DEFAULT_TOKEN_OUTPUT_SOMPI,
        },
      );
    }
    return outputSompi;
  }

  function singleHolderSweepTokenOutputSompi(legCount, configuredOutputSompi) {
    const configured = BigInt(configuredOutputSompi);
    if (Number(legCount) <= KCC20_ORDERBOOK_MAX_SWEEP_BID_LEGS) {
      return configured;
    }
    return KCC20_ORDERBOOK_EXPANDED_SWEEP_OUTPUT_SOMPI;
  }

  function sellerSettlementOutputIndex(
    sellerValueSompi,
    sellerOutputIndex,
    feeOutputIndex,
  ) {
    if (BigInt(sellerValueSompi) > 0n) {
      return Number(sellerOutputIndex);
    }
    if (Number(feeOutputIndex) < 0) {
      throw new Error("zero-net seller settlement requires a fee output");
    }
    return Number(feeOutputIndex);
  }

  function refundableBidDepositSompi(
    bidInputSompi,
    bidAmount,
    unitPriceSompi,
    priceScale,
  ) {
    return (
      BigInt(bidInputSompi) -
      exactGrossSompi(
        BigInt(bidAmount),
        BigInt(unitPriceSompi),
        BigInt(priceScale),
        "bid deposit",
      )
    );
  }

  function sellerFundedHolderTopUpSompi(
    bidDepositSompi,
    buyerHolderOutputSompi,
    remainingBidAmount,
  ) {
    const deposit = BigInt(bidDepositSompi);
    const holderOutput = BigInt(buyerHolderOutputSompi);
    if (BigInt(remainingBidAmount) > 0n) {
      return holderOutput;
    }
    if (holderOutput !== deposit) {
      throw new Error("full bid fill must transfer exactly the bid deposit");
    }
    return 0n;
  }

  function calculateTemporaryKasLockedSompi(fills, sellerContinuationSompi) {
    return (
      fills.reduce(
        (sum, fill) => sum + BigInt(fill.buyerHolderDepositSompi),
        0n,
      ) + BigInt(sellerContinuationSompi)
    );
  }

  function assertPartialBuyerHolderOutputSompi(outputSompi) {
    const output = BigInt(outputSompi);
    if (
      output < DEFAULT_TOKEN_OUTPUT_SOMPI ||
      output > KCC20_ORDERBOOK_EXPANDED_SWEEP_OUTPUT_SOMPI
    ) {
      throw kcc20PsktBuilderError(
        `partial buyer holder output ${output} must be between ${DEFAULT_TOKEN_OUTPUT_SOMPI} and ${KCC20_ORDERBOOK_EXPANDED_SWEEP_OUTPUT_SOMPI} sompi`,
        "PARTIAL_BUYER_HOLDER_OUTPUT_INVALID",
        {
          buyerHolderOutputSompi: output,
          minimumBuyerHolderOutputSompi: DEFAULT_TOKEN_OUTPUT_SOMPI,
          maximumBuyerHolderOutputSompi:
            KCC20_ORDERBOOK_EXPANDED_SWEEP_OUTPUT_SOMPI,
        },
      );
    }
    return output;
  }

  function assertPartialSweepLegIsFinal(
    remainingBidAmount,
    legIndex,
    legCount,
  ) {
    if (
      BigInt(remainingBidAmount) > 0n &&
      Number(legIndex) !== Number(legCount) - 1
    ) {
      throw new Error("only the final sweep bid leg may be partially filled");
    }
  }

  function assertSweepBidPricePriority(
    unitPriceSompi,
    legIndex,
    previousUnitPriceSompi,
  ) {
    if (
      Number(legIndex) > 0 &&
      BigInt(unitPriceSompi) > BigInt(previousUnitPriceSompi)
    ) {
      throw new Error(
        "sweep bid legs must be ordered from highest to lowest unit price",
      );
    }
  }

  function singleHolderSweepScriptLegCapacity(legCount, artifactMaxLegs) {
    return Number(legCount) > KCC20_ORDERBOOK_MAX_SWEEP_BID_LEGS
      ? Number(artifactMaxLegs)
      : KCC20_ORDERBOOK_MAX_SWEEP_BID_LEGS;
  }

  function singleHolderSweepCoversTotal(singleHolderUtxo, totalFillAmount) {
    if (!singleHolderUtxo) return false;
    return (
      parsePositiveU64(
        singleHolderUtxo.state?.amount,
        "single holder amount",
      ) >= BigInt(totalFillAmount)
    );
  }

  function predictedFeeTicketCreateMass(kw, network, details) {
    if (typeof kw.calculateTransactionMass !== "function") {
      return 0n;
    }
    const serialized = details.transaction.serializeToSafeJSON();
    if (typeof serialized !== "string") {
      throw new Error(
        "FeeTicket mass preflight transaction serialization did not return JSON text",
      );
    }
    const predicted =
      typeof kw.Transaction.deserializeFromSafeJSON === "function"
        ? kw.Transaction.deserializeFromSafeJSON(serialized)
        : kw.Transaction.deserializeFromJSON(serialized);
    const dummySignature = new Uint8Array(65);
    dummySignature[64] = 1;
    const utilityPrefix = buildKcc20BurnSigScript(kw, details.utilityArtifact, {
      nextStates:
        details.utilityRemaining > 0n ? [details.utilityChangeState] : [],
      burnAmount: details.totalDenomination,
      witness: dummySignature,
    });
    predicted.inputs[1].signatureScript = encodeCovenantP2shSignatureScript(
      utilityPrefix,
      details.utilityScript,
    );
    predicted.inputs[details.fundingInputIndex].signatureScript =
      encodeP2pkSignatureScript(bytesToHex(dummySignature));
    return sompiToBigInt(
      kw.calculateTransactionMass(network, predicted, 1),
      "FeeTicket predicted transaction mass",
    );
  }

  function predictedFeeTicketBurnMass(kw, network, details) {
    if (typeof kw.calculateTransactionMass !== "function") {
      return 0n;
    }
    const serialized = details.transaction.serializeToSafeJSON();
    if (typeof serialized !== "string") {
      throw new Error(
        "FeeTicket burn mass preflight serialization did not return JSON text",
      );
    }
    const predicted =
      typeof kw.Transaction.deserializeFromSafeJSON === "function"
        ? kw.Transaction.deserializeFromSafeJSON(serialized)
        : kw.Transaction.deserializeFromJSON(serialized);
    const dummySignature = new Uint8Array(65);
    dummySignature[64] = 1;
    details.artifactInfos.forEach((info, index) => {
      const prefix = buildFeeTicketBurnPrefix(
        kw,
        bytesToHex(dummySignature),
        info.burnDispatchTag,
        index,
        info.burnTakesRefundOutput,
      );
      predicted.inputs[index].signatureScript =
        encodeCovenantP2shSignatureScript(prefix, info.script);
    });
    predicted.inputs[details.fundingInputIndex].signatureScript =
      encodeP2pkSignatureScript(bytesToHex(dummySignature));
    return sompiToBigInt(
      kw.calculateTransactionMass(network, predicted, 1),
      "FeeTicket burn predicted transaction mass",
    );
  }

  function predictedFeeTicketTransferMass(kw, network, details) {
    if (typeof kw.calculateTransactionMass !== "function") {
      return 0n;
    }
    const serialized = details.transaction.serializeToSafeJSON();
    if (typeof serialized !== "string") {
      throw new Error(
        "FeeTicket transfer mass preflight serialization did not return JSON text",
      );
    }
    const predicted =
      typeof kw.Transaction.deserializeFromSafeJSON === "function"
        ? kw.Transaction.deserializeFromSafeJSON(serialized)
        : kw.Transaction.deserializeFromJSON(serialized);
    const dummySignature = new Uint8Array(65);
    dummySignature[64] = 1;
    details.artifactInfos.forEach((info, index) => {
      const prefix = covenantScriptBuilder(kw);
      prefix.addData(dummySignature);
      prefix.addData(hexToBytes(details.recipientOwner));
      addExplicitByte(prefix, 0);
      prefix.addI64(BigInt(index));
      prefix.addData(info.transferDispatchTag);
      predicted.inputs[index].signatureScript =
        encodeCovenantP2shSignatureScript(prefix.drain(), info.script);
    });
    predicted.inputs[details.fundingInputIndex].signatureScript =
      encodeP2pkSignatureScript(bytesToHex(dummySignature));
    return sompiToBigInt(
      kw.calculateTransactionMass(network, predicted, 1),
      "FeeTicket transfer predicted transaction mass",
    );
  }

  function dummySignatureBytes() {
    const signature = new Uint8Array(65);
    signature[64] = 1;
    return signature;
  }

  function cloneTransactionForMassPreflight(kw, transaction, label) {
    const serialized = transaction.serializeToSafeJSON();
    if (typeof serialized !== "string") {
      throw new Error(
        `${label} mass preflight serialization did not return JSON text`,
      );
    }
    return typeof kw.Transaction.deserializeFromSafeJSON === "function"
      ? kw.Transaction.deserializeFromSafeJSON(serialized)
      : kw.Transaction.deserializeFromJSON(serialized);
  }

  function sweepBidComputeBudgetLayout(legCount, mode, feeTicketApplied) {
    const count = Number(legCount);
    if (!Number.isInteger(count) || count < 2) {
      throw new Error(
        "sweep bid compute-budget layout requires at least two legs",
      );
    }
    if (mode !== "single-holder" && mode !== "paired-holder") {
      throw new Error(`unsupported sweep bid compute-budget mode: ${mode}`);
    }

    const bidInputIndexes =
      mode === "single-holder"
        ? Array.from({ length: count }, (_, index) => index)
        : Array.from({ length: count }, (_, index) => index * 2);
    const holderInputIndexes =
      mode === "single-holder"
        ? [count]
        : Array.from({ length: count }, (_, index) => index * 2 + 1);
    const covenantInputCount =
      bidInputIndexes.length + holderInputIndexes.length;
    const feeTicketInputIndex = feeTicketApplied ? covenantInputCount : -1;
    const fundingInputIndex = covenantInputCount + (feeTicketApplied ? 1 : 0);

    return {
      mode,
      bidInputIndexes,
      holderInputIndexes,
      feeTicketInputIndex,
      fundingInputIndex,
      inputCount: fundingInputIndex + 1,
    };
  }

  function sweepAskComputeBudgetLayout(legCount, feeTicketApplied) {
    const count = Number(legCount);
    if (!Number.isInteger(count) || count < 2) {
      throw new Error(
        "sweep ask compute-budget layout requires at least two legs",
      );
    }
    const askInputIndexes = Array.from({ length: count }, (_, index) => index);
    const feeTicketInputIndex = feeTicketApplied ? count : -1;
    const fundingInputIndex = count + (feeTicketApplied ? 1 : 0);

    return {
      askInputIndexes,
      feeTicketInputIndex,
      fundingInputIndex,
      inputCount: fundingInputIndex + 1,
    };
  }

  function sweepBidReservedComputeMass(layout) {
    return (
      BigInt(layout.bidInputIndexes.length) *
        BigInt(KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.bidOrder) *
        GRAMS_PER_COMPUTE_BUDGET_UNIT +
      BigInt(layout.holderInputIndexes.length) *
        BigInt(KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.holder) *
        GRAMS_PER_COMPUTE_BUDGET_UNIT +
      BigInt(layout.feeTicketInputIndex >= 0 ? 1 : 0) *
        BigInt(KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.feeTicket) *
        GRAMS_PER_COMPUTE_BUDGET_UNIT +
      BigInt(KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.funding) *
        GRAMS_PER_COMPUTE_BUDGET_UNIT
    );
  }

  function sweepAskReservedComputeMass(
    layout,
    feeTicketComputeBudget: number = KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE.feeTicket,
  ) {
    const effectiveFeeTicketComputeBudget = requirePositiveComputeBudget(
      feeTicketComputeBudget,
      "sweep ask FeeTicket compute budget",
    );
    return (
      BigInt(layout.askInputIndexes.length) *
        BigInt(KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE.askOrder) *
        GRAMS_PER_COMPUTE_BUDGET_UNIT +
      BigInt(layout.feeTicketInputIndex >= 0 ? 1 : 0) *
        BigInt(effectiveFeeTicketComputeBudget) *
        GRAMS_PER_COMPUTE_BUDGET_UNIT +
      BigInt(KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE.funding) *
        GRAMS_PER_COMPUTE_BUDGET_UNIT
    );
  }

  function assertSweepBidReservedComputeMassStandard(layout, label) {
    const reservedComputeMass = sweepBidReservedComputeMass(layout);
    if (reservedComputeMass > TOCCATA_MAX_STANDARD_TRANSACTION_MASS) {
      throw kcc20PsktBuilderError(
        `${label} reserved compute mass ${reservedComputeMass} exceeds standard transaction mass ${TOCCATA_MAX_STANDARD_TRANSACTION_MASS}`,
        "TRANSACTION_MASS_EXCEEDED",
        {
          reservedComputeMass,
          maximumStandardTransactionMass: TOCCATA_MAX_STANDARD_TRANSACTION_MASS,
        },
      );
    }
    return reservedComputeMass;
  }

  function assertSweepAskReservedComputeMassStandard(
    layout,
    label,
    feeTicketComputeBudget: number = KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE.feeTicket,
  ) {
    const reservedComputeMass = sweepAskReservedComputeMass(
      layout,
      feeTicketComputeBudget,
    );
    if (reservedComputeMass > TOCCATA_MAX_STANDARD_TRANSACTION_MASS) {
      throw kcc20PsktBuilderError(
        `${label} reserved compute mass ${reservedComputeMass} exceeds standard transaction mass ${TOCCATA_MAX_STANDARD_TRANSACTION_MASS}`,
        "TRANSACTION_MASS_EXCEEDED",
        {
          reservedComputeMass,
          maximumStandardTransactionMass: TOCCATA_MAX_STANDARD_TRANSACTION_MASS,
        },
      );
    }
    return reservedComputeMass;
  }

  function assertSweepBidComputeBudgetArtifactCompatibility(
    wrappedArtifact,
    feeTicketArtifact = null,
  ) {
    const wrappedArtifactHash = artifactScriptSha256(
      wrappedArtifact,
      "wrapped artifact",
    );
    if (
      !SWEEP_BID_CALIBRATED_WRAPPED_ARTIFACT_HASHES.has(wrappedArtifactHash)
    ) {
      throw kcc20PsktBuilderError(
        `sweep bid compute-budget profile is not calibrated for wrapped artifact ${wrappedArtifactHash}`,
        "COMPUTE_BUDGET_PROFILE_UNVERIFIED",
        {
          profile: KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.version,
          wrappedArtifactHash,
        },
      );
    }

    const feeTicketArtifactHash = feeTicketArtifact
      ? artifactScriptSha256(feeTicketArtifact, "FeeTicket artifact")
      : null;
    if (feeTicketArtifactHash) {
      if (
        !SWEEP_BID_CALIBRATED_FEE_TICKET_ARTIFACT_HASHES.has(
          feeTicketArtifactHash,
        )
      ) {
        throw kcc20PsktBuilderError(
          `sweep bid compute-budget profile is not calibrated for FeeTicket artifact ${feeTicketArtifactHash}`,
          "COMPUTE_BUDGET_PROFILE_UNVERIFIED",
          {
            profile: KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.version,
            feeTicketArtifactHash,
          },
        );
      }
    }

    return {
      profile: KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.version,
      wrappedArtifactHash,
      feeTicketArtifactHash,
    };
  }

  function assertSweepAskComputeBudgetArtifactCompatibility(
    wrappedArtifacts,
    feeTicketArtifact = null,
  ) {
    if (!Array.isArray(wrappedArtifacts) || wrappedArtifacts.length === 0) {
      throw new Error("sweep ask wrapped artifacts are required");
    }
    const wrappedArtifactHashes = [
      ...new Set(
        wrappedArtifacts.map((artifact, index) =>
          artifactScriptSha256(artifact, `wrapped artifact ${index}`),
        ),
      ),
    ];
    for (const wrappedArtifactHash of wrappedArtifactHashes) {
      if (
        !SWEEP_ASK_CALIBRATED_WRAPPED_ARTIFACT_HASHES.has(wrappedArtifactHash)
      ) {
        throw kcc20PsktBuilderError(
          `sweep ask compute-budget profile is not calibrated for wrapped artifact ${wrappedArtifactHash}`,
          "COMPUTE_BUDGET_PROFILE_UNVERIFIED",
          {
            profile: KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE.version,
            wrappedArtifactHash,
          },
        );
      }
    }

    const feeTicketArtifactHash = feeTicketArtifact
      ? artifactScriptSha256(feeTicketArtifact, "FeeTicket artifact")
      : null;
    const feeTicketComputeBudget = feeTicketArtifactHash
      ? SWEEP_ASK_FEE_TICKET_ARTIFACT_BUDGETS.get(feeTicketArtifactHash)
      : null;
    if (feeTicketArtifactHash && feeTicketComputeBudget === undefined) {
      throw kcc20PsktBuilderError(
        `sweep ask compute-budget profile is not calibrated for FeeTicket artifact ${feeTicketArtifactHash}`,
        "COMPUTE_BUDGET_PROFILE_UNVERIFIED",
        {
          profile: KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE.version,
          feeTicketArtifactHash,
        },
      );
    }

    return {
      profile: KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE.version,
      wrappedArtifactHashes,
      feeTicketArtifactHash,
      feeTicketComputeBudget,
    };
  }

  function requirePositiveComputeBudget(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`${label} must be a positive integer`);
    }
    return parsed;
  }

  function artifactScriptSha256(artifact, label) {
    if (
      !Array.isArray(artifact?.script) ||
      artifact.script.some(
        (byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff,
      )
    ) {
      throw new Error(`${label} script is invalid`);
    }
    return bytesToHex(sha256(Uint8Array.from(artifact.script)));
  }

  function assertUniqueSweepBidOutpoints(utxos, label) {
    const seen = new Set();
    for (const [index, utxo] of utxos.entries()) {
      const txid = requireHex32(
        utxo?.txidHex,
        `${label} outpoint ${index} txid`,
      );
      const vout = parseVout(utxo?.vout, `${label} outpoint ${index} vout`);
      const outpoint = `${txid}:${vout}`;
      if (seen.has(outpoint)) {
        throw kcc20PsktBuilderError(
          `${label} contains duplicate outpoint ${outpoint}`,
          "DUPLICATE_TRANSACTION_INPUT",
          { outpoint },
        );
      }
      seen.add(outpoint);
    }
  }

  function assertSweepAskLegIdentity({
    fill,
    askUtxo,
    askState,
    canonicalTokenId,
    index,
  }) {
    const projectedCanonicalTokenId =
      askUtxo?.state?.canonicalTokenId || askUtxo?.state?.tokenId;
    if (!projectedCanonicalTokenId) {
      throw new Error(`sweep leg ${index} is missing canonical token id`);
    }
    const askCanonicalTokenId = requireHex32(
      projectedCanonicalTokenId,
      `sweep leg ${index} canonical token id`,
    );
    if (askCanonicalTokenId !== canonicalTokenId) {
      throw new Error(
        `sweep leg ${index} canonical token does not match requested token`,
      );
    }
    if (bytesToHex(askState?.canonicalTokenId || []) !== askCanonicalTokenId) {
      throw new Error(
        `sweep leg ${index} decoded canonical token does not match projected state`,
      );
    }
    const askTxid = requireHex32(askUtxo?.txidHex, `ask ${index} txid`);
    const askVout = parseVout(askUtxo?.vout, `ask ${index} vout`);
    const expectedOrderId = `${askTxid}:${askVout}`;
    const quotedOrderId = requireOrderId(
      fill?.orderId,
      `sweep leg ${index} orderId`,
    );
    if (quotedOrderId !== expectedOrderId) {
      throw new Error(
        `sweep leg ${index} orderId does not match active ask UTXO`,
      );
    }
    return { askTxid, askVout };
  }

  function applySweepBidComputeBudgetProfile(transaction, layout) {
    return applySweepComputeBudgetAssignments({
      transaction,
      label: "sweep bid",
      inputCount: layout.inputCount,
      profile: KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE,
      assignments: [
        {
          indexes: layout.bidInputIndexes,
          role: "bid-order",
          budget: KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.bidOrder,
        },
        {
          indexes: layout.holderInputIndexes,
          role: "holder",
          budget: KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.holder,
        },
        ...(layout.feeTicketInputIndex >= 0
          ? [
              {
                indexes: [layout.feeTicketInputIndex],
                role: "fee-ticket",
                budget:
                  KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.feeTicket,
              },
            ]
          : []),
        {
          indexes: [layout.fundingInputIndex],
          role: "funding",
          budget: KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.funding,
        },
      ],
    });
  }

  function applySweepAskComputeBudgetProfile(
    transaction,
    layout,
    feeTicketComputeBudget: number = KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE.feeTicket,
  ) {
    const effectiveFeeTicketComputeBudget = requirePositiveComputeBudget(
      feeTicketComputeBudget,
      "sweep ask FeeTicket compute budget",
    );
    return applySweepComputeBudgetAssignments({
      transaction,
      label: "sweep ask",
      inputCount: layout.inputCount,
      profile: {
        ...KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE,
        feeTicket: effectiveFeeTicketComputeBudget,
      },
      assignments: [
        {
          indexes: layout.askInputIndexes,
          role: "ask-order",
          budget: KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE.askOrder,
        },
        ...(layout.feeTicketInputIndex >= 0
          ? [
              {
                indexes: [layout.feeTicketInputIndex],
                role: "fee-ticket",
                budget: effectiveFeeTicketComputeBudget,
              },
            ]
          : []),
        {
          indexes: [layout.fundingInputIndex],
          role: "funding",
          budget: KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE.funding,
        },
      ],
    });
  }

  function applySweepComputeBudgetAssignments({
    transaction,
    label,
    inputCount,
    profile,
    assignments: roleAssignments,
  }) {
    const inputs = transaction.inputs;
    if (!Array.isArray(inputs) || inputs.length !== inputCount) {
      throw new Error(
        `${label} compute-budget layout expected ${inputCount} inputs, got ${inputs?.length ?? 0}`,
      );
    }

    const assignments = new Map();
    const assign = (indexes, role, budget) => {
      for (const index of indexes) {
        if (!Number.isInteger(index) || index < 0 || index >= inputs.length) {
          throw new Error(`invalid ${role} input index ${index}`);
        }
        if (assignments.has(index)) {
          throw new Error(`${label} input ${index} has multiple budget roles`);
        }
        assignments.set(index, { role, budget });
      }
    };
    roleAssignments.forEach(({ indexes, role, budget }) =>
      assign(indexes, role, budget),
    );
    if (assignments.size !== inputs.length) {
      throw new Error(
        `${label} compute-budget layout leaves ${inputs.length - assignments.size} inputs unassigned`,
      );
    }

    for (const [index, assignment] of assignments) {
      inputs[index].sigOpCount = 0;
      inputs[index].computeBudget = assignment.budget;
    }
    transaction.inputs = inputs;

    return {
      ...profile,
      reservedComputeMass: (
        Array.from(assignments.values()).reduce(
          (sum, assignment) => sum + BigInt(assignment.budget),
          0n,
        ) * GRAMS_PER_COMPUTE_BUDGET_UNIT
      ).toString(),
    };
  }

  function assertTransactionComputeMassStandard(
    transaction,
    label,
    details = {},
  ) {
    const { transactionMass } = calculateToccataV1NonContextualMass(
      transaction,
      label,
    );
    const maximumStandardTransactionMass =
      TOCCATA_MAX_STANDARD_TRANSACTION_MASS;
    if (transactionMass > maximumStandardTransactionMass) {
      throw kcc20PsktBuilderError(
        `${label} mass ${transactionMass} exceeds standard transaction mass ${maximumStandardTransactionMass}`,
        "TRANSACTION_MASS_EXCEEDED",
        {
          ...details,
          transactionMass,
          maximumStandardTransactionMass,
        },
      );
    }
    return transactionMass;
  }

  function assertConsolidationMassTarget(transaction, label, inputCount) {
    const { transactionMass } = calculateToccataV1NonContextualMass(
      transaction,
      label,
    );
    const storageMass = calculateToccataStorageMass(transaction, label);
    const effectiveMass =
      transactionMass > storageMass ? transactionMass : storageMass;
    if (effectiveMass <= CONSOLIDATION_TARGET_TRANSACTION_MASS) {
      return effectiveMass;
    }
    throw kcc20PsktBuilderError(
      `${label} mass ${effectiveMass} exceeds target ${CONSOLIDATION_TARGET_TRANSACTION_MASS}`,
      "CONSOLIDATION_BATCH_MASS_TARGET_EXCEEDED",
      {
        inputCount,
        transactionMass,
        storageMass,
        targetTransactionMass: CONSOLIDATION_TARGET_TRANSACTION_MASS,
        maximumStandardTransactionMass: TOCCATA_MAX_STANDARD_TRANSACTION_MASS,
      },
    );
  }

  function calculateToccataV1NonContextualMass(transaction, label) {
    const serialized = transaction.serializeToSafeJSON();
    if (typeof serialized !== "string") {
      throw new Error(
        `${label} consensus-mass serialization did not return JSON text`,
      );
    }
    const json = JSON.parse(serialized);
    if (Number(json.version) !== 1) {
      throw new Error(`${label} consensus-mass calculation requires version 1`);
    }
    if (!Array.isArray(json.inputs) || !Array.isArray(json.outputs)) {
      throw new Error(`${label} consensus-mass transaction shape is invalid`);
    }

    // Mirrors rusty-kaspa consensus/core/src/mass/mod.rs for Toccata v1.
    let estimatedSerializedSize =
      2n + // version
      8n + // input count
      8n + // output count
      8n + // lock time
      20n + // subnetwork ID
      8n + // gas
      32n + // payload hash
      8n; // payload length
    let computeBudgetUnits = 0n;
    for (const [index, input] of json.inputs.entries()) {
      const signatureScriptBytes = safeJsonHexByteLength(
        input?.signatureScript ?? "",
        `${label} input ${index} signature script`,
      );
      const computeBudget = Number(input?.computeBudget);
      if (
        !Number.isInteger(computeBudget) ||
        computeBudget < 0 ||
        computeBudget > 0xffff
      ) {
        throw new Error(`${label} input ${index} compute budget must be a u16`);
      }
      estimatedSerializedSize +=
        32n + // previous transaction ID
        4n + // previous output index
        8n + // signature script length
        signatureScriptBytes +
        8n + // sequence
        2n; // compute budget
      computeBudgetUnits += BigInt(computeBudget);
    }

    let totalScriptPublicKeySize = 0n;
    for (const [index, output] of json.outputs.entries()) {
      const serializedScriptPublicKeyBytes = safeJsonHexByteLength(
        output?.scriptPublicKey,
        `${label} output ${index} script public key`,
      );
      if (serializedScriptPublicKeyBytes < 2n) {
        throw new Error(
          `${label} output ${index} script public key is missing its u16 version`,
        );
      }
      const scriptPublicKeyBytes = serializedScriptPublicKeyBytes - 2n;
      estimatedSerializedSize +=
        8n + // value
        2n + // script public key version
        8n + // script public key length
        scriptPublicKeyBytes +
        (output?.covenant ? 34n : 0n);
      totalScriptPublicKeySize += 2n + scriptPublicKeyBytes;
    }

    estimatedSerializedSize += safeJsonHexByteLength(
      json.payload ?? "",
      `${label} payload`,
    );
    const computeMass =
      estimatedSerializedSize * TOCCATA_MASS_PER_TX_BYTE +
      totalScriptPublicKeySize * TOCCATA_MASS_PER_SCRIPT_PUBLIC_KEY_BYTE +
      computeBudgetUnits * GRAMS_PER_COMPUTE_BUDGET_UNIT;
    const transientMass =
      estimatedSerializedSize * TOCCATA_TRANSIENT_BYTE_TO_MASS_FACTOR;
    const normalizedTransientMass =
      (transientMass +
        TOCCATA_POST_ACTIVATION_TRANSIENT_NORMALIZATION_DIVISOR -
        1n) /
      TOCCATA_POST_ACTIVATION_TRANSIENT_NORMALIZATION_DIVISOR;

    return {
      estimatedSerializedSize,
      computeBudgetUnits,
      computeMass,
      transientMass,
      normalizedTransientMass,
      transactionMass:
        computeMass > normalizedTransientMass
          ? computeMass
          : normalizedTransientMass,
    };
  }

  function safeJsonHexByteLength(value, label) {
    if (
      typeof value !== "string" ||
      value.length % 2 !== 0 ||
      !/^[0-9a-f]*$/i.test(value)
    ) {
      throw new Error(`${label} must be even-length hexadecimal`);
    }
    return BigInt(value.length / 2);
  }

  function applyDummyFeeTicketAndFundingSignatures(kw, predicted, details) {
    const dummySignature = dummySignatureBytes();
    if (details.sharedFeeTicket) {
      const ticketPrefix = buildFeeTicketBurnPrefix(
        kw,
        bytesToHex(dummySignature),
        details.sharedFeeTicket.burnDispatchTag,
        details.metadataFills?.[0]?.feeTicketRefundOutputIndex ?? -1,
        details.sharedFeeTicket.burnTakesRefundOutput,
      );
      predicted.inputs[details.feeTicketInputIndex].signatureScript =
        encodeCovenantP2shSignatureScript(
          ticketPrefix,
          details.sharedFeeTicket.script,
        );
    }
    predicted.inputs[details.fundingInputIndex].signatureScript =
      encodeP2pkSignatureScript(bytesToHex(dummySignature));
    return dummySignature;
  }

  function predictPairedHolderSweepBidSignedTransaction(kw, details) {
    const predicted = cloneTransactionForMassPreflight(
      kw,
      details.transaction,
      "paired-holder sweep bids",
    );
    const dummySignature = applyDummyFeeTicketAndFundingSignatures(
      kw,
      predicted,
      details,
    );
    details.legs.forEach((leg, index) => {
      const metadata = details.metadataFills[index];
      const holderPrefix = buildKcc20V3SellIntoBidSigScript(kw, {
        signature: dummySignature,
        buyerOwner: leg.bidState.ownerIdentifier,
        fillAmount: leg.fillAmount,
        buyerTokenOutputIndex: metadata.buyerTokenOutputIndex,
        sellerChangeOutputIndex: metadata.sellerChangeOutputIndex,
        sellerRefundOutputIndex: metadata.sellerHolderRefundOutputIndex,
        sellerOutputsEndIndex: metadata.sellerOutputsEndIndex,
        takesRefundOutput: wrappedArtifactRefundsHolderDeposits(
          leg.artifactInfo,
        ),
      });
      predicted.inputs[metadata.sellerInputIndex].signatureScript =
        encodeCovenantP2shSignatureScript(holderPrefix, leg.holderScript);
    });

    return predicted;
  }

  function predictSingleHolderSweepBidSignedTransaction(kw, details) {
    const predicted = cloneTransactionForMassPreflight(
      kw,
      details.transaction,
      "single-holder sweep bids",
    );
    const dummySignature = applyDummyFeeTicketAndFundingSignatures(
      kw,
      predicted,
      details,
    );
    const sellerLegs = details.legs.map((leg, index) => ({
      buyerOwner: leg.bidState.ownerIdentifier,
      fillAmount: leg.fillAmount,
      buyerTokenOutputIndex: details.metadataFills[index].buyerTokenOutputIndex,
    }));
    const sellerPrefix =
      details.selectedScriptLegCapacity > KCC20_ORDERBOOK_MAX_SWEEP_BID_LEGS
        ? buildKcc20OrderbookSellIntoBids10SigScript(kw, {
            signature: dummySignature,
            legs: sellerLegs,
            changeOutputIndex: details.sellerChangeOutputIndex,
            sellerRefundOutputIndex: details.sellerHolderRefundOutputIndex,
            sellerOutputsEndIndex: details.sellerOutputsEndIndex,
            takesRefundOutput: details.refundAware,
          })
        : buildKcc20OrderbookSellIntoBidsSigScript(kw, {
            signature: dummySignature,
            legs: sellerLegs,
            changeOutputIndex: details.sellerChangeOutputIndex,
            sellerRefundOutputIndex: details.sellerHolderRefundOutputIndex,
            sellerOutputsEndIndex: details.sellerOutputsEndIndex,
            takesRefundOutput: details.refundAware,
          });
    predicted.inputs[details.sellerInputIndex].signatureScript =
      encodeCovenantP2shSignatureScript(sellerPrefix, details.holderScript);

    return predicted;
  }

  function predictSweepAskSignedTransaction(kw, details) {
    const predicted = cloneTransactionForMassPreflight(
      kw,
      details.transaction,
      "sweep asks",
    );
    applyDummyFeeTicketAndFundingSignatures(kw, predicted, details);
    return predicted;
  }

  async function buildWrapperMarketDeployPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const { appCanonicalTokenId, contractCanonicalTokenId } =
      resolveWrapperMarketDeployTokenIds(params);
    const feeTicketId = requireHex32(
      params.feeTicketId || ZERO_HASH,
      "fee ticket id",
    );
    const deployerOwner = requireHex32(
      params.deployerOwner || request.owner?.kcc20Owner,
      "deployer owner",
    );
    const rootAmount = parseU64(
      params.wrappedRootAmount ?? "0",
      "wrappedRootAmount",
    );
    const priceScale = parsePositiveU64(
      params.priceScale ??
        params.tokenDisplayScale ??
        DEFAULT_KCC20_PRICE_SCALE,
      "priceScale",
    );
    assertWrapperArtifactPriceScale(priceScale);
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const amountTkas = parseAmountTkas(
      env.KCC20_WRAPPER_DEPLOY_OUTPUT_TKAS ||
        env.KCC20_DEPLOY_OUTPUT_TKAS ||
        DEFAULT_DEPLOY_TKAS,
      "KCC20_WRAPPER_DEPLOY_OUTPUT_TKAS",
    );
    const priorityFee = wrapperDeployPriorityFee(
      env.KCC20_WRAPPER_DEPLOY_PRIORITY_FEE_SOMPI,
    );
    const computeBudget = parsePositiveNumber(
      env.KCC20_WRAPPER_DEPLOY_COMPUTE_BUDGET || 600,
      "computeBudget",
    );

    const wrapperArtifact = await readStaticArtifact(WRAPPER_ARTIFACT_PATH);
    const wrappedArtifacts = await readWrappedArtifacts();
    const wrappedArtifact = wrappedArtifacts[0].artifact;
    const wrapperState = {
      canonicalTokenId: hexToBytes(contractCanonicalTokenId),
      enabled: true,
      priceScale,
      feeTicketId: hexToBytes(feeTicketId),
    };
    const wrappedRootState = {
      canonicalTokenId: hexToBytes(contractCanonicalTokenId),
      ownerIdentifier: hexToBytes(deployerOwner),
      identifierType: 0,
      amount: rootAmount,
      mode: 1,
      unitPriceSompi: 0n,
      feeTicketId: hexToBytes(feeTicketId),
      priceScale,
    };

    const kw = kaspaWasm;
    const {
      Encoding,
      GenesisCovenantGroup,
      RpcClient,
      Transaction,
      TransactionOutput,
      addressFromScriptPublicKey,
      covenantId,
      payToAddressScript,
      payToScriptHashScript,
    } = kw;

    const wrapperScript = buildKcc20WrapperScriptForState(
      wrapperArtifact.script,
      wrapperState,
    );
    const wrappedRootScript = buildKcc20OrderbookScriptForState(
      wrappedArtifact.script,
      wrappedRootState,
    );
    const wrapperAddress = addressFromScriptPublicKey(
      payToScriptHashScript(wrapperScript),
      network,
    ).toString();
    const wrappedRootAddress = addressFromScriptPublicKey(
      payToScriptHashScript(wrappedRootScript),
      network,
    ).toString();
    const deploySompi = BigInt(Math.round(amountTkas * Number(SOMPI_PER_TKAS)));

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const utxos = await getUtxosByAddresses(rpc, [walletAddress]);
      const fundingEntry = selectFundingEntry(
        utxos.entries,
        deploySompi * 2n + priorityFee + 10_000_000n,
      );
      const fundingChangeOutputIndex = 2;
      const change =
        utxoAmountSompi(fundingEntry) - deploySompi * 2n - priorityFee;
      if (change <= 10_000n) {
        throw kcc20PsktBuilderError(
          "wrapper market deploy PSKT builder selected insufficient change",
          "KAS_FUNDING_CHANGE_TOO_SMALL",
        );
      }

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
        ],
        outputs: [
          new TransactionOutput(
            deploySompi,
            payToScriptHashScript(wrapperScript),
          ),
          new TransactionOutput(
            deploySompi,
            payToScriptHashScript(wrappedRootScript),
          ),
          new TransactionOutput(change, payToAddressScript(walletAddress)),
        ],
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildWrapperMarketDeployPayload({
          canonicalTokenId: appCanonicalTokenId,
          feeTicketId,
          rootAmount,
          priceScale,
          stateOwner: deployerOwner,
        }),
      });
      unsignedTx.version = 1;
      setVersionOneInputMassFields(unsignedTx, computeBudget);

      const wrapperOutputIndex = findOutputIndex(
        unsignedTx,
        wrapperAddress,
        network,
        addressFromScriptPublicKey,
      );
      const wrappedRootOutputIndex = findOutputIndex(
        unsignedTx,
        wrappedRootAddress,
        network,
        addressFromScriptPublicKey,
      );
      if (wrapperOutputIndex < 0 || wrappedRootOutputIndex < 0) {
        throw new Error(
          "final transaction did not contain wrapper and wrapped-root outputs",
        );
      }
      unsignedTx.populateGenesisCovenants([
        new GenesisCovenantGroup(0, [
          wrapperOutputIndex,
          wrappedRootOutputIndex,
        ]),
      ]);
      unsignedTx.finalize();
      const wrapperMarketId =
        unsignedTx.outputs[
          wrapperOutputIndex
        ]?.covenant?.covenantId?.toString();
      if (!wrapperMarketId) {
        throw new Error(
          `failed to populate KCC20Wrapper covenant binding on output ${wrapperOutputIndex}`,
        );
      }
      const expectedWrapperMarketId = covenantId(fundingEntry.outpoint, [
        {
          index: wrapperOutputIndex,
          output: unsignedTx.outputs[wrapperOutputIndex],
        },
        {
          index: wrappedRootOutputIndex,
          output: unsignedTx.outputs[wrappedRootOutputIndex],
        },
      ]).toString();
      if (wrapperMarketId !== expectedWrapperMarketId) {
        throw new Error(
          `wrapper market deploy covenant binding mismatch: output covenant id ${wrapperMarketId} does not match final transaction genesis id ${expectedWrapperMarketId}`,
        );
      }

      const feeAdjustedTx = transactionWithCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
      );
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "wrapper market deploy PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: unsignedTx.inputs.map((_, index) => ({
          index,
          sighashType: 1,
        })),
        submitTransactionSupported: true,
        metadata: {
          builderKey: "kcc20wrapper.deploy-market",
          contract: "KCC20Wrapper",
          network,
          walletAddress,
          wrapperAddress,
          wrappedRootAddress,
          canonicalTokenId: appCanonicalTokenId,
          appCanonicalTokenId,
          contractCanonicalTokenId,
          feeTicketId,
          wrapperMarketId,
          covenantId: wrapperMarketId,
          wrapperOutputIndex,
          wrappedRootOutputIndex,
          rootOutputIndex: wrappedRootOutputIndex,
          wrappedRootAmount: rootAmount.toString(),
          priceScale: priceScale.toString(),
          tokenDisplayScale: priceScale.toString(),
          amountSompi: deploySompi.toString(),
          ownerIdentifier: deployerOwner,
          stateOwner: deployerOwner,
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  function wrapperDeployPriorityFee(configuredValue) {
    return parseU64(
      configuredValue || DEFAULT_WRAPPER_DEPLOY_PRIORITY_FEE.toString(),
      "priorityFee",
    );
  }

  function resolveWrapperMarketDeployTokenIds(params) {
    const appCanonicalTokenId = requireHex32(
      params.canonicalCovenantId ||
        params.appCanonicalCovenantId ||
        params.covenantId,
      "app canonical token id",
    );
    const contractCanonicalTokenId = requireHex32(
      params.contractCanonicalCovenantId || appCanonicalTokenId,
      "contract canonical token id",
    );
    return { appCanonicalTokenId, contractCanonicalTokenId };
  }

  function assertWrapperArtifactPriceScale(priceScale) {
    const requestedPriceScale = BigInt(priceScale);
    if (
      requestedPriceScale < 1n ||
      requestedPriceScale > DEFAULT_KCC20_PRICE_SCALE ||
      (requestedPriceScale.toString().length > 1 &&
        !/^10+$/.test(requestedPriceScale.toString()))
    ) {
      throw kcc20PsktBuilderError(
        `wrapper artifact supports KCC20 priceScale powers of ten from 1 through ${DEFAULT_KCC20_PRICE_SCALE}, got ${requestedPriceScale}`,
        "WRAPPER_ARTIFACT_PRICE_SCALE_UNAVAILABLE",
        {
          requestedPriceScale,
          supportedPriceScale: DEFAULT_KCC20_PRICE_SCALE,
          supportedDecimals: "0-8",
        },
      );
    }
    return requestedPriceScale;
  }

  function resolveExpectedHolderSpendCovenantId(params, canonicalTokenId) {
    return requireHex32(
      params.activeHolderNativeCovenantId || canonicalTokenId,
      "active holder native covenant id",
    );
  }

  async function buildWrapperWrapPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const holderUtxo = params.activeHolderUtxo;
    const wrapperUtxo = params.activeWrapperUtxo;
    if (!holderUtxo) {
      throw new Error("active KCC20 holder UTXO is required");
    }
    if (!wrapperUtxo) {
      throw new Error("active KCC20Wrapper UTXO is required");
    }

    const canonicalTokenId = requireHex32(
      params.canonicalCovenantId || params.covenantId,
      "canonical token id",
    );
    const appCanonicalTokenId = requireHex32(
      params.appCanonicalCovenantId || canonicalTokenId,
      "app canonical token id",
    );
    const expectedHolderSpendCovenantId = resolveExpectedHolderSpendCovenantId(
      params,
      canonicalTokenId,
    );
    const wrapperId = requireHex32(
      params.wrappedMarketId || params.wrapperId,
      "wrapped market id",
    );
    const recipientOwner = requireHex32(
      params.recipientOwner || request.owner?.kcc20Owner,
      "wrapped recipient owner",
    );
    const tokenAmount = parsePositiveU64(params.tokenAmount, "tokenAmount");
    const feeTicketId = requireHex32(
      params.feeTicketId || ZERO_HASH,
      "fee ticket id",
    );
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const tokenOutputSompi = parseU64(
      env.KCC20_WRAP_TOKEN_OUTPUT_SOMPI ||
        DEFAULT_TOKEN_OUTPUT_SOMPI.toString(),
      "tokenOutputSompi",
    );
    const priorityFee = parseU64(
      env.KCC20_WRAP_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const computeBudget = parsePositiveNumber(
      env.KCC20_WRAP_COMPUTE_BUDGET || 700,
      "computeBudget",
    );

    const [wrapperArtifacts, wrappedArtifacts] = await Promise.all([
      readWrapperArtifacts(),
      readWrappedArtifacts(),
    ]);
    const holderState = kcc20StateFromUtxo(holderUtxo, request.owner);
    if (holderState.identifierType !== 0) {
      throw new Error("wrap requires pubkey-owned KCC20 holder UTXO");
    }
    if (
      bytesToHex(holderState.ownerIdentifier) !==
      String(request.owner?.kcc20Owner || "").toLowerCase()
    ) {
      throw new Error("KCC20 holder UTXO is not owned by authenticated wallet");
    }
    assertKcc20HolderStateForWrap(holderState);
    if (holderState.amount < tokenAmount) {
      throw new Error("tokenAmount exceeds KCC20 holder balance");
    }
    const kcc20ArtifactInfo = await resolveKcc20ArtifactForState(
      holderState,
      requireKaspaAddress(holderUtxo.address),
      network,
    );
    const kcc20Artifact = kcc20ArtifactInfo.artifact;
    const remaining = holderState.amount - tokenAmount;
    const priceScale = parsePositiveU64(
      wrapperUtxo.state?.priceScale ??
        wrapperUtxo.state?.tokenDisplayScale ??
        params.priceScale ??
        params.tokenDisplayScale ??
        DEFAULT_KCC20_PRICE_SCALE,
      "priceScale",
    );
    const wrapperState = {
      canonicalTokenId: hexToBytes(canonicalTokenId),
      enabled: wrapperUtxo.state?.enabled !== false,
      priceScale,
    };
    const wrappedHolderState = {
      canonicalTokenId: hexToBytes(canonicalTokenId),
      ownerIdentifier: hexToBytes(recipientOwner),
      ownerScheme: 0,
      identifierType: 0,
      amount: tokenAmount,
      mode: 0,
      unitPriceSompi: 0n,
      feeTicketId: hexToBytes(feeTicketId),
      priceScale,
    };

    const kw = kaspaWasm;
    const {
      CovenantBinding,
      Encoding,
      Hash,
      RpcClient,
      ScriptBuilder,
      Transaction,
      TransactionOutput,
      payToAddressScript,
      payToScriptHashScript,
    } = kw;

    const wrapperArtifactInfo = selectWrapperArtifactForUtxo({
      kw,
      artifacts: wrapperArtifacts,
      state: wrapperState,
      utxo: wrapperUtxo,
      network,
      label: "active wrapper UTXO address",
    });
    const wrappedArtifactInfo = wrappedArtifacts.find(
      (info) => info.version === wrapperArtifactInfo.version,
    );
    if (!wrappedArtifactInfo) {
      throw new Error(
        `wrapped artifact ${wrapperArtifactInfo.version} required by wrapper is unavailable`,
      );
    }
    const wrapperArtifact = wrapperArtifactInfo.artifact;
    const wrappedArtifact = wrappedArtifactInfo.artifact;
    const wrapperScript = wrapperArtifactInfo.script;
    const holderScript = buildNativeKcc20ScriptForState(
      kcc20Artifact.script,
      holderState,
    );
    const wrapperAddress = requireKaspaAddress(wrapperUtxo.address);
    const holderAddress = requireKaspaAddress(holderUtxo.address);
    assertScriptAddress(
      kw,
      holderScript,
      holderAddress,
      network,
      "KCC20 holder UTXO address",
    );

    const wrapperTxid = requireHex32(wrapperUtxo.txidHex, "wrapper txid");
    const wrapperVout = parseVout(wrapperUtxo.vout, "wrapper vout");
    const holderTxid = requireHex32(holderUtxo.txidHex, "holder txid");
    const holderVout = parseVout(holderUtxo.vout, "holder vout");

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [initialCovenantUtxos, walletUtxos] = await Promise.all([
        getUtxosByAddresses(rpc, [...new Set([wrapperAddress, holderAddress])]),
        getUtxosByAddresses(rpc, [walletAddress]),
      ]);
      let covenantUtxos = initialCovenantUtxos;
      let wrapperEntry = findUtxoEntry(
        covenantUtxos.entries,
        wrapperTxid,
        wrapperVout,
      );
      let holderEntry = findUtxoEntry(
        covenantUtxos.entries,
        holderTxid,
        holderVout,
      );
      if (!wrapperEntry || !holderEntry) {
        covenantUtxos = await retryUtxosByAddresses(
          rpc,
          [...new Set([wrapperAddress, holderAddress])],
          (entries) =>
            Boolean(
              findUtxoEntry(entries, wrapperTxid, wrapperVout) &&
              findUtxoEntry(entries, holderTxid, holderVout),
            ),
          covenantUtxos,
        );
        wrapperEntry = findUtxoEntry(
          covenantUtxos.entries,
          wrapperTxid,
          wrapperVout,
        );
        holderEntry = findUtxoEntry(
          covenantUtxos.entries,
          holderTxid,
          holderVout,
        );
      }
      if (!wrapperEntry) {
        throw new Error(
          `active wrapper UTXO ${wrapperTxid}:${wrapperVout} not found`,
        );
      }
      if (!holderEntry) {
        throw new Error(
          `KCC20 holder UTXO ${holderTxid}:${holderVout} not found`,
        );
      }
      const wrapperSpendCovenantId =
        covenantIdFromUtxoEntry(wrapperEntry) ?? wrapperId;
      const holderSpendCovenantId =
        covenantIdFromUtxoEntry(holderEntry) ?? canonicalTokenId;
      if (holderSpendCovenantId !== expectedHolderSpendCovenantId) {
        throw new Error(
          `active KCC20 holder UTXO covenant id ${holderSpendCovenantId} does not match expected holder native covenant id ${expectedHolderSpendCovenantId}`,
        );
      }
      const lockedTokenState = {
        ...holderState,
        owner: hexToBytes(wrapperSpendCovenantId),
        ownerIdentifier: hexToBytes(wrapperSpendCovenantId),
        ownerScheme: 4,
        identifierType: 4,
        borrowScheme: 0,
        borrowGuard: hexToBytes(ZERO_HASH),
        amount: tokenAmount,
      };
      const holderChangeState =
        remaining > 0n ? { ...holderState, amount: remaining } : null;

      const wrappedHolderOutputIndex = 0;
      const wrapperOutputIndex = 1;
      const lockedTokenOutputIndex = 2;
      const outputs = [
        wrappedTokenOutput(
          kw,
          wrappedArtifact,
          wrappedHolderState,
          tokenOutputSompi,
          wrapperSpendCovenantId,
          0,
        ),
        new TransactionOutput(
          utxoAmountSompi(wrapperEntry),
          payToScriptHashScript(wrapperScript),
          new CovenantBinding(0, new Hash(wrapperSpendCovenantId)),
        ),
        tokenOutput(
          kw,
          kcc20Artifact,
          lockedTokenState,
          tokenOutputSompi,
          holderSpendCovenantId,
          1,
        ),
      ];
      let holderChangeOutputIndex = -1;
      if (holderChangeState) {
        holderChangeOutputIndex = outputs.length;
        outputs.push(
          tokenOutput(
            kw,
            kcc20Artifact,
            holderChangeState,
            utxoAmountSompi(holderEntry),
            holderSpendCovenantId,
            1,
          ),
        );
      }

      let outputSompi =
        utxoAmountSompi(wrapperEntry) + tokenOutputSompi + tokenOutputSompi;
      if (holderChangeState) {
        outputSompi += utxoAmountSompi(holderEntry);
      }
      const covenantInputSompi =
        utxoAmountSompi(wrapperEntry) + utxoAmountSompi(holderEntry);
      const requiredFunding =
        outputSompi + priorityFee > covenantInputSompi
          ? outputSompi + priorityFee - covenantInputSompi + 10_000n
          : priorityFee + 10_000n;
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        requiredFunding,
      );
      const fundingInputIndex = 2;
      const change =
        covenantInputSompi +
        utxoAmountSompi(fundingEntry) -
        outputSompi -
        priorityFee;
      let fundingChangeOutputIndex = -1;
      if (change > 10_000n) {
        fundingChangeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(change, payToAddressScript(walletAddress)),
        );
      }

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          {
            previousOutpoint: wrapperEntry.outpoint,
            utxo: wrapperEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          {
            previousOutpoint: holderEntry.outpoint,
            utxo: holderEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildWrapperWrapPayload({
          canonicalTokenId,
          wrapperId: wrapperSpendCovenantId,
          recipientOwner,
          tokenAmount,
        }),
      });
      setVersionOneInputMassFields(unsignedTx, computeBudget);
      unsignedTx.inputs[2].computeBudget = 30;

      const wrapperPrefix = buildWrapPrefix(kw, kcc20Artifact, {
        state: wrapperState,
        tokenInputIndex: 1,
        tokenLockedOutputIndex: lockedTokenOutputIndex,
        orderbookHolderOutputIndex: wrappedHolderOutputIndex,
        wrapperOutputIndex,
        wrappedRecipient: hexToBytes(recipientOwner),
        wrappedRecipientScheme: 0,
        tokenAmount,
        lockedTokenState,
        wrappedHolderState,
        wrappedArtifact,
        wrapperArtifact,
      });
      unsignedTx.inputs[0].signatureScript = encodeCovenantP2shSignatureScript(
        wrapperPrefix,
        wrapperScript,
      );

      const scripts = [
        {
          inputIndex: 1,
          scriptHex: bytesToHex(holderScript),
          signType: 1,
          signatureScript: {
            mode: "ordered-args",
            args: kcc20TransferOrderedArgs(
              kcc20Artifact,
              holderChangeState
                ? [lockedTokenState, holderChangeState]
                : [lockedTokenState],
            ),
          },
        },
      ];
      const feeAdjustedTx = transactionWithCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        scripts,
      );
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "wrapper wrap PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        scripts,
        submitTransactionSupported: true,
        metadata: {
          builderKey: "kcc20wrapper.wrap",
          contract: "KCC20Wrapper",
          network,
          walletAddress,
          canonicalTokenId,
          appCanonicalTokenId,
          wrapperId: wrapperSpendCovenantId,
          requestedWrapperId: wrapperId,
          covenantId: wrapperSpendCovenantId,
          feeTicketId,
          holderOutpoint: `${holderTxid}:${holderVout}`,
          wrapperOutpoint: `${wrapperTxid}:${wrapperVout}`,
          wrappedHolderOutputIndex,
          wrapperOutputIndex,
          lockedTokenOutputIndex,
          holderChangeOutputIndex,
          tokenAmount: tokenAmount.toString(),
          remainingTokenAmount: remaining.toString(),
          wrappedRecipient: recipientOwner,
          wrappedArtifactVersion: wrappedArtifactInfo.version,
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildWrapperUnwrapPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const wrappedUtxo = params.activeWrappedHolderUtxo;
    const reserveUtxo = params.activeReserveUtxo;
    const wrapperUtxo = params.activeWrapperUtxo;
    if (!wrappedUtxo) {
      throw new Error("active KCC20 orderbook holder UTXO is required");
    }
    if (!reserveUtxo) {
      throw new Error("active KCC20 wrapper reserve UTXO is required");
    }
    if (!wrapperUtxo) {
      throw new Error("active KCC20Wrapper UTXO is required");
    }

    const canonicalTokenId = requireHex32(
      params.canonicalCovenantId || params.covenantId,
      "canonical token id",
    );
    const wrapperId = requireHex32(
      params.wrappedMarketId || params.wrapperId,
      "wrapped market id",
    );
    const recipientOwner = requireHex32(
      params.recipientOwner || request.owner?.kcc20Owner,
      "KCC20 recipient owner",
    );
    const tokenAmount = parsePositiveU64(params.tokenAmount, "tokenAmount");
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const tokenOutputSompi = parseU64(
      env.KCC20_UNWRAP_TOKEN_OUTPUT_SOMPI ||
        DEFAULT_TOKEN_OUTPUT_SOMPI.toString(),
      "tokenOutputSompi",
    );
    const priorityFee = parseU64(
      env.KCC20_UNWRAP_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const computeBudget = parsePositiveNumber(
      env.KCC20_UNWRAP_COMPUTE_BUDGET || 700,
      "computeBudget",
    );

    const [wrapperArtifacts, wrappedArtifacts] = await Promise.all([
      readWrapperArtifacts(),
      readWrappedArtifacts(),
    ]);
    const reserveState = kcc20StateFromUtxo(reserveUtxo, request.owner);
    if (reserveState.ownerScheme !== 4 || reserveState.isMintAuthority) {
      throw new Error("KCC20 reserve UTXO must be covenant-owned holder state");
    }
    if (reserveState.amount < tokenAmount) {
      throw new Error("tokenAmount exceeds KCC20 reserve balance");
    }
    const kcc20ArtifactInfo = await resolveKcc20ArtifactForState(
      reserveState,
      requireKaspaAddress(reserveUtxo.address),
      network,
    );
    const kcc20Artifact = kcc20ArtifactInfo.artifact;
    const wrappedState = kcc20V3WrappedStateFromUtxo(
      wrappedUtxo,
      canonicalTokenId,
      request.owner,
    );
    if (bytesToHex(wrappedState.ownerIdentifier) !== recipientOwner) {
      throw new Error(
        "KCC20 orderbook holder UTXO is not owned by authenticated wallet",
      );
    }
    if (wrappedState.mode !== 0) {
      throw new Error("unwrap requires a wrapped holder UTXO");
    }
    if (wrappedState.amount < tokenAmount) {
      throw new Error("tokenAmount exceeds wrapped holder balance");
    }

    const reserveRemaining = reserveState.amount - tokenAmount;
    const wrappedRemaining = wrappedState.amount - tokenAmount;
    const tokenRecipientState = {
      ...reserveState,
      owner: hexToBytes(recipientOwner),
      ownerIdentifier: hexToBytes(recipientOwner),
      ownerScheme: 0,
      identifierType: 0,
      amount: tokenAmount,
    };
    const reserveChangeState =
      reserveRemaining > 0n
        ? { ...reserveState, amount: reserveRemaining }
        : { ...reserveState, amount: 0n };
    const wrappedChangeState =
      wrappedRemaining > 0n
        ? {
            ...wrappedState,
            amount: wrappedRemaining,
            mode: 0,
            unitPriceSompi: 0n,
          }
        : { ...wrappedState, amount: 0n, mode: 0, unitPriceSompi: 0n };
    const wrapperState = {
      canonicalTokenId: hexToBytes(canonicalTokenId),
      enabled: wrapperUtxo.state?.enabled !== false,
      priceScale: parsePositiveU64(
        wrapperUtxo.state?.priceScale ??
          wrapperUtxo.state?.tokenDisplayScale ??
          wrappedState.priceScale ??
          DEFAULT_KCC20_PRICE_SCALE,
        "priceScale",
      ),
    };

    const kw = kaspaWasm;
    const {
      CovenantBinding,
      Encoding,
      Hash,
      RpcClient,
      ScriptBuilder,
      Transaction,
      TransactionOutput,
      payToAddressScript,
      payToScriptHashScript,
    } = kw;

    const wrapperArtifactInfo = selectWrapperArtifactForUtxo({
      kw,
      artifacts: wrapperArtifacts,
      state: wrapperState,
      utxo: wrapperUtxo,
      network,
      label: "active wrapper UTXO address",
    });
    const wrappedArtifactInfo = selectWrappedArtifactForUtxo({
      kw,
      artifacts: wrappedArtifacts,
      state: wrappedState,
      utxo: wrappedUtxo,
      network,
      label: "KCC20 orderbook holder UTXO address",
    });
    if (wrapperArtifactInfo.version !== wrappedArtifactInfo.version) {
      throw new Error(
        `wrapper artifact ${wrapperArtifactInfo.version} is incompatible with wrapped holder artifact ${wrappedArtifactInfo.version}`,
      );
    }
    const wrapperArtifact = wrapperArtifactInfo.artifact;
    const wrappedArtifact = wrappedArtifactInfo.artifact;
    const wrapperScript = wrapperArtifactInfo.script;
    const wrappedScript = wrappedArtifactInfo.script;
    const refundAware =
      wrappedArtifactRefundsHolderDeposits(wrappedArtifactInfo);
    const reserveScript = buildNativeKcc20ScriptForState(
      kcc20Artifact.script,
      reserveState,
    );
    const wrapperAddress = wrapperArtifactInfo.address;
    const wrappedAddress = wrappedArtifactInfo.address;
    const reserveAddress = requireKaspaAddress(reserveUtxo.address);
    assertScriptAddress(
      kw,
      reserveScript,
      reserveAddress,
      network,
      "KCC20 reserve UTXO address",
    );

    const wrapperTxid = requireHex32(wrapperUtxo.txidHex, "wrapper txid");
    const wrapperVout = parseVout(wrapperUtxo.vout, "wrapper vout");
    const wrappedTxid = requireHex32(wrappedUtxo.txidHex, "wrapped txid");
    const wrappedVout = parseVout(wrappedUtxo.vout, "wrapped vout");
    const reserveTxid = requireHex32(reserveUtxo.txidHex, "reserve txid");
    const reserveVout = parseVout(reserveUtxo.vout, "reserve vout");

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [covenantUtxos, walletUtxos] = await Promise.all([
        getUtxosByAddresses(rpc, [
          ...new Set([wrapperAddress, wrappedAddress, reserveAddress]),
        ]),
        getUtxosByAddresses(rpc, [walletAddress]),
      ]);
      const wrapperEntry = findUtxoEntry(
        covenantUtxos.entries,
        wrapperTxid,
        wrapperVout,
      );
      if (!wrapperEntry) {
        throw new Error(
          `active wrapper UTXO ${wrapperTxid}:${wrapperVout} not found`,
        );
      }
      const wrappedEntry = findUtxoEntry(
        covenantUtxos.entries,
        wrappedTxid,
        wrappedVout,
      );
      if (!wrappedEntry) {
        throw new Error(
          `KCC20 orderbook holder UTXO ${wrappedTxid}:${wrappedVout} not found`,
        );
      }
      const reserveEntry = findUtxoEntry(
        covenantUtxos.entries,
        reserveTxid,
        reserveVout,
      );
      if (!reserveEntry) {
        throw new Error(
          `KCC20 reserve UTXO ${reserveTxid}:${reserveVout} not found`,
        );
      }
      const wrapperSpendCovenantId =
        covenantIdFromUtxoEntry(wrapperEntry) ?? wrapperId;
      const wrappedSpendCovenantId =
        covenantIdFromUtxoEntry(wrappedEntry) ?? wrapperId;
      const reserveSpendCovenantId =
        covenantIdFromUtxoEntry(reserveEntry) ?? canonicalTokenId;
      if (bytesToHex(reserveState.ownerIdentifier) !== wrapperSpendCovenantId) {
        throw new Error("KCC20 reserve UTXO is not owned by wrapper covenant");
      }

      const tokenRecipientOutputIndex = 0;
      const tokenRecipientValue =
        reserveRemaining > 0n
          ? tokenOutputSompi
          : utxoAmountSompi(reserveEntry);
      const outputs = [
        tokenOutput(
          kw,
          kcc20Artifact,
          tokenRecipientState,
          tokenRecipientValue,
          reserveSpendCovenantId,
          2,
        ),
      ];

      let tokenReserveChangeOutputIndex = -1;
      if (reserveRemaining > 0n) {
        tokenReserveChangeOutputIndex = outputs.length;
        outputs.push(
          tokenOutput(
            kw,
            kcc20Artifact,
            reserveChangeState,
            utxoAmountSompi(reserveEntry),
            reserveSpendCovenantId,
            2,
          ),
        );
      }

      let wrappedChangeOutputIndex = -1;
      if (wrappedRemaining > 0n) {
        wrappedChangeOutputIndex = outputs.length;
        outputs.push(
          wrappedTokenOutput(
            kw,
            wrappedArtifact,
            wrappedChangeState,
            refundAware ? utxoAmountSompi(wrappedEntry) : tokenOutputSompi,
            wrappedSpendCovenantId,
            1,
          ),
        );
      }

      let wrappedHolderRefundOutputIndex = -1;
      const wrappedHolderRefundSompi =
        refundAware && wrappedRemaining === 0n
          ? utxoAmountSompi(wrappedEntry)
          : 0n;
      if (wrappedHolderRefundSompi > 0n) {
        wrappedHolderRefundOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(
            wrappedHolderRefundSompi,
            p2pkScriptPubKey(kw, recipientOwner),
          ),
        );
      }

      const wrapperOutputIndex = outputs.length;
      outputs.push(
        new TransactionOutput(
          utxoAmountSompi(wrapperEntry),
          payToScriptHashScript(wrapperScript),
          new CovenantBinding(0, new Hash(wrapperSpendCovenantId)),
        ),
      );

      const outputSompi = outputs.reduce(
        (sum, output) => sum + BigInt(output.value),
        0n,
      );
      const covenantInputSompi =
        utxoAmountSompi(wrapperEntry) +
        utxoAmountSompi(wrappedEntry) +
        utxoAmountSompi(reserveEntry);
      const requiredFunding =
        outputSompi + priorityFee > covenantInputSompi
          ? outputSompi + priorityFee - covenantInputSompi + 10_000n
          : priorityFee + 10_000n;
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        requiredFunding,
      );
      const fundingInputIndex = 3;
      const change =
        covenantInputSompi +
        utxoAmountSompi(fundingEntry) -
        outputSompi -
        priorityFee;
      let fundingChangeOutputIndex = -1;
      if (change > 10_000n) {
        fundingChangeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(change, payToAddressScript(walletAddress)),
        );
      }

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          {
            previousOutpoint: wrapperEntry.outpoint,
            utxo: wrapperEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          {
            previousOutpoint: wrappedEntry.outpoint,
            utxo: wrappedEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          {
            previousOutpoint: reserveEntry.outpoint,
            utxo: reserveEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildWrapperUnwrapPayload({
          canonicalTokenId,
          wrapperId: wrapperSpendCovenantId,
          recipientOwner,
          tokenAmount,
        }),
      });
      setVersionOneInputMassFields(unsignedTx, computeBudget);
      unsignedTx.inputs[3].computeBudget = 30;

      const wrapperPrefix = buildWrapperUnwrapPrefix(kw, kcc20Artifact, {
        state: wrapperState,
        wrappedInputIndex: 1,
        tokenReserveInputIndex: 2,
        tokenRecipientOutputIndex,
        tokenReserveChangeOutputIndex,
        wrappedChangeOutputIndex,
        wrapperOutputIndex,
        tokenRecipient: hexToBytes(recipientOwner),
        tokenRecipientScheme: 0,
        tokenAmount,
        tokenRecipientState,
        reserveChangeState,
        wrappedChangeState,
        wrappedArtifact,
        wrapperArtifact,
      });
      unsignedTx.inputs[0].signatureScript = encodeCovenantP2shSignatureScript(
        wrapperPrefix,
        wrapperScript,
      );
      const reservePrefix = buildKcc20TransferSigScript(kw, kcc20Artifact, {
        nextStates:
          reserveRemaining > 0n
            ? [tokenRecipientState, reserveChangeState]
            : [tokenRecipientState],
        witness: Uint8Array.of(0),
      });
      unsignedTx.inputs[2].signatureScript = encodeCovenantP2shSignatureScript(
        reservePrefix,
        reserveScript,
      );

      const scripts = [
        {
          inputIndex: 1,
          scriptHex: bytesToHex(wrappedScript),
          signType: 1,
          signatureScript: {
            mode: "signature-first-args",
            args: [
              { type: "i64", value: "0" },
              { type: "i64", value: tokenAmount.toString() },
              { type: "i64", value: String(wrappedChangeOutputIndex) },
              ...(refundAware
                ? [
                    {
                      type: "i64",
                      value: String(wrappedHolderRefundOutputIndex),
                    },
                  ]
                : []),
              dispatchTagTemplateArg(wrappedArtifact, "unwrapByOwnerSig"),
            ],
          },
        },
      ];
      const feeAdjustedTx = transactionWithCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        scripts,
      );
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "wrapper unwrap PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        scripts,
        submitTransactionSupported: true,
        metadata: {
          builderKey: "kcc20wrapper.unwrap",
          contract: "KCC20Wrapper",
          network,
          walletAddress,
          canonicalTokenId,
          wrapperId: wrapperSpendCovenantId,
          requestedWrapperId: wrapperId,
          covenantId: wrapperSpendCovenantId,
          wrappedOutpoint: `${wrappedTxid}:${wrappedVout}`,
          reserveOutpoint: `${reserveTxid}:${reserveVout}`,
          wrapperOutpoint: `${wrapperTxid}:${wrapperVout}`,
          tokenRecipientOutputIndex,
          tokenReserveChangeOutputIndex,
          wrappedChangeOutputIndex,
          wrappedHolderRefundOutputIndex,
          wrappedHolderRefundSompi: wrappedHolderRefundSompi.toString(),
          wrapperOutputIndex,
          tokenAmount: tokenAmount.toString(),
          reserveRemainingAmount: reserveRemaining.toString(),
          wrappedRemainingAmount: wrappedRemaining.toString(),
          recipientOwner,
          wrappedArtifactVersion: wrappedArtifactInfo.version,
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildWrappedOrderPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const builderKey = request.builderKey;
    const isBid = builderKey === "kcc20orderbook.create-bid";
    const rootUtxo = params.activeWrappedRootUtxo;
    const holderUtxo = params.activeWrappedHolderUtxo;
    if (isBid && !rootUtxo) {
      throw new Error("active KCC20 orderbook root UTXO is required");
    }
    if (!isBid && !holderUtxo) {
      throw new Error("active KCC20 orderbook holder UTXO is required");
    }

    const canonicalTokenId = requireHex32(
      params.canonicalCovenantId || params.covenantId,
      "canonical token id",
    );
    const wrapperId = requireHex32(
      params.wrappedMarketId || params.wrapperId,
      "wrapped market id",
    );
    const owner = requireHex32(
      params.orderOwner || request.owner?.kcc20Owner,
      "order owner",
    );
    const tokenAmount = parsePositiveU64(params.tokenAmount, "tokenAmount");
    const unitPriceSompi = parsePositiveU64(
      params.unitPriceSompi,
      "unitPriceSompi",
    );
    const expectedFeeTicketId = params.feeTicketId
      ? requireHex32(params.feeTicketId, "fee ticket id")
      : null;
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const tokenOutputSompi = parseU64(
      env.KCC20_ORDER_TOKEN_OUTPUT_SOMPI ||
        DEFAULT_TOKEN_OUTPUT_SOMPI.toString(),
      "tokenOutputSompi",
    );
    const priorityFee = parseU64(
      env.KCC20_ORDER_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const computeBudget = parsePositiveNumber(
      env.KCC20_ORDER_COMPUTE_BUDGET || 700,
      "computeBudget",
    );

    const wrappedArtifacts = await readWrappedArtifacts();
    const activeUtxo = isBid ? rootUtxo : holderUtxo;
    const activeState = kcc20V3WrappedStateFromUtxo(
      activeUtxo,
      canonicalTokenId,
      request.owner,
    );
    const activeFeeTicketId = bytesToHex(activeState.feeTicketId);
    if (expectedFeeTicketId && expectedFeeTicketId !== activeFeeTicketId) {
      throw new Error("requested FeeTicket root does not match wrapped market");
    }
    const grossSompi = exactGrossSompi(
      tokenAmount,
      unitPriceSompi,
      activeState.priceScale,
    );
    if (grossSompi < MIN_FILL_GROSS_SOMPI) {
      throw minimumFillGrossError(
        "order gross value is below KCC20Orderbook minimum fill value",
      );
    }

    if (isBid) {
      if (activeState.mode !== 1) {
        throw new Error("create bid requires a wrapped root UTXO");
      }
    } else {
      if (activeState.mode !== 0) {
        throw new Error("create ask requires a wrapped holder UTXO");
      }
      if (bytesToHex(activeState.ownerIdentifier) !== owner) {
        throw new Error(
          "KCC20 orderbook holder UTXO is not owned by authenticated wallet",
        );
      }
      if (activeState.amount < tokenAmount) {
        throw new Error("tokenAmount exceeds wrapped holder balance");
      }
    }

    const orderState = {
      ...activeState,
      ownerIdentifier: hexToBytes(owner),
      amount: tokenAmount,
      mode: isBid ? 3 : 2,
      unitPriceSompi,
    };
    const remainingHolder =
      !isBid && activeState.amount > tokenAmount
        ? {
            ...activeState,
            amount: activeState.amount - tokenAmount,
            mode: 0,
            unitPriceSompi: 0n,
          }
        : null;

    const kw = kaspaWasm;
    const {
      CovenantBinding,
      Encoding,
      Hash,
      RpcClient,
      ScriptBuilder,
      Transaction,
      TransactionOutput,
      payToAddressScript,
      payToScriptHashScript,
    } = kw;

    const activeAddress = requireKaspaAddress(activeUtxo.address);
    const activeArtifactInfo = selectWrappedArtifactForUtxo({
      kw,
      artifacts: wrappedArtifacts,
      state: activeState,
      utxo: activeUtxo,
      network,
      label: isBid
        ? "KCC20 orderbook root UTXO address"
        : "KCC20 orderbook holder UTXO address",
    });
    const wrappedArtifact = activeArtifactInfo.artifact;
    const activeScript = activeArtifactInfo.script;
    const refundAware =
      wrappedArtifactRefundsHolderDeposits(activeArtifactInfo);
    const bidDepositSompi = refundAware
      ? KCC20_ORDERBOOK_EXPANDED_SWEEP_OUTPUT_SOMPI
      : 0n;

    const activeTxid = requireHex32(activeUtxo.txidHex, "wrapped txid");
    const activeVout = parseVout(activeUtxo.vout, "wrapped vout");

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [activeUtxos, walletUtxos] = await Promise.all([
        getUtxosByAddresses(rpc, [activeAddress]),
        getUtxosByAddresses(rpc, [walletAddress]),
      ]);
      const activeEntry = findUtxoEntry(
        activeUtxos.entries,
        activeTxid,
        activeVout,
      );
      if (!activeEntry) {
        throw new Error(
          `active wrapped UTXO ${activeTxid}:${activeVout} not found`,
        );
      }
      const activeSpendCovenantId =
        covenantIdFromUtxoEntry(activeEntry) ?? wrapperId;

      const orderOutputIndex = 0;
      const outputs = [
        wrappedTokenOutput(
          kw,
          wrappedArtifact,
          orderState,
          isBid
            ? grossSompi + bidDepositSompi
            : refundAware
              ? utxoAmountSompi(activeEntry)
              : tokenOutputSompi,
          activeSpendCovenantId,
          0,
        ),
      ];

      let rootOutputIndex = -1;
      let holderChangeOutputIndex = -1;
      if (isBid) {
        rootOutputIndex = outputs.length;
        outputs.push(
          wrappedTokenOutput(
            kw,
            wrappedArtifact,
            activeState,
            utxoAmountSompi(activeEntry),
            activeSpendCovenantId,
            0,
          ),
        );
      } else if (remainingHolder) {
        holderChangeOutputIndex = outputs.length;
        outputs.push(
          wrappedTokenOutput(
            kw,
            wrappedArtifact,
            remainingHolder,
            tokenOutputSompi,
            activeSpendCovenantId,
            0,
          ),
        );
      }

      const outputSompi = outputs.reduce(
        (sum, output) => sum + BigInt(output.value),
        0n,
      );
      const covenantInputSompi = utxoAmountSompi(activeEntry);
      const requiredFunding =
        outputSompi + priorityFee > covenantInputSompi
          ? outputSompi + priorityFee - covenantInputSompi + 10_000n
          : priorityFee + 10_000n;
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        requiredFunding,
      );
      const fundingInputIndex = 1;
      const change =
        covenantInputSompi +
        utxoAmountSompi(fundingEntry) -
        outputSompi -
        priorityFee;
      let fundingChangeOutputIndex = -1;
      if (change > 10_000n) {
        fundingChangeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(change, payToAddressScript(walletAddress)),
        );
      }

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          {
            previousOutpoint: activeEntry.outpoint,
            utxo: activeEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildWrappedOrderPayload({
          canonicalTokenId,
          wrapperId: activeSpendCovenantId,
          owner,
          side: isBid ? "buy" : "sell",
          tokenAmount,
          unitPriceSompi,
          feeTicketId: activeFeeTicketId,
        }),
      });
      setVersionOneInputMassFields(unsignedTx, computeBudget);
      unsignedTx.inputs[1].computeBudget = 30;

      if (isBid) {
        const bidPrefix = buildKcc20V3CreateBidSigScript(kw, {
          buyer: hexToBytes(owner),
          bidAmount: tokenAmount,
          unitPriceSompi,
          bidOutputIndex: orderOutputIndex,
          rootOutputIndex,
        });
        unsignedTx.inputs[0].signatureScript =
          encodeCovenantP2shSignatureScript(bidPrefix, activeScript);
      }

      const scripts = isBid
        ? []
        : [
            {
              inputIndex: 0,
              scriptHex: bytesToHex(activeScript),
              signType: 1,
              signatureScript: {
                mode: "signature-first-args",
                args: [
                  { type: "i64", value: tokenAmount.toString() },
                  { type: "i64", value: unitPriceSompi.toString() },
                  { type: "i64", value: String(orderOutputIndex) },
                  { type: "i64", value: String(holderChangeOutputIndex) },
                  dispatchTagTemplateArg(
                    wrappedArtifact,
                    "createAskByOwnerSig",
                  ),
                ],
              },
            },
          ];
      const feeAdjustedTx = transactionWithCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        scripts,
      );
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "KCC20Orderbook create order PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        ...(scripts.length > 0 ? { scripts } : {}),
        submitTransactionSupported: true,
        metadata: {
          builderKey,
          contract: "KCC20Orderbook",
          network,
          walletAddress,
          canonicalTokenId,
          wrapperId: activeSpendCovenantId,
          requestedWrapperId: wrapperId,
          covenantId: activeSpendCovenantId,
          side: isBid ? "buy" : "sell",
          sourceOutpoint: `${activeTxid}:${activeVout}`,
          orderOutputIndex,
          rootOutputIndex: isBid ? rootOutputIndex : null,
          holderChangeOutputIndex: isBid ? null : holderChangeOutputIndex,
          tokenAmount: tokenAmount.toString(),
          unitPriceSompi: unitPriceSompi.toString(),
          priceScale: activeState.priceScale.toString(),
          grossSompi: grossSompi.toString(),
          feePayer: "none",
          feeTiming: "order-creation",
          estimatedProtocolFeeSompi:
            calculateFeeSplit(grossSompi).fee.toString(),
          ...(isBid
            ? {
                buyerEscrowSompi: (grossSompi + bidDepositSompi).toString(),
                buyerTradeEscrowSompi: grossSompi.toString(),
              }
            : {}),
          buyerHolderDepositSompi: isBid ? bidDepositSompi.toString() : null,
          wrappedArtifactVersion: activeArtifactInfo.version,
          feeTicketId: activeFeeTicketId,
          owner,
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildWrappedFillAskPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const askUtxo = params.activeTargetOrderUtxo;
    const ticketUtxo = params.activeFeeTicketUtxo || null;
    if (!askUtxo) {
      throw new Error("active KCC20Orderbook ask order UTXO is required");
    }

    const canonicalTokenId = requireHex32(
      params.canonicalCovenantId || params.covenantId,
      "canonical token id",
    );
    const wrapperId = requireHex32(
      params.wrappedMarketId || params.wrapperId,
      "wrapped market id",
    );
    const buyerOwner = requireHex32(request.owner?.kcc20Owner, "buyer owner");
    const fillAmount = parsePositiveU64(params.tokenAmount, "tokenAmount");
    const unitPriceSompi = parsePositiveU64(
      params.unitPriceSompi,
      "unitPriceSompi",
    );
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const tokenOutputSompi = parseU64(
      env.KCC20_FILL_TOKEN_OUTPUT_SOMPI ||
        DEFAULT_TOKEN_OUTPUT_SOMPI.toString(),
      "tokenOutputSompi",
    );
    const priorityFee = parseU64(
      env.KCC20_FILL_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const computeBudget = parsePositiveNumber(
      env.KCC20_FILL_COMPUTE_BUDGET || 800,
      "computeBudget",
    );

    const wrappedArtifacts = await readWrappedArtifacts();
    const ticketArtifacts = ticketUtxo ? await readFeeTicketArtifacts() : null;
    const askState = kcc20V3WrappedStateFromUtxo(
      askUtxo,
      canonicalTokenId,
      request.owner,
    );
    const activeFeeTicketId = bytesToHex(askState.feeTicketId);
    if (params.feeTicketId && !ticketUtxo) {
      throw new Error("active FeeTicket UTXO is required for discounted fill");
    }
    if (ticketUtxo && !params.feeTicketId) {
      throw new Error(
        "feeTicketId is required when FeeTicket UTXO is supplied",
      );
    }
    if (ticketUtxo && activeFeeTicketId === ZERO_HASH) {
      throw new Error("selected ask does not support FeeTicket discount");
    }
    if (
      params.feeTicketId &&
      requireHex32(params.feeTicketId, "fee ticket id") !== activeFeeTicketId
    ) {
      throw new Error("requested FeeTicket root does not match ask order");
    }
    if (askState.mode !== 2) {
      throw new Error("fill ask requires a KCC20Orderbook ask order UTXO");
    }
    if (askState.unitPriceSompi !== unitPriceSompi) {
      throw new Error("requested unit price does not match ask order");
    }
    const grossSompi = exactGrossSompi(
      fillAmount,
      unitPriceSompi,
      askState.priceScale,
    );
    if (grossSompi < MIN_FILL_GROSS_SOMPI) {
      throw minimumFillGrossError(
        "fill gross value is below KCC20Orderbook minimum fill value",
      );
    }
    if (askState.amount < fillAmount) {
      throw new Error("tokenAmount exceeds ask order amount");
    }
    const remainingAskAmount = askState.amount - fillAmount;
    if (
      remainingAskAmount > 0n &&
      exactGrossSompi(
        remainingAskAmount,
        askState.unitPriceSompi,
        askState.priceScale,
      ) < MIN_FILL_GROSS_SOMPI
    ) {
      throw remainingOrderBelowMinimumError(
        "remaining ask value would be below minimum fill value",
      );
    }
    const buyerState = {
      ...askState,
      ownerIdentifier: hexToBytes(buyerOwner),
      amount: fillAmount,
      mode: 0,
      unitPriceSompi: 0n,
    };
    const askChangeState =
      remainingAskAmount > 0n
        ? { ...askState, amount: remainingAskAmount, mode: 2 }
        : null;
    const ticketState = ticketUtxo
      ? kcc20FeeTicketStateFromUtxo(ticketUtxo, buyerOwner)
      : null;
    if (ticketState && ticketState.mode !== 2) {
      throw new Error("FeeTicket discount requires a ticket UTXO");
    }
    if (ticketState && bytesToHex(ticketState.ownerIdentifier) !== buyerOwner) {
      throw new Error("FeeTicket UTXO is not owned by authenticated wallet");
    }
    const feeSompi = ticketState ? 0n : calculateFeeSplit(grossSompi).fee;
    const sellerValueSompi = grossSompi;

    const kw = kaspaWasm;
    const {
      Encoding,
      RpcClient,
      ScriptBuilder,
      Transaction,
      TransactionOutput,
      payToAddressScript,
    } = kw;

    const askArtifactInfo = selectWrappedArtifactForUtxo({
      kw,
      artifacts: wrappedArtifacts,
      state: askState,
      utxo: askUtxo,
      network,
      label: "KCC20Orderbook ask order UTXO address",
    });
    const wrappedArtifact = askArtifactInfo.artifact;
    const askScript = askArtifactInfo.script;
    const askAddress = askArtifactInfo.address;
    const ticketAddress = ticketUtxo
      ? requireKaspaAddress(ticketUtxo.address)
      : null;
    const ticketInfo =
      ticketArtifacts && ticketState && ticketAddress
        ? selectFeeTicketArtifactForState(
            ticketArtifacts,
            ticketState,

            ticketAddress,
            network,
            "FeeTicket discount UTXO address",
          )
        : null;
    const ticketScript = ticketInfo?.script ?? null;
    if (ticketScript && ticketAddress) {
      assertScriptAddress(
        kw,
        ticketScript,
        ticketAddress,
        network,
        "FeeTicket discount UTXO address",
      );
    }

    const askTxid = requireHex32(askUtxo.txidHex, "ask txid");
    const askVout = parseVout(askUtxo.vout, "ask vout");
    const ticketTxid = ticketUtxo
      ? requireHex32(ticketUtxo.txidHex, "FeeTicket txid")
      : null;
    const ticketVout = ticketUtxo
      ? parseVout(ticketUtxo.vout, "FeeTicket vout")
      : null;

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [askUtxos, ticketUtxos, walletUtxos] = await Promise.all([
        getUtxosByAddresses(rpc, [askAddress]),
        ticketAddress
          ? getUtxosByAddresses(rpc, [ticketAddress])
          : Promise.resolve({ entries: [] }),
        getUtxosByAddresses(rpc, [walletAddress]),
      ]);
      const askEntry = findUtxoEntry(askUtxos.entries, askTxid, askVout);
      if (!askEntry) {
        throw new Error(`ask order UTXO ${askTxid}:${askVout} not found`);
      }
      const ticketEntry =
        ticketTxid !== null && ticketVout !== null
          ? findUtxoEntry(ticketUtxos.entries, ticketTxid, ticketVout)
          : null;
      if (ticketUtxo && !ticketEntry) {
        throw new Error(`FeeTicket UTXO ${ticketTxid}:${ticketVout} not found`);
      }
      const askSpendCovenantId = covenantIdFromUtxoEntry(askEntry) ?? wrapperId;

      const buyerTokenOutputIndex = 0;
      const outputs = [
        wrappedTokenOutput(
          kw,
          wrappedArtifact,
          buyerState,
          tokenOutputSompi,
          askSpendCovenantId,
          0,
        ),
      ];

      let askOutputIndex = -1;
      if (askChangeState) {
        askOutputIndex = outputs.length;
        outputs.push(
          wrappedTokenOutput(
            kw,
            wrappedArtifact,
            askChangeState,
            utxoAmountSompi(askEntry),
            askSpendCovenantId,
            0,
          ),
        );
      }

      const sellerOutputIndex = outputs.length;
      const sellerValueWithAskDust =
        askChangeState === null
          ? sellerValueSompi + utxoAmountSompi(askEntry)
          : sellerValueSompi;
      outputs.push(
        new TransactionOutput(
          sellerValueWithAskDust,
          p2pkScriptPubKey(kw, bytesToHex(askState.ownerIdentifier)),
        ),
      );
      let feeOutputIndex = -1;
      if (feeSompi > 0n) {
        feeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(
            feeSompi,
            p2pkScriptPubKey(kw, KCC20_ORDERBOOK_PROTOCOL_FEE_RECIPIENT),
          ),
        );
      }
      const feeTicketRefund = appendFeeTicketRefundOutput(
        kw,
        outputs,
        ticketState,
        ticketEntry,
      );

      const outputSompi = outputs.reduce(
        (sum, output) => sum + BigInt(output.value),
        0n,
      );
      const ticketInputSompi = ticketEntry ? utxoAmountSompi(ticketEntry) : 0n;
      const covenantInputSompi = utxoAmountSompi(askEntry) + ticketInputSompi;
      const requiredFunding =
        outputSompi + priorityFee > covenantInputSompi
          ? outputSompi + priorityFee - covenantInputSompi + 10_000n
          : priorityFee + 10_000n;
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        requiredFunding,
      );
      const ticketInputIndex = ticketEntry ? 1 : -1;
      const fundingInputIndex = ticketEntry ? 2 : 1;
      const change =
        covenantInputSompi +
        utxoAmountSompi(fundingEntry) -
        outputSompi -
        priorityFee;
      let fundingChangeOutputIndex = -1;
      if (change > 10_000n) {
        fundingChangeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(change, payToAddressScript(walletAddress)),
        );
      }

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          {
            previousOutpoint: askEntry.outpoint,
            utxo: askEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          ...(ticketEntry
            ? [
                {
                  previousOutpoint: ticketEntry.outpoint,
                  utxo: ticketEntry,
                  sequence: 0n,
                  sigOpCount: 0,
                  computeBudget,
                },
              ]
            : []),
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildWrappedFillPayload({
          canonicalTokenId,
          wrapperId: askSpendCovenantId,
          side: "buy",
          targetOrderId: `${askTxid}:${askVout}`,
          tokenAmount: fillAmount,
          unitPriceSompi,
        }),
      });
      setVersionOneInputMassFields(unsignedTx, computeBudget);
      unsignedTx.inputs[fundingInputIndex].computeBudget = 30;
      const askPrefix = buildKcc20OrderbookFillAskSigScript(kw, {
        buyerOwner: hexToBytes(buyerOwner),
        fillAmount,
        buyerTokenOutputIndex,
        askOutputIndex,
        sellerOutputIndex,
        ticketInputIndex,
      });
      unsignedTx.inputs[0].signatureScript = encodeCovenantP2shSignatureScript(
        askPrefix,
        askScript,
      );

      const scripts = ticketInfo
        ? [
            feeTicketBurnScriptHint(
              ticketInputIndex,
              ticketInfo.script,
              ticketInfo.burnDispatchTag,
              feeTicketRefund.outputIndex,
              ticketInfo.burnTakesRefundOutput,
            ),
          ]
        : [];
      const feeAdjustedTx = transactionWithCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        scripts,
      );
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "KCC20Orderbook fill ask PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        ...(scripts.length > 0 ? { scripts } : {}),
        submitTransactionSupported: true,
        metadata: {
          builderKey: "kcc20orderbook.fill-ask",
          contract: "KCC20Orderbook",
          network,
          walletAddress,
          canonicalTokenId,
          wrapperId: askSpendCovenantId,
          requestedWrapperId: wrapperId,
          covenantId: askSpendCovenantId,
          side: "buy",
          targetOrderId: `${askTxid}:${askVout}`,
          askOutpoint: `${askTxid}:${askVout}`,
          buyerTokenOutputIndex,
          askOutputIndex,
          sellerOutputIndex,
          feeOutputIndex,
          tokenAmount: fillAmount.toString(),
          unitPriceSompi: unitPriceSompi.toString(),
          priceScale: askState.priceScale.toString(),
          grossSompi: grossSompi.toString(),
          protocolFeeSompi: feeSompi.toString(),
          feePayer: "buyer",
          feeTiming: "fill",
          buyerPaysSompi: (grossSompi + feeSompi).toString(),
          sellerReceivesSompi: sellerValueSompi.toString(),
          remainingAskAmount: remainingAskAmount.toString(),
          feeTicketId: activeFeeTicketId,
          feeTicketInputIndex: ticketInputIndex,
          feeTicketRefundOutputIndex: feeTicketRefund.outputIndex,
          feeTicketRefundSompi: feeTicketRefund.sompi.toString(),
          feeTicketOutpoint:
            ticketTxid !== null && ticketVout !== null
              ? `${ticketTxid}:${ticketVout}`
              : null,
          wrappedArtifactVersion: askArtifactInfo.version,
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildWrappedFillBidPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const bidUtxo = params.activeTargetOrderUtxo;
    const holderUtxo = params.activeWrappedHolderUtxo;
    const ticketUtxo = params.activeFeeTicketUtxo || null;
    if (!bidUtxo) {
      throw new Error("active KCC20Orderbook bid order UTXO is required");
    }
    if (!holderUtxo) {
      throw new Error("active KCC20Orderbook seller holder UTXO is required");
    }

    const canonicalTokenId = requireHex32(
      params.canonicalCovenantId || params.covenantId,
      "canonical token id",
    );
    const wrapperId = requireHex32(
      params.wrappedMarketId || params.wrapperId,
      "wrapped market id",
    );
    const sellerOwner = requireHex32(request.owner?.kcc20Owner, "seller owner");
    const fillAmount = parsePositiveU64(params.tokenAmount, "tokenAmount");
    const unitPriceSompi = parsePositiveU64(
      params.unitPriceSompi,
      "unitPriceSompi",
    );
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const tokenOutputSompi = parseU64(
      env.KCC20_FILL_TOKEN_OUTPUT_SOMPI ||
        DEFAULT_TOKEN_OUTPUT_SOMPI.toString(),
      "tokenOutputSompi",
    );
    const priorityFee = parseU64(
      env.KCC20_FILL_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const computeBudget = parsePositiveNumber(
      env.KCC20_FILL_COMPUTE_BUDGET || 800,
      "computeBudget",
    );

    const wrappedArtifacts = await readWrappedArtifacts();
    const ticketArtifacts = ticketUtxo ? await readFeeTicketArtifacts() : null;
    const bidState = kcc20V3WrappedStateFromUtxo(
      bidUtxo,
      canonicalTokenId,
      request.owner,
    );
    const activeFeeTicketId = bytesToHex(bidState.feeTicketId);
    if (params.feeTicketId && !ticketUtxo) {
      throw new Error("active FeeTicket UTXO is required for discounted fill");
    }
    if (ticketUtxo && !params.feeTicketId) {
      throw new Error(
        "feeTicketId is required when FeeTicket UTXO is supplied",
      );
    }
    if (ticketUtxo && activeFeeTicketId === ZERO_HASH) {
      throw new Error("selected bid does not support FeeTicket discount");
    }
    if (
      params.feeTicketId &&
      requireHex32(params.feeTicketId, "fee ticket id") !== activeFeeTicketId
    ) {
      throw new Error("requested FeeTicket root does not match bid order");
    }
    if (bidState.mode !== 3) {
      throw new Error("fill bid requires a KCC20Orderbook bid order UTXO");
    }
    if (bidState.unitPriceSompi !== unitPriceSompi) {
      throw new Error("requested unit price does not match bid order");
    }
    const grossSompi = exactGrossSompi(
      fillAmount,
      unitPriceSompi,
      bidState.priceScale,
    );
    if (grossSompi < MIN_FILL_GROSS_SOMPI) {
      throw minimumFillGrossError(
        "fill gross value is below KCC20Orderbook minimum fill value",
      );
    }
    if (bidState.amount < fillAmount) {
      throw new Error("tokenAmount exceeds bid order amount");
    }
    const holderState = kcc20V3WrappedStateFromUtxo(
      holderUtxo,
      canonicalTokenId,
      request.owner,
    );
    if (holderState.mode !== 0) {
      throw new Error("fill bid requires a wrapped holder UTXO");
    }
    if (holderState.priceScale !== bidState.priceScale) {
      throw new Error("wrapped holder price scale does not match bid order");
    }
    if (bytesToHex(holderState.ownerIdentifier) !== sellerOwner) {
      throw new Error(
        "wrapped holder UTXO is not owned by authenticated wallet",
      );
    }
    if (holderState.amount < fillAmount) {
      throw new Error("tokenAmount exceeds wrapped holder balance");
    }
    const remainingBidAmount = bidState.amount - fillAmount;
    if (remainingBidAmount > 0n) {
      assertPartialBuyerHolderOutputSompi(tokenOutputSompi);
    }
    const remainingHolderAmount = holderState.amount - fillAmount;
    if (
      remainingBidAmount > 0n &&
      exactGrossSompi(
        remainingBidAmount,
        bidState.unitPriceSompi,
        bidState.priceScale,
      ) < MIN_FILL_GROSS_SOMPI
    ) {
      throw remainingOrderBelowMinimumError(
        "remaining bid value would be below minimum fill value",
      );
    }
    const buyerState = {
      ...bidState,
      amount: fillAmount,
      mode: 0,
      unitPriceSompi: 0n,
    };
    const bidChangeState =
      remainingBidAmount > 0n
        ? { ...bidState, amount: remainingBidAmount, mode: 3 }
        : null;
    const holderChangeState =
      remainingHolderAmount > 0n
        ? {
            ...holderState,
            amount: remainingHolderAmount,
            mode: 0,
            unitPriceSompi: 0n,
          }
        : null;
    const ticketState = ticketUtxo
      ? kcc20FeeTicketStateFromUtxo(ticketUtxo, sellerOwner)
      : null;
    if (ticketState && ticketState.mode !== 2) {
      throw new Error("FeeTicket discount requires a ticket UTXO");
    }
    if (
      ticketState &&
      bytesToHex(ticketState.ownerIdentifier) !== sellerOwner
    ) {
      throw new Error("FeeTicket UTXO is not owned by authenticated wallet");
    }
    const feeSompi = ticketState ? 0n : calculateFeeSplit(grossSompi).fee;

    const kw = kaspaWasm;
    const {
      Encoding,
      RpcClient,
      ScriptBuilder,
      Transaction,
      TransactionOutput,
      payToAddressScript,
    } = kw;

    const bidArtifactInfo = selectWrappedArtifactForUtxo({
      kw,
      artifacts: wrappedArtifacts,
      state: bidState,
      utxo: bidUtxo,
      network,
      label: "KCC20Orderbook bid order UTXO address",
    });
    const holderArtifactInfo = selectWrappedArtifactForUtxo({
      kw,
      artifacts: wrappedArtifacts,
      state: holderState,
      utxo: holderUtxo,
      network,
      label: "KCC20Orderbook seller holder UTXO address",
    });
    if (bidArtifactInfo.version !== holderArtifactInfo.version) {
      throw new Error(
        "bid order and seller holder use different wrapped artifacts",
      );
    }
    const wrappedArtifact = bidArtifactInfo.artifact;
    const refundAware = wrappedArtifactRefundsHolderDeposits(bidArtifactInfo);
    const bidScript = bidArtifactInfo.script;
    const holderScript = holderArtifactInfo.script;
    const bidAddress = bidArtifactInfo.address;
    const holderAddress = holderArtifactInfo.address;
    const ticketAddress = ticketUtxo
      ? requireKaspaAddress(ticketUtxo.address)
      : null;
    const ticketInfo =
      ticketArtifacts && ticketState && ticketAddress
        ? selectFeeTicketArtifactForState(
            ticketArtifacts,
            ticketState,
            ticketAddress,
            network,
            "FeeTicket discount UTXO address",
          )
        : null;
    const ticketScript = ticketInfo?.script ?? null;
    if (ticketScript && ticketAddress) {
      assertScriptAddress(
        kw,
        ticketScript,
        ticketAddress,
        network,
        "FeeTicket discount UTXO address",
      );
    }

    const bidTxid = requireHex32(bidUtxo.txidHex, "bid txid");
    const bidVout = parseVout(bidUtxo.vout, "bid vout");
    const holderTxid = requireHex32(holderUtxo.txidHex, "holder txid");
    const holderVout = parseVout(holderUtxo.vout, "holder vout");
    const ticketTxid = ticketUtxo
      ? requireHex32(ticketUtxo.txidHex, "FeeTicket txid")
      : null;
    const ticketVout = ticketUtxo
      ? parseVout(ticketUtxo.vout, "FeeTicket vout")
      : null;

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [bidUtxos, holderUtxos, ticketUtxos, walletUtxos] =
        await Promise.all([
          getUtxosByAddresses(rpc, [bidAddress]),
          getUtxosByAddresses(rpc, [holderAddress]),
          ticketAddress
            ? getUtxosByAddresses(rpc, [ticketAddress])
            : Promise.resolve({ entries: [] }),
          getUtxosByAddresses(rpc, [walletAddress]),
        ]);
      const bidEntry = findUtxoEntry(bidUtxos.entries, bidTxid, bidVout);
      if (!bidEntry) {
        throw new Error(`bid order UTXO ${bidTxid}:${bidVout} not found`);
      }
      const holderEntry = findUtxoEntry(
        holderUtxos.entries,
        holderTxid,
        holderVout,
      );
      if (!holderEntry) {
        throw new Error(
          `seller holder UTXO ${holderTxid}:${holderVout} not found`,
        );
      }
      const ticketEntry =
        ticketTxid !== null && ticketVout !== null
          ? findUtxoEntry(ticketUtxos.entries, ticketTxid, ticketVout)
          : null;
      if (ticketUtxo && !ticketEntry) {
        throw new Error(`FeeTicket UTXO ${ticketTxid}:${ticketVout} not found`);
      }
      const bidSpendCovenantId = covenantIdFromUtxoEntry(bidEntry) ?? wrapperId;
      const holderSpendCovenantId =
        covenantIdFromUtxoEntry(holderEntry) ?? wrapperId;
      const bidGrossTotalSompi = exactGrossSompi(
        bidState.amount,
        bidState.unitPriceSompi,
        bidState.priceScale,
      );
      const bidDepositSompi = refundAware
        ? utxoAmountSompi(bidEntry) - bidGrossTotalSompi
        : 0n;
      if (refundAware && bidDepositSompi < tokenOutputSompi) {
        throw new Error(
          `bid holder deposit ${bidDepositSompi} is below ${tokenOutputSompi}`,
        );
      }
      const buyerHolderOutputSompi =
        refundAware && bidChangeState === null
          ? bidDepositSompi
          : tokenOutputSompi;

      const buyerTokenOutputIndex = 0;
      const outputs = [
        wrappedTokenOutput(
          kw,
          wrappedArtifact,
          buyerState,
          buyerHolderOutputSompi,
          holderSpendCovenantId,
          1,
        ),
      ];

      let bidOutputIndex = -1;
      if (bidChangeState) {
        bidOutputIndex = outputs.length;
        outputs.push(
          wrappedTokenOutput(
            kw,
            wrappedArtifact,
            bidChangeState,
            exactGrossSompi(
              remainingBidAmount,
              bidState.unitPriceSompi,
              bidState.priceScale,
            ) + bidDepositSompi,
            bidSpendCovenantId,
            0,
          ),
        );
      }

      const sellerValueSompi = grossSompi - feeSompi;
      let sellerOutputIndex = -1;
      if (sellerValueSompi > 0n) {
        sellerOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(
            sellerValueSompi,
            p2pkScriptPubKey(kw, sellerOwner),
          ),
        );
      }
      let feeOutputIndex = -1;
      if (feeSompi > 0n) {
        feeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(
            feeSompi,
            p2pkScriptPubKey(kw, KCC20_ORDERBOOK_PROTOCOL_FEE_RECIPIENT),
          ),
        );
      }
      sellerOutputIndex = sellerSettlementOutputIndex(
        sellerValueSompi,
        sellerOutputIndex,
        feeOutputIndex,
      );

      let sellerChangeOutputIndex = -1;
      if (holderChangeState) {
        sellerChangeOutputIndex = outputs.length;
        outputs.push(
          wrappedTokenOutput(
            kw,
            wrappedArtifact,
            holderChangeState,
            refundAware ? utxoAmountSompi(holderEntry) : tokenOutputSompi,
            holderSpendCovenantId,
            1,
          ),
        );
      }
      const feeTicketRefund = appendFeeTicketRefundOutput(
        kw,
        outputs,
        ticketState,
        ticketEntry,
      );
      const sellerOutputsEndIndex = outputs.length - 1;
      let sellerHolderRefundOutputIndex = -1;
      let sellerHolderRefundSompi = 0n;
      if (refundAware && holderChangeState === null) {
        sellerHolderRefundOutputIndex = outputs.length;
        sellerHolderRefundSompi = utxoAmountSompi(holderEntry);
        outputs.push(
          new TransactionOutput(
            sellerHolderRefundSompi,
            p2pkScriptPubKey(kw, sellerOwner),
          ),
        );
      }

      const outputSompi = outputs.reduce(
        (sum, output) => sum + BigInt(output.value),
        0n,
      );
      const ticketInputSompi = ticketEntry ? utxoAmountSompi(ticketEntry) : 0n;
      const covenantInputSompi =
        utxoAmountSompi(bidEntry) +
        utxoAmountSompi(holderEntry) +
        ticketInputSompi;
      const requiredFunding =
        outputSompi + priorityFee > covenantInputSompi
          ? outputSompi + priorityFee - covenantInputSompi + 10_000n
          : priorityFee + 10_000n;
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        requiredFunding,
      );
      const ticketInputIndex = ticketEntry ? 2 : -1;
      const fundingInputIndex = ticketEntry ? 3 : 2;
      const change =
        covenantInputSompi +
        utxoAmountSompi(fundingEntry) -
        outputSompi -
        priorityFee;
      let fundingChangeOutputIndex = -1;
      if (change > 10_000n) {
        fundingChangeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(change, payToAddressScript(walletAddress)),
        );
      }

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          {
            previousOutpoint: bidEntry.outpoint,
            utxo: bidEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          {
            previousOutpoint: holderEntry.outpoint,
            utxo: holderEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          ...(ticketEntry
            ? [
                {
                  previousOutpoint: ticketEntry.outpoint,
                  utxo: ticketEntry,
                  sequence: 0n,
                  sigOpCount: 0,
                  computeBudget,
                },
              ]
            : []),
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildWrappedFillPayload({
          canonicalTokenId,
          wrapperId: bidSpendCovenantId,
          side: "sell",
          targetOrderId: `${bidTxid}:${bidVout}`,
          tokenAmount: fillAmount,
          unitPriceSompi,
        }),
      });
      setVersionOneInputMassFields(unsignedTx, computeBudget);
      unsignedTx.inputs[fundingInputIndex].computeBudget = 30;
      const bidPrefix = buildKcc20OrderbookFillBidSigScript(kw, {
        sellerTokenInputIndex: 1,
        fillAmount,
        buyerTokenOutputIndex,
        bidOutputIndex,
        sellerOutputIndex,
        seller: hexToBytes(sellerOwner),
        ticketInputIndex,
      });
      unsignedTx.inputs[0].signatureScript = encodeCovenantP2shSignatureScript(
        bidPrefix,
        bidScript,
      );

      const scripts = [
        {
          inputIndex: 1,
          scriptHex: bytesToHex(holderScript),
          signType: 1,
          signatureScript: {
            mode: "signature-first-args",
            args: [
              { type: "data", hex: bytesToHex(bidState.ownerIdentifier) },
              { type: "i64", value: fillAmount.toString() },
              { type: "i64", value: String(buyerTokenOutputIndex) },
              { type: "i64", value: String(sellerChangeOutputIndex) },
              ...(refundAware
                ? [
                    {
                      type: "i64",
                      value: String(sellerHolderRefundOutputIndex),
                    },
                    {
                      type: "i64",
                      value: String(sellerOutputsEndIndex),
                    },
                  ]
                : []),
              dispatchTagTemplateArg(wrappedArtifact, "sellIntoBidByOwnerSig"),
            ],
          },
        },
        ...(ticketInfo
          ? [
              feeTicketBurnScriptHint(
                ticketInputIndex,
                ticketInfo.script,
                ticketInfo.burnDispatchTag,
                feeTicketRefund.outputIndex,
                ticketInfo.burnTakesRefundOutput,
              ),
            ]
          : []),
      ];
      const feeAdjustedTx = transactionWithCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        scripts,
      );
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "KCC20Orderbook fill bid PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        scripts,
        submitTransactionSupported: true,
        metadata: {
          builderKey: "kcc20orderbook.fill-bid",
          contract: "KCC20Orderbook",
          network,
          walletAddress,
          canonicalTokenId,
          wrapperId: bidSpendCovenantId,
          requestedWrapperId: wrapperId,
          covenantId: bidSpendCovenantId,
          side: "sell",
          targetOrderId: `${bidTxid}:${bidVout}`,
          bidOutpoint: `${bidTxid}:${bidVout}`,
          holderOutpoint: `${holderTxid}:${holderVout}`,
          buyerTokenOutputIndex,
          bidOutputIndex,
          sellerOutputIndex,
          feeOutputIndex,
          sellerChangeOutputIndex,
          sellerHolderRefundOutputIndex,
          sellerOutputsEndIndex,
          sellerHolderRefundSompi: sellerHolderRefundSompi.toString(),
          buyerHolderDepositSompi: buyerHolderOutputSompi.toString(),
          bidHolderDepositSompi: bidDepositSompi.toString(),
          tokenAmount: fillAmount.toString(),
          unitPriceSompi: unitPriceSompi.toString(),
          priceScale: bidState.priceScale.toString(),
          grossSompi: grossSompi.toString(),
          protocolFeeSompi: feeSompi.toString(),
          feePayer: "seller",
          feeTiming: "fill",
          buyerPaysSompi: grossSompi.toString(),
          sellerReceivesSompi: sellerValueSompi.toString(),
          remainingBidAmount: remainingBidAmount.toString(),
          remainingHolderAmount: remainingHolderAmount.toString(),
          feeTicketId: activeFeeTicketId,
          feeTicketInputIndex: ticketInputIndex,
          feeTicketRefundOutputIndex: feeTicketRefund.outputIndex,
          feeTicketRefundSompi: feeTicketRefund.sompi.toString(),
          feeTicketOutpoint:
            ticketTxid !== null && ticketVout !== null
              ? `${ticketTxid}:${ticketVout}`
              : null,
          wrappedArtifactVersion: bidArtifactInfo.version,
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildWrappedSweepAsksPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const orderUtxos = Array.isArray(params.activeTargetOrderUtxos)
      ? params.activeTargetOrderUtxos
      : [];
    const ticketUtxos = Array.isArray(params.activeFeeTicketUtxos)
      ? params.activeFeeTicketUtxos
      : [];
    const fills = Array.isArray(params.fills) ? params.fills : [];
    if (fills.length < 2) {
      throw new Error("sweep asks requires at least two fill legs");
    }
    if (orderUtxos.length !== fills.length) {
      throw new Error("active ask order UTXOs must match sweep fills");
    }
    assertUniqueSweepBidOutpoints(
      [...orderUtxos, ...ticketUtxos],
      "sweep asks",
    );

    const canonicalTokenId = requireHex32(
      params.canonicalCovenantId || params.covenantId,
      "canonical token id",
    );
    const wrapperId = requireHex32(
      params.wrappedMarketId || params.wrapperId,
      "wrapped market id",
    );
    const buyerOwner = requireHex32(request.owner?.kcc20Owner, "buyer owner");
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const tokenOutputSompi = parseU64(
      env.KCC20_FILL_TOKEN_OUTPUT_SOMPI ||
        DEFAULT_TOKEN_OUTPUT_SOMPI.toString(),
      "tokenOutputSompi",
    );
    const priorityFee = parseU64(
      env.KCC20_FILL_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const wrappedArtifacts = await readWrappedArtifacts();
    const ticketArtifacts = params.feeTicketId
      ? await readFeeTicketArtifacts()
      : null;

    const legs = fills.map((fill, index) => {
      const askUtxo = orderUtxos[index];
      if (!askUtxo) {
        throw new Error(`missing ask order UTXO for sweep leg ${index}`);
      }
      const askState = kcc20V3WrappedStateFromUtxo(
        askUtxo,
        canonicalTokenId,
        request.owner,
      );
      const { askTxid, askVout } = assertSweepAskLegIdentity({
        fill,
        askUtxo,
        askState,
        canonicalTokenId,
        index,
      });
      if (askState.mode !== 2) {
        throw new Error(
          `sweep leg ${index} requires a KCC20Orderbook ask order UTXO`,
        );
      }
      const fillAmount = parsePositiveU64(fill.tokenAmount, "fill tokenAmount");
      const unitPriceSompi = parsePositiveU64(
        fill.unitPriceSompi,
        "fill unitPriceSompi",
      );
      if (askState.unitPriceSompi !== unitPriceSompi) {
        throw new Error(
          `sweep leg ${index} unit price does not match ask order`,
        );
      }
      if (askState.amount < fillAmount) {
        throw new Error(
          `sweep leg ${index} tokenAmount exceeds ask order amount`,
        );
      }
      const grossSompi = exactGrossSompi(
        fillAmount,
        unitPriceSompi,
        askState.priceScale,
        `sweep ask leg ${index}`,
      );
      if (grossSompi < MIN_FILL_GROSS_SOMPI) {
        throw minimumFillGrossError(
          `sweep leg ${index} gross value is below minimum fill value`,
        );
      }
      const remainingAskAmount = askState.amount - fillAmount;
      if (
        remainingAskAmount > 0n &&
        exactGrossSompi(
          remainingAskAmount,
          askState.unitPriceSompi,
          askState.priceScale,
          `sweep ask leg ${index} remainder`,
        ) < MIN_FILL_GROSS_SOMPI
      ) {
        throw remainingOrderBelowMinimumError(
          `sweep leg ${index} remaining ask value would be below minimum fill value`,
        );
      }
      const askArtifactInfo = selectWrappedArtifactForUtxo({
        kw: kaspaWasm,
        artifacts: wrappedArtifacts,
        state: askState,
        utxo: askUtxo,
        network,
        label: `KCC20Orderbook ask order UTXO ${index} address`,
      });
      return {
        fill,
        askUtxo,
        askState,
        askScript: askArtifactInfo.script,
        askAddress: askArtifactInfo.address,
        askArtifactInfo,
        fillAmount,
        unitPriceSompi,
        grossSompi,
        protocolFeeSompi: calculateFeeSplit(grossSompi).fee,
        remainingAskAmount,
        askTxid,
        askVout,
      };
    });

    const totalGrossSompi = legs.reduce((sum, leg) => sum + leg.grossSompi, 0n);
    const sharedFeeTicket = prepareSharedFeeTicketForSweep({
      params,
      ticketUtxos,
      orderStates: legs.map((leg) => leg.askState),
      owner: buyerOwner,
      ticketArtifacts,
      network,
      label: "sweep asks",
    });
    const computeBudgetLayout = sweepAskComputeBudgetLayout(
      legs.length,
      Boolean(sharedFeeTicket),
    );
    const computeBudgetArtifacts =
      assertSweepAskComputeBudgetArtifactCompatibility(
        legs.map((leg) => leg.askArtifactInfo.artifact),
        sharedFeeTicket?.artifact,
      );
    const feeTicketComputeBudget =
      computeBudgetArtifacts.feeTicketComputeBudget ??
      KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE.feeTicket;
    assertSweepAskReservedComputeMassStandard(
      computeBudgetLayout,
      "sweep asks",
      feeTicketComputeBudget,
    );
    const totalQuotedProtocolFeeSompi = legs.reduce(
      (sum, leg) => sum + leg.protocolFeeSompi,
      0n,
    );
    const totalProtocolFeeSompi = sharedFeeTicket
      ? 0n
      : totalQuotedProtocolFeeSompi;
    const quotedGrossSompi = parsePositiveU64(params.grossSompi, "grossSompi");
    if (totalGrossSompi !== quotedGrossSompi) {
      throw new Error("sweep ask gross total does not match route quote");
    }
    const quotedProtocolFeeSompi = parseQuotedProtocolFeeSompi(params);
    if (totalQuotedProtocolFeeSompi !== quotedProtocolFeeSompi) {
      throw new Error("sweep ask protocol fee does not match route quote");
    }

    const kw = kaspaWasm;
    const {
      Encoding,
      RpcClient,
      Transaction,
      TransactionOutput,
      payToAddressScript,
    } = kw;
    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [askEntryResults, ticketEntryResult, walletUtxos] =
        await Promise.all([
          Promise.all(
            legs.map((leg) => getUtxosByAddresses(rpc, [leg.askAddress])),
          ),
          sharedFeeTicket
            ? getUtxosByAddresses(rpc, [sharedFeeTicket.address])
            : { entries: [] },
          getUtxosByAddresses(rpc, [walletAddress]),
        ]);
      const sharedTicketEntry = sharedFeeTicket
        ? findUtxoEntry(
            ticketEntryResult.entries,
            sharedFeeTicket.txid,
            sharedFeeTicket.vout,
          )
        : null;
      if (sharedFeeTicket && !sharedTicketEntry) {
        throw new Error(`FeeTicket UTXO ${sharedFeeTicket.outpoint} not found`);
      }
      if (sharedTicketEntry) {
        requireMatchingCovenantId(
          sharedTicketEntry,
          requireHex32(params.feeTicketId, "FeeTicket root id"),
          "sweep asks FeeTicket UTXO",
        );
      }
      const resolvedLegs = legs.map((leg, index) => {
        const askEntry = findUtxoEntry(
          askEntryResults[index].entries,
          leg.askTxid,
          leg.askVout,
        );
        if (!askEntry) {
          throw new Error(
            `ask order UTXO ${leg.askTxid}:${leg.askVout} not found`,
          );
        }
        const spendCovenantId = requireMatchingCovenantId(
          askEntry,
          wrapperId,
          `sweep ask input ${index}`,
        );
        return {
          ...leg,
          askEntry,
          spendCovenantId,
        };
      });

      const outputs = [];
      const metadataFills = [];
      for (const [legIndex, leg] of resolvedLegs.entries()) {
        const feeSompi = sharedTicketEntry ? 0n : leg.protocolFeeSompi;
        const buyerTokenOutputIndex = outputs.length;
        outputs.push(
          wrappedTokenOutput(
            kw,
            leg.askArtifactInfo.artifact,
            {
              ...leg.askState,
              amount: leg.fillAmount,
              mode: 0,
              ownerIdentifier: hexToBytes(buyerOwner),
              identifierType: 0,
              unitPriceSompi: 0n,
            },
            tokenOutputSompi,
            leg.spendCovenantId,
            legIndex,
          ),
        );

        let askOutputIndex = -1;
        if (leg.remainingAskAmount > 0n) {
          askOutputIndex = outputs.length;
          outputs.push(
            wrappedTokenOutput(
              kw,
              leg.askArtifactInfo.artifact,
              { ...leg.askState, amount: leg.remainingAskAmount, mode: 2 },
              utxoAmountSompi(leg.askEntry),
              leg.spendCovenantId,
              legIndex,
            ),
          );
        }

        const sellerOutputIndex = outputs.length;
        const sellerValueSompi =
          leg.remainingAskAmount > 0n
            ? leg.grossSompi
            : leg.grossSompi + utxoAmountSompi(leg.askEntry);
        outputs.push(
          new TransactionOutput(
            sellerValueSompi,
            p2pkScriptPubKey(kw, bytesToHex(leg.askState.ownerIdentifier)),
          ),
        );
        let feeOutputIndex = -1;
        if (feeSompi > 0n) {
          feeOutputIndex = outputs.length;
          outputs.push(
            new TransactionOutput(
              feeSompi,
              p2pkScriptPubKey(kw, KCC20_ORDERBOOK_PROTOCOL_FEE_RECIPIENT),
            ),
          );
        }
        const ticketInputIndex = sharedTicketEntry ? resolvedLegs.length : -1;
        metadataFills.push({
          orderId: `${leg.askTxid}:${leg.askVout}`,
          tokenAmount: leg.fillAmount.toString(),
          unitPriceSompi: leg.unitPriceSompi.toString(),
          totalPriceSompi: leg.grossSompi.toString(),
          protocolFeeSompi: feeSompi.toString(),
          quotedProtocolFeeSompi: leg.protocolFeeSompi.toString(),
          buyerTokenOutputIndex,
          askOutputIndex,
          sellerOutputIndex,
          feeOutputIndex,
          feeTicketInputIndex: ticketInputIndex,
          feeTicketOutpoint: sharedFeeTicket?.outpoint ?? null,
          feeTicketRefundOutputIndex: -1,
          feeTicketRefundSompi: "0",
          remainingAskAmount: leg.remainingAskAmount.toString(),
          wrappedArtifactVersion: leg.askArtifactInfo.version,
        });
      }

      if (sharedTicketEntry) {
        const feeTicketRefund = appendFeeTicketRefundOutput(
          kw,
          outputs,
          sharedFeeTicket.state,
          sharedTicketEntry,
        );
        for (const metadata of metadataFills) {
          metadata.feeTicketRefundOutputIndex = feeTicketRefund.outputIndex;
          metadata.feeTicketRefundSompi = feeTicketRefund.sompi.toString();
        }
      }

      const outputSompi = outputs.reduce(
        (sum, output) => sum + BigInt(output.value),
        0n,
      );
      const covenantInputSompi =
        resolvedLegs.reduce(
          (sum, leg) => sum + utxoAmountSompi(leg.askEntry),
          0n,
        ) + (sharedTicketEntry ? utxoAmountSompi(sharedTicketEntry) : 0n);
      const requiredFunding =
        outputSompi + priorityFee > covenantInputSompi
          ? outputSompi +
            priorityFee -
            covenantInputSompi +
            MIN_FUNDING_CHANGE_SOMPI
          : priorityFee + MIN_FUNDING_CHANGE_SOMPI;
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        requiredFunding,
      );
      const fundingInputIndex =
        resolvedLegs.length + (sharedTicketEntry ? 1 : 0);
      const change =
        covenantInputSompi +
        utxoAmountSompi(fundingEntry) -
        outputSompi -
        priorityFee;
      let fundingChangeOutputIndex = -1;
      if (change > MIN_FUNDING_CHANGE_SOMPI) {
        fundingChangeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(change, payToAddressScript(walletAddress)),
        );
      }

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          ...resolvedLegs.map((leg) => ({
            previousOutpoint: leg.askEntry.outpoint,
            utxo: leg.askEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget:
              KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE.askOrder,
          })),
          ...(sharedTicketEntry
            ? [
                {
                  previousOutpoint: sharedTicketEntry.outpoint,
                  utxo: sharedTicketEntry,
                  sequence: 0n,
                  sigOpCount: 0,
                  computeBudget: feeTicketComputeBudget,
                },
              ]
            : []),
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget:
              KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE.funding,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildWrappedSweepPayload({
          canonicalTokenId,
          wrapperId,
          side: "buy",
          fills: metadataFills,
        }),
      });
      const computeBudgetProfile = applySweepAskComputeBudgetProfile(
        unsignedTx,
        computeBudgetLayout,
        feeTicketComputeBudget,
      );
      assertUniqueTransactionInputOutpoints(unsignedTx, "sweep asks");
      resolvedLegs.forEach((leg, inputIndex) => {
        const metadata = metadataFills[inputIndex];
        const askPrefix = buildKcc20OrderbookFillAskSigScript(kw, {
          buyerOwner: hexToBytes(buyerOwner),
          fillAmount: leg.fillAmount,
          buyerTokenOutputIndex: metadata.buyerTokenOutputIndex,
          askOutputIndex: metadata.askOutputIndex,
          sellerOutputIndex: metadata.sellerOutputIndex,
          ticketInputIndex: metadata.feeTicketInputIndex,
        });
        unsignedTx.inputs[inputIndex].signatureScript =
          encodeCovenantP2shSignatureScript(askPrefix, leg.askScript);
      });

      const scripts = sharedFeeTicket
        ? [
            feeTicketBurnScriptHint(
              metadataFills[0].feeTicketInputIndex,
              sharedFeeTicket.script,
              sharedFeeTicket.burnDispatchTag,
              metadataFills[0].feeTicketRefundOutputIndex,
              sharedFeeTicket.burnTakesRefundOutput,
            ),
          ]
        : [];
      const signedShapeDetails = {
        sharedFeeTicket,
        metadataFills,
        feeTicketInputIndex: metadataFills[0]?.feeTicketInputIndex ?? -1,
        fundingInputIndex,
      };
      const feeResult = transactionWithPredictedSignedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        (transaction) =>
          predictSweepAskSignedTransaction(kw, {
            ...signedShapeDetails,
            transaction,
          }),
      );
      const feeAdjustedTx = feeResult.transaction;
      const nonContextualMass = assertTransactionComputeMassStandard(
        feeResult.predictedTransaction,
        "sweep asks",
        {
          selectedLegCount: metadataFills.length,
          computeBudgetProfile:
            KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE.version,
        },
      );
      const storageMass = assertTransactionStorageMassStandard(
        feeAdjustedTx,
        "sweep asks",
        {
          selectedLegCount: metadataFills.length,
          tokenOutputSompi,
        },
      );
      const transactionMass =
        nonContextualMass > storageMass ? nonContextualMass : storageMass;
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "KCC20Orderbook sweep asks PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        ...(scripts.length > 0 ? { scripts } : {}),
        submitTransactionSupported: true,
        metadata: {
          builderKey: "kcc20orderbook.sweep-asks",
          contract: "KCC20Orderbook",
          network,
          walletAddress,
          canonicalTokenId,
          wrapperId,
          requestedWrapperId: wrapperId,
          covenantId: wrapperId,
          side: "buy",
          executionMode: "multi",
          selectedLegCount: metadataFills.length,
          computeBudgetProfile,
          computeBudgetArtifacts,
          transactionMass: transactionMass.toString(),
          requiredTransactionFeeSompi: feeResult.requiredFeeSompi.toString(),
          paidTransactionFeeSompi: feeResult.paidFeeSompi.toString(),
          fills: metadataFills,
          feeOutputIndexes: metadataFills.map((fill) => fill.feeOutputIndex),
          fundingInputIndex,
          grossSompi: totalGrossSompi.toString(),
          protocolFeeSompi: totalProtocolFeeSompi.toString(),
          quotedProtocolFeeSompi: totalQuotedProtocolFeeSompi.toString(),
          feePayer: "buyer",
          feeTiming: "fill",
          buyerPaysSompi: (totalGrossSompi + totalProtocolFeeSompi).toString(),
          sellerReceivesSompi: totalGrossSompi.toString(),
          feeTicketId: params.feeTicketId ?? null,
          feeTicketApplied: totalProtocolFeeSompi < totalQuotedProtocolFeeSompi,
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildWrappedSweepBidsPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const orderUtxos = Array.isArray(params.activeTargetOrderUtxos)
      ? params.activeTargetOrderUtxos
      : [];
    const holderUtxos = Array.isArray(params.activeWrappedHolderUtxos)
      ? params.activeWrappedHolderUtxos
      : [];
    const ticketUtxos = Array.isArray(params.activeFeeTicketUtxos)
      ? params.activeFeeTicketUtxos
      : [];
    const fills = Array.isArray(params.fills) ? params.fills : [];
    if (fills.length < 2) {
      throw new Error("sweep bids requires at least two fill legs");
    }
    if (orderUtxos.length !== fills.length) {
      throw new Error("active bid order UTXOs must match sweep fills");
    }
    const totalFillAmount = fills.reduce(
      (sum, fill) =>
        sum + parsePositiveU64(fill.tokenAmount, "fill tokenAmount"),
      0n,
    );
    const singleHolderUtxo = params.activeWrappedHolderUtxo || null;
    if (singleHolderSweepCoversTotal(singleHolderUtxo, totalFillAmount)) {
      return buildWrappedSweepBidsOneHolderPskt(input);
    }
    if (holderUtxos.length !== fills.length) {
      throw new Error(
        "sweep bids requires either one seller holder UTXO covering the full sweep amount or one distinct seller holder UTXO per fill leg",
      );
    }
    assertUniqueSweepBidOutpoints(
      [...orderUtxos, ...holderUtxos],
      "paired-holder sweep bids",
    );

    const canonicalTokenId = requireHex32(
      params.canonicalCovenantId || params.covenantId,
      "canonical token id",
    );
    const wrapperId = requireHex32(
      params.wrappedMarketId || params.wrapperId,
      "wrapped market id",
    );
    const sellerOwner = requireHex32(request.owner?.kcc20Owner, "seller owner");
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const tokenOutputSompi = parseU64(
      env.KCC20_FILL_TOKEN_OUTPUT_SOMPI ||
        DEFAULT_TOKEN_OUTPUT_SOMPI.toString(),
      "tokenOutputSompi",
    );
    const priorityFee = parseU64(
      env.KCC20_FILL_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const wrappedArtifacts = await readWrappedArtifacts();
    const wrappedArtifact = wrappedArtifacts[0].artifact;
    const ticketArtifacts = params.feeTicketId
      ? await readFeeTicketArtifacts()
      : null;

    const usedHolderOutpoints = new Set();
    const legs = fills.map((fill, index) => {
      const bidUtxo = orderUtxos[index];
      const holderUtxo = holderUtxos[index];
      if (!bidUtxo) {
        throw new Error(`missing bid order UTXO for sweep leg ${index}`);
      }
      if (!holderUtxo) {
        throw new Error(`missing seller holder UTXO for sweep leg ${index}`);
      }
      const holderOutpoint = `${holderUtxo.txidHex}:${holderUtxo.vout}`;
      if (usedHolderOutpoints.has(holderOutpoint)) {
        throw new Error(
          `seller holder UTXO ${holderOutpoint} is reused across sweep legs`,
        );
      }
      usedHolderOutpoints.add(holderOutpoint);
      const bidState = kcc20V3WrappedStateFromUtxo(
        bidUtxo,
        canonicalTokenId,
        request.owner,
      );
      const holderState = kcc20V3WrappedStateFromUtxo(
        holderUtxo,
        canonicalTokenId,
        request.owner,
      );
      if (bidState.mode !== 3) {
        throw new Error(
          `sweep leg ${index} requires a KCC20Orderbook bid order UTXO`,
        );
      }
      if (holderState.mode !== 0) {
        throw new Error(
          `sweep leg ${index} requires a KCC20Orderbook holder UTXO`,
        );
      }
      if (holderState.priceScale !== bidState.priceScale) {
        throw new Error(
          `sweep leg ${index} holder price scale does not match bid`,
        );
      }
      if (bytesToHex(holderState.ownerIdentifier) !== sellerOwner) {
        throw new Error(
          `sweep leg ${index} holder UTXO is not owned by authenticated wallet`,
        );
      }
      const fillAmount = parsePositiveU64(fill.tokenAmount, "fill tokenAmount");
      const unitPriceSompi = parsePositiveU64(
        fill.unitPriceSompi,
        "fill unitPriceSompi",
      );
      assertSweepBidPricePriority(
        unitPriceSompi,
        index,
        index > 0 ? fills[index - 1].unitPriceSompi : unitPriceSompi,
      );
      if (bidState.unitPriceSompi !== unitPriceSompi) {
        throw new Error(
          `sweep leg ${index} unit price does not match bid order`,
        );
      }
      if (bidState.amount < fillAmount) {
        throw new Error(
          `sweep leg ${index} tokenAmount exceeds bid order amount`,
        );
      }
      if (holderState.amount < fillAmount) {
        throw new Error(
          `sweep leg ${index} tokenAmount exceeds selected holder amount`,
        );
      }
      const grossSompi = exactGrossSompi(
        fillAmount,
        unitPriceSompi,
        bidState.priceScale,
        `sweep bid leg ${index}`,
      );
      if (grossSompi < MIN_FILL_GROSS_SOMPI) {
        throw minimumFillGrossError(
          `sweep leg ${index} gross value is below minimum fill value`,
        );
      }
      const remainingBidAmount = bidState.amount - fillAmount;
      if (remainingBidAmount > 0n) {
        assertPartialBuyerHolderOutputSompi(tokenOutputSompi);
      }
      assertPartialSweepLegIsFinal(remainingBidAmount, index, fills.length);
      if (
        remainingBidAmount > 0n &&
        exactGrossSompi(
          remainingBidAmount,
          bidState.unitPriceSompi,
          bidState.priceScale,
          `sweep bid leg ${index} remainder`,
        ) < MIN_FILL_GROSS_SOMPI
      ) {
        throw remainingOrderBelowMinimumError(
          `sweep leg ${index} remaining bid value would be below minimum fill value`,
        );
      }
      const remainingHolderAmount = holderState.amount - fillAmount;
      const bidArtifactInfo = selectWrappedArtifactForUtxo({
        kw: kaspaWasm,
        artifacts: wrappedArtifacts,
        state: bidState,
        utxo: bidUtxo,
        network,
        label: `KCC20Orderbook bid order UTXO ${index} address`,
      });
      const holderArtifactInfo = selectWrappedArtifactForUtxo({
        kw: kaspaWasm,
        artifacts: wrappedArtifacts,
        state: holderState,
        utxo: holderUtxo,
        network,
        label: `KCC20Orderbook seller holder UTXO ${index} address`,
      });
      if (bidArtifactInfo.version !== holderArtifactInfo.version) {
        throw new Error(
          `sweep leg ${index} mixes bid artifact ${bidArtifactInfo.version} with holder artifact ${holderArtifactInfo.version}`,
        );
      }
      return {
        fill,
        bidUtxo,
        holderUtxo,
        bidState,
        holderState,
        bidScript: bidArtifactInfo.script,
        holderScript: holderArtifactInfo.script,
        bidAddress: bidArtifactInfo.address,
        holderAddress: holderArtifactInfo.address,
        artifactInfo: bidArtifactInfo,
        fillAmount,
        unitPriceSompi,
        grossSompi,
        protocolFeeSompi: calculateFeeSplit(grossSompi).fee,
        remainingBidAmount,
        remainingHolderAmount,
        bidTxid: requireHex32(bidUtxo.txidHex, `bid ${index} txid`),
        bidVout: parseVout(bidUtxo.vout, `bid ${index} vout`),
        holderTxid: requireHex32(holderUtxo.txidHex, `holder ${index} txid`),
        holderVout: parseVout(holderUtxo.vout, `holder ${index} vout`),
      };
    });

    const totalGrossSompi = legs.reduce((sum, leg) => sum + leg.grossSompi, 0n);
    const sharedFeeTicket = prepareSharedFeeTicketForSweep({
      params,
      ticketUtxos,
      orderStates: legs.map((leg) => leg.bidState),
      owner: sellerOwner,
      ticketArtifacts,
      network,
      label: "sweep bids",
    });
    const computeBudgetArtifacts =
      assertSweepBidComputeBudgetArtifactCompatibility(
        wrappedArtifact,
        sharedFeeTicket?.artifact,
      );
    const totalQuotedProtocolFeeSompi = legs.reduce(
      (sum, leg) => sum + leg.protocolFeeSompi,
      0n,
    );
    const totalProtocolFeeSompi = sharedFeeTicket
      ? 0n
      : totalQuotedProtocolFeeSompi;
    const computeBudgetLayout = sweepBidComputeBudgetLayout(
      legs.length,
      "paired-holder",
      Boolean(sharedFeeTicket),
    );
    assertSweepBidReservedComputeMassStandard(
      computeBudgetLayout,
      "paired-holder sweep bids",
    );
    const quotedGrossSompi = parsePositiveU64(params.grossSompi, "grossSompi");
    if (totalGrossSompi !== quotedGrossSompi) {
      throw new Error("sweep bid gross total does not match route quote");
    }
    const quotedProtocolFeeSompi = parseQuotedProtocolFeeSompi(params);
    if (totalQuotedProtocolFeeSompi !== quotedProtocolFeeSompi) {
      throw new Error("sweep bid protocol fee does not match route quote");
    }

    const kw = kaspaWasm;
    const {
      Encoding,
      RpcClient,
      Transaction,
      TransactionOutput,
      payToAddressScript,
    } = kw;
    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [
        bidEntryResults,
        holderEntryResults,
        ticketEntryResult,
        walletUtxos,
      ] = await Promise.all([
        Promise.all(
          legs.map((leg) => getUtxosByAddresses(rpc, [leg.bidAddress])),
        ),
        Promise.all(
          legs.map((leg) => getUtxosByAddresses(rpc, [leg.holderAddress])),
        ),
        sharedFeeTicket
          ? getUtxosByAddresses(rpc, [sharedFeeTicket.address])
          : { entries: [] },
        getUtxosByAddresses(rpc, [walletAddress]),
      ]);
      const sharedTicketEntry = sharedFeeTicket
        ? findUtxoEntry(
            ticketEntryResult.entries,
            sharedFeeTicket.txid,
            sharedFeeTicket.vout,
          )
        : null;
      if (sharedFeeTicket && !sharedTicketEntry) {
        throw new Error(`FeeTicket UTXO ${sharedFeeTicket.outpoint} not found`);
      }
      const resolvedLegs = legs.map((leg, index) => {
        const bidEntry = findUtxoEntry(
          bidEntryResults[index].entries,
          leg.bidTxid,
          leg.bidVout,
        );
        if (!bidEntry) {
          throw new Error(
            `bid order UTXO ${leg.bidTxid}:${leg.bidVout} not found`,
          );
        }
        const holderEntry = findUtxoEntry(
          holderEntryResults[index].entries,
          leg.holderTxid,
          leg.holderVout,
        );
        if (!holderEntry) {
          throw new Error(
            `seller holder UTXO ${leg.holderTxid}:${leg.holderVout} not found`,
          );
        }
        return {
          ...leg,
          bidEntry,
          holderEntry,
          bidSpendCovenantId: covenantIdFromUtxoEntry(bidEntry) ?? wrapperId,
          holderSpendCovenantId:
            covenantIdFromUtxoEntry(holderEntry) ?? wrapperId,
        };
      });

      const outputs = [];
      const metadataFills = [];
      for (const [legIndex, leg] of resolvedLegs.entries()) {
        const refundAware = wrappedArtifactRefundsHolderDeposits(
          leg.artifactInfo,
        );
        const bidDepositSompi = refundAware
          ? refundableBidDepositSompi(
              utxoAmountSompi(leg.bidEntry),
              leg.bidState.amount,
              leg.bidState.unitPriceSompi,
              leg.bidState.priceScale,
            )
          : 0n;
        if (refundAware && bidDepositSompi < tokenOutputSompi) {
          throw new Error(
            `sweep leg ${legIndex} bid holder deposit ${bidDepositSompi} is below ${tokenOutputSompi}`,
          );
        }
        const bidInputIndex = legIndex * 2;
        const sellerInputIndex = bidInputIndex + 1;
        const ticketInputIndex = sharedTicketEntry
          ? resolvedLegs.length * 2
          : -1;
        const feeSompi = sharedTicketEntry ? 0n : leg.protocolFeeSompi;
        const buyerHolderDepositSompi =
          refundAware && leg.remainingBidAmount === 0n
            ? bidDepositSompi
            : tokenOutputSompi;
        const sellerHolderTopUpSompi = sellerFundedHolderTopUpSompi(
          bidDepositSompi,
          buyerHolderDepositSompi,
          leg.remainingBidAmount,
        );
        const buyerTokenOutputIndex = outputs.length;
        outputs.push(
          wrappedTokenOutput(
            kw,
            leg.artifactInfo.artifact,
            {
              ...leg.bidState,
              amount: leg.fillAmount,
              mode: 0,
              unitPriceSompi: 0n,
            },
            buyerHolderDepositSompi,
            leg.holderSpendCovenantId,
            sellerInputIndex,
          ),
        );

        let bidOutputIndex = -1;
        if (leg.remainingBidAmount > 0n) {
          bidOutputIndex = outputs.length;
          outputs.push(
            wrappedTokenOutput(
              kw,
              leg.artifactInfo.artifact,
              { ...leg.bidState, amount: leg.remainingBidAmount, mode: 3 },
              exactGrossSompi(
                leg.remainingBidAmount,
                leg.bidState.unitPriceSompi,
                leg.bidState.priceScale,
                `sweep bid leg ${legIndex} output`,
              ) + bidDepositSompi,
              leg.bidSpendCovenantId,
              bidInputIndex,
            ),
          );
        }

        let sellerChangeOutputIndex = -1;
        if (leg.remainingHolderAmount > 0n) {
          sellerChangeOutputIndex = outputs.length;
          outputs.push(
            wrappedTokenOutput(
              kw,
              leg.artifactInfo.artifact,
              {
                ...leg.holderState,
                amount: leg.remainingHolderAmount,
                mode: 0,
                unitPriceSompi: 0n,
              },
              refundAware ? utxoAmountSompi(leg.holderEntry) : tokenOutputSompi,
              leg.holderSpendCovenantId,
              sellerInputIndex,
            ),
          );
        }

        const sellerHolderRefundOutputIndex = -1;
        const sellerHolderRefundSompi =
          refundAware && leg.remainingHolderAmount === 0n
            ? utxoAmountSompi(leg.holderEntry)
            : 0n;

        const sellerValueSompi =
          refundAware || leg.remainingBidAmount > 0n
            ? leg.grossSompi - feeSompi
            : utxoAmountSompi(leg.bidEntry) - feeSompi;
        const sellerOutputIndex = outputs.length;
        if (sellerValueSompi > 0n) {
          outputs.push(
            new TransactionOutput(
              sellerValueSompi,
              p2pkScriptPubKey(kw, sellerOwner),
            ),
          );
        }
        let feeOutputIndex = -1;
        if (feeSompi > 0n) {
          feeOutputIndex = outputs.length;
          outputs.push(
            new TransactionOutput(
              feeSompi,
              p2pkScriptPubKey(kw, KCC20_ORDERBOOK_PROTOCOL_FEE_RECIPIENT),
            ),
          );
        }
        metadataFills.push({
          orderId: `${leg.bidTxid}:${leg.bidVout}`,
          holderOutpoint: `${leg.holderTxid}:${leg.holderVout}`,
          tokenAmount: leg.fillAmount.toString(),
          unitPriceSompi: leg.unitPriceSompi.toString(),
          totalPriceSompi: leg.grossSompi.toString(),
          protocolFeeSompi: feeSompi.toString(),
          quotedProtocolFeeSompi: leg.protocolFeeSompi.toString(),
          bidInputIndex,
          sellerInputIndex,
          buyerTokenOutputIndex,
          bidOutputIndex,
          sellerChangeOutputIndex,
          sellerHolderRefundOutputIndex,
          sellerHolderRefundSompi: sellerHolderRefundSompi.toString(),
          buyerHolderDepositSompi: buyerHolderDepositSompi.toString(),
          bidHolderDepositSompi: bidDepositSompi.toString(),
          sellerFundedHolderTopUpSompi: sellerHolderTopUpSompi.toString(),
          sellerOutputIndex,
          feeOutputIndex,
          feeTicketInputIndex: ticketInputIndex,
          feeTicketOutpoint: sharedFeeTicket?.outpoint ?? null,
          feeTicketRefundOutputIndex: -1,
          feeTicketRefundSompi: "0",
          remainingBidAmount: leg.remainingBidAmount.toString(),
          remainingHolderAmount: leg.remainingHolderAmount.toString(),
          wrappedArtifactVersion: leg.artifactInfo.version,
        });
      }

      if (sharedTicketEntry) {
        const feeTicketRefund = appendFeeTicketRefundOutput(
          kw,
          outputs,
          sharedFeeTicket.state,
          sharedTicketEntry,
        );
        for (const metadata of metadataFills) {
          metadata.feeTicketRefundOutputIndex = feeTicketRefund.outputIndex;
          metadata.feeTicketRefundSompi = feeTicketRefund.sompi.toString();
        }
      }
      const sellerOutputsEndIndex = outputs.length - 1;
      metadataFills.forEach((metadata) => {
        const refundSompi = BigInt(metadata.sellerHolderRefundSompi);
        metadata.sellerOutputsEndIndex = sellerOutputsEndIndex;
        if (refundSompi > 0n) {
          metadata.sellerHolderRefundOutputIndex = outputs.length;
          outputs.push(
            new TransactionOutput(
              refundSompi,
              p2pkScriptPubKey(kw, sellerOwner),
            ),
          );
        }
      });

      const outputSompi = outputs.reduce(
        (sum, output) => sum + BigInt(output.value),
        0n,
      );
      const totalSellerFundedHolderTopUpSompi = metadataFills.reduce(
        (sum, fill) => sum + BigInt(fill.sellerFundedHolderTopUpSompi),
        0n,
      );
      const covenantInputSompi =
        resolvedLegs.reduce(
          (sum, leg) =>
            sum +
            utxoAmountSompi(leg.bidEntry) +
            utxoAmountSompi(leg.holderEntry),
          0n,
        ) + (sharedTicketEntry ? utxoAmountSompi(sharedTicketEntry) : 0n);
      const requiredFunding =
        outputSompi + priorityFee > covenantInputSompi
          ? outputSompi + priorityFee - covenantInputSompi + 10_000n
          : priorityFee + 10_000n;
      let fundingEntry;
      try {
        fundingEntry = selectFundingEntry(walletUtxos.entries, requiredFunding);
      } catch (error) {
        if (totalSellerFundedHolderTopUpSompi > 0n) {
          throw kcc20PsktBuilderError(
            `no single funding UTXO can cover the ${totalSellerFundedHolderTopUpSompi} sompi buyer holder top-up and transaction fee`,
            "SELLER_HOLDER_TOP_UP_NOT_AVAILABLE",
            {
              sellerFundedHolderTopUpSompi: totalSellerFundedHolderTopUpSompi,
              requiredFundingSompi: requiredFunding,
            },
          );
        }
        throw error;
      }
      const fundingInputIndex =
        resolvedLegs.length * 2 + (sharedTicketEntry ? 1 : 0);
      const change =
        covenantInputSompi +
        utxoAmountSompi(fundingEntry) -
        outputSompi -
        priorityFee;
      let fundingChangeOutputIndex = -1;
      if (change > 10_000n) {
        fundingChangeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(change, payToAddressScript(walletAddress)),
        );
      }

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          ...resolvedLegs.flatMap((leg) => [
            {
              previousOutpoint: leg.bidEntry.outpoint,
              utxo: leg.bidEntry,
              sequence: 0n,
              sigOpCount: 0,
              computeBudget:
                KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.bidOrder,
            },
            {
              previousOutpoint: leg.holderEntry.outpoint,
              utxo: leg.holderEntry,
              sequence: 0n,
              sigOpCount: 0,
              computeBudget:
                KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.holder,
            },
          ]),
          ...(sharedTicketEntry
            ? [
                {
                  previousOutpoint: sharedTicketEntry.outpoint,
                  utxo: sharedTicketEntry,
                  sequence: 0n,
                  sigOpCount: 0,
                  computeBudget:
                    KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.feeTicket,
                },
              ]
            : []),
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget:
              KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.funding,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildWrappedSweepPayload({
          canonicalTokenId,
          wrapperId,
          side: "sell",
          fills: metadataFills,
        }),
      });
      const computeBudgetProfile = applySweepBidComputeBudgetProfile(
        unsignedTx,
        computeBudgetLayout,
      );
      assertUniqueTransactionInputOutpoints(
        unsignedTx,
        "paired-holder sweep bids",
      );
      const scripts = [];
      resolvedLegs.forEach((leg, legIndex) => {
        const metadata = metadataFills[legIndex];
        const bidPrefix = buildKcc20OrderbookFillBidSigScript(kw, {
          sellerTokenInputIndex: metadata.sellerInputIndex,
          fillAmount: leg.fillAmount,
          buyerTokenOutputIndex: metadata.buyerTokenOutputIndex,
          bidOutputIndex: metadata.bidOutputIndex,
          sellerOutputIndex: metadata.sellerOutputIndex,
          seller: hexToBytes(sellerOwner),
          ticketInputIndex: metadata.feeTicketInputIndex,
        });
        unsignedTx.inputs[metadata.bidInputIndex].signatureScript =
          encodeCovenantP2shSignatureScript(bidPrefix, leg.bidScript);

        scripts.push({
          inputIndex: metadata.sellerInputIndex,
          scriptHex: bytesToHex(leg.holderScript),

          signType: 1,
          signatureScript: {
            mode: "signature-first-args",
            args: [
              { type: "data", hex: bytesToHex(leg.bidState.ownerIdentifier) },
              { type: "i64", value: leg.fillAmount.toString() },
              { type: "i64", value: String(metadata.buyerTokenOutputIndex) },
              { type: "i64", value: String(metadata.sellerChangeOutputIndex) },
              ...(wrappedArtifactRefundsHolderDeposits(leg.artifactInfo)
                ? [
                    {
                      type: "i64",
                      value: String(metadata.sellerHolderRefundOutputIndex),
                    },
                    {
                      type: "i64",
                      value: String(metadata.sellerOutputsEndIndex),
                    },
                  ]
                : []),
              dispatchTagTemplateArg(
                leg.artifactInfo.artifact,
                "sellIntoBidByOwnerSig",
              ),
            ],
          },
        });
      });
      if (sharedFeeTicket) {
        scripts.push(
          feeTicketBurnScriptHint(
            metadataFills[0].feeTicketInputIndex,
            sharedFeeTicket.script,
            sharedFeeTicket.burnDispatchTag,
            metadataFills[0].feeTicketRefundOutputIndex,
            sharedFeeTicket.burnTakesRefundOutput,
          ),
        );
      }

      const signedShapeDetails = {
        legs: resolvedLegs,
        metadataFills,
        sharedFeeTicket,
        feeTicketInputIndex: metadataFills[0]?.feeTicketInputIndex ?? -1,
        fundingInputIndex,
      };
      const feeResult = transactionWithPredictedSignedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        (transaction) =>
          predictPairedHolderSweepBidSignedTransaction(kw, {
            ...signedShapeDetails,
            transaction,
          }),
      );
      const feeAdjustedTx = feeResult.transaction;
      const nonContextualMass = assertTransactionComputeMassStandard(
        feeResult.predictedTransaction,
        "paired-holder sweep bids",
        {
          selectedLegCount: metadataFills.length,
          computeBudgetProfile:
            KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.version,
        },
      );
      const storageMass = assertTransactionStorageMassStandard(
        feeAdjustedTx,
        "paired-holder sweep bids",
        {
          selectedLegCount: metadataFills.length,
          tokenOutputSompi,
        },
      );
      const transactionMass =
        nonContextualMass > storageMass ? nonContextualMass : storageMass;
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "KCC20Orderbook sweep bids PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        scripts,
        submitTransactionSupported: true,
        metadata: {
          builderKey: "kcc20orderbook.sweep-bids",
          contract: "KCC20Orderbook",
          network,
          walletAddress,
          canonicalTokenId,
          wrapperId,
          requestedWrapperId: wrapperId,
          covenantId: wrapperId,
          side: "sell",
          executionMode: "multi",
          sweepBidMode: "paired-holder",
          selectedLegCount: metadataFills.length,
          computeBudgetProfile,
          computeBudgetArtifacts,
          transactionMass: transactionMass.toString(),
          requiredTransactionFeeSompi: feeResult.requiredFeeSompi.toString(),
          paidTransactionFeeSompi: feeResult.paidFeeSompi.toString(),
          fills: metadataFills,
          feeOutputIndexes: metadataFills.map((fill) => fill.feeOutputIndex),
          fundingInputIndex,
          grossSompi: totalGrossSompi.toString(),
          protocolFeeSompi: totalProtocolFeeSompi.toString(),
          quotedProtocolFeeSompi: totalQuotedProtocolFeeSompi.toString(),
          feePayer: "seller",
          feeTiming: "fill",
          buyerPaysSompi: totalGrossSompi.toString(),
          sellerReceivesSompi: (
            totalGrossSompi - totalProtocolFeeSompi
          ).toString(),
          feeTicketId: params.feeTicketId ?? null,
          feeTicketApplied: totalProtocolFeeSompi < totalQuotedProtocolFeeSompi,
          sellerFundedHolderTopUpSompi:
            totalSellerFundedHolderTopUpSompi.toString(),
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildWrappedSweepBidsOneHolderPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const orderUtxos = Array.isArray(params.activeTargetOrderUtxos)
      ? params.activeTargetOrderUtxos
      : [];
    const ticketUtxos = Array.isArray(params.activeFeeTicketUtxos)
      ? params.activeFeeTicketUtxos
      : [];
    const fills = Array.isArray(params.fills) ? params.fills : [];
    const holderUtxo = params.activeWrappedHolderUtxo;
    if (fills.length < 2) {
      throw new Error(
        "single-holder sweep bids requires at least two fill legs",
      );
    }
    if (!holderUtxo) {
      throw new Error("single-holder sweep bids requires a seller holder UTXO");
    }
    if (orderUtxos.length !== fills.length) {
      throw new Error("active bid order UTXOs must match sweep fills");
    }
    assertUniqueSweepBidOutpoints(
      [...orderUtxos, holderUtxo],
      "single-holder sweep bids",
    );

    const canonicalTokenId = requireHex32(
      params.canonicalCovenantId || params.covenantId,
      "canonical token id",
    );
    const wrapperId = requireHex32(
      params.wrappedMarketId || params.wrapperId,
      "wrapped market id",
    );
    const sellerOwner = requireHex32(request.owner?.kcc20Owner, "seller owner");
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const configuredTokenOutputSompi = parseU64(
      env.KCC20_FILL_TOKEN_OUTPUT_SOMPI ||
        DEFAULT_TOKEN_OUTPUT_SOMPI.toString(),
      "tokenOutputSompi",
    );
    const priorityFee = parseU64(
      env.KCC20_FILL_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const wrappedArtifacts = await readWrappedArtifacts();
    const ticketArtifacts = params.feeTicketId
      ? await readFeeTicketArtifacts()
      : null;
    const holderState = kcc20V3WrappedStateFromUtxo(
      holderUtxo,
      canonicalTokenId,
      request.owner,
    );
    if (holderState.mode !== 0) {
      throw new Error(
        "single-holder sweep bids requires a KCC20Orderbook holder UTXO",
      );
    }
    if (bytesToHex(holderState.ownerIdentifier) !== sellerOwner) {
      throw new Error("single-holder sweep bids holder is not owned by wallet");
    }
    const holderArtifactInfo = selectWrappedArtifactForUtxo({
      kw: kaspaWasm,
      artifacts: wrappedArtifacts,
      state: holderState,
      utxo: holderUtxo,
      network,
      label: "KCC20Orderbook seller holder UTXO address",
    });
    const wrappedArtifact = holderArtifactInfo.artifact;
    const holderScript = holderArtifactInfo.script;
    const holderAddress = holderArtifactInfo.address;
    const refundAware =
      wrappedArtifactRefundsHolderDeposits(holderArtifactInfo);
    const singleHolderMaxSweepBidLegs = wrappedArtifactSupportsEntrypoint(
      holderArtifactInfo,
      "sellIntoBids10ByOwnerSig",
    )
      ? KCC20_ORDERBOOK_MAX_EXPANDED_SWEEP_BID_LEGS
      : KCC20_ORDERBOOK_MAX_SWEEP_BID_LEGS;
    if (fills.length > singleHolderMaxSweepBidLegs) {
      throw new Error(
        `single-holder sweep bids supports at most ${singleHolderMaxSweepBidLegs} fill legs for this wrapped artifact`,
      );
    }
    const tokenOutputSompi = singleHolderSweepTokenOutputSompi(
      fills.length,
      configuredTokenOutputSompi,
    );
    const selectedScriptLegCapacity = singleHolderSweepScriptLegCapacity(
      fills.length,
      singleHolderMaxSweepBidLegs,
    );

    const legs = fills.map((fill, index) => {
      const bidUtxo = orderUtxos[index];
      if (!bidUtxo) {
        throw new Error(`missing bid order UTXO for sweep leg ${index}`);
      }
      const bidState = kcc20V3WrappedStateFromUtxo(
        bidUtxo,
        canonicalTokenId,
        request.owner,
      );
      if (bidState.mode !== 3) {
        throw new Error(
          `sweep leg ${index} requires a KCC20Orderbook bid order UTXO`,
        );
      }
      if (bidState.priceScale !== holderState.priceScale) {
        throw new Error(
          `sweep leg ${index} holder price scale does not match bid`,
        );
      }
      const fillAmount = parsePositiveU64(fill.tokenAmount, "fill tokenAmount");
      const unitPriceSompi = parsePositiveU64(
        fill.unitPriceSompi,
        "fill unitPriceSompi",
      );
      assertSweepBidPricePriority(
        unitPriceSompi,
        index,
        index > 0 ? fills[index - 1].unitPriceSompi : unitPriceSompi,
      );
      if (bidState.unitPriceSompi !== unitPriceSompi) {
        throw new Error(
          `sweep leg ${index} unit price does not match bid order`,
        );
      }
      if (bidState.amount < fillAmount) {
        throw new Error(
          `sweep leg ${index} tokenAmount exceeds bid order amount`,
        );
      }
      const grossSompi = exactGrossSompi(
        fillAmount,
        unitPriceSompi,
        bidState.priceScale,
        `single-holder sweep bid leg ${index}`,
      );
      if (grossSompi < MIN_FILL_GROSS_SOMPI) {
        throw minimumFillGrossError(
          `sweep leg ${index} gross value is below minimum fill value`,
        );
      }
      const remainingBidAmount = bidState.amount - fillAmount;
      if (remainingBidAmount > 0n) {
        assertPartialBuyerHolderOutputSompi(tokenOutputSompi);
      }
      assertPartialSweepLegIsFinal(remainingBidAmount, index, fills.length);
      if (
        remainingBidAmount > 0n &&
        exactGrossSompi(
          remainingBidAmount,
          bidState.unitPriceSompi,
          bidState.priceScale,
          `single-holder sweep bid leg ${index} remainder`,
        ) < MIN_FILL_GROSS_SOMPI
      ) {
        throw remainingOrderBelowMinimumError(
          `sweep leg ${index} remaining bid value would be below minimum fill value`,
        );
      }
      const bidArtifactInfo = selectWrappedArtifactForUtxo({
        kw: kaspaWasm,
        artifacts: wrappedArtifacts,
        state: bidState,
        utxo: bidUtxo,
        network,
        label: `KCC20Orderbook bid order UTXO ${index} address`,
      });
      if (bidArtifactInfo.version !== holderArtifactInfo.version) {
        throw new Error(
          `sweep leg ${index} mixes bid artifact ${bidArtifactInfo.version} with holder artifact ${holderArtifactInfo.version}`,
        );
      }
      return {
        fill,
        bidUtxo,
        bidState,
        bidScript: bidArtifactInfo.script,
        bidAddress: bidArtifactInfo.address,
        fillAmount,
        unitPriceSompi,
        grossSompi,
        protocolFeeSompi: calculateFeeSplit(grossSompi).fee,
        remainingBidAmount,
        bidTxid: requireHex32(bidUtxo.txidHex, `bid ${index} txid`),
        bidVout: parseVout(bidUtxo.vout, `bid ${index} vout`),
      };
    });

    const totalFillAmount = legs.reduce((sum, leg) => sum + leg.fillAmount, 0n);
    if (holderState.amount < totalFillAmount) {
      throw new Error(
        "single-holder sweep amount exceeds seller holder balance",
      );
    }
    const totalGrossSompi = legs.reduce((sum, leg) => sum + leg.grossSompi, 0n);
    const sharedFeeTicket = prepareSharedFeeTicketForSweep({
      params,
      ticketUtxos,
      orderStates: legs.map((leg) => leg.bidState),
      owner: sellerOwner,
      ticketArtifacts,
      network,
      label: "single-holder sweep bids",
    });
    const computeBudgetArtifacts =
      assertSweepBidComputeBudgetArtifactCompatibility(
        wrappedArtifact,
        sharedFeeTicket?.artifact,
      );
    const totalQuotedProtocolFeeSompi = legs.reduce(
      (sum, leg) => sum + leg.protocolFeeSompi,
      0n,
    );
    const totalProtocolFeeSompi = sharedFeeTicket
      ? 0n
      : totalQuotedProtocolFeeSompi;
    const computeBudgetLayout = sweepBidComputeBudgetLayout(
      legs.length,
      "single-holder",
      Boolean(sharedFeeTicket),
    );
    assertSweepBidReservedComputeMassStandard(
      computeBudgetLayout,
      "single-holder sweep bids",
    );
    const quotedGrossSompi = parsePositiveU64(params.grossSompi, "grossSompi");
    if (totalGrossSompi !== quotedGrossSompi) {
      throw new Error("sweep bid gross total does not match route quote");
    }
    const quotedProtocolFeeSompi = parseQuotedProtocolFeeSompi(params);
    if (totalQuotedProtocolFeeSompi !== quotedProtocolFeeSompi) {
      throw new Error("sweep bid protocol fee does not match route quote");
    }

    const kw = kaspaWasm;
    const {
      Encoding,
      RpcClient,
      Transaction,
      TransactionOutput,
      payToAddressScript,
    } = kw;
    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [bidEntryResults, holderUtxos, ticketEntryResult, walletUtxos] =
        await Promise.all([
          Promise.all(
            legs.map((leg) => getUtxosByAddresses(rpc, [leg.bidAddress])),
          ),
          getUtxosByAddresses(rpc, [holderAddress]),
          sharedFeeTicket
            ? getUtxosByAddresses(rpc, [sharedFeeTicket.address])
            : { entries: [] },
          getUtxosByAddresses(rpc, [walletAddress]),
        ]);
      const sharedTicketEntry = sharedFeeTicket
        ? findUtxoEntry(
            ticketEntryResult.entries,
            sharedFeeTicket.txid,
            sharedFeeTicket.vout,
          )
        : null;
      if (sharedFeeTicket && !sharedTicketEntry) {
        throw new Error(`FeeTicket UTXO ${sharedFeeTicket.outpoint} not found`);
      }
      const holderTxid = requireHex32(holderUtxo.txidHex, "holder txid");
      const holderVout = parseVout(holderUtxo.vout, "holder vout");
      const holderEntry = findUtxoEntry(
        holderUtxos.entries,
        holderTxid,
        holderVout,
      );
      if (!holderEntry) {
        throw new Error(
          `seller holder UTXO ${holderTxid}:${holderVout} not found`,
        );
      }
      const resolvedLegs = legs.map((leg, index) => {
        const bidEntry = findUtxoEntry(
          bidEntryResults[index].entries,
          leg.bidTxid,
          leg.bidVout,
        );
        if (!bidEntry) {
          throw new Error(
            `bid order UTXO ${leg.bidTxid}:${leg.bidVout} not found`,
          );
        }
        return {
          ...leg,
          bidEntry,
          bidSpendCovenantId: covenantIdFromUtxoEntry(bidEntry) ?? wrapperId,
        };
      });
      const holderSpendCovenantId =
        covenantIdFromUtxoEntry(holderEntry) ?? wrapperId;
      const sellerInputIndex = resolvedLegs.length;
      const outputs = [];
      const metadataFills = [];

      for (const [legIndex, leg] of resolvedLegs.entries()) {
        const bidDepositSompi = refundAware
          ? refundableBidDepositSompi(
              utxoAmountSompi(leg.bidEntry),
              leg.bidState.amount,
              leg.bidState.unitPriceSompi,
              leg.bidState.priceScale,
            )
          : 0n;
        if (refundAware && bidDepositSompi < tokenOutputSompi) {
          throw new Error(
            `sweep leg ${legIndex} bid holder deposit ${bidDepositSompi} is below required ${tokenOutputSompi}`,
          );
        }
        const ticketInputIndex = sharedTicketEntry
          ? resolvedLegs.length + 1
          : -1;
        const feeSompi = sharedTicketEntry ? 0n : leg.protocolFeeSompi;
        const buyerHolderDepositSompi =
          refundAware && leg.remainingBidAmount === 0n
            ? bidDepositSompi
            : tokenOutputSompi;
        const sellerHolderTopUpSompi = sellerFundedHolderTopUpSompi(
          bidDepositSompi,
          buyerHolderDepositSompi,
          leg.remainingBidAmount,
        );
        const buyerTokenOutputIndex = outputs.length;
        outputs.push(
          wrappedTokenOutput(
            kw,
            wrappedArtifact,
            {
              ...leg.bidState,
              amount: leg.fillAmount,
              mode: 0,
              unitPriceSompi: 0n,
            },
            buyerHolderDepositSompi,
            holderSpendCovenantId,
            sellerInputIndex,
          ),
        );
        let bidOutputIndex = -1;
        if (leg.remainingBidAmount > 0n) {
          bidOutputIndex = outputs.length;
          outputs.push(
            wrappedTokenOutput(
              kw,
              wrappedArtifact,
              { ...leg.bidState, amount: leg.remainingBidAmount, mode: 3 },
              exactGrossSompi(
                leg.remainingBidAmount,
                leg.bidState.unitPriceSompi,
                leg.bidState.priceScale,
                `single-holder sweep bid leg ${legIndex} output`,
              ) + bidDepositSompi,
              leg.bidSpendCovenantId,
              legIndex,
            ),
          );
        }
        const sellerValueSompi =
          refundAware || leg.remainingBidAmount > 0n
            ? leg.grossSompi - feeSompi
            : utxoAmountSompi(leg.bidEntry) - feeSompi;
        const sellerOutputIndex = outputs.length;
        if (sellerValueSompi > 0n) {
          outputs.push(
            new TransactionOutput(
              sellerValueSompi,
              p2pkScriptPubKey(kw, sellerOwner),
            ),
          );
        }
        let feeOutputIndex = -1;
        if (feeSompi > 0n) {
          feeOutputIndex = outputs.length;
          outputs.push(
            new TransactionOutput(
              feeSompi,
              p2pkScriptPubKey(kw, KCC20_ORDERBOOK_PROTOCOL_FEE_RECIPIENT),
            ),
          );
        }
        metadataFills.push({
          orderId: `${leg.bidTxid}:${leg.bidVout}`,
          holderOutpoint: `${holderTxid}:${holderVout}`,
          tokenAmount: leg.fillAmount.toString(),
          unitPriceSompi: leg.unitPriceSompi.toString(),
          totalPriceSompi: leg.grossSompi.toString(),
          protocolFeeSompi: feeSompi.toString(),
          quotedProtocolFeeSompi: leg.protocolFeeSompi.toString(),
          bidInputIndex: legIndex,
          sellerInputIndex,
          sellerAuthOutputOrdinal: legIndex,
          buyerTokenOutputIndex,
          bidOutputIndex,
          sellerOutputIndex,
          feeOutputIndex,
          feeTicketInputIndex: ticketInputIndex,
          feeTicketOutpoint: sharedFeeTicket?.outpoint ?? null,
          feeTicketRefundOutputIndex: -1,
          feeTicketRefundSompi: "0",
          remainingBidAmount: leg.remainingBidAmount.toString(),
          buyerHolderDepositSompi: buyerHolderDepositSompi.toString(),
          bidHolderDepositSompi: bidDepositSompi.toString(),
          sellerFundedHolderTopUpSompi: sellerHolderTopUpSompi.toString(),
        });
      }

      if (sharedTicketEntry) {
        const feeTicketRefund = appendFeeTicketRefundOutput(
          kw,
          outputs,
          sharedFeeTicket.state,
          sharedTicketEntry,
        );
        for (const metadata of metadataFills) {
          metadata.feeTicketRefundOutputIndex = feeTicketRefund.outputIndex;
          metadata.feeTicketRefundSompi = feeTicketRefund.sompi.toString();
        }
      }

      const remainingHolderAmount = holderState.amount - totalFillAmount;
      let sellerChangeOutputIndex = -1;
      if (remainingHolderAmount > 0n) {
        sellerChangeOutputIndex = outputs.length;
        outputs.push(
          wrappedTokenOutput(
            kw,
            wrappedArtifact,
            {
              ...holderState,
              amount: remainingHolderAmount,
              mode: 0,
              unitPriceSompi: 0n,
            },
            refundAware ? utxoAmountSompi(holderEntry) : tokenOutputSompi,
            holderSpendCovenantId,
            sellerInputIndex,
          ),
        );
      }

      let sellerHolderRefundOutputIndex = -1;
      const sellerHolderRefundSompi =
        refundAware && remainingHolderAmount === 0n
          ? utxoAmountSompi(holderEntry)
          : 0n;
      const sellerOutputsEndIndex = outputs.length - 1;
      if (sellerHolderRefundSompi > 0n) {
        sellerHolderRefundOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(
            sellerHolderRefundSompi,
            p2pkScriptPubKey(kw, sellerOwner),
          ),
        );
      }

      const outputSompi = outputs.reduce(
        (sum, output) => sum + BigInt(output.value),
        0n,
      );
      const totalSellerFundedHolderTopUpSompi = metadataFills.reduce(
        (sum, fill) => sum + BigInt(fill.sellerFundedHolderTopUpSompi),
        0n,
      );
      const temporaryKasLockedSompi = calculateTemporaryKasLockedSompi(
        metadataFills,
        sellerChangeOutputIndex >= 0
          ? refundAware
            ? utxoAmountSompi(holderEntry)
            : tokenOutputSompi
          : 0n,
      );
      const covenantInputSompi =
        resolvedLegs.reduce(
          (sum, leg) => sum + utxoAmountSompi(leg.bidEntry),
          0n,
        ) +
        utxoAmountSompi(holderEntry) +
        (sharedTicketEntry ? utxoAmountSompi(sharedTicketEntry) : 0n);
      const requiredFunding =
        outputSompi + priorityFee > covenantInputSompi
          ? outputSompi + priorityFee - covenantInputSompi + 10_000n
          : priorityFee + 10_000n;
      let fundingEntry;
      try {
        fundingEntry = selectFundingEntry(walletUtxos.entries, requiredFunding);
      } catch (error) {
        if (totalSellerFundedHolderTopUpSompi > 0n) {
          throw kcc20PsktBuilderError(
            `no single funding UTXO can cover the ${totalSellerFundedHolderTopUpSompi} sompi buyer holder top-up and transaction fee`,
            "SELLER_HOLDER_TOP_UP_NOT_AVAILABLE",
            {
              sellerFundedHolderTopUpSompi: totalSellerFundedHolderTopUpSompi,
              requiredFundingSompi: requiredFunding,
            },
          );
        }
        throw error;
      }
      const fundingInputIndex =
        resolvedLegs.length + 1 + (sharedTicketEntry ? 1 : 0);
      const change =
        covenantInputSompi +
        utxoAmountSompi(fundingEntry) -
        outputSompi -
        priorityFee;
      let fundingChangeOutputIndex = -1;
      if (change > 10_000n) {
        fundingChangeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(change, payToAddressScript(walletAddress)),
        );
      }

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          ...resolvedLegs.map((leg) => ({
            previousOutpoint: leg.bidEntry.outpoint,
            utxo: leg.bidEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget:
              KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.bidOrder,
          })),
          {
            previousOutpoint: holderEntry.outpoint,
            utxo: holderEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget:
              KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.holder,
          },
          ...(sharedTicketEntry
            ? [
                {
                  previousOutpoint: sharedTicketEntry.outpoint,
                  utxo: sharedTicketEntry,
                  sequence: 0n,
                  sigOpCount: 0,
                  computeBudget:
                    KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.feeTicket,
                },
              ]
            : []),
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget:
              KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.funding,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildWrappedSweepPayload({
          canonicalTokenId,
          wrapperId,
          side: "sell",
          fills: metadataFills,
        }),
      });
      const computeBudgetProfile = applySweepBidComputeBudgetProfile(
        unsignedTx,
        computeBudgetLayout,
      );
      assertUniqueTransactionInputOutpoints(
        unsignedTx,
        "single-holder sweep bids",
      );

      resolvedLegs.forEach((leg, legIndex) => {
        const metadata = metadataFills[legIndex];
        const bidPrefix = buildKcc20OrderbookFillBidFromSellerSweepSigScript(
          kw,
          {
            sellerTokenInputIndex: sellerInputIndex,
            sellerAuthOutputOrdinal: metadata.sellerAuthOutputOrdinal,
            fillAmount: leg.fillAmount,
            buyerTokenOutputIndex: metadata.buyerTokenOutputIndex,
            bidOutputIndex: metadata.bidOutputIndex,
            sellerOutputIndex: metadata.sellerOutputIndex,
            seller: hexToBytes(sellerOwner),
            ticketInputIndex: metadata.feeTicketInputIndex,
          },
        );
        unsignedTx.inputs[metadata.bidInputIndex].signatureScript =
          encodeCovenantP2shSignatureScript(bidPrefix, leg.bidScript);
      });

      const scripts = [
        {
          inputIndex: sellerInputIndex,
          scriptHex: bytesToHex(holderScript),
          signType: 1,
          signatureScript: {
            mode: "signature-first-args",
            args: [
              ...metadataFills.flatMap((metadata, index) => [
                {
                  type: "data",
                  hex: bytesToHex(resolvedLegs[index].bidState.ownerIdentifier),
                },
                {
                  type: "i64",
                  value: resolvedLegs[index].fillAmount.toString(),
                },
                { type: "i64", value: String(metadata.buyerTokenOutputIndex) },
              ]),
              ...Array.from({
                length: selectedScriptLegCapacity - metadataFills.length,
              }).flatMap(() => [
                { type: "data", hex: ZERO_HASH },
                { type: "i64", value: "0" },
                { type: "i64", value: "-1" },
              ]),
              { type: "i64", value: String(sellerChangeOutputIndex) },
              ...(refundAware
                ? [
                    {
                      type: "i64",
                      value: String(sellerHolderRefundOutputIndex),
                    },
                    {
                      type: "i64",
                      value: String(sellerOutputsEndIndex),
                    },
                  ]
                : []),
              dispatchTagTemplateArg(
                wrappedArtifact,
                selectedScriptLegCapacity > KCC20_ORDERBOOK_MAX_SWEEP_BID_LEGS
                  ? "sellIntoBids10ByOwnerSig"
                  : "sellIntoBidsByOwnerSig",
              ),
            ],
          },
        },
      ];
      if (sharedFeeTicket) {
        scripts.push(
          feeTicketBurnScriptHint(
            metadataFills[0].feeTicketInputIndex,
            sharedFeeTicket.script,
            sharedFeeTicket.burnDispatchTag,
            metadataFills[0].feeTicketRefundOutputIndex,
            sharedFeeTicket.burnTakesRefundOutput,
          ),
        );
      }

      const signedShapeDetails = {
        legs: resolvedLegs,
        metadataFills,
        selectedScriptLegCapacity,
        sellerChangeOutputIndex,
        sellerInputIndex,
        holderScript,
        sharedFeeTicket,
        feeTicketInputIndex: metadataFills[0]?.feeTicketInputIndex ?? -1,
        fundingInputIndex,
        tokenOutputSompi,
        refundAware,
        sellerHolderRefundOutputIndex,
        sellerOutputsEndIndex,
      };
      const feeResult = transactionWithPredictedSignedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        (transaction) =>
          predictSingleHolderSweepBidSignedTransaction(kw, {
            ...signedShapeDetails,
            transaction,
          }),
      );
      const feeAdjustedTx = feeResult.transaction;
      const nonContextualMass = assertTransactionComputeMassStandard(
        feeResult.predictedTransaction,
        "single-holder sweep bids",
        {
          selectedLegCount: metadataFills.length,
          selectedScriptLegCapacity,
          tokenOutputSompi,
          computeBudgetProfile:
            KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE.version,
        },
      );
      const storageMass = assertTransactionStorageMassStandard(
        feeAdjustedTx,
        "single-holder sweep bids",
        {
          selectedLegCount: metadataFills.length,
          tokenOutputSompi,
        },
      );
      const transactionMass =
        nonContextualMass > storageMass ? nonContextualMass : storageMass;
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "KCC20Orderbook single-holder sweep bids PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        scripts,
        submitTransactionSupported: true,
        metadata: {
          builderKey: "kcc20orderbook.sweep-bids",
          contract: "KCC20Orderbook",
          network,
          walletAddress,
          canonicalTokenId,
          wrapperId,
          requestedWrapperId: wrapperId,
          covenantId: wrapperId,
          side: "sell",
          executionMode: "multi",
          sweepBidMode: "single-holder",
          selectedLegCount: metadataFills.length,
          maxSupportedLegs: singleHolderMaxSweepBidLegs,
          selectedScriptLegCapacity,
          wrappedArtifactVersion: holderArtifactInfo.version,
          sellerHolderRefundOutputIndex,
          sellerOutputsEndIndex,
          sellerHolderRefundSompi: sellerHolderRefundSompi.toString(),
          computeBudgetProfile,
          computeBudgetArtifacts,
          transactionMass: transactionMass.toString(),
          requiredTransactionFeeSompi: feeResult.requiredFeeSompi.toString(),
          paidTransactionFeeSompi: feeResult.paidFeeSompi.toString(),
          fills: metadataFills,
          feeOutputIndexes: metadataFills.map((fill) => fill.feeOutputIndex),
          fundingInputIndex,
          grossSompi: totalGrossSompi.toString(),
          protocolFeeSompi: totalProtocolFeeSompi.toString(),
          quotedProtocolFeeSompi: totalQuotedProtocolFeeSompi.toString(),
          feePayer: "seller",
          feeTiming: "fill",
          buyerPaysSompi: totalGrossSompi.toString(),
          sellerReceivesSompi: (
            totalGrossSompi - totalProtocolFeeSompi
          ).toString(),
          feeTicketId: params.feeTicketId ?? null,
          feeTicketApplied: totalProtocolFeeSompi < totalQuotedProtocolFeeSompi,
          sellerFundedHolderTopUpSompi:
            totalSellerFundedHolderTopUpSompi.toString(),
          temporaryKasDepositPerOutputSompi:
            tokenOutputSompi > configuredTokenOutputSompi
              ? tokenOutputSompi.toString()
              : "0",
          temporaryKasLockedSompi: temporaryKasLockedSompi.toString(),
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildWrappedConsolidatePskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const holderUtxos = Array.isArray(params.activeWrappedHolderUtxos)
      ? params.activeWrappedHolderUtxos
      : [];
    if (holderUtxos.length < 2 || holderUtxos.length > 8) {
      throw new Error(
        "between two and eight KCC20 orderbook holder UTXOs are required",
      );
    }

    const canonicalTokenId = requireHex32(
      params.canonicalCovenantId || params.covenantId,
      "canonical token id",
    );
    const wrapperId = requireHex32(
      params.activeWrapperCovenantId ||
        params.wrappedMarketId ||
        params.wrapperId,
      "wrapped market id",
    );
    const requestedWrapperId = requireHex32(
      params.wrappedMarketId || params.wrapperId || wrapperId,
      "requested wrapped market id",
    );
    const owner = requireHex32(request.owner?.kcc20Owner, "token owner");
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const priorityFee = parseU64(
      env.KCC20_CONSOLIDATE_PRIORITY_FEE_SOMPI ||
        env.KCC20_FILL_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const configuredPrimaryComputeBudget = parsePositiveNumber(
      env.KCC20_CONSOLIDATE_COMPUTE_BUDGET ||
        env.KCC20_FILL_COMPUTE_BUDGET ||
        800,
      "configuredPrimaryComputeBudget",
    );
    const peerComputeBudget = parsePositiveNumber(
      env.KCC20_CONSOLIDATE_PEER_COMPUTE_BUDGET || 200,
      "peerComputeBudget",
    );
    const computeBudget = Math.max(
      configuredPrimaryComputeBudget,
      500 + holderUtxos.length * 100,
    );

    const wrappedArtifacts = await readWrappedArtifacts();
    const states = holderUtxos.map((utxo) =>
      kcc20V3WrappedStateFromUtxo(utxo, canonicalTokenId, request.owner),
    );
    const primaryState = states[0];
    for (const peerState of states.slice(1)) {
      assertKcc20OrderbookMergeableStates(primaryState, peerState, owner);
    }
    const mergedState = {
      ...primaryState,
      amount: states.reduce((sum, state) => sum + state.amount, 0n),
      mode: 0,
      unitPriceSompi: 0n,
    };

    const kw = kaspaWasm;
    const {
      Encoding,
      RpcClient,
      Transaction,
      TransactionOutput,
      payToAddressScript,
    } = kw;
    const sources = holderUtxos.map((utxo, index) => {
      const artifactInfo = selectWrappedArtifactForUtxo({
        kw,
        artifacts: wrappedArtifacts,
        state: states[index],
        utxo,
        network,
        label: `wrapped holder ${index} UTXO address`,
      });
      return {
        txid: requireHex32(utxo.txidHex, `wrapped holder ${index} txid`),
        vout: parseVout(utxo.vout, `wrapped holder ${index} vout`),
        artifactInfo,
      };
    });
    const artifactVersions = new Set(
      sources.map((source) => source.artifactInfo.version),
    );
    if (artifactVersions.size !== 1) {
      throw new Error(
        "cannot consolidate wrapped holders from different artifact versions",
      );
    }
    const primaryArtifactInfo = sources[0].artifactInfo;
    const artifact = primaryArtifactInfo.artifact;

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [onChainHolderUtxos, walletUtxos] = await Promise.all([
        getUtxosByAddresses(
          rpc,
          uniqueStrings(sources.map((source) => source.artifactInfo.address)),
        ),
        getUtxosByAddresses(rpc, [walletAddress]),
      ]);
      const entries = sources.map((source, index) => {
        const entry = findUtxoEntry(
          onChainHolderUtxos.entries,
          source.txid,
          source.vout,
        );
        if (!entry) {
          throw new Error(
            `wrapped holder ${index} UTXO ${source.txid}:${source.vout} not found`,
          );
        }
        if (utxoAmountSompi(entry) < DEFAULT_TOKEN_OUTPUT_SOMPI) {
          throw new Error(
            `wrapped holder ${index} deposit is below ${DEFAULT_TOKEN_OUTPUT_SOMPI} sompi`,
          );
        }
        return entry;
      });
      const spendCovenantIds = entries.map(
        (entry) => covenantIdFromUtxoEntry(entry) ?? wrapperId,
      );
      if (new Set(spendCovenantIds).size !== 1) {
        throw new Error("wrapped holder UTXOs use different covenant ids");
      }
      const spendCovenantId = spendCovenantIds[0];

      const mergedOutputIndex = 0;
      const refundOutputIndex = 1;
      const tokenOutputSompi = DEFAULT_TOKEN_OUTPUT_SOMPI;
      const covenantInputSompi = entries.reduce(
        (sum, entry) => sum + utxoAmountSompi(entry),
        0n,
      );
      const refundSompi = covenantInputSompi - tokenOutputSompi;
      if (refundSompi < DEFAULT_TOKEN_OUTPUT_SOMPI) {
        throw new Error("wrapped holder deposits cannot fund the merge refund");
      }
      const outputs = [
        wrappedTokenOutput(
          kw,
          artifact,
          mergedState,
          tokenOutputSompi,
          spendCovenantId,
          0,
        ),
        new TransactionOutput(refundSompi, payToAddressScript(walletAddress)),
      ];
      const requiredFunding = priorityFee + MIN_FUNDING_CHANGE_SOMPI;
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        requiredFunding,
      );
      const fundingInputIndex = entries.length;
      const change = utxoAmountSompi(fundingEntry) - priorityFee;
      let fundingChangeOutputIndex = -1;
      if (change > MIN_FUNDING_CHANGE_SOMPI) {
        fundingChangeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(change, payToAddressScript(walletAddress)),
        );
      }

      const sourceOutpoints = sources.map(
        (source) => `${source.txid}:${source.vout}`,
      );
      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          ...entries.map((entry, index) => ({
            previousOutpoint: entry.outpoint,
            utxo: entry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: index === 0 ? computeBudget : peerComputeBudget,
          })),
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildWrappedConsolidatePayload({
          canonicalTokenId,
          wrapperId: spendCovenantId,
          sourceOutpoints,
          tokenAmount: mergedState.amount,
        }),
      });
      setVersionOneInputMassFields(unsignedTx, computeBudget);
      for (let index = 1; index < fundingInputIndex; index += 1) {
        unsignedTx.inputs[index].computeBudget = peerComputeBudget;
      }
      unsignedTx.inputs[fundingInputIndex].computeBudget = 30;

      const scripts = sources.map((source, index) => ({
        inputIndex: index,
        scriptHex: bytesToHex(source.artifactInfo.script),
        signType: 1,
        signatureScript:
          index === 0
            ? {
                mode: "signature-first-args",
                args: [
                  dispatchTagTemplateArg(
                    source.artifactInfo.artifact,
                    "mergeByOwnerSig",
                  ),
                ],
              }
            : {
                mode: "signature-first-args",
                args: [
                  { type: "i64", value: "0" },
                  { type: "i64", value: mergedState.amount.toString() },
                  dispatchTagTemplateArg(
                    source.artifactInfo.artifact,
                    "mergePeerByOwnerSig",
                  ),
                ],
              },
      }));
      const feeAdjustedTx = transactionWithCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        scripts,
      );
      assertConsolidationMassTarget(
        feeAdjustedTx,
        "KCC20Orderbook consolidation",
        entries.length,
      );
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "KCC20 orderbook consolidate PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        scripts,
        submitTransactionSupported: true,
        metadata: {
          builderKey: "kcc20orderbook.consolidate-holders",
          operation: "consolidate-orderbook-holders",
          action: "consolidate",
          contract: "KCC20Orderbook",
          network,
          walletAddress,
          canonicalTokenId,
          wrapperId: spendCovenantId,
          requestedWrapperId,
          covenantId: spendCovenantId,
          sourceOutpoints,
          mergedOutputIndex,
          refundOutputIndex,
          tokenAmount: mergedState.amount.toString(),
          mergedHolderDepositSompi: tokenOutputSompi.toString(),
          refundedHolderDepositSompi: refundSompi.toString(),
          wrappedArtifactVersion: primaryArtifactInfo.version,
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildWrappedCrossMatchPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const askUtxo = params.activeAskOrderUtxo;
    const bidUtxo = params.activeBidOrderUtxo;
    const ticketUtxo = params.activeFeeTicketUtxo || null;
    if (!askUtxo) {
      throw new Error("active KCC20Orderbook ask order UTXO is required");
    }
    if (!bidUtxo) {
      throw new Error("active KCC20Orderbook bid order UTXO is required");
    }

    const canonicalTokenId = requireHex32(
      params.canonicalTokenId ||
        params.canonicalCovenantId ||
        params.covenantId,
      "canonical token id",
    );
    const wrapperId = requireHex32(
      params.wrappedMarketId || params.wrapperId,
      "wrapped market id",
    );
    const expectedAskOrderId = params.askOrderId
      ? requireOrderId(params.askOrderId, "askOrderId")
      : null;
    const expectedBidOrderId = params.bidOrderId
      ? requireOrderId(params.bidOrderId, "bidOrderId")
      : null;
    const configuredFeeTicketId = params.feeTicketId
      ? requireHex32(params.feeTicketId, "fee ticket id")
      : null;
    const maxFeeSompi = parseU64(params.maxFeeSompi || "0", "maxFeeSompi");
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const expectedOwner = request.owner?.kcc20Owner
      ? requireHex32(request.owner.kcc20Owner, "matcher owner")
      : null;
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const tokenOutputSompi = parseU64(
      env.KCC20_MATCHER_TOKEN_OUTPUT_SOMPI ||
        env.KCC20_FILL_TOKEN_OUTPUT_SOMPI ||
        DEFAULT_TOKEN_OUTPUT_SOMPI.toString(),
      "tokenOutputSompi",
    );
    const priorityFee = parseU64(
      env.KCC20_MATCHER_PRIORITY_FEE_SOMPI ||
        env.KCC20_FILL_PRIORITY_FEE_SOMPI ||
        DEFAULT_MATCHER_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const networkFeeReserve = parseU64(
      env.KCC20_MATCHER_NETWORK_FEE_RESERVE_SOMPI || "5000000",
      "networkFeeReserve",
    );
    const transactionFeeReserve = priorityFee + networkFeeReserve;
    const computeBudget = parsePositiveNumber(
      env.KCC20_MATCHER_COMPUTE_BUDGET ||
        env.KCC20_FILL_COMPUTE_BUDGET ||
        800,
      "computeBudget",
    );
    const privateKeyHex = String(
      env.KCC20_WRAPPER_OPERATOR_PRIVATE_KEY || "",
    )
      .trim()
      .replace(/^0x/i, "");
    if (!privateKeyHex) {
      throw new Error("KCC20_WRAPPER_OPERATOR_PRIVATE_KEY is required");
    }

    const wrappedArtifacts = await readWrappedArtifacts();
    const ticketArtifacts = ticketUtxo ? await readFeeTicketArtifacts() : null;
    const askState = kcc20V3WrappedStateFromUtxo(
      askUtxo,
      canonicalTokenId,
      request.owner,
    );
    const bidState = kcc20V3WrappedStateFromUtxo(
      bidUtxo,
      canonicalTokenId,
      request.owner,
    );
    if (askState.mode !== 2) {
      throw new Error(
        "crossed settlement requires a KCC20Orderbook ask order UTXO",
      );
    }
    if (bidState.mode !== 3) {
      throw new Error(
        "crossed settlement requires a KCC20Orderbook bid order UTXO",
      );
    }
    if (bytesToHex(askState.canonicalTokenId) !== canonicalTokenId) {
      throw new Error("ask order canonical token id does not match request");
    }
    if (bytesToHex(bidState.canonicalTokenId) !== canonicalTokenId) {
      throw new Error("bid order canonical token id does not match request");
    }
    if (
      bytesToHex(askState.ownerIdentifier) ===
      bytesToHex(bidState.ownerIdentifier)
    ) {
      throw new Error(
        "crossed settlement cannot match orders from the same owner",
      );
    }
    const askFeeTicketId = bytesToHex(askState.feeTicketId);
    const bidFeeTicketId = bytesToHex(bidState.feeTicketId);
    if (askFeeTicketId !== bidFeeTicketId) {
      throw new Error("crossed ask and bid FeeTicket roots do not match");
    }
    if (configuredFeeTicketId && configuredFeeTicketId !== askFeeTicketId) {
      throw new Error("requested FeeTicket root does not match crossed orders");
    }
    if (bidState.unitPriceSompi < askState.unitPriceSompi) {
      throw new Error("bid unit price is below ask clearing price");
    }
    if (bidState.priceScale !== askState.priceScale) {
      throw new Error("crossed ask and bid price scales do not match");
    }

    const fillAmount = selectKcc20V3CrossFillAmount({
      askAmount: askState.amount,
      bidAmount: bidState.amount,
      askUnitPriceSompi: askState.unitPriceSompi,
      bidUnitPriceSompi: bidState.unitPriceSompi,
      priceScale: askState.priceScale,
    });
    const clearingUnitPriceSompi = askState.unitPriceSompi;
    const remainingAskAmount = askState.amount - fillAmount;
    const remainingBidAmount = bidState.amount - fillAmount;
    if (remainingBidAmount > 0n) {
      assertPartialBuyerHolderOutputSompi(tokenOutputSompi);
    }
    const grossSompi = exactGrossSompi(
      fillAmount,
      clearingUnitPriceSompi,
      askState.priceScale,
      "crossed settlement",
    );
    const protocolFeeSompi = calculateFeeSplit(grossSompi).fee;
    let feeSompi = protocolFeeSompi;
    const surplusSompi =
      bidState.unitPriceSompi > clearingUnitPriceSompi
        ? exactGrossSompi(
            fillAmount,
            bidState.unitPriceSompi - clearingUnitPriceSompi,
            askState.priceScale,
            "crossed settlement surplus",
          )
        : 0n;
    const kw = kaspaWasm;
    const {
      Encoding,
      PrivateKey,
      RpcClient,
      Transaction,
      TransactionOutput,
      createInputSignature,
      payToAddressScript,
    } = kw;
    const privateKey = new PrivateKey(privateKeyHex);
    const derivedWalletAddress = privateKey.toAddress(network).toString();
    const derivedOwner = privateKey
      .toPublicKey()
      .toXOnlyPublicKey()
      .toString()
      .toLowerCase();
    if (derivedWalletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error(
        "matcher private key does not match configured wallet address",
      );
    }
    if (expectedOwner && derivedOwner !== expectedOwner) {
      throw new Error("matcher private key does not match configured owner");
    }

    const askArtifactInfo = selectWrappedArtifactForUtxo({
      kw,
      artifacts: wrappedArtifacts,
      state: askState,
      utxo: askUtxo,
      network,
      label: "KCC20Orderbook ask order UTXO address",
    });
    const bidArtifactInfo = selectWrappedArtifactForUtxo({
      kw,
      artifacts: wrappedArtifacts,
      state: bidState,
      utxo: bidUtxo,
      network,
      label: "KCC20Orderbook bid order UTXO address",
    });
    if (askArtifactInfo.version !== bidArtifactInfo.version) {
      throw new Error(
        "crossed ask and bid are built from different wrapped artifact versions",
      );
    }
    const wrappedArtifact = askArtifactInfo.artifact;
    const askScript = askArtifactInfo.script;
    const bidScript = bidArtifactInfo.script;
    const askAddress = askArtifactInfo.address;
    const bidAddress = bidArtifactInfo.address;
    const crossSupportsFeeTicket =
      wrappedArtifactSupportsCrossFeeTicket(askArtifactInfo) &&
      wrappedArtifactSupportsCrossFeeTicket(bidArtifactInfo);
    const refundAware = wrappedArtifactRefundsHolderDeposits(bidArtifactInfo);
    const ticketCandidateUtxo =
      crossSupportsFeeTicket &&
      configuredFeeTicketId &&
      askFeeTicketId !== ZERO_HASH
        ? ticketUtxo
        : null;
    const ticketState = ticketCandidateUtxo
      ? kcc20FeeTicketStateFromUtxo(ticketUtxo, derivedOwner)
      : null;
    if (ticketState && ticketState.mode !== 2) {
      throw new Error("FeeTicket discount requires a ticket UTXO");
    }
    if (
      ticketState &&
      bytesToHex(ticketState.ownerIdentifier) !== derivedOwner
    ) {
      throw new Error("FeeTicket UTXO is not owned by matcher wallet");
    }
    const ticketAddress = ticketCandidateUtxo
      ? requireKaspaAddress(ticketUtxo.address)
      : null;
    const ticketInfo =
      ticketArtifacts && ticketState && ticketAddress
        ? selectFeeTicketArtifactForState(
            ticketArtifacts,
            ticketState,
            ticketAddress,
            network,
            "FeeTicket matcher discount UTXO address",
          )
        : null;
    feeSompi = ticketInfo ? 0n : protocolFeeSompi;
    if (maxFeeSompi > 0n && feeSompi + transactionFeeReserve > maxFeeSompi) {
      throw kcc20PsktBuilderError(
        "matcher settlement fee exceeds maxFeeSompi",
        "MATCHER_FEE_EXCEEDS_MAX",
        {
          protocolFeeSompi: feeSompi,
          undiscountedProtocolFeeSompi: protocolFeeSompi,
          transactionFeeReserveSompi: transactionFeeReserve,
          maxFeeSompi,
        },
      );
    }

    const askTxid = requireHex32(askUtxo.txidHex, "ask txid");
    const askVout = parseVout(askUtxo.vout, "ask vout");
    const bidTxid = requireHex32(bidUtxo.txidHex, "bid txid");
    const bidVout = parseVout(bidUtxo.vout, "bid vout");
    const ticketTxid = ticketUtxo
      ? requireHex32(ticketUtxo.txidHex, "FeeTicket txid")
      : null;
    const ticketVout = ticketUtxo
      ? parseVout(ticketUtxo.vout, "FeeTicket vout")
      : null;
    if (expectedAskOrderId && expectedAskOrderId !== `${askTxid}:${askVout}`) {
      throw new Error("active ask order UTXO does not match askOrderId");
    }
    if (expectedBidOrderId && expectedBidOrderId !== `${bidTxid}:${bidVout}`) {
      throw new Error("active bid order UTXO does not match bidOrderId");
    }

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [orderUtxos, ticketUtxos, walletUtxos] = await Promise.all([
        getUtxosByAddresses(rpc, [...new Set([askAddress, bidAddress])]),
        ticketAddress
          ? getUtxosByAddresses(rpc, [ticketAddress])
          : Promise.resolve({ entries: [] }),
        getUtxosByAddresses(rpc, [walletAddress]),
      ]);
      const askEntry = findUtxoEntry(orderUtxos.entries, askTxid, askVout);
      if (!askEntry) {
        throw new Error(`ask order UTXO ${askTxid}:${askVout} not found`);
      }
      const bidEntry = findUtxoEntry(orderUtxos.entries, bidTxid, bidVout);
      if (!bidEntry) {
        throw new Error(`bid order UTXO ${bidTxid}:${bidVout} not found`);
      }
      const ticketEntry =
        ticketTxid !== null && ticketVout !== null
          ? findUtxoEntry(ticketUtxos.entries, ticketTxid, ticketVout)
          : null;
      if (ticketUtxo && !ticketEntry) {
        throw new Error(`FeeTicket UTXO ${ticketTxid}:${ticketVout} not found`);
      }
      const askSpendCovenantId = covenantIdFromUtxoEntry(askEntry) ?? wrapperId;
      const bidSpendCovenantId = covenantIdFromUtxoEntry(bidEntry) ?? wrapperId;
      if (askSpendCovenantId !== bidSpendCovenantId) {
        throw new Error(
          "crossed ask and bid are not on the same wrapper market",
        );
      }
      if (askSpendCovenantId !== wrapperId) {
        throw new Error(
          "crossed ask and bid do not match the requested wrapper market",
        );
      }
      const bidGrossSompi = exactGrossSompi(
        bidState.amount,
        bidState.unitPriceSompi,
        bidState.priceScale,
        "crossed bid deposit",
      );
      const bidDepositSompi = refundAware
        ? utxoAmountSompi(bidEntry) - bidGrossSompi
        : 0n;
      if (refundAware && bidDepositSompi < tokenOutputSompi) {
        throw new Error(
          `crossed bid holder deposit ${bidDepositSompi} is below ${tokenOutputSompi}`,
        );
      }
      const buyerTokenOutputIndex = 0;
      const buyerState = {
        ...askState,
        ownerIdentifier: bidState.ownerIdentifier,
        amount: fillAmount,
        mode: 0,
        unitPriceSompi: 0n,
      };
      const outputs = [
        wrappedTokenOutput(
          kw,
          wrappedArtifact,
          buyerState,
          refundAware && remainingBidAmount === 0n
            ? bidDepositSompi
            : tokenOutputSompi,
          askSpendCovenantId,
          0,
        ),
      ];

      let askOutputIndex = -1;
      if (remainingAskAmount > 0n) {
        askOutputIndex = outputs.length;
        outputs.push(
          wrappedTokenOutput(
            kw,
            wrappedArtifact,
            { ...askState, amount: remainingAskAmount },
            utxoAmountSompi(askEntry),
            askSpendCovenantId,
            0,
          ),
        );
      }

      let bidOutputIndex = -1;
      if (remainingBidAmount > 0n) {
        bidOutputIndex = outputs.length;
        outputs.push(
          wrappedTokenOutput(
            kw,
            wrappedArtifact,
            { ...bidState, amount: remainingBidAmount },
            exactGrossSompi(
              remainingBidAmount,
              bidState.unitPriceSompi,
              bidState.priceScale,
              "crossed bid remainder",
            ) + bidDepositSompi,
            bidSpendCovenantId,
            1,
          ),
        );
      }

      const sellerOutputIndex = outputs.length;
      outputs.push(
        new TransactionOutput(
          grossSompi +
            (remainingAskAmount > 0n ? 0n : utxoAmountSompi(askEntry)),
          p2pkScriptPubKey(kw, bytesToHex(askState.ownerIdentifier)),
        ),
      );
      let feeOutputIndex = -1;
      if (feeSompi > 0n) {
        feeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(
            feeSompi,
            p2pkScriptPubKey(kw, KCC20_ORDERBOOK_PROTOCOL_FEE_RECIPIENT),
          ),
        );
      }
      let refundOutputIndex = -1;
      if (surplusSompi > 0n) {
        refundOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(
            surplusSompi,
            p2pkScriptPubKey(kw, bytesToHex(bidState.ownerIdentifier)),
          ),
        );
      }
      const feeTicketRefund = appendFeeTicketRefundOutput(
        kw,
        outputs,
        ticketState,
        ticketEntry,
      );

      const outputSompi = outputs.reduce(
        (sum, output) => sum + BigInt(output.value),
        0n,
      );
      const ticketInputSompi = ticketEntry ? utxoAmountSompi(ticketEntry) : 0n;
      const covenantInputSompi =
        utxoAmountSompi(askEntry) +
        utxoAmountSompi(bidEntry) +
        ticketInputSompi;
      const requiredFunding =
        outputSompi + transactionFeeReserve > covenantInputSompi
          ? outputSompi + transactionFeeReserve - covenantInputSompi + 10_000n
          : transactionFeeReserve + 10_000n;
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        requiredFunding,
      );
      const ticketInputIndex = ticketEntry ? 2 : -1;
      const fundingInputIndex = ticketEntry ? 3 : 2;
      const change =
        covenantInputSompi +
        utxoAmountSompi(fundingEntry) -
        outputSompi -
        transactionFeeReserve;
      let fundingChangeOutputIndex = -1;
      if (change > 10_000n) {
        fundingChangeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(change, payToAddressScript(walletAddress)),
        );
      }

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          {
            previousOutpoint: askEntry.outpoint,
            utxo: askEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          {
            previousOutpoint: bidEntry.outpoint,
            utxo: bidEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          ...(ticketEntry
            ? [
                {
                  previousOutpoint: ticketEntry.outpoint,
                  utxo: ticketEntry,
                  sequence: 0n,
                  sigOpCount: 0,
                  computeBudget,
                },
              ]
            : []),
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildWrappedCrossPayload({
          canonicalTokenId,
          wrapperId: askSpendCovenantId,
          askOrderId: `${askTxid}:${askVout}`,
          bidOrderId: `${bidTxid}:${bidVout}`,
          tokenAmount: fillAmount,
          unitPriceSompi: clearingUnitPriceSompi,
        }),
      });
      setVersionOneInputMassFields(unsignedTx, computeBudget);
      unsignedTx.inputs[fundingInputIndex].computeBudget = 30;
      const crossAskArgs = {
        buyerOwner: bidState.ownerIdentifier,
        bidInputIndex: 1,
        fillAmount,
        clearingUnitPriceSompi,
        buyerTokenOutputIndex,
        askOutputIndex,
        bidOutputIndex,
        sellerOutputIndex,
        feeOutputIndex,
        refundOutputIndex,
        ticketInputIndex,
      };
      const crossBidArgs = {
        askInputIndex: 0,
        fillAmount,
        clearingUnitPriceSompi,
        buyerTokenOutputIndex,
        askOutputIndex,
        bidOutputIndex,
        sellerOutputIndex,
        feeOutputIndex,
        refundOutputIndex,
        seller: askState.ownerIdentifier,
        ticketInputIndex,
      };
      const askPrefix = crossSupportsFeeTicket
        ? buildKcc20OrderbookCrossAskSigScript(kw, crossAskArgs)
        : buildKcc20OrderbookCrossAskLegacySigScript(kw, crossAskArgs);
      const bidPrefix = crossSupportsFeeTicket
        ? buildKcc20OrderbookCrossBidSigScript(kw, crossBidArgs)
        : buildKcc20OrderbookCrossBidLegacySigScript(kw, crossBidArgs);
      unsignedTx.inputs[0].signatureScript = encodeCovenantP2shSignatureScript(
        askPrefix,
        askScript,
      );
      unsignedTx.inputs[1].signatureScript = encodeCovenantP2shSignatureScript(
        bidPrefix,
        bidScript,
      );
      if (ticketInfo && ticketInputIndex >= 0) {
        const dummySignature = new Uint8Array(65);
        dummySignature[64] = 1;
        unsignedTx.inputs[ticketInputIndex].signatureScript =
          encodeCovenantP2shSignatureScript(
            buildFeeTicketBurnPrefix(
              kw,
              bytesToHex(dummySignature),
              ticketInfo.burnDispatchTag,
              feeTicketRefund.outputIndex,
              ticketInfo.burnTakesRefundOutput,
            ),
            ticketInfo.script,
          );
      }

      let feeAdjustedTx = transactionWithCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
      );
      if (ticketInfo && ticketInputIndex >= 0) {
        feeAdjustedTx.inputs[ticketInputIndex].signatureScript =
          encodeCovenantP2shSignatureScript(
            buildFeeTicketBurnPrefix(
              kw,
              createInputSignature(
                feeAdjustedTx,
                ticketInputIndex,
                privateKey,
                1,
              ),
              ticketInfo.burnDispatchTag,
              feeTicketRefund.outputIndex,
              ticketInfo.burnTakesRefundOutput,
            ),
            ticketInfo.script,
          );
      }
      feeAdjustedTx.inputs[fundingInputIndex].signatureScript =
        encodeP2pkSignatureScript(
          createInputSignature(feeAdjustedTx, fundingInputIndex, privateKey, 1),
        );
      feeAdjustedTx = transactionWithMinimumCalculatedFeeChange(
        kw,
        feeAdjustedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
      );
      if (ticketInfo && ticketInputIndex >= 0) {
        feeAdjustedTx.inputs[ticketInputIndex].signatureScript =
          encodeCovenantP2shSignatureScript(
            buildFeeTicketBurnPrefix(
              kw,
              createInputSignature(
                feeAdjustedTx,
                ticketInputIndex,
                privateKey,
                1,
              ),
              ticketInfo.burnDispatchTag,
              feeTicketRefund.outputIndex,
              ticketInfo.burnTakesRefundOutput,
            ),
            ticketInfo.script,
          );
      }
      feeAdjustedTx.inputs[fundingInputIndex].signatureScript =
        encodeP2pkSignatureScript(
          createInputSignature(feeAdjustedTx, fundingInputIndex, privateKey, 1),
        );
      const signedTransaction = feeAdjustedTx;
      const psktTransactionJson = signedTransaction.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "KCC20Orderbook crossed settlement PSKT serialization did not return JSON text",
        );
      }
      const response = await rpc.submitTransaction({
        transaction: signedTransaction,
        allowOrphan: false,
      });
      const submittedTxidHex = String(response?.transactionId || response || "")
        .trim()
        .toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(submittedTxidHex)) {
        throw new Error("matcher settlement broadcast did not return a txid");
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        submitTransactionSupported: true,
        submittedTxidHex,
        submissionWalletRequestId: String(params.matcherJobId || ""),
        metadata: {
          builderKey: "kcc20orderbook.matcher-settle-crossed",
          contract: "KCC20Orderbook",
          network,
          walletAddress,
          canonicalTokenId,
          wrapperId: askSpendCovenantId,
          requestedWrapperId: wrapperId,
          covenantId: askSpendCovenantId,
          askOutpoint: `${askTxid}:${askVout}`,
          bidOutpoint: `${bidTxid}:${bidVout}`,
          buyerTokenOutputIndex,
          askOutputIndex,
          bidOutputIndex,
          sellerOutputIndex,
          feeOutputIndex,
          refundOutputIndex,
          buyerHolderDepositSompi: (refundAware && remainingBidAmount === 0n
            ? bidDepositSompi
            : tokenOutputSompi
          ).toString(),
          bidHolderDepositSompi: bidDepositSompi.toString(),
          tokenAmount: fillAmount.toString(),
          unitPriceSompi: clearingUnitPriceSompi.toString(),
          askUnitPriceSompi: askState.unitPriceSompi.toString(),
          bidUnitPriceSompi: bidState.unitPriceSompi.toString(),
          grossSompi: grossSompi.toString(),
          protocolFeeSompi: feeSompi.toString(),
          undiscountedProtocolFeeSompi: protocolFeeSompi.toString(),
          feePayer: "matcher",
          feeTiming: "cross-match",
          buyerPaysSompi: (grossSompi + surplusSompi).toString(),
          sellerReceivesSompi: grossSompi.toString(),
          matcherPaysSompi: feeSompi.toString(),
          matcherNetworkFeeReserveSompi: transactionFeeReserve.toString(),
          surplusRefundSompi: surplusSompi.toString(),
          remainingAskAmount: remainingAskAmount.toString(),
          remainingBidAmount: remainingBidAmount.toString(),
          feeTicketId: askFeeTicketId,
          feeTicketApplied: Boolean(ticketInfo),
          feeTicketInputIndex: ticketInputIndex,
          feeTicketRefundOutputIndex: feeTicketRefund.outputIndex,
          feeTicketRefundSompi: feeTicketRefund.sompi.toString(),
          feeTicketOutpoint:
            ticketTxid !== null && ticketVout !== null
              ? `${ticketTxid}:${ticketVout}`
              : null,
          wrappedArtifactVersion: askArtifactInfo.version,
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildWrappedCancelPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const builderKey = request.builderKey;
    if (
      builderKey !== "kcc20orderbook.cancel-ask" &&
      builderKey !== "kcc20orderbook.cancel-bid"
    ) {
      throw new Error(
        `unsupported cancel builderKey: ${builderKey || "missing"}`,
      );
    }
    const cancelsAsk = builderKey === "kcc20orderbook.cancel-ask";
    const expectedMode = cancelsAsk ? 2 : 3;
    const orderUtxo = params.activeTargetOrderUtxo;
    if (!orderUtxo) {
      throw new Error(
        cancelsAsk
          ? "active KCC20Orderbook ask order UTXO is required"
          : "active KCC20Orderbook bid order UTXO is required",
      );
    }

    const canonicalTokenId = requireHex32(
      params.canonicalCovenantId || params.covenantId,
      "canonical token id",
    );
    const wrapperId = requireHex32(
      params.wrappedMarketId || params.wrapperId,
      "wrapped market id",
    );
    const owner = requireHex32(request.owner?.kcc20Owner, "order owner");
    const targetOrderId = requireOrderId(
      params.targetOrderId,
      "target order id",
    );
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const priorityFee = parseU64(
      env.KCC20_CANCEL_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const computeBudget = parsePositiveNumber(
      env.KCC20_CANCEL_COMPUTE_BUDGET || 800,
      "computeBudget",
    );

    const wrappedArtifacts = await readWrappedArtifacts();
    const orderState = kcc20V3WrappedStateFromUtxo(
      orderUtxo,
      canonicalTokenId,
      request.owner,
    );
    if (orderState.mode !== expectedMode) {
      throw new Error(
        cancelsAsk
          ? "cancel ask requires a KCC20Orderbook ask order UTXO"
          : "cancel bid requires a KCC20Orderbook bid order UTXO",
      );
    }
    if (bytesToHex(orderState.ownerIdentifier) !== owner) {
      throw new Error(
        "selected order UTXO is not owned by authenticated wallet",
      );
    }

    const kw = kaspaWasm;
    const {
      Encoding,
      RpcClient,
      Transaction,
      TransactionOutput,
      payToAddressScript,
    } = kw;

    const orderArtifactInfo = selectWrappedArtifactForUtxo({
      kw,
      artifacts: wrappedArtifacts,
      state: orderState,
      utxo: orderUtxo,
      network,
      label: cancelsAsk
        ? "KCC20Orderbook ask order UTXO address"
        : "KCC20Orderbook bid order UTXO address",
    });
    const wrappedArtifact = orderArtifactInfo.artifact;
    const orderScript = orderArtifactInfo.script;
    const orderAddress = orderArtifactInfo.address;

    const orderTxid = requireHex32(orderUtxo.txidHex, "order txid");
    const orderVout = parseVout(orderUtxo.vout, "order vout");
    if (`${orderTxid}:${orderVout}` !== targetOrderId) {
      throw new Error("target order id does not match active order UTXO");
    }

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [orderUtxos, walletUtxos] = await Promise.all([
        getUtxosByAddresses(rpc, [orderAddress]),
        getUtxosByAddresses(rpc, [walletAddress]),
      ]);
      const orderEntry = findUtxoEntry(
        orderUtxos.entries,
        orderTxid,
        orderVout,
      );
      if (!orderEntry) {
        throw new Error(`order UTXO ${orderTxid}:${orderVout} not found`);
      }
      const orderSpendCovenantId =
        covenantIdFromUtxoEntry(orderEntry) ?? wrapperId;

      const refundOutputIndex = 0;
      const outputs = cancelsAsk
        ? [
            wrappedTokenOutput(
              kw,
              wrappedArtifact,
              {
                ...orderState,
                mode: 0,
                unitPriceSompi: 0n,
              },
              utxoAmountSompi(orderEntry),
              orderSpendCovenantId,
              0,
            ),
          ]
        : [
            new TransactionOutput(
              utxoAmountSompi(orderEntry),
              p2pkScriptPubKey(kw, owner),
            ),
          ];

      const outputSompi = outputs.reduce(
        (sum, output) => sum + BigInt(output.value),
        0n,
      );
      const covenantInputSompi = utxoAmountSompi(orderEntry);
      const requiredFunding =
        outputSompi + priorityFee > covenantInputSompi
          ? outputSompi + priorityFee - covenantInputSompi + 10_000n
          : priorityFee + 10_000n;
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        requiredFunding,
      );
      const fundingInputIndex = 1;
      const change =
        covenantInputSompi +
        utxoAmountSompi(fundingEntry) -
        outputSompi -
        priorityFee;
      let fundingChangeOutputIndex = -1;
      if (change > 10_000n) {
        fundingChangeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(change, payToAddressScript(walletAddress)),
        );
      }

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          {
            previousOutpoint: orderEntry.outpoint,
            utxo: orderEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildWrappedCancelPayload({
          canonicalTokenId,
          wrapperId: orderSpendCovenantId,
          side: cancelsAsk ? "ask" : "bid",
          targetOrderId,
          tokenAmount: orderState.amount,
          unitPriceSompi: orderState.unitPriceSompi,
        }),
      });
      setVersionOneInputMassFields(unsignedTx, computeBudget);
      unsignedTx.inputs[fundingInputIndex].computeBudget = 30;

      const scripts = [
        {
          inputIndex: 0,
          scriptHex: bytesToHex(orderScript),
          signType: 1,
          signatureScript: {
            mode: "signature-first-args",
            args: [
              { type: "i64", value: String(refundOutputIndex) },
              dispatchTagTemplateArg(
                wrappedArtifact,
                cancelsAsk ? "cancelAskByOwnerSig" : "cancelBidByOwnerSig",
              ),
            ],
          },
        },
      ];
      const feeAdjustedTx = transactionWithCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        scripts,
      );
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "KCC20Orderbook cancel order PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        scripts,
        submitTransactionSupported: true,
        metadata: {
          builderKey,
          contract: "KCC20Orderbook",
          network,
          walletAddress,
          canonicalTokenId,
          wrapperId: orderSpendCovenantId,
          requestedWrapperId: wrapperId,
          covenantId: orderSpendCovenantId,
          side: cancelsAsk ? "ask" : "bid",
          targetOrderId,
          orderOutpoint: targetOrderId,
          refundOutputIndex,
          tokenAmount: orderState.amount.toString(),
          unitPriceSompi: orderState.unitPriceSompi.toString(),
          refundSompi: utxoAmountSompi(orderEntry).toString(),
          wrappedArtifactVersion: orderArtifactInfo.version,
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildKcc20MintPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const mintPolicy = params.mintPolicy || {};
    const activeMinterUtxo = params.activeMinterUtxo || null;
    if (!activeMinterUtxo) {
      throw new Error("active KCC20 mint-authority UTXO is required");
    }

    const covenantId = requireHex32(params.covenantId, "canonical covenant id");
    const recipientOwner = requireHex32(
      params.recipientOwner || request.owner?.kcc20Owner,
      "mint recipient owner",
    );
    const recipientOwnerScheme = parseOwnerScheme(
      params.recipientOwnerScheme ?? params.recipientOwnerType ?? 0,
      "recipientOwnerScheme",
    );
    const recipientBorrowScheme = parseBorrowScheme(
      params.recipientBorrowScheme ?? 0,
      "recipientBorrowScheme",
    );
    const recipientBorrowGuard = requireHex32(
      params.recipientBorrowGuard || ZERO_HASH,
      "recipientBorrowGuard",
    );
    const mintAmount = parsePositiveU64(params.tokenAmount, "tokenAmount");
    const minterAmount = parsePositiveU64(
      activeMinterUtxo.state?.remainingSupply ?? mintPolicy.remainingSupply,
      "active mint-authority remaining supply",
    );
    if (mintAmount > minterAmount) {
      throw new Error("tokenAmount exceeds active minter remaining supply");
    }

    const mintPolicyValue = parseMintPolicy(
      activeMinterUtxo.state?.mintPolicy ??
        mintPolicy.mintPolicyValue ??
        mintPolicy.policyValue ??
        mintPolicy.mintPolicy ??
        mintPolicy.policy,
    );
    if (mintPolicyValue !== 1 && mintPolicyValue !== 2) {
      throw new Error("KCC20 mint requires a controlled or public mint policy");
    }
    const mintPath = String(params.mintPath || "public").toLowerCase();
    if (mintPath !== "owner" && mintPath !== "public") {
      throw new Error("mintPath must be owner or public");
    }
    if (mintPath === "public" && mintPolicyValue !== 2) {
      throw new Error("public mint requires the public mint policy");
    }
    const mintPriceScale = parsePositiveU64(
      params.priceScale ??
        params.tokenDisplayScale ??
        DEFAULT_KCC20_PRICE_SCALE,
      "priceScale",
    );
    const extension = kcc20MintExtensionFromSources(
      activeMinterUtxo,
      params,
      mintPolicy,
      mintPolicyValue,
      minterAmount,
      mintPriceScale,
    );
    const mintPriceSompi = extension.mintPriceSompi;
    const feeBps = Number(extension.protocolFeeBps);
    const treasury = bytesToHex(extension.treasury);
    const feeRecipient = bytesToHex(extension.protocolFeeRecipient);
    const minterOwner = requireHex32(
      activeMinterUtxo.state?.owner ?? activeMinterUtxo.state?.ownerIdentifier,
      "active minter owner",
    );
    const minterOwnerScheme = parseOwnerScheme(
      activeMinterUtxo.state?.ownerScheme ??
        activeMinterUtxo.state?.identifierType ??
        0,
      "active mint-authority owner scheme",
    );
    if (mintPath === "owner" && minterOwnerScheme !== 0) {
      throw new Error("authority mint requires a pubkey-owned minter UTXO");
    }
    if (
      mintPath === "owner" &&
      minterOwner !== String(request.owner?.kcc20Owner || "").toLowerCase()
    ) {
      throw new Error(
        "authority mint PSKT requires authenticated wallet to own the active minter UTXO",
      );
    }
    const minterTxid = requireHex32(activeMinterUtxo.txidHex, "minter txid");
    const minterVout = parseVout(activeMinterUtxo.vout, "minter vout");
    const minterAddress = requireKaspaAddress(activeMinterUtxo.address);
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const tokenOutputSompi = assertKcc20TokenOutputSompi(
      parseU64(
        env.KCC20_MINT_TOKEN_OUTPUT_SOMPI ||
          DEFAULT_TOKEN_OUTPUT_SOMPI.toString(),
        "tokenOutputSompi",
      ),
      "mint",
    );
    const priorityFee = parseU64(
      env.KCC20_MINT_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const computeBudget = parsePositiveNumber(
      env.KCC20_MINT_COMPUTE_BUDGET || DEFAULT_COMPUTE_BUDGET,
      "computeBudget",
    );

    const inputState = {
      amount: 0n,
      owner: hexToBytes(minterOwner),
      ownerScheme: minterOwnerScheme,
      borrowScheme: 0,
      borrowGuard: hexToBytes(ZERO_HASH),
      extensionCommitment: mintExtensionCommitment(extension),
    };
    const resolvedArtifact = await resolveKcc20ArtifactForState(
      inputState,
      minterAddress,
      network,
    );
    const artifact = resolvedArtifact.artifact;
    const recipientState = {
      amount: mintAmount,
      owner: hexToBytes(recipientOwner),
      ownerScheme: recipientOwnerScheme,
      borrowScheme: recipientBorrowScheme,
      borrowGuard: hexToBytes(recipientBorrowGuard),
      extensionCommitment: extension.holderExtensionCommitment,
    };
    const remaining = minterAmount - mintAmount;
    const nextExtension =
      remaining > 0n ? { ...extension, remainingSupply: remaining } : null;
    const minterChangeState = nextExtension
      ? {
          ...inputState,
          extensionCommitment: mintExtensionCommitment(nextExtension),
        }
      : null;

    const kw = kaspaWasm;
    const {
      Encoding,
      RpcClient,
      ScriptBuilder,
      Transaction,
      TransactionOutput,
      addressFromScriptPublicKey,
      payToAddressScript,
      payToScriptHashScript,
    } = kw;

    const minterScript = resolvedArtifact.script;

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [initialMinterUtxos, walletUtxos] = await Promise.all([
        getUtxosByAddresses(rpc, [minterAddress]),
        getUtxosByAddresses(rpc, [walletAddress]),
      ]);
      let minterUtxos = initialMinterUtxos;
      let minterEntry = findUtxoEntry(
        minterUtxos.entries,
        minterTxid,
        minterVout,
      );
      if (!minterEntry) {
        minterUtxos = await retryUtxosByAddresses(
          rpc,
          [minterAddress],
          (entries) => Boolean(findUtxoEntry(entries, minterTxid, minterVout)),
          minterUtxos,
        );
        minterEntry = findUtxoEntry(
          minterUtxos.entries,
          minterTxid,
          minterVout,
        );
      }
      if (!minterEntry) {
        throw new Error(
          `active minter UTXO ${minterTxid}:${minterVout} not found`,
        );
      }
      const spendCovenantId =
        covenantIdFromUtxoEntry(minterEntry) ?? covenantId;
      const minterInputSompi = BigInt(minterEntry.amount);

      let outputSompi = 0n;
      const outputs = [];
      outputs.push(
        tokenOutput(
          kw,
          artifact,
          recipientState,
          tokenOutputSompi,
          spendCovenantId,
          0,
        ),
      );
      outputSompi += tokenOutputSompi;
      let minterOutputIndex = null;
      if (minterChangeState) {
        minterOutputIndex = outputs.length;
        outputs.push(
          tokenOutput(
            kw,
            artifact,
            minterChangeState,
            minterInputSompi,
            spendCovenantId,
            0,
          ),
        );
        outputSompi += minterInputSompi;
      }

      const grossPayment =
        mintPriceSompi > 0n
          ? exactGrossSompi(
              mintAmount,
              mintPriceSompi,
              extension.displayScale,
              "paid mint",
            )
          : 0n;
      if (
        grossPayment > 0n &&
        grossPayment < DEFAULT_KCC20_MIN_PROTOCOL_FEE_SOMPI
      ) {
        throw kcc20PsktBuilderError(
          `paid mint gross ${formatSompiAsKas(
            grossPayment,
          )} KAS is below minimum protocol fee ${formatSompiAsKas(
            DEFAULT_KCC20_MIN_PROTOCOL_FEE_SOMPI,
          )} KAS`,
          "PAID_MINT_GROSS_BELOW_MIN_PROTOCOL_FEE",
          {
            grossPaymentSompi: grossPayment,
            minimumProtocolFeeSompi: DEFAULT_KCC20_MIN_PROTOCOL_FEE_SOMPI,
          },
        );
      }
      const { fee, net } =
        grossPayment > 0n
          ? calculateFeeSplit(grossPayment, feeBps)
          : { fee: 0n, net: 0n };
      const treasuryOutputIndex = net > 0n ? outputs.length : 0;
      if (net > 0n) {
        outputs.push(
          new TransactionOutput(net, p2pkScriptPubKey(kw, treasury)),
        );
        outputSompi += net;
      }
      const feeOutputIndex = outputs.length;
      if (fee > 0n) {
        outputs.push(
          new TransactionOutput(fee, p2pkScriptPubKey(kw, feeRecipient)),
        );
        outputSompi += fee;
      }

      const requiredFunding =
        outputSompi + priorityFee > minterInputSompi
          ? outputSompi + priorityFee - minterInputSompi + 10_000n
          : priorityFee + 10_000n;
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        requiredFunding,
      );
      const fundingInputIndex = 1;
      const change =
        minterInputSompi +
        BigInt(fundingEntry.amount) -
        outputSompi -
        priorityFee;
      let fundingChangeOutputIndex = -1;
      if (change > 10_000n) {
        fundingChangeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(change, payToAddressScript(walletAddress)),
        );
      }

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          {
            previousOutpoint: minterEntry.outpoint,
            utxo: minterEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildMintPayload({
          covenantId: spendCovenantId,
          recipientOwner,
          recipientOwnerScheme,
          mintAmount,
          mintPriceSompi,
          feeBps,
          treasury,
          feeRecipient,
          mintPath,
        }),
      });
      setVersionOneInputMassFields(unsignedTx, computeBudget);

      const mintArgs = {
        extension,
        toOwner: recipientState.owner,
        toOwnerScheme: recipientState.ownerScheme,
        toBorrowScheme: recipientState.borrowScheme,
        toBorrowGuard: recipientState.borrowGuard,
        tokenAmount: mintAmount,
        tokenOutputIndex: 0,
        minterOutputIndex: minterOutputIndex ?? 0,
        treasuryOutputIndex,
        feeOutputIndex,
      };
      if (mintPath === "public") {
        if (!extension.publicMintActive) {
          throw new Error("public mint is paused by the token creator");
        }
        const mintPrefix = buildKcc20MintPublicSigScript(
          kw,
          artifact,
          mintArgs,
        );
        unsignedTx.inputs[0].signatureScript =
          encodeCovenantP2shSignatureScript(mintPrefix, minterScript);
      }

      if (grossPayment > 0n) {
        assertPaidMintPaymentStorageMassStandard(kw, network, {
          grossPaymentSompi: grossPayment,
          protocolFeeSompi: fee,
          treasuryPaymentSompi: net,
        });
      }
      const scripts =
        mintPath === "owner"
          ? [
              {
                inputIndex: 0,
                scriptHex: bytesToHex(minterScript),
                signType: 1,
                signatureScript: {
                  mode: "ordered-args",
                  args: kcc20MintOrderedArgs(artifact, mintArgs, true),
                },
              },
            ]
          : [];
      const predictMintSignedTransaction = (transaction) => {
        const predicted = cloneTransactionForMassPreflight(
          kw,
          transaction,
          "KCC20 mint",
        );
        const dummySignature = dummySignatureBytes();
        if (mintPath === "owner") {
          const predictedMintPrefix = buildKcc20MintByOwnerSigScript(
            kw,
            artifact,
            {
              ...mintArgs,
              authoritySignature: dummySignature,
            },
          );
          predicted.inputs[0].signatureScript =
            encodeCovenantP2shSignatureScript(
              predictedMintPrefix,
              minterScript,
            );
        }
        predicted.inputs[fundingInputIndex].signatureScript =
          encodeP2pkSignatureScript(bytesToHex(dummySignature));
        return predicted;
      };
      const feeResult = transactionWithPredictedSignedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        predictMintSignedTransaction,
      );
      const feeAdjustedTx = feeResult.transaction;
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "KCC20 mint PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        ...(scripts.length > 0 ? { scripts } : {}),
        submitTransactionSupported: true,
        metadata: {
          builderKey: "kcc20.mint",
          contract: "KCC20",
          network,
          walletAddress,
          covenantId: spendCovenantId,
          requestedCovenantId:
            spendCovenantId === covenantId ? undefined : covenantId,
          minterOutpoint: `${minterTxid}:${minterVout}`,
          tokenOutputIndex: 0,
          minterOutputIndex,
          treasuryOutputIndex: net > 0n ? treasuryOutputIndex : null,
          feeOutputIndex: fee > 0n ? feeOutputIndex : null,
          tokenAmount: mintAmount.toString(),
          priceScale: extension.displayScale.toString(),
          tokenDisplayScale: extension.displayScale.toString(),
          remainingSupply: remaining.toString(),
          grossPaymentSompi: grossPayment.toString(),
          treasuryPaymentSompi: net.toString(),
          protocolFeeSompi: fee.toString(),
          mintPolicy: mintPolicyValue,
          mintPath,
          publicMintActive: extension.publicMintActive,
          extension: nextExtension
            ? jsonKcc20MintExtension(nextExtension)
            : null,
          artifactVersion: resolvedArtifact.version,
          ...stateToReceiptFields(recipientState),
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildKcc20SetPublicMintActivePskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const requestedMinterUtxos =
      Array.isArray(params.activeMinterUtxos) &&
      params.activeMinterUtxos.length > 0
        ? params.activeMinterUtxos
        : params.activeMinterUtxo
          ? [params.activeMinterUtxo]
          : [];
    if (requestedMinterUtxos.length === 0) {
      throw new Error("active KCC20 mint-authority UTXO is required");
    }
    if (typeof params.active !== "boolean") {
      throw new Error("active must be a boolean");
    }

    const covenantId = requireHex32(params.covenantId, "canonical covenant id");
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const walletOwner = requireHex32(
      request.owner?.kcc20Owner,
      "authenticated wallet owner",
    );
    const mintPolicy = params.mintPolicy || {};
    const displayScale = parsePositiveU64(
      params.priceScale ??
        params.tokenDisplayScale ??
        DEFAULT_KCC20_PRICE_SCALE,
      "displayScale",
    );
    const seenOutpoints = new Set();
    const laneContexts = (
      await Promise.all(
        requestedMinterUtxos.map(async (activeMinterUtxo, laneIndex) => {
          if (
            activeMinterUtxo.state?.isMintAuthority !== true ||
            parseMintPolicy(activeMinterUtxo.state?.mintPolicy) !== 2
          ) {
            throw new Error(
              "public mint availability requires public mint-authority lanes",
            );
          }
          const minterAddress = requireKaspaAddress(activeMinterUtxo.address);
          const minterOwner = requireHex32(
            activeMinterUtxo.state?.owner ??
              activeMinterUtxo.state?.ownerIdentifier,
            "active mint-authority owner",
          );
          const minterOwnerScheme = parseOwnerScheme(
            activeMinterUtxo.state?.ownerScheme ??
              activeMinterUtxo.state?.identifierType ??
              0,
            "active mint-authority owner scheme",
          );
          if (minterOwnerScheme !== 0) {
            throw new Error(
              "public mint availability requires a pubkey-owned minter",
            );
          }
          if (minterOwner !== walletOwner) {
            throw new Error(
              "public mint availability requires authenticated wallet to own every active minter UTXO",
            );
          }
          const remainingSupply = parsePositiveU64(
            activeMinterUtxo.state?.remainingSupply ??
              mintPolicy.remainingSupply,
            "active mint-authority remaining supply",
          );
          const extension = kcc20MintExtensionFromSources(
            activeMinterUtxo,
            params,
            mintPolicy,
            2,
            remainingSupply,
            displayScale,
          );
          if (extension.publicMintActive === params.active) {
            return null;
          }
          const inputState = {
            amount: 0n,
            owner: hexToBytes(minterOwner),
            ownerScheme: minterOwnerScheme,
            borrowScheme: 0,
            borrowGuard: hexToBytes(ZERO_HASH),
            extensionCommitment: mintExtensionCommitment(extension),
          };
          const nextExtension = {
            ...extension,
            publicMintActive: params.active,
          };
          const outputState = {
            ...inputState,
            extensionCommitment: mintExtensionCommitment(nextExtension),
          };
          const resolvedArtifact = await resolveKcc20ArtifactForState(
            inputState,
            minterAddress,
            network,
          );
          dispatchTagFor(resolvedArtifact.artifact, "set_public_mint_active");
          const minterTxid = requireHex32(
            activeMinterUtxo.txidHex,
            "minter txid",
          );
          const minterVout = parseVout(activeMinterUtxo.vout, "minter vout");
          const outpoint = `${minterTxid}:${minterVout}`;
          if (seenOutpoints.has(outpoint)) {
            throw new Error(`duplicate active minter outpoint ${outpoint}`);
          }
          seenOutpoints.add(outpoint);
          return {
            activeMinterUtxo,
            laneIndex,
            minterAddress,
            minterTxid,
            minterVout,
            outpoint,
            remainingSupply,
            extension,
            nextExtension,
            inputState,
            outputState,
            resolvedArtifact,
          };
        }),
      )
    ).filter(Boolean);
    if (laneContexts.length === 0) {
      throw new Error(
        params.active
          ? "public mint is not paused"
          : "public mint is not active",
      );
    }
    const priorityFee = parseU64(
      env.KCC20_MINT_AVAILABILITY_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const computeBudget = parsePositiveNumber(
      env.KCC20_MINT_AVAILABILITY_COMPUTE_BUDGET ||
        DEFAULT_COMPUTE_BUDGET,
      "computeBudget",
    );
    const rpc = new kaspaWasm.RpcClient({
      url: env.KASPA_WRPC_URL || DEFAULT_WRPC_URL,
      encoding: kaspaWasm.Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [minterUtxos, walletUtxos] = await Promise.all([
        getUtxosByAddresses(rpc, [
          ...new Set(laneContexts.map((lane) => lane.minterAddress)),
        ]),
        getUtxosByAddresses(rpc, [walletAddress]),
      ]);
      const resolvedLanes = laneContexts.map((lane, laneIndex) => {
        const minterEntry = findUtxoEntry(
          minterUtxos.entries,
          lane.minterTxid,
          lane.minterVout,
        );
        if (!minterEntry) {
          throw new Error(`active minter UTXO ${lane.outpoint} not found`);
        }
        const spendCovenantId = requireMatchingCovenantId(
          minterEntry,
          covenantId,
          `active minter lane ${laneIndex}`,
        );
        return {
          ...lane,
          laneIndex,
          minterEntry,
          spendCovenantId,
          minterInputSompi: BigInt(minterEntry.amount),
        };
      });
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        priorityFee + 10_000n,
      );
      const fundingInputIndex = resolvedLanes.length;
      const fundingChange = BigInt(fundingEntry.amount) - priorityFee;
      const outputs = resolvedLanes.map((lane, laneIndex) =>
        tokenOutput(
          kaspaWasm,
          lane.resolvedArtifact.artifact,
          lane.outputState,
          lane.minterInputSompi,
          lane.spendCovenantId,
          laneIndex,
        ),
      );
      let fundingChangeOutputIndex = -1;
      if (fundingChange > 10_000n) {
        fundingChangeOutputIndex = outputs.length;
        outputs.push(
          new kaspaWasm.TransactionOutput(
            fundingChange,
            kaspaWasm.payToAddressScript(walletAddress),
          ),
        );
      }
      const unsignedTx = new kaspaWasm.Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          ...resolvedLanes.map((lane) => ({
            previousOutpoint: lane.minterEntry.outpoint,
            utxo: lane.minterEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          })),
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: new Uint8Array(),
      });
      setVersionOneInputMassFields(unsignedTx, computeBudget);
      unsignedTx.inputs[fundingInputIndex].computeBudget = 30;
      const scripts = resolvedLanes.map((lane, laneIndex) => ({
        inputIndex: laneIndex,
        scriptHex: bytesToHex(lane.resolvedArtifact.script),
        signType: 1,
        signatureScript: {
          mode: "ordered-args",
          args: kcc20SetPublicMintActiveOrderedArgs(
            lane.resolvedArtifact.artifact,
            lane.extension,
            params.active,
            laneIndex,
          ),
        },
      }));
      const predictSignedTransaction = (transaction) => {
        const predicted = cloneTransactionForMassPreflight(
          kaspaWasm,
          transaction,
          "KCC20 public mint availability",
        );
        const dummySignature = dummySignatureBytes();
        resolvedLanes.forEach((lane, laneIndex) => {
          const prefix = buildKcc20SetPublicMintActiveSigScript(
            kaspaWasm,
            lane.resolvedArtifact.artifact,
            {
              extension: lane.extension,
              authoritySignature: dummySignature,
              active: params.active,
              minterOutputIndex: laneIndex,
            },
          );
          predicted.inputs[laneIndex].signatureScript =
            encodeCovenantP2shSignatureScript(
              prefix,
              lane.resolvedArtifact.script,
            );
        });
        predicted.inputs[fundingInputIndex].signatureScript =
          encodeP2pkSignatureScript(bytesToHex(dummySignature));
        return predicted;
      };
      const feeResult = transactionWithPredictedSignedFeeChange(
        kaspaWasm,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        predictSignedTransaction,
      );
      const psktTransactionJson = feeResult.transaction.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "KCC20 mint availability PSKT serialization did not return JSON text",
        );
      }
      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        scripts,
        submitTransactionSupported: true,
        metadata: {
          builderKey: "kcc20.set-public-mint-active",
          contract: "KCC20",
          network,
          walletAddress,
          covenantId,
          minterOutpoint: resolvedLanes[0].outpoint,
          minterOutpoints: resolvedLanes.map((lane) => lane.outpoint),
          minterOutputIndex: 0,
          minterOutputIndexes: resolvedLanes.map((_, index) => index),
          mintLaneCount: Number(resolvedLanes[0].extension.mintLaneCount),
          updatedMintLaneCount: resolvedLanes.length,
          publicMintActive: params.active,
          mintPolicy: 2,
          remainingSupply: resolvedLanes[0].remainingSupply.toString(),
          remainingSupplies: resolvedLanes.map((lane) =>
            lane.remainingSupply.toString(),
          ),
          extension: jsonKcc20MintExtension(resolvedLanes[0].nextExtension),
          extensions: resolvedLanes.map((lane) =>
            jsonKcc20MintExtension(lane.nextExtension),
          ),
          artifactVersion: resolvedLanes[0].resolvedArtifact.version,
          artifactVersions: resolvedLanes.map(
            (lane) => lane.resolvedArtifact.version,
          ),
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildKcc20RevealPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const activeTokenUtxo = params.activeTokenUtxo || null;
    if (!activeTokenUtxo) {
      throw new Error("active KCC20 token UTXO is required");
    }

    const revealMode =
      params.revealMode ||
      (activeTokenUtxo.state?.isMintAuthority ? "mint" : "self-transfer");
    if (revealMode === "mint") {
      const signing = await buildKcc20MintPskt({
        ...input,
        request: {
          ...request,
          builderKey: "kcc20.reveal-token",
          operation: "verify-token",
          action: "reveal",
          params: {
            ...params,
            activeMinterUtxo: activeTokenUtxo,
            tokenAmount: params.tokenAmount || "1",
          },
        },
      });
      return {
        ...signing,
        metadata: {
          ...signing.metadata,
          builderKey: "kcc20.reveal-token",
          operation: "verify-token",
          action: "reveal",
          revealMode: "mint",
        },
      };
    }

    return buildKcc20SelfTransferRevealPskt(input, activeTokenUtxo);
  }

  async function buildKcc20ConsolidatePskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const holderUtxos = Array.isArray(params.activeHolderUtxos)
      ? params.activeHolderUtxos
      : [];
    if (holderUtxos.length < 2 || holderUtxos.length > 3) {
      throw new Error("between two and three KCC20 holder UTXOs are required");
    }

    const covenantId = requireHex32(
      params.activeHolderNativeCovenantId || params.covenantId,
      "canonical covenant id",
    );
    const appCanonicalTokenId = requireHex32(
      params.appCanonicalCovenantId || params.covenantId || covenantId,
      "app canonical token id",
    );
    const owner = requireHex32(request.owner?.kcc20Owner, "token owner");
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const priorityFee = parseU64(
      env.KCC20_CONSOLIDATE_PRIORITY_FEE_SOMPI ||
        env.KCC20_TRANSFER_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const configuredPrimaryComputeBudget = parsePositiveNumber(
      env.KCC20_CONSOLIDATE_COMPUTE_BUDGET ||
        env.KCC20_TRANSFER_COMPUTE_BUDGET ||
        DEFAULT_COMPUTE_BUDGET,
      "configuredPrimaryComputeBudget",
    );
    const peerComputeBudget = parsePositiveNumber(
      env.KCC20_CONSOLIDATE_PEER_COMPUTE_BUDGET || 200,
      "peerComputeBudget",
    );
    const computeBudget = Math.max(
      configuredPrimaryComputeBudget,
      500 + holderUtxos.length * 100,
    );

    const states = holderUtxos.map((utxo) =>
      kcc20StateFromUtxo(utxo, request.owner),
    );
    const primaryState = states[0];
    const resolvedArtifacts = await Promise.all(
      holderUtxos.map((utxo, index) =>
        resolveKcc20ArtifactForState(
          states[index],
          requireKaspaAddress(utxo.address),
          network,
        ),
      ),
    );
    if (
      resolvedArtifacts.some(
        (candidate) => candidate.version !== resolvedArtifacts[0].version,
      )
    ) {
      throw new Error("consolidation requires holder UTXOs from one artifact");
    }
    const artifact = resolvedArtifacts[0].artifact;
    for (const peerState of states.slice(1)) {
      assertKcc20MergeableStates(primaryState, peerState, owner);
    }
    const mergedState = {
      ...primaryState,
      amount: states.reduce((sum, state) => sum + state.amount, 0n),
    };

    const kw = kaspaWasm;
    const {
      Encoding,
      RpcClient,
      Transaction,
      TransactionOutput,
      payToAddressScript,
    } = kw;
    const sources = holderUtxos.map((utxo, index) => {
      const txid = requireHex32(utxo.txidHex, `holder ${index} txid`);
      const vout = parseVout(utxo.vout, `holder ${index} vout`);
      const address = requireKaspaAddress(utxo.address);
      const script = buildNativeKcc20ScriptForState(
        artifact.script,
        states[index],
      );
      assertScriptAddress(
        kw,
        script,
        address,
        network,
        `holder ${index} UTXO address`,
      );
      return { txid, vout, address, script };
    });

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [onChainHolderUtxos, walletUtxos] = await Promise.all([
        getUtxosByAddresses(
          rpc,
          uniqueStrings(sources.map((source) => source.address)),
        ),
        getUtxosByAddresses(rpc, [walletAddress]),
      ]);
      const entries = sources.map((source, index) => {
        const entry = findUtxoEntry(
          onChainHolderUtxos.entries,
          source.txid,
          source.vout,
        );
        if (!entry) {
          throw new Error(
            `holder ${index} UTXO ${source.txid}:${source.vout} not found`,
          );
        }
        if (utxoAmountSompi(entry) < DEFAULT_TOKEN_OUTPUT_SOMPI) {
          throw new Error(
            `holder ${index} deposit is below ${DEFAULT_TOKEN_OUTPUT_SOMPI} sompi`,
          );
        }
        return entry;
      });
      const spendCovenantIds = entries.map(
        (entry) => covenantIdFromUtxoEntry(entry) ?? covenantId,
      );

      if (new Set(spendCovenantIds).size !== 1) {
        throw new Error("KCC20 holder UTXOs use different covenant ids");
      }
      const spendCovenantId = spendCovenantIds[0];

      const mergedOutputIndex = 0;
      const refundOutputIndex = 1;
      const tokenOutputSompi = DEFAULT_TOKEN_OUTPUT_SOMPI;
      const covenantInputSompi = entries.reduce(
        (sum, entry) => sum + utxoAmountSompi(entry),
        0n,
      );
      const refundSompi = covenantInputSompi - tokenOutputSompi;
      if (refundSompi < DEFAULT_TOKEN_OUTPUT_SOMPI) {
        throw new Error("KCC20 holder deposits cannot fund the merge refund");
      }
      const outputs = [
        tokenOutput(
          kw,
          artifact,
          mergedState,
          tokenOutputSompi,
          spendCovenantId,
          0,
        ),
        new TransactionOutput(refundSompi, payToAddressScript(walletAddress)),
      ];
      const requiredFunding = priorityFee + MIN_FUNDING_CHANGE_SOMPI;
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        requiredFunding,
      );
      const fundingInputIndex = entries.length;
      const change = utxoAmountSompi(fundingEntry) - priorityFee;
      let fundingChangeOutputIndex = -1;
      if (change > MIN_FUNDING_CHANGE_SOMPI) {
        fundingChangeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(change, payToAddressScript(walletAddress)),
        );
      }

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          ...entries.map((entry, index) => ({
            previousOutpoint: entry.outpoint,
            utxo: entry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: index === 0 ? computeBudget : peerComputeBudget,
          })),
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildKcc20ConsolidatePayload({
          covenantId: spendCovenantId,
          tokenAmount: mergedState.amount,
          sourceOutpoints: sources.map(
            (source) => `${source.txid}:${source.vout}`,
          ),
        }),
      });
      setVersionOneInputMassFields(unsignedTx, computeBudget);
      for (let index = 1; index < fundingInputIndex; index += 1) {
        unsignedTx.inputs[index].computeBudget = peerComputeBudget;
      }
      unsignedTx.inputs[fundingInputIndex].computeBudget = 30;

      const scripts = sources.map((source, index) => ({
        inputIndex: index,
        scriptHex: bytesToHex(source.script),
        signType: 1,
        signatureScript:
          index === 0
            ? {
                mode: "ordered-args",
                args: kcc20TransferOrderedArgs(artifact, [mergedState]),
              }
            : {
                mode: "ordered-args",
                args: kcc20TransferDelegatorOrderedArgs(artifact),
              },
      }));
      const feeAdjustedTx = transactionWithCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        scripts,
      );
      assertConsolidationMassTarget(
        feeAdjustedTx,
        "KCC20 consolidation",
        entries.length,
      );
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "KCC20 consolidate PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        scripts,
        submitTransactionSupported: true,
        metadata: {
          builderKey: "kcc20.consolidate-holders",
          operation: "consolidate-holders",
          action: "consolidate",
          contract: "KCC20",
          network,
          walletAddress,
          covenantId: spendCovenantId,
          appCanonicalTokenId,
          requestedCovenantId:
            spendCovenantId === covenantId ? undefined : covenantId,
          sourceOutpoints: sources.map(
            (source) => `${source.txid}:${source.vout}`,
          ),
          mergedOutputIndex,
          refundOutputIndex,
          refundedHolderDepositSompi: refundSompi.toString(),
          mergedHolderDepositSompi: tokenOutputSompi.toString(),
          tokenAmount: mergedState.amount.toString(),
          ...stateToReceiptFields(mergedState),
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildKcc20SelfTransferRevealPskt(input, activeTokenUtxo) {
    const request = input.request || {};
    const params = request.params || {};
    const covenantId = requireHex32(params.covenantId, "canonical covenant id");
    const owner = requireHex32(request.owner?.kcc20Owner, "token owner");
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const priorityFee = parseU64(
      env.KCC20_REVEAL_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const computeBudget = parsePositiveNumber(
      env.KCC20_REVEAL_COMPUTE_BUDGET || DEFAULT_COMPUTE_BUDGET,
      "computeBudget",
    );

    const inputState = kcc20StateFromUtxo(activeTokenUtxo, request.owner);
    if (inputState.isMintAuthority) {
      throw new Error("self-transfer reveal requires a KCC20 holder UTXO");
    }
    if (inputState.ownerScheme !== 0) {
      throw new Error("self-transfer reveal requires a P2PK Schnorr holder");
    }
    if (bytesToHex(inputState.ownerIdentifier) !== owner) {
      throw new Error(
        "self-transfer reveal requires authenticated wallet to own the active holder UTXO",
      );
    }

    const tokenTxid = requireHex32(activeTokenUtxo.txidHex, "token txid");
    const tokenVout = parseVout(activeTokenUtxo.vout, "token vout");
    const tokenAddress = requireKaspaAddress(activeTokenUtxo.address);
    const resolvedArtifact = await resolveKcc20ArtifactForState(
      inputState,
      tokenAddress,
      network,
    );
    const artifact = resolvedArtifact.artifact;

    const kw = kaspaWasm;
    const {
      Encoding,
      RpcClient,
      Transaction,
      TransactionOutput,
      payToAddressScript,
    } = kw;
    const tokenScript = resolvedArtifact.script;

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [tokenUtxos, walletUtxos] = await Promise.all([
        getUtxosByAddresses(rpc, [tokenAddress]),
        getUtxosByAddresses(rpc, [walletAddress]),
      ]);
      const tokenEntry = findUtxoEntry(
        tokenUtxos.entries,
        tokenTxid,
        tokenVout,
      );
      if (!tokenEntry) {
        throw new Error(
          `active token UTXO ${tokenTxid}:${tokenVout} not found`,
        );
      }
      const spendCovenantId = covenantIdFromUtxoEntry(tokenEntry) ?? covenantId;

      const tokenOutputIndex = 0;
      const tokenOutputSompi = utxoAmountSompi(tokenEntry);
      const outputs = [
        tokenOutput(
          kw,
          artifact,
          inputState,
          tokenOutputSompi,
          spendCovenantId,
          0,
        ),
      ];
      const requiredFunding = priorityFee + 10_000n;
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        requiredFunding,
      );
      const fundingInputIndex = 1;
      const change = utxoAmountSompi(fundingEntry) - priorityFee;
      let fundingChangeOutputIndex = -1;
      if (change > 10_000n) {
        fundingChangeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(change, payToAddressScript(walletAddress)),
        );
      }

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          {
            previousOutpoint: tokenEntry.outpoint,
            utxo: tokenEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildRevealPayload({
          covenantId: spendCovenantId,
          revealMode: "self-transfer",
          owner,
          tokenAmount: inputState.amount,
        }),
      });
      setVersionOneInputMassFields(unsignedTx, computeBudget);
      unsignedTx.inputs[fundingInputIndex].computeBudget = 30;

      const scripts = [
        {
          inputIndex: 0,
          scriptHex: bytesToHex(tokenScript),
          signType: 1,
          signatureScript: {
            mode: "ordered-args",
            args: kcc20TransferOrderedArgs(artifact, [inputState]),
          },
        },
      ];
      const feeAdjustedTx = transactionWithCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        scripts,
      );
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "KCC20 reveal self-transfer PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        scripts,
        submitTransactionSupported: true,
        metadata: {
          builderKey: "kcc20.reveal-token",
          operation: "verify-token",
          action: "reveal",
          contract: "KCC20",
          network,
          walletAddress,
          covenantId: spendCovenantId,
          requestedCovenantId:
            spendCovenantId === covenantId ? undefined : covenantId,
          revealMode: "self-transfer",
          tokenOutpoint: `${tokenTxid}:${tokenVout}`,
          tokenOutputIndex,
          tokenAmount: inputState.amount.toString(),
          ...stateToReceiptFields(inputState),
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildKcc20TransferPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const activeHolderUtxo = params.activeHolderUtxo || null;
    if (!activeHolderUtxo) {
      throw new Error("active KCC20 holder UTXO is required");
    }

    const covenantId = requireHex32(
      params.activeHolderNativeCovenantId || params.covenantId,
      "canonical covenant id",
    );
    const owner = requireHex32(request.owner?.kcc20Owner, "token owner");
    const recipientOwner = requireHex32(
      params.recipientOwner,
      "transfer recipient owner",
    );
    const recipientOwnerScheme = parseOwnerScheme(
      params.recipientOwnerScheme ?? params.recipientOwnerType ?? 0,
      "recipientOwnerScheme",
    );
    const transferAmount = parsePositiveU64(params.tokenAmount, "tokenAmount");
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const tokenOutputSompi = assertKcc20TokenOutputSompi(
      parseU64(
        env.KCC20_TRANSFER_TOKEN_OUTPUT_SOMPI ||
          DEFAULT_TOKEN_OUTPUT_SOMPI.toString(),
        "tokenOutputSompi",
      ),
      "transfer",
    );
    const priorityFee = parseU64(
      env.KCC20_TRANSFER_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const computeBudget = parsePositiveNumber(
      env.KCC20_TRANSFER_COMPUTE_BUDGET || DEFAULT_COMPUTE_BUDGET,
      "computeBudget",
    );

    const inputState = kcc20StateFromUtxo(activeHolderUtxo, request.owner);
    if (inputState.isMintAuthority || inputState.amount <= 0n) {
      throw new Error("KCC20 transfer requires a holder UTXO");
    }
    if (inputState.ownerScheme !== 0) {
      throw new Error("KCC20 transfer requires a Schnorr P2PK holder UTXO");
    }
    if (bytesToHex(inputState.ownerIdentifier) !== owner) {
      throw new Error(
        "KCC20 transfer requires wallet to own the active holder UTXO",
      );
    }
    if (transferAmount > inputState.amount) {
      throw new Error("tokenAmount exceeds active holder balance");
    }

    const tokenTxid = requireHex32(activeHolderUtxo.txidHex, "holder txid");
    const tokenVout = parseVout(activeHolderUtxo.vout, "holder vout");
    const tokenAddress = requireKaspaAddress(activeHolderUtxo.address);
    const resolvedArtifact = await resolveKcc20ArtifactForState(
      inputState,
      tokenAddress,
      network,
    );
    const artifact = resolvedArtifact.artifact;
    const recipientState = {
      ...inputState,
      owner: hexToBytes(recipientOwner),
      ownerIdentifier: hexToBytes(recipientOwner),
      ownerScheme: recipientOwnerScheme,
      identifierType: recipientOwnerScheme,
      borrowScheme: 0,
      borrowGuard: hexToBytes(ZERO_HASH),
      amount: transferAmount,
    };
    const changeAmount = inputState.amount - transferAmount;
    const changeState =
      changeAmount > 0n ? { ...inputState, amount: changeAmount } : null;

    const kw = kaspaWasm;
    const {
      Encoding,
      RpcClient,
      Transaction,
      TransactionOutput,
      payToAddressScript,
    } = kw;
    const tokenScript = resolvedArtifact.script;

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const [tokenUtxos, walletUtxos] = await Promise.all([
        getUtxosByAddresses(rpc, [tokenAddress]),
        getUtxosByAddresses(rpc, [walletAddress]),
      ]);
      const tokenEntry = findUtxoEntry(
        tokenUtxos.entries,
        tokenTxid,
        tokenVout,
      );
      if (!tokenEntry) {
        throw new Error(
          `active holder UTXO ${tokenTxid}:${tokenVout} not found`,
        );
      }
      const spendCovenantId = covenantIdFromUtxoEntry(tokenEntry) ?? covenantId;

      let outputSompi = 0n;
      const recipientOutputIndex = 0;
      const outputs = [
        tokenOutput(
          kw,
          artifact,
          recipientState,
          changeState ? tokenOutputSompi : utxoAmountSompi(tokenEntry),
          spendCovenantId,
          0,
        ),
      ];
      outputSompi += changeState
        ? tokenOutputSompi
        : utxoAmountSompi(tokenEntry);

      let changeOutputIndex = recipientOutputIndex;
      if (changeState) {
        changeOutputIndex = outputs.length;
        outputs.push(
          tokenOutput(
            kw,
            artifact,
            changeState,
            tokenOutputSompi,
            spendCovenantId,
            0,
          ),
        );
        outputSompi += tokenOutputSompi;
      }

      const tokenInputSompi = utxoAmountSompi(tokenEntry);
      const requiredFunding =
        outputSompi + priorityFee > tokenInputSompi
          ? outputSompi + priorityFee - tokenInputSompi + 10_000n
          : priorityFee + 10_000n;
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        requiredFunding,
      );
      const fundingInputIndex = 1;
      const change =
        tokenInputSompi +
        utxoAmountSompi(fundingEntry) -
        outputSompi -
        priorityFee;
      let fundingChangeOutputIndex = -1;
      if (change > 10_000n) {
        fundingChangeOutputIndex = outputs.length;
        outputs.push(
          new TransactionOutput(change, payToAddressScript(walletAddress)),
        );
      }

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          {
            previousOutpoint: tokenEntry.outpoint,
            utxo: tokenEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget,
          },
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildTransferPayload({
          covenantId: spendCovenantId,
          fromOwner: owner,
          recipientOwner,
          recipientOwnerScheme,
          tokenAmount: transferAmount,
        }),
      });
      setVersionOneInputMassFields(unsignedTx, computeBudget);
      unsignedTx.inputs[fundingInputIndex].computeBudget = 30;

      const scripts = [
        {
          inputIndex: 0,
          scriptHex: bytesToHex(tokenScript),
          signType: 1,
          signatureScript: {
            mode: "ordered-args",
            args: kcc20TransferOrderedArgs(
              artifact,
              changeState ? [recipientState, changeState] : [recipientState],
            ),
          },
        },
      ];
      const feeAdjustedTx = transactionWithCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
        scripts,
      );
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "KCC20 transfer PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: [{ index: fundingInputIndex, sighashType: 1 }],
        scripts,
        submitTransactionSupported: true,
        metadata: {
          builderKey: "kcc20.transfer",
          operation: "transfer-token",
          action: "transfer",
          contract: "KCC20",
          network,
          walletAddress,
          covenantId: spendCovenantId,
          requestedCovenantId:
            spendCovenantId === covenantId ? undefined : covenantId,
          holderOutpoint: `${tokenTxid}:${tokenVout}`,
          recipientOwner,
          recipientOutputIndex,
          changeOutputIndex: changeState ? changeOutputIndex : null,
          tokenAmount: transferAmount.toString(),
          changeAmount: changeAmount.toString(),
          ...stateToReceiptFields(recipientState),
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildKcc20DeployPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const owner = requireHex32(
      params.creator || request.owner?.kcc20Owner,
      "creator",
    );
    const premintRecipient = requireHex32(
      params.premintRecipient || owner,
      "premint recipient",
    );
    const treasury = requireHex32(
      params.treasury || params.treasuryRecipient || owner,
      "treasury recipient",
    );
    const feeRecipient = requireHex32(
      params.protocolFeeRecipient || KCC20_PLATFORM_PROTOCOL_FEE_RECIPIENT,
      "protocol fee recipient",
    );
    const premintOwnerScheme = parseOwnerScheme(
      params.premintOwnerScheme ?? 0,
      "premintOwnerScheme",
    );
    const maxSupply = parsePositiveU64(params.maxSupply, "maxSupply");
    const premintSupply = parseU64(
      params.premintSupply || "0",
      "premintSupply",
    );
    const mintPolicy = parseMintPolicy(
      params.mintPolicy || mintPolicyName(params.mintPolicyValue ?? 0),
    );
    const mintPriceSompi = parseU64(
      params.mintPricePerTokenSompi || "0",
      "mintPricePerTokenSompi",
    );
    const feeBps = parseFeeBps(
      params.protocolFeeBps ??
        env.KCC20_PROTOCOL_FEE_BPS ??
        DEFAULT_KCC20_FEE_BPS,
    );
    const decimals = parseU64(params.decimals ?? "0", "decimals");
    const priceScale = 10n ** decimals;
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const amountTkas = parseAmountTkas(
      env.KCC20_DEPLOY_OUTPUT_TKAS || DEFAULT_DEPLOY_TKAS,
    );
    const priorityFee = parseU64(
      env.KCC20_DEPLOY_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );
    const metadata = {
      ticker: normalizeTicker(params.ticker || ""),
      name: normalizeTokenName(params.tokenName || ""),
    };

    if (premintSupply > maxSupply)
      throw new Error("premintSupply cannot exceed maxSupply");
    if (mintPolicy === 0 && premintSupply !== maxSupply) {
      throw new Error("fixed deploys must premint the full maxSupply");
    }
    if (mintPolicy !== 0 && premintSupply === maxSupply) {
      throw new Error(
        "controlled/public mint deploys must leave remaining mint supply",
      );
    }

    const artifact = await readStaticArtifact(KCC20_ARTIFACT_PATH);
    const displayScale = priceScale;
    const remainingSupply = maxSupply - premintSupply;
    const mintLaneCount =
      mintPolicy === 0
        ? 1n
        : parseMintLaneCount(params.mintLaneCount ?? 1, "mintLaneCount");
    const mintLaneSupplies =
      mintPolicy === 0
        ? []
        : splitKcc20MintSupply(remainingSupply, mintLaneCount);
    const immutableExtension = {
      kind: 1,
      creator: hexToBytes(owner),
      ticker: asciiToBytes32(metadata.ticker, "ticker"),
      name: asciiToBytes32(metadata.name, "token name"),
      displayScale,
      maxSupply,
      mintLaneCount,
      mintPolicy,
      mintPriceSompi,
      treasury: hexToBytes(treasury),
      protocolFeeRecipient: hexToBytes(feeRecipient),
      protocolFeeBps: BigInt(feeBps),
    };
    const holderCommitment = holderExtensionCommitment(immutableExtension);
    const baseExtension =
      mintPolicy === 0
        ? null
        : {
            ...immutableExtension,
            publicMintActive: false,
            holderExtensionCommitment: holderCommitment,
          };
    const minterStates = baseExtension
      ? mintLaneSupplies.map((laneSupply) => {
          const extension = { ...baseExtension, remainingSupply: laneSupply };
          return {
            extension,
            state: {
              amount: 0n,
              owner: hexToBytes(owner),
              ownerScheme: 0,
              borrowScheme: 0,
              borrowGuard: hexToBytes(ZERO_HASH),
              extensionCommitment: mintExtensionCommitment(extension),
            },
          };
        })
      : [];
    const extension = minterStates[0]?.extension ?? null;
    const state = extension
      ? minterStates[0].state
      : {
          amount: maxSupply,
          owner: hexToBytes(premintRecipient),
          ownerScheme: premintOwnerScheme,
          borrowScheme: 0,
          borrowGuard: hexToBytes(ZERO_HASH),
          extensionCommitment: holderCommitment,
        };
    const premintState =
      extension && premintSupply > 0n
        ? {
            amount: premintSupply,
            owner: hexToBytes(premintRecipient),
            ownerScheme: premintOwnerScheme,
            borrowScheme: 0,
            borrowGuard: hexToBytes(ZERO_HASH),
            extensionCommitment: holderCommitment,
          }
        : null;
    const covenantStates = extension
      ? minterStates.map(({ state }) => state)
      : [state];
    if (premintState) covenantStates.push(premintState);

    const kw = kaspaWasm;
    const {
      Encoding,
      GenesisCovenantGroup,
      RpcClient,
      Transaction,
      TransactionOutput,
      addressFromScriptPublicKey,
      payToAddressScript,
      payToScriptHashScript,
    } = kw;

    const covenantOutputs = covenantStates.map((covenantState) => {
      const script = buildKcc20ScriptForState(artifact, covenantState);
      const scriptPublicKey = payToScriptHashScript(script);
      return {
        script,
        scriptPublicKey,
        address: addressFromScriptPublicKey(
          scriptPublicKey,
          network,
        ).toString(),
      };
    });
    const contractAddress = covenantOutputs[0].address;
    const canonicalCovenantId = p2shScriptHashHex(
      kw,
      covenantOutputs[0].script,
    );
    const deploySompi = BigInt(Math.round(amountTkas * Number(SOMPI_PER_TKAS)));
    const premintOutputIndex = premintState ? covenantOutputs.length - 1 : null;

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const utxos = await getUtxosByAddresses(rpc, [walletAddress]);
      const outputSompi = deploySompi * BigInt(covenantOutputs.length);
      const fundingEntry = selectFundingEntry(
        utxos.entries,
        outputSompi + priorityFee + 10_000_000n,
      );
      const fundingChangeOutputIndex = covenantOutputs.length;
      const change = utxoAmountSompi(fundingEntry) - outputSompi - priorityFee;
      if (change <= 10_000n) {
        throw kcc20PsktBuilderError(
          "deploy PSKT builder selected insufficient change",
          "KAS_FUNDING_CHANGE_TOO_SMALL",
        );
      }

      const outputs = [
        ...covenantOutputs.map(
          ({ scriptPublicKey }) =>
            new TransactionOutput(deploySompi, scriptPublicKey),
        ),
        new TransactionOutput(change, payToAddressScript(walletAddress)),
      ];

      const unsignedTx = new Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          {
            previousOutpoint: fundingEntry.outpoint,
            utxo: fundingEntry,
            sequence: 0n,
            sigOpCount: 0,
            computeBudget: 30,
          },
        ],
        outputs,
        subnetworkId: SUBNETWORK_ID_NATIVE,
        gas: 0n,
        payload: buildKcc20DeployPayload({
          owner,
          maxSupply,
          premintSupply,
          premintRecipient,
          premintOwnerScheme,
          mintPolicy,
          mintPriceSompi,
          treasury,
          feeRecipient,
          feeBps,
          displayScale,
          mintLaneCount: immutableExtension.mintLaneCount,
          holderExtensionCommitment: bytesToHex(holderCommitment),
          metadata,
        }),
      });
      unsignedTx.version = 1;
      setVersionOneInputMassFields(unsignedTx);

      const covenantOutputIndex = 0;
      const covenantOutputIndexes = covenantOutputs.map((_, index) => index);
      unsignedTx.populateGenesisCovenants([
        new GenesisCovenantGroup(0, covenantOutputIndexes),
      ]);

      unsignedTx.finalize();
      const kip20BindingCovenantId =
        unsignedTx.outputs[
          covenantOutputIndex
        ]?.covenant?.covenantId?.toString();
      if (!kip20BindingCovenantId)
        throw new Error(
          `failed to populate KCC20 covenant binding on output ${covenantOutputIndex}`,
        );

      const feeAdjustedTx = transactionWithCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
      );
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "KCC20 deploy PSKT serialization did not return JSON text",
        );
      }
      const revealScriptHex = bytesToHex(
        covenantOutputs[covenantOutputIndex].script,
      );

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: unsignedTx.inputs.map((_, index) => ({
          index,
          sighashType: 1,
        })),
        submitTransactionSupported: true,
        metadata: {
          builderKey: "kcc20.deploy-token",
          contract: "KCC20",
          network,
          walletAddress,
          contractAddress,
          covenantOutputIndex,
          minterOutputIndexes: extension
            ? minterStates.map((_, index) => index)
            : undefined,
          premintOutputIndex,
          covenantId: kip20BindingCovenantId,
          scriptHashHex: canonicalCovenantId,
          amountSompi: deploySompi.toString(),
          maxSupply: maxSupply.toString(),
          premintSupply: premintSupply.toString(),
          decimals: String(decimals),
          mintPolicy,
          publicMintActive: mintPolicy === 2 ? false : undefined,
          mintLaneCount: immutableExtension.mintLaneCount.toString(),
          holderExtensionCommitment: bytesToHex(holderCommitment),
          revealScriptHex,
          maximumFeeSompi: (
            [...feeAdjustedTx.inputs].reduce(
              (sum, input) =>
                sum + BigInt(input.utxo?.amount ?? input.utxo?.value),
              0n,
            ) -
            [...feeAdjustedTx.outputs].reduce(
              (sum, output) => sum + BigInt(output.value ?? output.amount),
              0n,
            )
          ).toString(),
          intentInputs: [{ role: "creator-funding", index: 0 }],
          intentOutputs: [
            {
              role: "fixed-supply-token",
              index: covenantOutputIndex,
              covenantId: kip20BindingCovenantId,
              revealScriptHex,
              owner: premintRecipient,
              ownerScheme: premintOwnerScheme,
              borrowScheme: 0,
              borrowGuard: ZERO_HASH,
              extensionCommitment: bytesToHex(holderCommitment),
              tokenAmount: maxSupply.toString(),
            },
          ],
          mintLaneSupplies: extension
            ? mintLaneSupplies.map((supply) => supply.toString())
            : undefined,
          extension: extension ? jsonKcc20MintExtension(extension) : undefined,
          ...stateToReceiptFields(state),
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildFeeTicketRootDeployPskt(input) {
    const request = input.request || {};
    const params = request.params || {};
    const owner = requireHex32(
      params.rootOwner || request.owner?.kcc20Owner,
      "root owner",
    );
    const utilityTokenId = requireHex32(
      params.utilityTokenId,
      "utility token id",
    );
    const denomination = parsePositiveU64(
      params.utilityTokenAmount,
      "utilityTokenAmount",
    );
    const network =
      request.network || env.KASPA_NETWORK || "testnet-10";
    const walletAddress = requireKaspaAddress(request.owner?.walletAddress);
    const rpcUrl = env.KASPA_WRPC_URL || DEFAULT_WRPC_URL;
    const amountTkas = parseAmountTkas(
      env.KCC20_FEE_TICKET_OUTPUT_TKAS || DEFAULT_DEPLOY_TKAS,
    );
    const priorityFee = parseU64(
      env.KCC20_FEE_TICKET_PRIORITY_FEE_SOMPI ||
        DEFAULT_PRIORITY_FEE.toString(),
      "priorityFee",
    );

    const artifact = await readStaticArtifact(FEE_TICKET_ARTIFACT_PATH);
    const state = {
      ownerIdentifier: hexToBytes(owner),
      mode: 1,
      utilityTokenId: hexToBytes(utilityTokenId),
      denomination,
    };

    const kw = kaspaWasm;
    const {
      Encoding,
      GenesisCovenantGroup,
      RpcClient,
      Transaction,
      addressFromScriptPublicKey,
      createTransactions,
      payToScriptHashScript,
    } = kw;

    const contractScript = buildKcc20FeeTicketScriptForState(
      artifact.script,
      state,
    );
    const contractAddress = addressFromScriptPublicKey(
      payToScriptHashScript(contractScript),
      network,
    ).toString();
    const deploySompi = BigInt(Math.round(amountTkas * Number(SOMPI_PER_TKAS)));

    const rpc = new RpcClient({
      url: rpcUrl,
      encoding: Encoding.Borsh,
      networkId: network,
    });
    await rpc.connect();
    try {
      const utxos = await getUtxosByAddresses(rpc, [walletAddress]);
      const fundingEntry = selectFundingEntry(
        utxos.entries,
        deploySompi + priorityFee + 10_000_000n,
      );
      const created = await createTransactions({
        entries: [fundingEntry],
        outputs: [{ address: contractAddress, amount: deploySompi }],
        changeAddress: walletAddress,
        priorityFee,
        networkId: network,
        payload: buildFeeTicketPayload({
          owner,
          stateMode: 1,
          utilityTokenId,
          denomination,
        }),
      });
      if (created.transactions.length !== 1) {
        throw new Error(
          "FeeTicket root deploy PSKT builder expected a single final transaction",
        );
      }

      const unsignedTx = Transaction.deserializeFromJSON(
        created.transactions[0].serializeToJSON(),
      );
      unsignedTx.version = 1;
      setVersionOneInputMassFields(unsignedTx, 300);

      const covenantOutputIndex = findOutputIndex(
        unsignedTx,
        contractAddress,
        network,
        addressFromScriptPublicKey,
      );
      if (covenantOutputIndex < 0)
        throw new Error(
          "final transaction did not contain the FeeTicket root output",
        );
      unsignedTx.populateGenesisCovenants([
        new GenesisCovenantGroup(0, [covenantOutputIndex]),
      ]);
      unsignedTx.finalize();
      const covenantId =
        unsignedTx.outputs[
          covenantOutputIndex
        ]?.covenant?.covenantId?.toString();
      if (!covenantId)
        throw new Error(
          `failed to populate FeeTicket covenant binding on output ${covenantOutputIndex}`,
        );

      const fundingChangeOutputIndex = findOutputIndex(
        unsignedTx,
        walletAddress,
        network,
        addressFromScriptPublicKey,
      );
      if (fundingChangeOutputIndex < 0) {
        throw new Error(
          "final transaction did not contain the FeeTicket funding change output",
        );
      }

      const feeAdjustedTx = transactionWithMinimumCalculatedFeeChange(
        kw,
        unsignedTx,
        fundingChangeOutputIndex,
        network,
        input.request?.builderKey || "PSKT",
      );
      const psktTransactionJson = feeAdjustedTx.serializeToSafeJSON();
      if (typeof psktTransactionJson !== "string") {
        throw new Error(
          "FeeTicket root deploy PSKT serialization did not return JSON text",
        );
      }

      return {
        schema: OUTPUT_SCHEMA,
        psktTransactionJson,
        signInputs: unsignedTx.inputs.map((_, index) => ({
          index,
          sighashType: 1,
        })),
        submitTransactionSupported: true,
        metadata: {
          builderKey: "fee-ticket.deploy-root",
          contract: "KCC20FeeTicket",
          network,
          walletAddress,
          contractAddress,
          covenantOutputIndex,
          covenantId,
          amountSompi: deploySompi.toString(),
          ownerIdentifier: owner,
          stateOwner: owner,
          mode: 1,
          stateMode: 1,
          modeName: "root",
          utilityTokenId,
          denomination: denomination.toString(),
          discountBps: params.discountBps ?? null,
          supportedMarketIds: Array.isArray(params.supportedMarketIds)
            ? params.supportedMarketIds
            : [],
        },
      };
    } finally {
      await rpc.disconnect();
    }
  }

  function buildKcc20DeployPayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn12: {
          v: 1,
          tmpl: "KCC20",
          args: [
            { name: "creator", type: "byte[32]", value: fields.owner },
            {
              name: "maxSupply",
              type: "u64",
              value: fields.maxSupply.toString(),
            },
            {
              name: "mintLaneCount",
              type: "u64",
              value: BigInt(fields.mintLaneCount ?? 1).toString(),
            },
            {
              name: "premintSupply",
              type: "u64",
              value: fields.premintSupply.toString(),
            },
            {
              name: "premintRecipient",
              type: "byte[32]",
              value: fields.premintRecipient,
            },
            {
              name: "premintOwnerScheme",
              type: "u64",
              value: String(fields.premintOwnerScheme),
            },
            {
              name: "mintPolicy",
              type: "u64",
              value: String(fields.mintPolicy),
            },
            {
              name: "displayScale",
              type: "u64",
              value: fields.displayScale.toString(),
            },
            {
              name: "mintPriceSompi",
              type: "u64",
              value: fields.mintPriceSompi.toString(),
            },
            {
              name: "treasury",
              type: "byte[32]",
              value: fields.treasury,
            },
            {
              name: "protocolFeeRecipient",
              type: "byte[32]",
              value: fields.feeRecipient,
            },
            {
              name: "protocolFeeBps",
              type: "u64",
              value: String(fields.feeBps),
            },
            {
              name: "ticker",
              type: "string",
              value: fields.metadata?.ticker || "",
            },
            {
              name: "name",
              type: "string",
              value: fields.metadata?.name || "",
            },
          ],
        },
      }),
    );
  }

  function buildFeeTicketPayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn10: {
          v: 1,
          tmpl: "KCC20FeeTicket",
          args: [
            { name: "stateOwner", type: "byte[32]", value: fields.owner },
            { name: "stateMode", type: "u64", value: String(fields.stateMode) },
            {
              name: "utilityTokenId",
              type: "byte[32]",
              value: fields.utilityTokenId,
            },
            {
              name: "denomination",
              type: "u64",
              value: fields.denomination.toString(),
            },
          ],
        },
      }),
    );
  }

  function buildFeeTicketRootUpdatePayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn10: {
          v: 1,
          tmpl: "KCC20FeeTicket",
          op: "updateDenominationByOwnerSig",
          args: [
            { name: "rootId", type: "byte[32]", value: fields.rootId },
            { name: "owner", type: "byte[32]", value: fields.owner },
            {
              name: "utilityTokenId",
              type: "byte[32]",
              value: fields.utilityTokenId,
            },
            {
              name: "previousDenomination",
              type: "u64",
              value: fields.previousDenomination.toString(),
            },
            {
              name: "newDenomination",
              type: "u64",
              value: fields.newDenomination.toString(),
            },
          ],
        },
      }),
    );
  }

  function buildFeeTicketBurnPayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn10: {
          v: 1,
          tmpl: "KCC20FeeTicket",
          op: "burnByOwnerSig",
          args: [
            { name: "rootId", type: "byte[32]", value: fields.rootId },
            { name: "owner", type: "byte[32]", value: fields.owner },
            {
              name: "sourceOutpoints",
              type: "string[]",
              value: fields.sourceOutpoints,
            },
          ],
        },
      }),
    );
  }

  function buildFeeTicketTransferPayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn10: {
          v: 1,
          tmpl: "KCC20FeeTicket",
          op: "transferByOwnerSig",
          args: [
            { name: "rootId", type: "byte[32]", value: fields.rootId },
            { name: "owner", type: "byte[32]", value: fields.owner },
            {
              name: "recipientOwner",
              type: "byte[32]",
              value: fields.recipientOwner,
            },
            {
              name: "sourceOutpoints",
              type: "string[]",
              value: fields.sourceOutpoints,
            },
          ],
        },
      }),
    );
  }

  function buildWrapperMarketDeployPayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn10: {
          v: 1,
          tmpl: "KCC20Wrapper",
          args: [
            {
              name: "canonicalTokenId",
              type: "byte[32]",
              value: fields.canonicalTokenId,
            },
            {
              name: "feeTicketId",
              type: "byte[32]",
              value: fields.feeTicketId,
            },
            {
              name: "wrappedRootAmount",
              type: "u64",
              value: fields.rootAmount.toString(),
            },
            {
              name: "stateOwner",
              type: "byte[32]",
              value: fields.stateOwner,
            },
            {
              name: "priceScale",
              type: "u64",
              value: fields.priceScale.toString(),
            },
          ],
        },
      }),
    );
  }

  function buildWrapperWrapPayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn10: {
          v: 1,
          tmpl: "KCC20Wrapper",
          op: "wrap",
          args: [
            {
              name: "canonicalTokenId",
              type: "byte[32]",
              value: fields.canonicalTokenId,
            },
            {
              name: "wrappedMarketId",
              type: "byte[32]",
              value: fields.wrapperId,
            },
            {
              name: "recipientOwner",
              type: "byte[32]",
              value: fields.recipientOwner,
            },
            {
              name: "tokenAmount",
              type: "u64",
              value: fields.tokenAmount.toString(),
            },
          ],
        },
      }),
    );
  }

  function buildWrapperUnwrapPayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn10: {
          v: 1,
          tmpl: "KCC20Wrapper",
          op: "unwrap",
          args: [
            {
              name: "canonicalTokenId",
              type: "byte[32]",
              value: fields.canonicalTokenId,
            },
            {
              name: "wrappedMarketId",
              type: "byte[32]",
              value: fields.wrapperId,
            },
            {
              name: "recipientOwner",
              type: "byte[32]",
              value: fields.recipientOwner,
            },
            {
              name: "tokenAmount",
              type: "u64",
              value: fields.tokenAmount.toString(),
            },
          ],
        },
      }),
    );
  }

  function buildWrappedOrderPayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn10: {
          v: 1,
          tmpl: "KCC20Orderbook",
          op: fields.side === "buy" ? "createBid" : "createAsk",
          args: [
            {
              name: "canonicalTokenId",
              type: "byte[32]",
              value: fields.canonicalTokenId,
            },
            {
              name: "wrappedMarketId",
              type: "byte[32]",
              value: fields.wrapperId,
            },
            { name: "owner", type: "byte[32]", value: fields.owner },
            { name: "side", type: "string", value: fields.side },
            {
              name: "tokenAmount",
              type: "u64",
              value: fields.tokenAmount.toString(),
            },
            {
              name: "unitPriceSompi",
              type: "u64",
              value: fields.unitPriceSompi.toString(),
            },
            {
              name: "feeTicketId",
              type: "byte[32]",
              value: fields.feeTicketId,
            },
          ],
        },
      }),
    );
  }

  function buildWrappedFillPayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn10: {
          v: 1,
          tmpl: "KCC20Orderbook",
          op: fields.side === "buy" ? "fillAsk" : "fillBid",
          args: [
            {
              name: "canonicalTokenId",
              type: "byte[32]",
              value: fields.canonicalTokenId,
            },
            {
              name: "wrappedMarketId",
              type: "byte[32]",
              value: fields.wrapperId,
            },
            { name: "side", type: "string", value: fields.side },
            {
              name: "targetOrderId",
              type: "string",
              value: fields.targetOrderId,
            },
            {
              name: "tokenAmount",
              type: "u64",
              value: fields.tokenAmount.toString(),
            },
            {
              name: "unitPriceSompi",
              type: "u64",
              value: fields.unitPriceSompi.toString(),
            },
          ],
        },
      }),
    );
  }

  function buildWrappedSweepPayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn10: {
          v: 1,
          tmpl: "KCC20Orderbook",
          op: fields.side === "buy" ? "sweepAsks" : "sweepBids",
          args: [
            {
              name: "canonicalTokenId",
              type: "byte[32]",
              value: fields.canonicalTokenId,
            },
            {
              name: "wrappedMarketId",
              type: "byte[32]",
              value: fields.wrapperId,
            },
            { name: "side", type: "string", value: fields.side },
            {
              name: "fills",
              type: "json",
              value: fields.fills.map((fill) => ({
                orderId: fill.orderId,
                tokenAmount: fill.tokenAmount.toString(),
                unitPriceSompi: fill.unitPriceSompi.toString(),
              })),
            },
          ],
        },
      }),
    );
  }

  function buildWrappedConsolidatePayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn10: {
          v: 1,
          tmpl: "KCC20Orderbook",
          op: "consolidate",
          args: [
            {
              name: "canonicalTokenId",
              type: "byte[32]",
              value: fields.canonicalTokenId,
            },
            {
              name: "wrappedMarketId",
              type: "byte[32]",
              value: fields.wrapperId,
            },
            {
              name: "sourceOutpoints",
              type: "json",
              value: fields.sourceOutpoints,
            },
            {
              name: "tokenAmount",
              type: "u64",
              value: fields.tokenAmount.toString(),
            },
          ],
        },
      }),
    );
  }

  function buildWrappedCrossPayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn10: {
          v: 1,
          tmpl: "KCC20Orderbook",
          op: "settleCrossed",
          args: [
            {
              name: "canonicalTokenId",
              type: "byte[32]",
              value: fields.canonicalTokenId,
            },
            {
              name: "wrappedMarketId",
              type: "byte[32]",
              value: fields.wrapperId,
            },
            { name: "side", type: "string", value: "cross" },
            {
              name: "askOrderId",
              type: "string",
              value: fields.askOrderId,
            },
            {
              name: "bidOrderId",
              type: "string",
              value: fields.bidOrderId,
            },
            {
              name: "tokenAmount",
              type: "u64",
              value: fields.tokenAmount.toString(),
            },
            {
              name: "unitPriceSompi",
              type: "u64",
              value: fields.unitPriceSompi.toString(),
            },
          ],
        },
      }),
    );
  }

  function buildWrappedCancelPayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn10: {
          v: 1,
          tmpl: "KCC20Orderbook",
          op: fields.side === "ask" ? "cancelAsk" : "cancelBid",
          args: [
            {
              name: "canonicalTokenId",
              type: "byte[32]",
              value: fields.canonicalTokenId,
            },
            {
              name: "wrappedMarketId",
              type: "byte[32]",
              value: fields.wrapperId,
            },
            { name: "side", type: "string", value: fields.side },
            {
              name: "targetOrderId",
              type: "string",
              value: fields.targetOrderId,
            },
            {
              name: "tokenAmount",
              type: "u64",
              value: fields.tokenAmount.toString(),
            },
            {
              name: "unitPriceSompi",
              type: "u64",
              value: fields.unitPriceSompi.toString(),
            },
          ],
        },
      }),
    );
  }

  function buildMintPayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn12: {
          v: 1,
          tmpl: "KCC20",
          op: fields.mintPath === "owner" ? "mint_by_owner" : "mint_public",
          args: [
            { name: "covenantId", type: "byte[32]", value: fields.covenantId },
            {
              name: "recipientOwner",
              type: "byte[32]",
              value: fields.recipientOwner,
            },
            {
              name: "recipientOwnerScheme",
              type: "u64",
              value: String(fields.recipientOwnerScheme),
            },
            {
              name: "tokenAmount",
              type: "u64",
              value: fields.mintAmount.toString(),
            },
            {
              name: "mintPriceSompi",
              type: "u64",
              value: fields.mintPriceSompi.toString(),
            },
            {
              name: "protocolFeeBps",
              type: "u64",
              value: String(fields.feeBps),
            },
            {
              name: "treasury",
              type: "byte[32]",
              value: fields.treasury,
            },
            {
              name: "protocolFeeRecipient",
              type: "byte[32]",
              value: fields.feeRecipient,
            },
          ],
        },
      }),
    );
  }

  function buildKcc20TransferPayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn12: {
          v: 1,
          tmpl: "KCC20",
          op: "transfer",
          args: [
            { name: "covenantId", type: "byte[32]", value: fields.covenantId },
            {
              name: "recipientOwner",
              type: "byte[32]",
              value: fields.recipientOwner,
            },
            {
              name: "recipientOwnerScheme",
              type: "u64",
              value: String(fields.recipientOwnerScheme),
            },
            {
              name: "tokenAmount",
              type: "u64",
              value: fields.tokenAmount.toString(),
            },
          ],
        },
      }),
    );
  }

  function buildKcc20ConsolidatePayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn12: {
          v: 1,
          tmpl: "KCC20",
          op: "consolidate",
          args: [
            { name: "covenantId", type: "byte[32]", value: fields.covenantId },
            {
              name: "sourceOutpoints",
              type: "json",
              value: fields.sourceOutpoints,
            },
            {
              name: "tokenAmount",
              type: "u64",
              value: fields.tokenAmount.toString(),
            },
          ],
        },
      }),
    );
  }

  function buildRevealPayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn12: {
          v: 1,
          tmpl: "KCC20",
          op: "reveal",
          args: [
            { name: "covenantId", type: "byte[32]", value: fields.covenantId },
            { name: "revealMode", type: "string", value: fields.revealMode },
            { name: "owner", type: "byte[32]", value: fields.owner },
            {
              name: "tokenAmount",
              type: "u64",
              value: fields.tokenAmount.toString(),
            },
          ],
        },
      }),
    );
  }

  function buildTransferPayload(fields) {
    return new TextEncoder().encode(
      JSON.stringify({
        tn12: {
          v: 1,
          tmpl: "KCC20",
          op: "transfer",
          args: [
            { name: "covenantId", type: "byte[32]", value: fields.covenantId },
            { name: "fromOwner", type: "byte[32]", value: fields.fromOwner },
            {
              name: "recipientOwner",
              type: "byte[32]",
              value: fields.recipientOwner,
            },
            {
              name: "recipientOwnerScheme",
              type: "u64",
              value: String(fields.recipientOwnerScheme),
            },
            {
              name: "tokenAmount",
              type: "u64",
              value: fields.tokenAmount.toString(),
            },
          ],
        },
      }),
    );
  }

  function tokenOutput(
    kw,
    artifact,
    state,
    sompi,
    covenantId,
    authorizingInput,
  ) {
    return new kw.TransactionOutput(
      sompi,
      kw.payToScriptHashScript(buildKcc20ScriptForState(artifact, state)),
      new kw.CovenantBinding(authorizingInput, new kw.Hash(covenantId)),
    );
  }

  function wrappedTokenOutput(
    kw,
    artifact,
    state,
    sompi,
    covenantId,
    authorizingInput,
  ) {
    return new kw.TransactionOutput(
      BigInt(sompi),
      kw.payToScriptHashScript(
        buildKcc20OrderbookScriptForState(artifact.script, state),
      ),
      new kw.CovenantBinding(authorizingInput, new kw.Hash(covenantId)),
    );
  }

  function assertKcc20MergeableStates(primary, peer, owner) {
    if (primary.isMintAuthority || peer.isMintAuthority) {
      throw new Error("consolidation requires KCC20 holder UTXOs");
    }
    if (primary.ownerScheme !== 0 || peer.ownerScheme !== 0) {
      throw new Error("consolidation requires P2PK Schnorr KCC20 holders");
    }
    if (
      bytesToHex(primary.ownerIdentifier) !== owner ||
      bytesToHex(peer.ownerIdentifier) !== owner
    ) {
      throw new Error("consolidation requires wallet-owned KCC20 holder UTXOs");
    }
    const checks = [
      ["owner", primary.ownerIdentifier, peer.ownerIdentifier],
      [
        "extension commitment",
        primary.extensionCommitment,
        peer.extensionCommitment,
      ],
    ];
    for (const [label, left, right] of checks) {
      if (!bytesEqual(left, right)) {
        throw new Error(
          `KCC20 holder ${label} does not match for consolidation`,
        );
      }
    }
    if (primary.ownerScheme !== peer.ownerScheme) {
      throw new Error("KCC20 holder state does not match for consolidation");
    }
  }

  function assertKcc20OrderbookMergeableStates(primary, peer, owner) {
    if (primary.mode !== 0 || peer.mode !== 0) {
      throw new Error("consolidation requires KCC20 orderbook holder UTXOs");
    }
    if (
      bytesToHex(primary.ownerIdentifier) !== owner ||
      bytesToHex(peer.ownerIdentifier) !== owner
    ) {
      throw new Error(
        "consolidation requires wallet-owned KCC20 orderbook holder UTXOs",
      );
    }
    const checks = [
      ["canonicalTokenId", primary.canonicalTokenId, peer.canonicalTokenId],
      ["ownerIdentifier", primary.ownerIdentifier, peer.ownerIdentifier],
      ["feeTicketId", primary.feeTicketId, peer.feeTicketId],
    ];
    for (const [label, left, right] of checks) {
      if (!bytesEqual(left, right)) {
        throw new Error(
          `KCC20 orderbook holder ${label} does not match for merge`,
        );
      }
    }
    if (
      primary.unitPriceSompi !== 0n ||
      peer.unitPriceSompi !== 0n ||
      primary.priceScale !== peer.priceScale
    ) {
      throw new Error("KCC20 orderbook holder state does not match for merge");
    }
  }

  function bytesEqual(left, right) {
    if (!left || !right || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        return false;
      }
    }
    return true;
  }

  function uniqueStrings(values) {
    return [...new Set(values)];
  }

  function maxBigint(values) {
    return values.reduce((max, value) => (value > max ? value : max), 0n);
  }

  function buildWrapPrefix(kw, kcc20Artifact, args) {
    const kcc20Parts = templateParts(kcc20Artifact);
    const orderbookParts = templateParts(args.wrappedArtifact);
    const builder = covenantScriptBuilder(kw);
    addWrapperState(builder, args.state);
    addWrapperState(builder, args.state);
    builder.addI64(BigInt(args.tokenInputIndex));
    builder.addI64(BigInt(args.tokenLockedOutputIndex));
    builder.addI64(BigInt(args.orderbookHolderOutputIndex));
    builder.addI64(BigInt(args.wrapperOutputIndex));
    builder.addData(args.wrappedRecipient);
    addExplicitByte(builder, args.wrappedRecipientScheme);
    builder.addI64(BigInt(args.tokenAmount));
    builder.addData(kcc20Parts.prefix);
    builder.addData(kcc20Parts.suffix);
    builder.addData(orderbookParts.prefix);
    builder.addData(orderbookParts.suffix);
    addKcc20State(builder, args.lockedTokenState);
    addOrderbookState(builder, args.wrappedHolderState);
    builder.addData(dispatchTagFor(args.wrapperArtifact, "wrap"));
    return builder.drain();
  }

  function buildWrapperUnwrapPrefix(kw, kcc20Artifact, args) {
    const kcc20Parts = templateParts(kcc20Artifact);
    const orderbookParts = templateParts(args.wrappedArtifact);
    const builder = covenantScriptBuilder(kw);
    addWrapperState(builder, args.state);
    addWrapperState(builder, args.state);
    builder.addI64(BigInt(args.wrappedInputIndex));
    builder.addI64(BigInt(args.tokenReserveInputIndex));
    builder.addI64(BigInt(args.tokenRecipientOutputIndex));
    builder.addI64(BigInt(args.tokenReserveChangeOutputIndex));
    builder.addI64(BigInt(args.wrappedChangeOutputIndex));
    builder.addI64(BigInt(args.wrapperOutputIndex));
    builder.addData(args.tokenRecipient);
    addExplicitByte(builder, args.tokenRecipientScheme);
    builder.addI64(BigInt(args.tokenAmount));
    builder.addData(kcc20Parts.prefix);
    builder.addData(kcc20Parts.suffix);
    builder.addData(orderbookParts.prefix);
    builder.addData(orderbookParts.suffix);
    addKcc20State(builder, args.tokenRecipientState);
    addKcc20State(builder, args.reserveChangeState);
    addOrderbookState(builder, args.wrappedChangeState);
    builder.addData(dispatchTagFor(args.wrapperArtifact, "unwrap"));
    return builder.drain();
  }

  function feeTicketBurnScriptHint(
    inputIndex,
    ticketScript,
    burnDispatchTag,
    refundOutputIndex = -1,
    burnTakesRefundOutput = false,
  ) {
    const args = [];
    if (burnTakesRefundOutput) {
      args.push({ type: "i64", value: String(refundOutputIndex) });
    }
    args.push({ type: "data", hex: bytesToHex(burnDispatchTag) });
    return {
      inputIndex,
      scriptHex: bytesToHex(ticketScript),
      signType: 1,
      signatureScript: {
        mode: "signature-first-args",
        args,
      },
    };
  }

  function buildFeeTicketBurnPrefix(
    kw,
    signatureHex,
    burnDispatchTag,
    refundOutputIndex = -1,
    burnTakesRefundOutput = false,
  ) {
    const builder = new kw.ScriptBuilder();
    builder.addData(normalizeSignature(hexToBytes(signatureHex)));
    if (burnTakesRefundOutput) {
      builder.addI64(BigInt(refundOutputIndex));
    }
    builder.addData(burnDispatchTag);
    return builder.drain();
  }

  function feeTicketTransferScriptHint(
    inputIndex,
    ticketScript,
    recipientOwner,
    ticketOutputIndex,
    transferDispatchTag,
  ) {
    return {
      inputIndex,
      scriptHex: bytesToHex(ticketScript),
      signType: 1,
      signatureScript: {
        mode: "signature-first-args",
        args: [
          { type: "data", hex: recipientOwner },
          { type: "byte", value: 0 },
          { type: "i64", value: String(ticketOutputIndex) },
          { type: "data", hex: bytesToHex(transferDispatchTag) },
        ],
      },
    };
  }

  function feeTicketRootUpdateScriptHint(
    inputIndex,
    rootScript,
    newDenomination,
    rootOutputIndex,
    updateDispatchTag,
  ) {
    return {
      inputIndex,
      scriptHex: bytesToHex(rootScript),
      signType: 1,
      signatureScript: {
        mode: "signature-first-args",
        args: [
          { type: "i64", value: String(newDenomination) },
          { type: "i64", value: String(rootOutputIndex) },
          { type: "data", hex: bytesToHex(updateDispatchTag) },
        ],
      },
    };
  }

  function appendFeeTicketRefundOutput(kw, outputs, ticketState, ticketEntry) {
    if (!ticketState || !ticketEntry) {
      return { outputIndex: -1, sompi: 0n };
    }
    const outputIndex = outputs.length;
    const sompi = utxoAmountSompi(ticketEntry);
    outputs.push(
      new kw.TransactionOutput(
        sompi,
        p2pkScriptPubKey(kw, bytesToHex(ticketState.ownerIdentifier)),
      ),
    );
    return { outputIndex, sompi };
  }

  function addWrapperState(builder, state) {
    builder.addData(state.canonicalTokenId);
    builder.addI64(state.enabled ? 1n : 0n);
    builder.addI64(BigInt(state.priceScale));
  }

  function addOrderbookState(builder, state) {
    if (!state.canonicalTokenId) {
      throw new Error("KCC20Orderbook state missing canonicalTokenId");
    }
    builder.addData(state.canonicalTokenId);
    builder.addData(state.ownerIdentifier);
    addExplicitByte(builder, state.ownerScheme ?? state.identifierType ?? 0);
    builder.addI64(BigInt(state.amount));
    builder.addI64(BigInt(state.mode));
    builder.addI64(BigInt(state.unitPriceSompi));
    builder.addData(state.feeTicketId || hexToBytes(ZERO_HASH));
    builder.addI64(BigInt(state.priceScale ?? DEFAULT_KCC20_PRICE_SCALE));
  }

  function addExplicitByte(builder, value) {
    const byte = Number(value);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new Error(`invalid byte ${value}`);
    }
    builder.addOps(Uint8Array.of(0x01, byte));
  }

  function kcc20StateFromUtxo(utxo, owner) {
    const state = utxo?.state || {};
    const extension = state.extension || {};
    const fallbackOwner = owner?.kcc20Owner;
    const ownerIdentifier = requireHex32(
      state.owner || state.stateOwner || state.ownerIdentifier || fallbackOwner,
      "utility token owner",
    );
    const ownerScheme = parseOwnerScheme(
      state.ownerScheme ?? state.stateOwnerType ?? state.identifierType ?? 0,
      "utility token owner scheme",
    );
    const borrowScheme = parseBorrowScheme(
      state.borrowScheme ?? 0,
      "utility token borrow scheme",
    );
    const borrowGuard = requireHex32(
      state.borrowGuard || ZERO_HASH,
      "utility token borrow guard",
    );
    const isMintAuthority = Boolean(state.isMintAuthority || state.isMinter);
    const extensionCommitmentSource =
      state.extensionCommitment ||
      (!isMintAuthority
        ? state.holderExtensionCommitment || extension.holderExtensionCommitment
        : undefined);
    const extensionCommitment = requireHex32(
      extensionCommitmentSource,
      "utility token extension commitment",
    );

    return {
      owner: hexToBytes(ownerIdentifier),
      ownerIdentifier: hexToBytes(ownerIdentifier),
      ownerScheme,
      identifierType: ownerScheme,
      borrowScheme,
      borrowGuard: hexToBytes(borrowGuard),
      extensionCommitment: hexToBytes(extensionCommitment),
      amount: parseU64(
        state.stateAmount ?? state.tokenAmount ?? state.balance ?? state.amount,
        "utility token amount",
      ),
      isMintAuthority,
    };
  }

  function assertKcc20HolderStateForWrap(state) {
    if (state?.isMintAuthority === true) {
      throw new Error("wrap requires a KCC20 holder UTXO");
    }
  }

  function assertScriptAddress(kw, script, expectedAddress, network, label) {
    const actual = kw
      .addressFromScriptPublicKey(kw.payToScriptHashScript(script), network)
      .toString();
    if (actual !== expectedAddress) {
      throw new Error(`${label} does not match rebuilt covenant state`);
    }
  }

  function selectFeeTicketArtifactForState(
    artifacts,
    state,
    expectedAddress,
    network,
    label,
  ) {
    for (const info of artifacts || []) {
      const script = buildKcc20FeeTicketScriptForState(
        info.artifact.script,
        state,
      );
      const actual = kaspaWasm
        .addressFromScriptPublicKey(
          kaspaWasm.payToScriptHashScript(script),
          network,
        )
        .toString();
      if (actual === expectedAddress) {
        return { ...info, script };
      }
    }
    throw kcc20PsktBuilderError(
      `${label} was created with an unsupported KCC20FeeTicket artifact`,
      "CONTRACT_ARTIFACT_UNSUPPORTED",
      {
        contract: "KCC20FeeTicket",
        address: expectedAddress,
      },
    );
  }

  function findUtxoEntry(entries, txid, vout) {
    return entries.find(
      (entry) =>
        String(entry.outpoint.transactionId).toLowerCase() === txid &&
        Number(entry.outpoint.index) === vout,
    );
  }

  function getUtxosByAddresses(rpc, addresses) {
    return rpc.getUtxosByAddresses({ addresses });
  }

  async function retryUtxosByAddresses(rpc, addresses, isReady, initial) {
    const attempts = parseRetryInteger(
      env.KCC20_SOURCE_UTXO_RETRY_ATTEMPTS,
      3,
    );
    const delayMs = parseRetryInteger(
      env.KCC20_SOURCE_UTXO_RETRY_DELAY_MS,
      500,
    );
    let latest = initial ?? { entries: [] };
    for (let attempt = 1; attempt < attempts; attempt += 1) {
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      latest = await getUtxosByAddresses(rpc, addresses);
      if (isReady(latest.entries ?? [])) {
        return latest;
      }
    }
    return latest;
  }

  function parseRetryInteger(value, fallback) {
    const parsed = Number(value ?? fallback);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function covenantIdFromUtxoEntry(entry) {
    const value =
      entry?.entry?.covenantId?.toString?.() ??
      entry?.utxoEntry?.covenantId?.toString?.() ??
      entry?.covenantId?.toString?.();
    if (!value || value === "undefined" || value === "null") return null;
    return requireHex32(value, "UTXO covenant id");
  }

  function requireMatchingCovenantId(entry, expectedCovenantId, label) {
    const expected = requireHex32(expectedCovenantId, `${label} expected id`);
    const actual = covenantIdFromUtxoEntry(entry);
    if (!actual) {
      throw new Error(`${label} is missing covenant id`);
    }
    if (actual !== expected) {
      throw new Error(`${label} covenant id does not match requested id`);
    }
    return actual;
  }

  function buildCreateTicketPrefix(kw, kcc20Artifact, args) {
    if (Number(args.quantity ?? 1) > 1) {
      return buildCreateBatchTicketPrefix(kw, kcc20Artifact, args);
    }

    const kcc20Parts = templateParts(kcc20Artifact);
    const builder = covenantScriptBuilder(kw);
    builder.addI64(BigInt(args.utilityInputIndex));
    builder.addI64(BigInt(args.utilityChangeOutputIndex));
    builder.addI64(BigInt(args.ticketOutputIndex));
    builder.addI64(BigInt(args.rootOutputIndex));
    builder.addData(args.ticketOwner);
    addExplicitByte(builder, args.ticketOwnerScheme);
    builder.addData(kcc20Parts.prefix);
    builder.addData(kcc20Parts.suffix);
    addKcc20State(builder, args.utilityChangeState);
    builder.addData(
      dispatchTagFor(args.feeTicketArtifact, "createFromUtilityBurn"),
    );
    return builder.drain();
  }

  function buildCreateBatchTicketPrefix(kw, kcc20Artifact, args) {
    const kcc20Parts = templateParts(kcc20Artifact);
    const builder = covenantScriptBuilder(kw);
    builder.addI64(BigInt(args.utilityInputIndex));
    builder.addI64(BigInt(args.utilityChangeOutputIndex));
    builder.addI64(BigInt(args.ticketOutputIndex));
    builder.addI64(BigInt(args.rootOutputIndex));
    builder.addI64(BigInt(args.quantity));
    builder.addData(args.ticketOwner);
    addExplicitByte(builder, args.ticketOwnerScheme);
    builder.addData(kcc20Parts.prefix);
    builder.addData(kcc20Parts.suffix);
    addKcc20State(builder, args.utilityChangeState);
    builder.addData(
      dispatchTagFor(args.feeTicketArtifact, "createBatchFromUtilityBurn"),
    );
    return builder.drain();
  }

  function addKcc20State(builder, state) {
    builder.addI64(BigInt(state.amount));
    builder.addData(state.ownerIdentifier ?? state.owner);
    addExplicitByte(builder, state.identifierType ?? state.ownerScheme ?? 0);
    addExplicitByte(builder, state.borrowScheme ?? 0);
    builder.addData(state.borrowGuard ?? hexToBytes(ZERO_HASH));
    builder.addData(state.extensionCommitment);
  }

  function templateParts(artifact) {
    const script = Uint8Array.from(artifact.script);
    const start = artifact.state_layout?.start;
    const len = artifact.state_layout?.len;
    if (!Number.isInteger(start) || !Number.isInteger(len)) {
      throw new Error(`${artifact.contract_name} missing state_layout`);
    }
    return {
      prefix: script.slice(0, start),
      suffix: script.slice(start + len),
    };
  }

  function kcc20V3WrappedStateFromUtxo(utxo, canonicalTokenId, owner) {
    const state = utxo?.state || {};
    const fallbackOwner = owner?.kcc20Owner;
    const ownerIdentifier = requireHex32(
      state.stateOwner || state.ownerIdentifier || fallbackOwner,
      "wrapped token owner",
    );
    const mode = Number(state.stateMode ?? state.mode ?? 0);
    const amount = parseU64(
      state.stateAmount ?? state.amount,
      "wrapped token amount",
    );
    if (mode !== 1 && amount <= 0n) {
      throw new Error("wrapped token amount must be greater than zero");
    }
    const unitPriceSompi = parseU64(
      state.marketUnitPriceSompi ?? state.unitPriceSompi ?? "0",
      "wrapped token unit price",
    );
    const feeTicketId = requireHex32(
      state.feeTicketId || ZERO_HASH,
      "wrapped token fee ticket id",
    );
    const priceScale = parsePositiveU64(
      state.tokenDisplayScale || state.priceScale || DEFAULT_KCC20_PRICE_SCALE,
      "wrapped token price scale",
    );
    return {
      canonicalTokenId: hexToBytes(
        requireHex32(
          state.canonicalTokenId || state.tokenId || canonicalTokenId,
          "wrapped canonical token id",
        ),
      ),
      ownerIdentifier: hexToBytes(ownerIdentifier),
      ownerScheme: parseOwnerScheme(
        state.ownerScheme ?? state.identifierType ?? 0,
        "wrapped token owner scheme",
      ),
      amount,
      mode,
      unitPriceSompi,
      feeTicketId: hexToBytes(feeTicketId),
      priceScale,
    };
  }

  function exactGrossSompi(
    rawAmount,
    unitPriceSompi,
    priceScale,
    context = "wrapped order",
  ) {
    const raw = BigInt(rawAmount);
    const price = BigInt(unitPriceSompi);
    const scale = BigInt(priceScale ?? DEFAULT_KCC20_PRICE_SCALE);
    if (raw < 0n || price < 0n || scale <= 0n) {
      throw new Error("invalid wrapped order gross inputs");
    }
    const whole = raw / scale;
    const fraction = raw - whole * scale;
    const fractionProduct = fraction * price;
    if (fractionProduct % scale !== 0n) {
      throw new Error(
        `${context} gross value is not an exact sompi amount for tokenAmount=${raw} unitPriceSompi=${price} priceScale=${scale}`,
      );
    }
    return whole * price + fractionProduct / scale;
  }

  function minimumFillGrossError(message) {
    return kcc20PsktBuilderError(message, "KCC20Orderbook_MIN_FILL_GROSS", {
      minimumFillGrossSompi: MIN_FILL_GROSS_SOMPI,
    });
  }

  function remainingOrderBelowMinimumError(message) {
    return kcc20PsktBuilderError(
      message,
      "KCC20Orderbook_REMAINING_ORDER_BELOW_MIN_GROSS",
      {
        minimumRemainingGrossSompi: MIN_FILL_GROSS_SOMPI,
      },
    );
  }

  function kcc20FeeTicketStateFromUtxo(utxo, owner) {
    const state = utxo?.state || {};
    const fallbackOwner = owner?.kcc20Owner || owner;
    const ownerIdentifier = requireHex32(
      state.stateOwner ||
        state.ownerIdentifier ||
        state.ticketOwner ||
        state.owner ||
        fallbackOwner,
      "FeeTicket owner",
    );
    const utilityTokenId = requireHex32(
      state.utilityTokenId,
      "FeeTicket utility token id",
    );
    const denomination = parsePositiveU64(
      state.denomination ?? state.utilityTokenAmount ?? state.amount,
      "FeeTicket denomination",
    );
    const ownerScheme = parseOwnerScheme(
      state.ownerScheme ?? state.identifierType ?? 0,
      "FeeTicket owner scheme",
    );
    if (ownerScheme !== 0) {
      throw new Error(
        "FeeTicket wallet operations require P2PK Schnorr ownership",
      );
    }
    return {
      ownerIdentifier: hexToBytes(ownerIdentifier),
      ownerScheme,
      mode: Number(state.stateMode ?? state.mode ?? 2),
      utilityTokenId: hexToBytes(utilityTokenId),
      denomination,
    };
  }

  function prepareSharedFeeTicketForSweep({
    params,
    ticketUtxos,
    orderStates,
    owner,
    ticketArtifacts,
    network,
    label,
  }) {
    const requestedFeeTicketId = params.feeTicketId
      ? requireHex32(params.feeTicketId, "fee ticket id")
      : null;
    const normalizedTicketUtxos = Array.isArray(ticketUtxos) ? ticketUtxos : [];
    if (!requestedFeeTicketId) {
      if (normalizedTicketUtxos.length > 0) {
        throw new Error(
          "feeTicketId is required when FeeTicket UTXOs are supplied",
        );
      }
      return null;
    }
    if (!ticketArtifacts) {
      throw new Error("FeeTicket artifacts are required for discounted sweep");
    }
    if (normalizedTicketUtxos.length !== 1) {
      throw new Error(`${label} requires one active FeeTicket UTXO`);
    }

    for (const [index, orderState] of orderStates.entries()) {
      const orderFeeTicketId = bytesToHex(orderState.feeTicketId);
      if (orderFeeTicketId === ZERO_HASH) {
        throw new Error(
          `${label} leg ${index} does not support FeeTicket discount`,
        );
      }
      if (orderFeeTicketId !== requestedFeeTicketId) {
        throw new Error(
          `${label} leg ${index} FeeTicket root does not match request`,
        );
      }
    }

    const ownerHex = requireHex32(owner, "FeeTicket owner");
    const utxo = normalizedTicketUtxos[0];
    const txid = requireHex32(utxo.txidHex, `${label} FeeTicket txid`);
    const vout = parseVout(utxo.vout, `${label} FeeTicket vout`);
    const state = kcc20FeeTicketStateFromUtxo(utxo, ownerHex);
    if (state.mode !== 2) {
      throw new Error(`${label} requires a ticket UTXO`);
    }
    if (bytesToHex(state.ownerIdentifier) !== ownerHex) {
      throw new Error(
        `${label} FeeTicket UTXO is not owned by authenticated wallet`,
      );
    }
    const address = requireKaspaAddress(utxo.address);
    const ticketInfo = selectFeeTicketArtifactForState(
      ticketArtifacts,
      state,
      address,
      network,
      `${label} FeeTicket UTXO address`,
    );
    return {
      utxo,
      state,
      artifact: ticketInfo.artifact,
      script: ticketInfo.script,
      burnDispatchTag: ticketInfo.burnDispatchTag,
      burnTakesRefundOutput: ticketInfo.burnTakesRefundOutput,
      address,
      txid,
      vout,
      outpoint: `${txid}:${vout}`,
    };
  }

  function selectKcc20V3CrossFillAmount({
    askAmount,
    bidAmount,
    askUnitPriceSompi,
    bidUnitPriceSompi,
    priceScale = DEFAULT_KCC20_PRICE_SCALE,
  }) {
    const ask = BigInt(askAmount);
    const bid = BigInt(bidAmount);
    const askPrice = BigInt(askUnitPriceSompi);
    const bidPrice = BigInt(bidUnitPriceSompi);
    const scale = BigInt(priceScale);
    if (ask <= 0n || bid <= 0n) {
      throw new Error("crossed orders require positive ask and bid amounts");
    }
    if (askPrice <= 0n || bidPrice <= 0n) {
      throw new Error("crossed orders require positive unit prices");
    }
    if (scale <= 0n) {
      throw new Error("crossed orders require a positive price scale");
    }
    if (bidPrice < askPrice) {
      throw new Error("bid unit price is below ask clearing price");
    }

    const minFill = ceilDiv(MIN_FILL_GROSS_SOMPI * scale, askPrice);
    const minAskRemainder = ceilDiv(MIN_FILL_GROSS_SOMPI * scale, askPrice);
    const minBidRemainder = ceilDiv(MIN_FILL_GROSS_SOMPI * scale, bidPrice);
    const surplusDelta = bidPrice - askPrice;
    const minSurplusFill =
      surplusDelta > 0n
        ? ceilDiv(MIN_FILL_GROSS_SOMPI * scale, surplusDelta)
        : 1n;
    const maxFill = ask < bid ? ask : bid;
    const candidates = new Set(
      [
        maxFill,
        ask,
        bid,
        ask - minAskRemainder,
        bid - minBidRemainder,
        minFill,
        minSurplusFill,
      ]
        .filter((value) => value > 0n && value <= maxFill)
        .map((value) => value.toString()),
    );

    const valid = [...candidates]
      .map((value) => BigInt(value))
      .filter((fill) =>
        validKcc20V3CrossFill({
          fill,
          ask,
          bid,
          askPrice,
          bidPrice,
          priceScale: scale,
        }),
      )
      .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));

    if (!valid.length) {
      throw kcc20PsktBuilderError(
        "no valid crossed fill amount satisfies dust limits",
        "KCC20Orderbook_CROSSED_DUST_LIMITS",
        { minimumFillGrossSompi: MIN_FILL_GROSS_SOMPI },
      );
    }
    return valid[0];
  }

  function validKcc20V3CrossFill({
    fill,
    ask,
    bid,
    askPrice,
    bidPrice,
    priceScale,
  }) {
    if (fill <= 0n || fill > ask || fill > bid) return false;
    let grossSompi;
    try {
      grossSompi = exactGrossSompi(
        fill,
        askPrice,
        priceScale,
        "crossed settlement",
      );
    } catch (_error) {
      return false;
    }
    if (grossSompi < MIN_FILL_GROSS_SOMPI) return false;
    const remainingAsk = ask - fill;
    if (remainingAsk > 0n) {
      try {
        if (
          exactGrossSompi(
            remainingAsk,
            askPrice,
            priceScale,
            "crossed ask remainder",
          ) < MIN_FILL_GROSS_SOMPI
        ) {
          return false;
        }
      } catch (_error) {
        return false;
      }
    }
    const remainingBid = bid - fill;
    if (remainingBid > 0n) {
      try {
        if (
          exactGrossSompi(
            remainingBid,
            bidPrice,
            priceScale,
            "crossed bid remainder",
          ) < MIN_FILL_GROSS_SOMPI
        ) {
          return false;
        }
      } catch (_error) {
        return false;
      }
    }
    let surplus = 0n;
    if (bidPrice > askPrice) {
      try {
        surplus = exactGrossSompi(
          fill,
          bidPrice - askPrice,
          priceScale,
          "crossed settlement surplus",
        );
      } catch (_error) {
        return false;
      }
    }
    return surplus === 0n || surplus >= MIN_FILL_GROSS_SOMPI;
  }

  function ceilDiv(numerator, denominator) {
    return (numerator + denominator - 1n) / denominator;
  }

  function parseU64(value, label) {
    const raw = String(value ?? "").trim();
    if (!/^\d+$/.test(raw))
      throw new Error(`${label} must be an unsigned integer string`);
    const parsed = BigInt(raw);
    if (parsed > MAX_U64) {
      throw new Error(`${label} must fit in an unsigned 64-bit integer`);
    }
    return parsed;
  }

  function transactionWithCalculatedFeeChange(
    kw,
    transaction,
    changeOutputIndex,
    network,
    label,
    scriptHints = [],
  ) {
    if (changeOutputIndex < 0) {
      return transaction;
    }

    const fee = requiredTransactionFeeSompi(
      kw,
      network,
      transaction,
      scriptHints,
    );
    if (fee <= 0n) {
      return transaction;
    }

    const serialized = transaction.serializeToSafeJSON();
    if (typeof serialized !== "string") {
      throw new Error(`${label} PSKT serialization did not return JSON text`);
    }

    const json = JSON.parse(serialized);
    const output = json.outputs?.[changeOutputIndex];
    if (!output) {
      throw new Error(`${label} change output ${changeOutputIndex} is missing`);
    }

    const amountKey = output.value === undefined ? "amount" : "value";
    const adjustedChange = BigInt(output[amountKey]) - fee;
    if (adjustedChange <= 10_000n) {
      throw kcc20PsktBuilderError(
        `${label} PSKT builder selected insufficient change`,
        "KAS_FUNDING_CHANGE_TOO_SMALL",
      );
    }
    output[amountKey] = adjustedChange.toString();

    if (typeof kw.Transaction.deserializeFromSafeJSON === "function") {
      return kw.Transaction.deserializeFromSafeJSON(JSON.stringify(json));
    }
    return kw.Transaction.deserializeFromJSON(JSON.stringify(json));
  }

  function transactionWithMinimumCalculatedFeeChange(
    kw,
    transaction,
    changeOutputIndex,
    network,
    label,
    scriptHints = [],
  ) {
    if (changeOutputIndex < 0) {
      return transaction;
    }

    const requiredFee = requiredTransactionFeeSompi(
      kw,
      network,
      transaction,
      scriptHints,
    );
    if (requiredFee <= 0n) {
      return transaction;
    }

    const serialized = transaction.serializeToSafeJSON();
    if (typeof serialized !== "string") {
      throw new Error(`${label} PSKT serialization did not return JSON text`);
    }

    const json = JSON.parse(serialized);
    const paidFee = transactionFeeFromSafeJson(json, label);
    if (paidFee >= requiredFee) {
      return transaction;
    }

    const output = json.outputs?.[changeOutputIndex];
    if (!output) {
      throw new Error(`${label} change output ${changeOutputIndex} is missing`);
    }

    const amountKey = output.value === undefined ? "amount" : "value";
    const adjustedChange = BigInt(output[amountKey]) - (requiredFee - paidFee);
    if (adjustedChange <= 10_000n) {
      throw kcc20PsktBuilderError(
        `${label} PSKT builder selected insufficient change`,
        "KAS_FUNDING_CHANGE_TOO_SMALL",
      );
    }
    output[amountKey] = adjustedChange.toString();

    if (typeof kw.Transaction.deserializeFromSafeJSON === "function") {
      return kw.Transaction.deserializeFromSafeJSON(JSON.stringify(json));
    }
    return kw.Transaction.deserializeFromJSON(JSON.stringify(json));
  }

  function assertUniqueTransactionInputOutpoints(transaction, label) {
    const serialized = transaction.serializeToSafeJSON();
    if (typeof serialized !== "string") {
      throw new Error(
        `${label} input uniqueness serialization did not return JSON text`,
      );
    }
    const json = JSON.parse(serialized);
    const seen = new Set();
    for (const [index, input] of (json.inputs || []).entries()) {
      const transactionId = String(
        input?.transactionId ??
          input?.previousOutpoint?.transactionId ??
          input?.previousOutpoint?.transactionIdHex ??
          "",
      )
        .trim()
        .toLowerCase();
      const outputIndex =
        input?.index ??
        input?.previousOutpoint?.index ??
        input?.previousOutpoint?.outputIndex;
      if (!/^[0-9a-f]{64}$/.test(transactionId)) {
        throw new Error(
          `${label} input ${index} has an invalid transaction id`,
        );
      }
      const parsedOutputIndex = parseVout(
        outputIndex,
        `${label} input ${index} output index`,
      );
      const outpoint = `${transactionId}:${parsedOutputIndex}`;
      if (seen.has(outpoint)) {
        throw kcc20PsktBuilderError(
          `${label} contains duplicate transaction input ${outpoint}`,
          "DUPLICATE_TRANSACTION_INPUT",
          { outpoint },
        );
      }
      seen.add(outpoint);
    }
  }

  function transactionWithPredictedSignedFeeChange(
    kw,
    transaction,
    changeOutputIndex,
    network,
    label,
    predictSignedTransaction,
  ) {
    const initialTransaction = transaction;
    let adjustedTransaction = transaction;
    const maximumAttempts = SIGNED_FEE_CONVERGENCE_ATTEMPTS;

    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const predictedTransaction =
        predictSignedTransaction(adjustedTransaction);
      const requiredFeeSompi = requiredTransactionFeeSompi(
        kw,
        network,
        predictedTransaction,
        true,
      );
      const serialized = adjustedTransaction.serializeToSafeJSON();
      if (typeof serialized !== "string") {
        throw new Error(`${label} PSKT serialization did not return JSON text`);
      }
      const json = JSON.parse(serialized);
      const paidFeeSompi = transactionFeeFromSafeJson(json, label);
      if (paidFeeSompi >= requiredFeeSompi) {
        return {
          transaction: adjustedTransaction,
          predictedTransaction,
          requiredFeeSompi,
          paidFeeSompi,
        };
      }
      if (changeOutputIndex < 0) {
        throw kcc20PsktBuilderError(
          `${label} PSKT has no change output available to fund the required transaction fee`,
          "KAS_FUNDING_FEE_INSUFFICIENT",
          { requiredFeeSompi, paidFeeSompi },
        );
      }

      const output = json.outputs?.[changeOutputIndex];
      if (!output) {
        throw new Error(
          `${label} change output ${changeOutputIndex} is missing`,
        );
      }
      const amountKey = output.value === undefined ? "amount" : "value";
      const adjustedChange =
        BigInt(output[amountKey]) - (requiredFeeSompi - paidFeeSompi);
      if (adjustedChange <= MIN_FUNDING_CHANGE_SOMPI) {
        throw kcc20PsktBuilderError(
          `${label} PSKT builder selected insufficient change`,
          "KAS_FUNDING_CHANGE_TOO_SMALL",
        );
      }
      output[amountKey] = adjustedChange.toString();
      adjustedTransaction =
        typeof kw.Transaction.deserializeFromSafeJSON === "function"
          ? kw.Transaction.deserializeFromSafeJSON(JSON.stringify(json))
          : kw.Transaction.deserializeFromJSON(JSON.stringify(json));
    }

    return optimizePredictedSignedFeeChange(
      kw,
      initialTransaction,
      changeOutputIndex,
      network,
      label,
      predictSignedTransaction,
    );
  }

  function optimizePredictedSignedFeeChange(
    kw,
    transaction,
    changeOutputIndex,
    network,
    label,
    predictSignedTransaction,
  ) {
    if (changeOutputIndex < 0) {
      throw kcc20PsktBuilderError(
        `${label} PSKT has no change output available to fund the required transaction fee`,
        "KAS_FUNDING_FEE_INSUFFICIENT",
      );
    }
    const serialized = transaction.serializeToSafeJSON();
    if (typeof serialized !== "string") {
      throw new Error(`${label} PSKT serialization did not return JSON text`);
    }
    const originalJson = JSON.parse(serialized);
    const originalOutput = originalJson.outputs?.[changeOutputIndex];
    if (!originalOutput) {
      throw new Error(`${label} change output ${changeOutputIndex} is missing`);
    }
    const amountKey = originalOutput.value === undefined ? "amount" : "value";
    const maximumChange = BigInt(originalOutput[amountKey]);
    const minimumChange = MIN_FUNDING_CHANGE_SOMPI + 1n;
    if (maximumChange < minimumChange) {
      throw kcc20PsktBuilderError(
        `${label} PSKT builder selected insufficient change`,
        "KAS_FUNDING_CHANGE_TOO_SMALL",
      );
    }

    const cache = new Map();
    const evaluate = (change) => {
      const key = change.toString();
      const cached = cache.get(key);
      if (cached) return cached;
      const json = JSON.parse(JSON.stringify(originalJson));
      json.outputs[changeOutputIndex][amountKey] = key;
      const candidate =
        typeof kw.Transaction.deserializeFromSafeJSON === "function"
          ? kw.Transaction.deserializeFromSafeJSON(JSON.stringify(json))
          : kw.Transaction.deserializeFromJSON(JSON.stringify(json));
      const predictedTransaction = predictSignedTransaction(candidate);
      const requiredFeeSompi = requiredTransactionFeeSompi(
        kw,
        network,
        predictedTransaction,
        true,
      );
      const paidFeeSompi = transactionFeeFromSafeJson(json, label);
      const result = {
        change,
        transaction: candidate,
        predictedTransaction,
        requiredFeeSompi,
        paidFeeSompi,
        deficit: requiredFeeSompi - paidFeeSompi,
      };
      cache.set(key, result);
      return result;
    };

    // With a fixed signed shape, storage mass contributes K/change while paid
    // fee contributes -change, so the fee deficit is discrete-unimodal.
    let lower = minimumChange;
    let upper = maximumChange;
    while (upper - lower > 8n) {
      const third = (upper - lower) / 3n;
      const left = lower + third;
      const right = upper - third;
      if (evaluate(left).deficit <= evaluate(right).deficit) {
        upper = right - 1n;
      } else {
        lower = left + 1n;
      }
    }

    let best = evaluate(lower);
    for (let change = lower + 1n; change <= upper; change += 1n) {
      const candidate = evaluate(change);
      if (candidate.deficit < best.deficit) best = candidate;
    }
    if (best.deficit > 0n) {
      if (best.requiredFeeSompi > TOCCATA_MAX_STANDARD_RELAY_FEE_SOMPI) {
        throw kcc20PsktBuilderError(
          `${label} predicted signed transaction exceeds standard transaction mass`,
          "TRANSACTION_MASS_EXCEEDED",
          {
            requiredFeeSompi: best.requiredFeeSompi,
            maximumStandardRelayFeeSompi: TOCCATA_MAX_STANDARD_RELAY_FEE_SOMPI,
          },
        );
      }
      throw kcc20PsktBuilderError(
        `${label} PSKT builder selected insufficient change`,
        "KAS_FUNDING_CHANGE_TOO_SMALL",
        {
          bestChangeSompi: best.change,
          requiredFeeSompi: best.requiredFeeSompi,
          paidFeeSompi: best.paidFeeSompi,
        },
      );
    }

    // The valid interval ends at the largest change that still pays its exact
    // predicted signed-shape fee; maximize change to avoid overpaying relay fee.
    lower = best.change;
    upper = maximumChange;
    while (upper - lower > 1n) {
      const middle = (lower + upper) / 2n;
      if (evaluate(middle).deficit <= 0n) {
        lower = middle;
      } else {
        upper = middle;
      }
    }
    const selected = evaluate(lower);
    return {
      transaction: selected.transaction,
      predictedTransaction: selected.predictedTransaction,
      requiredFeeSompi: selected.requiredFeeSompi,
      paidFeeSompi: selected.paidFeeSompi,
    };
  }

  function transactionFeeFromSafeJson(json, label) {
    const inputSompi = (json.inputs || []).reduce(
      (sum, input) => sum + safeJsonAmount(input?.utxo, label),
      0n,
    );
    const outputSompi = (json.outputs || []).reduce(
      (sum, output) => sum + safeJsonAmount(output, label),
      0n,
    );
    return inputSompi - outputSompi;
  }

  function requiredTransactionFeeSompi(
    kw,
    network,
    transaction,
    massOptions = [],
  ) {
    const requireConsensusV1Mass = massOptions === true;
    if (requireConsensusV1Mass) {
      const { transactionMass: nonContextualMass } =
        calculateToccataV1NonContextualMass(
          transaction,
          "transaction fee consensus mass",
        );
      const storageMass = calculateToccataStorageMass(
        transaction,
        "transaction fee",
      );
      const consensusMass =
        nonContextualMass > storageMass ? nonContextualMass : storageMass;
      return consensusMass * MIN_RELAY_FEE_PER_MASS_SOMPI;
    }

    const canCalculateMass = typeof kw.calculateTransactionMass === "function";
    if (typeof kw.calculateTransactionFee !== "function" && !canCalculateMass) {
      throw kcc20PsktBuilderError(
        "transaction fee calculator is unavailable",
        "TRANSACTION_FEE_CALCULATOR_UNAVAILABLE",
      );
    }
    const scriptHints = Array.isArray(massOptions) ? massOptions : [];
    let calculatedFee = 0n;
    if (typeof kw.calculateTransactionFee === "function") {
      try {
        calculatedFee = sompiToBigInt(
          kw.calculateTransactionFee(network, transaction, 1, true),
          "calculated transaction fee",
        );
      } catch (error) {
        if (!canCalculateMass) {
          throw error;
        }
      }
    }
    if (!canCalculateMass) {
      return calculatedFee;
    }

    const serialized = transaction.serializeToSafeJSON();
    if (typeof serialized !== "string") {
      throw new Error(
        "transaction fee PSKT serialization did not return JSON text",
      );
    }
    const json = transactionJsonWithScriptHints(
      kw,
      JSON.parse(serialized),
      scriptHints,
    );
    // The bundled SDK omits v1 compute budgets and wallet-added scripts here.
    const outputCount = BigInt(json.outputs?.length || 1);
    const storageNeutralOutputValue = MAX_U64 / outputCount;
    const storageNeutralJson = {
      ...json,
      outputs: (json.outputs || []).map((output) => ({
        ...output,
        [output.value === undefined ? "amount" : "value"]:
          storageNeutralOutputValue.toString(),
      })),
    };
    const storageNeutralTransaction =
      typeof kw.Transaction.deserializeFromSafeJSON === "function"
        ? kw.Transaction.deserializeFromSafeJSON(
            JSON.stringify(storageNeutralJson),
          )
        : kw.Transaction.deserializeFromJSON(
            JSON.stringify(storageNeutralJson),
          );
    const baseComputeMass = sompiToBigInt(
      kw.calculateTransactionMass(network, storageNeutralTransaction, 1),
      "storage-neutral transaction mass",
    );
    const declaredComputeBudget = transactionInputComputeBudget(transaction);
    const computeMass =
      baseComputeMass +
      declaredComputeBudget * TOCCATA_COMPUTE_BUDGET_MASS_PER_UNIT;
    const transientMass = normalizedTransientMassUpperBound(json);
    const relayMass = computeMass > transientMass ? computeMass : transientMass;
    const massFloor = relayMass * MIN_RELAY_FEE_PER_MASS_SOMPI;
    return massFloor > calculatedFee ? massFloor : calculatedFee;
  }

  function transactionJsonWithScriptHints(kw, json, scriptHints) {
    if (!Array.isArray(scriptHints) || scriptHints.length === 0) {
      return json;
    }

    const massJson = {
      ...json,
      inputs: (json.inputs || []).map((input) => ({ ...input })),
    };
    for (const hint of scriptHints) {
      const templateMode = hint?.signatureScript?.mode;
      if (
        templateMode !== "signature-first-args" &&
        templateMode !== "ordered-args"
      ) {
        throw new Error("unsupported transaction fee script hint mode");
      }
      const inputIndex = Number(hint.inputIndex);
      const input = massJson.inputs[inputIndex];
      if (!Number.isInteger(inputIndex) || inputIndex < 0 || !input) {
        throw new Error(
          `transaction fee script hint input ${hint.inputIndex} is missing`,
        );
      }

      const builder = covenantScriptBuilder(kw);
      const dummySignature = new Uint8Array(65);
      dummySignature[64] = 1;
      if (templateMode === "signature-first-args") {
        builder.addData(dummySignature);
      }
      for (const arg of hint.signatureScript.args || []) {
        if (arg.type === "i64") {
          builder.addI64(BigInt(arg.value));
        } else if (arg.type === "byte") {
          addExplicitByte(builder, arg.value);
        } else if (arg.type === "data") {
          builder.addData(hexToBytes(arg.hex));
        } else if (
          arg.type === "signature" &&
          templateMode === "ordered-args"
        ) {
          const prefix = hexToBytes(arg.prefixHex || "");
          const value = new Uint8Array(prefix.length + dummySignature.length);
          value.set(prefix);
          value.set(dummySignature, prefix.length);
          builder.addData(value);
        } else {
          throw new Error(
            `unsupported transaction fee script hint argument ${arg.type}`,
          );
        }
      }
      const encoded = kw.ScriptBuilder.fromScript(hexToBytes(hint.scriptHex), {
        flags: { covenantsEnabled: true },
      }).encodePayToScriptHashSignatureScript(builder.drain());
      const encodedHex =
        typeof encoded === "string" ? encoded : bytesToHex(encoded);
      if (hexByteLength(encodedHex) > hexByteLength(input.signatureScript)) {
        input.signatureScript = encodedHex;
      }
    }
    return massJson;
  }

  function normalizedTransientMassUpperBound(json) {
    const version = Number(json.version || 0);
    let bytes = 94n;
    for (const input of json.inputs || []) {
      bytes += 52n + hexByteLength(input?.signatureScript);
      if (version >= 1) {
        bytes += 2n;
      }
      bytes += TOCCATA_SIGNATURE_RESERVE_BYTES;
    }
    for (const output of json.outputs || []) {
      const scriptBytes = hexByteLength(output?.scriptPublicKey);
      bytes += 16n + (scriptBytes >= 2n ? scriptBytes : 2n);
      if (output?.covenant) {
        bytes += 34n;
      }
    }
    bytes += hexByteLength(json.payload);
    return bytes * TOCCATA_NORMALIZED_TRANSIENT_MASS_PER_BYTE;
  }

  function hexByteLength(value) {
    const raw = String(value || "").replace(/^0x/i, "");
    if (!raw) {
      return 0n;
    }
    if (!/^[0-9a-f]+$/i.test(raw) || raw.length % 2 !== 0) {
      throw new Error("transaction fee mass field must be even-length hex");
    }
    return BigInt(raw.length / 2);
  }

  function transactionInputComputeBudget(transaction) {
    const inputs = transaction.inputs;
    if (!inputs || typeof inputs[Symbol.iterator] !== "function") {
      return 0n;
    }
    let total = 0n;
    for (const input of inputs) {
      const raw = input?.computeBudget;
      if (raw === undefined || raw === null) {
        continue;
      }
      const budget = sompiToBigInt(raw, "transaction input compute budget");
      total += budget;
    }
    return total;
  }

  function sompiToBigInt(value, label) {
    if (typeof value === "bigint") {
      return value;
    }
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      return BigInt(value);
    }
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return BigInt(Math.ceil(value));
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
      return BigInt(value);
    }
    if (
      value &&
      typeof value === "object" &&
      typeof value.toString === "function"
    ) {
      const rendered = value.toString();
      if (/^\d+$/.test(rendered)) {
        return BigInt(rendered);
      }
    }
    throw new Error(`${label} must be a safe integer sompi value`);
  }

  function safeJsonAmount(entity, label) {
    const raw = entity?.value ?? entity?.amount;
    if (raw === undefined || raw === null) {
      throw new Error(`${label} transaction JSON is missing an amount`);
    }
    return BigInt(raw);
  }

  function assertPaidMintPaymentStorageMassStandard(kw, network, details) {
    if (typeof kw.calculateStorageMass !== "function") {
      return;
    }
    const inputValues = [safeSompiAsNumber(details.grossPaymentSompi)];
    const outputValues = [];
    if (details.treasuryPaymentSompi > 0n) {
      outputValues.push(safeSompiAsNumber(details.treasuryPaymentSompi));
    }
    if (details.protocolFeeSompi > 0n) {
      outputValues.push(safeSompiAsNumber(details.protocolFeeSompi));
    }

    const storageMass = kw.calculateStorageMass(
      network,
      inputValues,
      outputValues,
    );
    if (storageMass === undefined || storageMass === null) {
      return;
    }
    const maximumStandardTransactionMass =
      TOCCATA_MAX_STANDARD_TRANSACTION_MASS;
    if (BigInt(storageMass) <= maximumStandardTransactionMass) {
      return;
    }

    throw kcc20PsktBuilderError(
      `paid mint output storage mass ${storageMass} exceeds standard transaction mass ${maximumStandardTransactionMass}`,
      "PAID_MINT_OUTPUT_STORAGE_MASS_EXCEEDS_STANDARD",
      {
        ...details,
        storageMass: BigInt(storageMass),
        maximumStandardTransactionMass,
      },
    );
  }

  function assertTransactionStorageMassStandard(
    transaction,
    label,
    details = {},
  ) {
    const storageMass = calculateToccataStorageMass(transaction, label);
    const maximumStandardTransactionMass =
      TOCCATA_MAX_STANDARD_TRANSACTION_MASS;
    if (storageMass <= maximumStandardTransactionMass) {
      return storageMass;
    }
    throw kcc20PsktBuilderError(
      `${label} storage mass ${storageMass} exceeds standard transaction mass ${maximumStandardTransactionMass}`,
      "TRANSACTION_STORAGE_MASS_EXCEEDS_STANDARD",
      {
        ...details,
        storageMass,
        maximumStandardTransactionMass,
      },
    );
  }

  function calculateToccataStorageMass(transaction, label) {
    const serialized = transaction.serializeToSafeJSON();
    if (typeof serialized !== "string") {
      throw new Error(
        `${label} storage-mass serialization did not return JSON text`,
      );
    }
    const json = JSON.parse(serialized);
    if (
      !Array.isArray(json.inputs) ||
      json.inputs.length === 0 ||
      !Array.isArray(json.outputs)
    ) {
      throw new Error(`${label} storage-mass transaction shape is invalid`);
    }

    const inputs = json.inputs.map((input, index) =>
      safeJsonUtxoCell(
        input?.utxo,
        Boolean(input?.utxo?.covenantId),
        `${label} input ${index}`,
      ),
    );
    const outputs = json.outputs.map((output, index) =>
      safeJsonUtxoCell(
        output,
        Boolean(output?.covenant),
        `${label} output ${index}`,
      ),
    );

    let outputPlurality = 0n;
    let harmonicOutputs = 0n;
    for (const output of outputs) {
      outputPlurality += output.plurality;
      harmonicOutputs +=
        (TOCCATA_STORAGE_MASS_PARAMETER * output.plurality * output.plurality) /
        output.amount;
    }

    const inputPlurality = inputs.reduce(
      (sum, input) => sum + input.plurality,
      0n,
    );
    const relaxedFormula =
      outputPlurality === 1n ||
      (inputs.length <= 2 &&
        (inputPlurality === 1n ||
          (outputPlurality === 2n && inputPlurality === 2n)));
    if (relaxedFormula) {
      const harmonicInputs = inputs.reduce(
        (sum, input) =>
          sum +
          (TOCCATA_STORAGE_MASS_PARAMETER * input.plurality * input.plurality) /
            input.amount,
        0n,
      );
      return harmonicOutputs > harmonicInputs
        ? harmonicOutputs - harmonicInputs
        : 0n;
    }

    const totalInputAmount = inputs.reduce(
      (sum, input) => sum + input.amount,
      0n,
    );
    const meanInputAmount = totalInputAmount / inputPlurality;
    if (meanInputAmount === 0n) {
      throw new Error(`${label} storage mass is incomputable`);
    }
    const arithmeticInputs =
      inputPlurality * (TOCCATA_STORAGE_MASS_PARAMETER / meanInputAmount);
    return harmonicOutputs > arithmeticInputs
      ? harmonicOutputs - arithmeticInputs
      : 0n;
  }

  function safeJsonUtxoCell(entity, hasCovenantId, label) {
    const amount = safeJsonAmount(entity, label);
    if (amount <= 0n) {
      throw new Error(`${label} amount must be greater than zero`);
    }
    const serializedScriptPublicKeyBytes = safeJsonHexByteLength(
      entity?.scriptPublicKey,
      `${label} script public key`,
    );
    if (serializedScriptPublicKeyBytes < 2n) {
      throw new Error(`${label} script public key is missing its u16 version`);
    }
    const scriptPublicKeyBytes = serializedScriptPublicKeyBytes - 2n;
    const storageBytes =
      TOCCATA_UTXO_FIXED_STORAGE_BYTES +
      scriptPublicKeyBytes +
      (hasCovenantId ? 32n : 0n);
    return {
      amount,
      plurality:
        (storageBytes + TOCCATA_UTXO_STORAGE_UNIT_BYTES - 1n) /
        TOCCATA_UTXO_STORAGE_UNIT_BYTES,
    };
  }

  function safeSompiAsNumber(amount) {
    const numericAmount = Number(amount);
    if (!Number.isSafeInteger(numericAmount) || numericAmount < 0) {
      throw new Error("paid mint storage-mass amount is out of range");
    }
    return numericAmount;
  }

  function formatSompiAsKas(value) {
    const sompi = BigInt(value);
    const whole = sompi / 100_000_000n;
    const fractional = sompi % 100_000_000n;
    if (fractional === 0n) return whole.toString();
    return `${whole}.${fractional.toString().padStart(8, "0").replace(/0+$/, "")}`;
  }

  function parsePositiveU64(value, label) {
    const parsed = parseU64(value, label);
    if (parsed <= 0n) throw new Error(`${label} must be greater than zero`);
    return parsed;
  }

  function parseMintLaneCount(value, label = "mint extension lane count") {
    const parsed = parsePositiveU64(value, label);
    if (parsed > 10n) throw new Error(`${label} must be between 1 and 10`);
    return parsed;
  }

  function parseQuotedProtocolFeeSompi(params) {
    return params.quotedProtocolFeeSompi !== undefined &&
      params.quotedProtocolFeeSompi !== null
      ? parsePositiveU64(
          params.quotedProtocolFeeSompi,
          "quotedProtocolFeeSompi",
        )
      : parsePositiveU64(params.protocolFeeSompi, "protocolFeeSompi");
  }

  function parseVout(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0)
      throw new Error(`${label} must be a non-negative integer`);
    return parsed;
  }

  function requireOrderId(value, label) {
    const raw = String(value || "")
      .trim()
      .toLowerCase();
    if (!/^[a-f0-9]{64}:\d+$/.test(raw)) {
      throw new Error(`${label} must be txid:vout`);
    }
    const [txid, vout] = raw.split(":");
    return `${requireHex32(txid, label)}:${parseVout(vout, label)}`;
  }

  function parsePositiveNumber(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0)
      throw new Error(`${label} must be a positive integer`);
    return parsed;
  }

  function parseFeeBps(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000)
      throw new Error("protocolFeeBps must be 0..10000");
    return parsed;
  }

  function parseOwnerScheme(value, label) {
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "pubkey" || normalized === "p2pk-schnorr/v1") {
        return 0;
      }
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4) {
      throw new Error(`${label} must be an owner scheme from 0 to 4`);
    }
    return parsed;
  }

  function parseBorrowScheme(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3) {
      throw new Error(`${label} must be a borrow scheme from 0 to 3`);
    }
    return parsed;
  }

  function kcc20MintExtensionFromSources(
    activeMinterUtxo,
    params,
    mintPolicy,
    mintPolicyValue,
    remainingSupply,
    displayScale,
  ) {
    const state = activeMinterUtxo?.state || {};
    const source =
      state.extension || params.mintExtension || mintPolicy.extension || {};
    const creator = requireHex32(
      source.creator || state.owner || state.ownerIdentifier,
      "mint extension creator",
    );
    const treasury = requireHex32(
      source.treasury || state.treasury || mintPolicy.treasuryRecipient,
      "mint extension treasury",
    );
    const protocolFeeRecipient = requireHex32(
      source.protocolFeeRecipient ||
        state.protocolFeeRecipient ||
        mintPolicy.protocolFeeRecipient ||
        KCC20_PLATFORM_PROTOCOL_FEE_RECIPIENT,
      "mint extension protocol fee recipient",
    );
    const publicMintActive = Boolean(
      source.publicMintActive ??
      state.publicMintActive ??
      mintPolicy.publicMintActive ??
      false,
    );
    const extension = {
      kind: Number(source.kind ?? 1),
      creator: hexToBytes(creator),
      ticker: kcc20Bytes32Value(
        source.ticker ?? state.ticker ?? params.ticker ?? "",
        "ticker",
      ),
      name: kcc20Bytes32Value(
        source.name ?? state.name ?? state.tokenName ?? params.tokenName ?? "",
        "token name",
      ),
      displayScale: parsePositiveU64(
        source.displayScale ??
          state.displayScale ??
          state.tokenDisplayScale ??
          displayScale,
        "mint extension display scale",
      ),
      maxSupply: parsePositiveU64(
        source.maxSupply ?? state.maxSupply ?? mintPolicy.maxSupply,
        "mint extension max supply",
      ),
      mintLaneCount: parseMintLaneCount(
        source.mintLaneCount ??
          state.mintLaneCount ??
          mintPolicy.mintLaneCount ??
          1,
        "mint extension lane count",
      ),
      mintPolicy: mintPolicyValue,
      mintPriceSompi: parseU64(
        source.mintPriceSompi ??
          state.mintPriceSompi ??
          state.mintPricePerTokenSompi ??
          mintPolicy.mintPricePerTokenSompi ??
          0,
        "mint extension price",
      ),
      treasury: hexToBytes(treasury),
      protocolFeeRecipient: hexToBytes(protocolFeeRecipient),
      protocolFeeBps: BigInt(
        parseFeeBps(
          source.protocolFeeBps ??
            state.protocolFeeBps ??
            mintPolicy.protocolFeeBps ??
            200,
        ),
      ),
      remainingSupply,
      publicMintActive,
    };
    const derivedHolderCommitment = holderExtensionCommitment(extension);
    const suppliedHolderCommitment =
      source.holderExtensionCommitment || state.holderExtensionCommitment;
    if (
      suppliedHolderCommitment &&
      requireHex32(suppliedHolderCommitment, "holder extension commitment") !==
        bytesToHex(derivedHolderCommitment)
    ) {
      throw new Error(
        "holder extension commitment does not match KCC20 metadata",
      );
    }
    return {
      ...extension,
      holderExtensionCommitment: derivedHolderCommitment,
    };
  }

  function kcc20Bytes32Value(value, label) {
    const raw = String(value ?? "").trim();
    return /^[0-9a-f]{64}$/i.test(raw)
      ? hexToBytes(raw)
      : asciiToBytes32(raw, label);
  }

  function kcc20MintOrderedArgs(artifact, args, includeSignature) {
    const extension = args.extension;
    const values = kcc20MintExtensionOrderedArgs(extension);
    if (includeSignature) values.push({ type: "signature" });
    values.push(
      dataTemplateArg(args.toOwner),
      byteTemplateArg(args.toOwnerScheme),
      byteTemplateArg(args.toBorrowScheme),
      dataTemplateArg(args.toBorrowGuard),
      i64TemplateArg(args.tokenAmount),
      i64TemplateArg(args.tokenOutputIndex),
      i64TemplateArg(args.minterOutputIndex),
      i64TemplateArg(args.treasuryOutputIndex),
      i64TemplateArg(args.feeOutputIndex),
      dataTemplateArg(
        dispatchTagFor(
          artifact,
          includeSignature ? "mint_by_owner" : "mint_public",
        ),
      ),
    );
    return values;
  }

  function kcc20MintExtensionOrderedArgs(extension) {
    return [
      byteTemplateArg(extension.kind ?? 1),
      dataTemplateArg(extension.creator),
      dataTemplateArg(extension.ticker),
      dataTemplateArg(extension.name),
      i64TemplateArg(extension.displayScale),
      i64TemplateArg(extension.maxSupply),
      i64TemplateArg(extension.mintLaneCount ?? 1),
      byteTemplateArg(extension.mintPolicy),
      i64TemplateArg(extension.mintPriceSompi),
      dataTemplateArg(extension.treasury),
      dataTemplateArg(extension.protocolFeeRecipient),
      i64TemplateArg(extension.protocolFeeBps),
      i64TemplateArg(extension.remainingSupply),
      i64TemplateArg(extension.publicMintActive ? 1 : 0),
      dataTemplateArg(extension.holderExtensionCommitment),
    ];
  }

  function kcc20SetPublicMintActiveOrderedArgs(
    artifact,
    extension,
    active,
    minterOutputIndex,
  ) {
    const values = kcc20MintExtensionOrderedArgs(extension);
    values.push(
      { type: "signature" },
      i64TemplateArg(active ? 1 : 0),
      i64TemplateArg(minterOutputIndex),
      dataTemplateArg(dispatchTagFor(artifact, "set_public_mint_active")),
    );
    return values;
  }

  function kcc20TransferOrderedArgs(artifact, nextStates) {
    const fields =
      encodeKcc20StateRecordArrays(nextStates).map(dataTemplateArg);
    return [
      ...fields,
      { type: "signature", prefixHex: "00" },
      dataTemplateArg(dispatchTagFor(artifact, "transfer")),
    ];
  }

  function kcc20TransferDelegatorOrderedArgs(artifact) {
    return [
      { type: "signature" },
      dataTemplateArg(dispatchTagFor(artifact, "transfer_delegator")),
    ];
  }

  function kcc20BurnOrderedArgs(artifact, nextStates, burnAmount) {
    return [
      ...encodeKcc20StateRecordArrays(nextStates).map(dataTemplateArg),
      i64TemplateArg(burnAmount),
      { type: "signature" },
      dataTemplateArg(dispatchTagFor(artifact, "burn")),
    ];
  }

  function dataTemplateArg(value) {
    return { type: "data", hex: bytesToHex(Uint8Array.from(value || [])) };
  }

  function byteTemplateArg(value) {
    const byte = Number(value);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new Error(`invalid byte ${value}`);
    }
    return { type: "byte", value: byte };
  }

  function i64TemplateArg(value) {
    return { type: "i64", value: BigInt(value).toString() };
  }

  function jsonKcc20MintExtension(extension) {
    return {
      kind: Number(extension.kind ?? 1),
      creator: bytesToHex(extension.creator),
      ticker: bytesToHex(extension.ticker),
      name: bytesToHex(extension.name),
      displayScale: BigInt(extension.displayScale).toString(),
      maxSupply: BigInt(extension.maxSupply).toString(),
      mintLaneCount: BigInt(extension.mintLaneCount ?? 1).toString(),
      mintPolicy: Number(extension.mintPolicy),
      mintPriceSompi: BigInt(extension.mintPriceSompi).toString(),
      treasury: bytesToHex(extension.treasury),
      protocolFeeRecipient: bytesToHex(extension.protocolFeeRecipient),
      protocolFeeBps: BigInt(extension.protocolFeeBps).toString(),
      remainingSupply: BigInt(extension.remainingSupply).toString(),
      publicMintActive: Boolean(extension.publicMintActive),
      holderExtensionCommitment: bytesToHex(
        extension.holderExtensionCommitment,
      ),
    };
  }

  function parseAmountTkas(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
      throw new Error("KCC20_DEPLOY_OUTPUT_TKAS must be positive");
    return parsed;
  }

  function normalizeTicker(raw) {
    const value = String(raw || "")
      .trim()
      .toUpperCase();
    if (!value) return "";
    if (!/^[A-Z0-9]{1,12}$/.test(value))
      throw new Error("ticker must be 1-12 uppercase alphanumeric characters");
    return value;
  }

  function normalizeTokenName(raw) {
    const value = String(raw || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!value) return "";
    if (value.length > 32)
      throw new Error("tokenName must be 32 characters or fewer");
    if (!/^[\x20-\x7E]+$/.test(value))
      throw new Error("tokenName must be printable ASCII");
    return value;
  }

  function requireKaspaAddress(value) {
    const address = String(value || "").trim();
    if (!/^kaspa(?:test|dev)?:/i.test(address))
      throw new Error("owner.walletAddress must be a Kaspa address");
    return address;
  }

  return {
    build: buildInProcessPskt,
    buildInProcessPskt,
    resolveFeeTicketBatchCreateCapability,
    protocol: Object.freeze({
      KCC20_ORDERBOOK_SWEEP_ASK_COMPUTE_BUDGET_PROFILE,
      KCC20_ORDERBOOK_SWEEP_BID_COMPUTE_BUDGET_PROFILE,
      artifactEntrypointDispatchTag,
      readWrappedArtifacts,
      readWrapperArtifacts,
      selectWrappedArtifactForUtxo,
      selectWrapperArtifactForUtxo,
      encodeCovenantP2shSignatureScript,
      feeTicketOutputSompiForQuantity,
      configuredFeeTicketOutputSompiForQuantity,
      assertKcc20TokenOutputSompi,
      singleHolderSweepTokenOutputSompi,
      sellerSettlementOutputIndex,
      refundableBidDepositSompi,
      sellerFundedHolderTopUpSompi,
      calculateTemporaryKasLockedSompi,
      assertPartialBuyerHolderOutputSompi,
      assertPartialSweepLegIsFinal,
      assertSweepBidPricePriority,
      singleHolderSweepScriptLegCapacity,
      singleHolderSweepCoversTotal,
      sweepBidComputeBudgetLayout,
      sweepAskComputeBudgetLayout,
      sweepBidReservedComputeMass,
      sweepAskReservedComputeMass,
      assertSweepBidReservedComputeMassStandard,
      assertSweepAskReservedComputeMassStandard,
      assertSweepBidComputeBudgetArtifactCompatibility,
      assertSweepAskComputeBudgetArtifactCompatibility,
      assertUniqueSweepBidOutpoints,
      assertSweepAskLegIdentity,
      applySweepBidComputeBudgetProfile,
      applySweepAskComputeBudgetProfile,
      assertTransactionComputeMassStandard,
      calculateToccataV1NonContextualMass,
      wrapperDeployPriorityFee,
      resolveWrapperMarketDeployTokenIds,
      assertWrapperArtifactPriceScale,
      resolveExpectedHolderSpendCovenantId,
      buildKcc20DeployPayload,
      feeTicketBurnScriptHint,
      buildFeeTicketBurnPrefix,
      feeTicketTransferScriptHint,
      kcc20StateFromUtxo,
      assertKcc20HolderStateForWrap,
      selectFeeTicketArtifactForState,
      requireMatchingCovenantId,
      selectKcc20V3CrossFillAmount,
      transactionWithCalculatedFeeChange,
      transactionWithMinimumCalculatedFeeChange,
      assertUniqueTransactionInputOutpoints,
      transactionWithPredictedSignedFeeChange,
      assertPaidMintPaymentStorageMassStandard,
      assertTransactionStorageMassStandard,
      calculateToccataStorageMass,
      parseQuotedProtocolFeeSompi,
      splitKcc20MintSupply,
    }),
  };
}
