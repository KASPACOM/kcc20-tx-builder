/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-unused-vars */
// @ts-nocheck
import { blake2b } from "@noble/hashes/blake2b";
import { sha256 } from "@noble/hashes/sha256";
import type { KaspaWasmRuntime } from "./runtime.js";
import {
  bytesToHex,
  hexToBytes,
  requireHex32,
  selectFundingEntry,
  setVersionOneInputMassFields,
  utxoAmountSompi,
  ZERO_HASH,
} from "./sale-common.js";
import {
  buildKcc20ScriptForState,
  buildKcc20TransferSigScript,
  dispatchTagFor,
  encodeKcc20StateRecordArrays,
  normalizeSilverScriptArtifact,
  templateParts,
} from "./abi.js";
import {
  buildBootstrapGenesisPlan as buildSignerlessBootstrapPlan,
  buildControllerGenesisPlan as createSignerlessControllerPlan,
  buildClaimPlan as buildSignerlessClaimPlan,
  buildSnapshotStartPlan,
  snapshotControllerStateCommitment as signerlessControllerStateCommitment,
  snapshotPeerPlanCommitment,
} from "./snapshot-signerless.js";
import {
  buildBootstrapGenesisUnsignedTransaction,
  buildControllerGenesisUnsignedTransaction,
  buildSnapshotBootstrapScriptForState as buildSignerlessBootstrapScript,
  buildSnapshotControllerScriptForState as buildSignerlessControllerScript,
  buildSnapshotKcc20DeploymentPayload,
  buildSnapshotStartUnsignedTransaction,
  deriveSnapshotTokenId,
} from "./snapshot-signerless-transactions.js";

export const KCC20_SNAPSHOT_BUILDER_KEYS = [
  "kcc20-snapshot.deploy-bootstrap",
  "kcc20-snapshot.deploy-controller",
  "kcc20-snapshot.start",
  "kcc20-snapshot.claim",
] as const;

/**
 * KAS the public funding input must add to an immutable snapshot start.
 * The consumed bootstrap cell is recycled while every reserve output must be
 * funded. Accept the start plan itself so callers cannot accidentally read
 * reserve fields from the narrower bootstrap-genesis plan.
 */
export function calculateSnapshotStartRequiredFunding(
  startPlan: {
    reserveCellKas: string | number | bigint;
    bootstrapCellKas: string | number | bigint;
  },
  shardCount: number,
  priorityFeeSompi: string | number | bigint,
  safetyMarginSompi: string | number | bigint = 10_000n,
): bigint {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error("start shard count must be a positive safe integer");
  }
  const reserveCellKas = snapshotFundingI64(
    startPlan?.reserveCellKas,
    "start reserve cell KAS",
    false,
  );
  const bootstrapCellKas = snapshotFundingI64(
    startPlan?.bootstrapCellKas,
    "start bootstrap cell KAS",
    false,
  );
  const priorityFee = snapshotFundingI64(
    priorityFeeSompi,
    "snapshot priority fee",
    true,
  );
  const safetyMargin = snapshotFundingI64(
    safetyMarginSompi,
    "snapshot start safety margin",
    true,
  );
  return (
    reserveCellKas * BigInt(shardCount) -
    bootstrapCellKas +
    priorityFee +
    safetyMargin
  );
}

function snapshotFundingI64(
  value: unknown,
  label: string,
  allowZero: boolean,
): bigint {
  let amount: bigint;
  try {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error("unsafe integer");
    }
    amount = BigInt(value as string | number | bigint);
  } catch {
    throw new Error(
      `${label} must be a ${allowZero ? "nonnegative" : "positive"} signed 64-bit integer`,
    );
  }
  if (
    amount > 9_223_372_036_854_775_807n ||
    (allowZero ? amount < 0n : amount <= 0n)
  ) {
    throw new Error(
      `${label} must be a ${allowZero ? "nonnegative" : "positive"} signed 64-bit integer`,
    );
  }
  return amount;
}

export interface Kcc20SnapshotBuilderOptions {
  wasm: KaspaWasmRuntime;
  artifacts?: Record<string, unknown>;
  artifactProvider?: (key: string) => Promise<unknown>;
  config?: Record<string, any>;
  sourceProvider?: {
    getUtxosByAddresses(args: { addresses: string[] }): Promise<unknown>;
  };
  rpcClientFactory?: (config: unknown) => any;
  transactionWithCalculatedFeeChange: (...args: any[]) => any;
}

export const SNAPSHOT_CANCEL_SINK_P2SH =
  "d379e50f3e2203f9a92584916335bb7cd014b237ceaa8b36f1d3d80d0cc88b32";

export function createKcc20SnapshotPsktBuilder(
  options: Kcc20SnapshotBuilderOptions,
): (input: unknown) => Promise<Record<string, unknown>> {
  const config = options.config ?? {};
  const transactionWithCalculatedFeeChange =
    options.transactionWithCalculatedFeeChange;
  class InjectedRpcClient {
    private readonly inner: any;
    constructor(rpcConfig: unknown) {
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
        "No source provider or RPC client was supplied to the snapshot builder",
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
  const NATIVE_SUBNETWORK_ID = "00".repeat(20);
  const DEFAULT_WRPC_URL =
    "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh";
  const DEFAULT_PRIORITY_FEE = 10_000n;
  const DEFAULT_CELL_SOMPI = 50_000_000n;
  const MAX_I64 = 9_223_372_036_854_775_807n;
  const MAX_U32 = 0xffffffff;
  const BOOTSTRAP_COMPUTE_BUDGET = 2_000;
  const CONTROLLER_COMPUTE_BUDGET = 2_000;
  const KCC20_COMPUTE_BUDGET = 200;
  const PUBLIC_INPUT_COMPUTE_BUDGET = 30;
  const KCC20_ARTIFACT_PATH = "KCC20.placeholder.json";
  const BOOTSTRAP_ARTIFACT_PATH = "KCC20SnapshotBootstrap.placeholder.json";
  const CONTROLLER_ARTIFACT_PATH = "KCC20SnapshotController.placeholder.json";
  const CONTROLLER_STATE_COMMITMENT_DOMAIN = new TextEncoder().encode(
    "kcc20-snapshot-controller-state/v1",
  );
  const artifactCache = new Map();

  async function buildSnapshotMigrationPskt(input) {
    if (input?.schema !== INPUT_SCHEMA) {
      throw new Error(
        `unsupported in-process PSKT builder input schema: ${input?.schema || "missing"}`,
      );
    }
    switch (input.request?.builderKey) {
      case "kcc20-snapshot.deploy-bootstrap":
        return buildSignerlessBootstrapGenesis(input);
      case "kcc20-snapshot.deploy-controller":
        return buildSignerlessControllerGenesis(input);
      case "kcc20-snapshot.start":
        return buildSignerlessStart(input);
      case "kcc20-snapshot.claim":
        return buildClaim(input);
      default:
        throw new Error(
          `unsupported snapshot builderKey: ${input.request?.builderKey || "missing"}`,
        );
    }
  }

  async function buildSignerlessControllerGenesis(input) {
    const request = input.request || {};
    const params = request.params || {};
    const network = networkOf(request);
    const walletAddress = walletAddressOf(request);
    const artifacts = await readPinnedArtifacts(
      params.artifactPins,
      true,
      true,
    );
    const shard = snapshotShard(params.shard);
    const allShards = normalizedSignerlessShards(
      params.allShards ?? [params.shard],
    );
    const plan = signerlessControllerPlan(params, artifacts, shard, allShards);
    const rpc = rpcFor(network);
    await rpc.connect();
    try {
      const walletUtxos = await rpc.getUtxosByAddresses({
        addresses: [walletAddress],
      });
      const cellKas = BigInt(plan.controllerCellKas);
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        cellKas + priorityFee() + 10_000n,
        [],
        params.fundingOutpoint,
      );
      const built = buildControllerGenesisUnsignedTransaction(kaspaWasm, {
        plan,
        controllerArtifact: artifacts.controller,
        fundingInput: portableInput(fundingEntry, network),
        changeAddress: walletAddress,
        feeSompi: priorityFee(),
      });
      const adjusted = transactionWithCalculatedFeeChange(
        kaspaWasm,
        built.transaction,
        built.unsignedTransaction.outputs.length - 1,
        network,
        "signerless snapshot controller genesis",
      );
      const json = JSON.parse(adjusted.serializeToSafeJSON());
      const controllerId = requireHex32(
        json.outputs?.[0]?.covenant?.covenantId,
        "controller covenant id",
      );
      const revealScript = buildSignerlessControllerScript(
        artifacts.controller,
        plan.controllerState,
      );
      return outputEnvelope(adjusted, [{ index: 0 }], [], {
        migrationId: requireHex32(params.migrationId, "migration id"),
        stage: "controller-deploy",
        controllerId,
        shard: shard.shardIndex,
        controllerState: plan.controllerState,
        controllerStateCommitment: signerlessControllerStateCommitment(
          plan.controllerState,
        ),
        holderExtensionCommitment: requireHex32(
          params.holderExtensionCommitment,
          "holder extension commitment",
        ),
        maximumFeeSompi: feeOf(adjusted).toString(),
        intentInputs: [{ role: "creator-funding", index: 0 }],
        intentOutputs: [
          {
            role: "snapshot-controller",
            index: 0,
            shard: shard.shardIndex,
            covenantId: controllerId,
            revealScriptHex: bytesToHex(revealScript),
          },
        ],
      });
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildSignerlessBootstrapGenesis(input) {
    const request = input.request || {};
    const params = request.params || {};
    const network = networkOf(request);
    const walletAddress = walletAddressOf(request);
    const artifacts = await readPinnedArtifacts(
      params.artifactPins,
      true,
      true,
    );
    const prepared = signerlessDeploymentPlans(params, artifacts);
    const rpc = rpcFor(network);
    await rpc.connect();
    try {
      const walletUtxos = await rpc.getUtxosByAddresses({
        addresses: [walletAddress],
      });
      const cellKas = BigInt(prepared.bootstrapPlan.bootstrapCellKas);
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        cellKas + priorityFee() + 10_000n,
        [],
        params.fundingOutpoint,
      );
      const built = buildBootstrapGenesisUnsignedTransaction(kaspaWasm, {
        plan: prepared.bootstrapPlan,
        bootstrapArtifact: artifacts.bootstrap,
        fundingInput: portableInput(fundingEntry, network),
        changeAddress: walletAddress,
        feeSompi: priorityFee(),
      });
      const adjusted = transactionWithCalculatedFeeChange(
        kaspaWasm,
        built.transaction,
        built.unsignedTransaction.outputs.length - 1,
        network,
        "signerless snapshot bootstrap genesis",
      );
      const json = JSON.parse(adjusted.serializeToSafeJSON());
      const covenantId = requireHex32(
        json.outputs?.[0]?.covenant?.covenantId,
        "bootstrap covenant id",
      );
      const revealScript = buildSignerlessBootstrapScript(
        artifacts.bootstrap,
        prepared.bootstrapPlan.bootstrapState,
      );
      return outputEnvelope(adjusted, [{ index: 0 }], [], {
        migrationId: requireHex32(params.migrationId, "migration id"),
        stage: "bootstrap-deploy",
        covenantId,
        tokenId: prepared.tokenId,
        bootstrapState: prepared.bootstrapPlan.bootstrapState,
        maximumFeeSompi: feeOf(adjusted).toString(),
        intentInputs: [{ role: "creator-funding", index: 0 }],
        intentOutputs: [
          {
            role: "snapshot-bootstrap",
            index: 0,
            covenantId,
            revealScriptHex: bytesToHex(revealScript),
          },
        ],
      });
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildSignerlessStart(input) {
    const request = input.request || {};
    const params = request.params || {};
    const network = networkOf(request);
    const walletAddress = walletAddressOf(request);
    const artifacts = await readPinnedArtifacts(
      params.artifactPins,
      true,
      true,
    );
    const prepared = signerlessDeploymentPlans(params, artifacts);
    const bootstrapId = requireHex32(
      params.bootstrapId,
      "bootstrap covenant id",
    );
    const startPlan = buildSnapshotStartPlan({
      migrationId: requireHex32(params.migrationId, "migration id"),
      bootstrapArtifact: artifacts.bootstrap,
      controllerArtifact: artifacts.controller,
      kcc20Artifact: artifacts.kcc20,
      bootstrapId,
      bootstrapState: prepared.bootstrapPlan.bootstrapState,
      shards: prepared.startShards,
    });
    const bootstrapScript = buildSignerlessBootstrapScript(
      artifacts.bootstrap,
      prepared.bootstrapPlan.bootstrapState,
    );
    const controllerScripts = prepared.controllerPlans.map((plan) =>
      buildSignerlessControllerScript(
        artifacts.controller,
        plan.controllerState,
      ),
    );
    const bootstrapSource = sourceDescriptor(
      params.bootstrapSource,
      "bootstrap source",
      scriptAddress(bootstrapScript, network),
    );
    const controllerSources = prepared.shards.map((shard, index) =>
      sourceDescriptor(
        shard.controllerSource,
        `controller ${index} source`,
        scriptAddress(controllerScripts[index], network),
      ),
    );
    const rpc = rpcFor(network);
    await rpc.connect();
    try {
      const addresses = [
        bootstrapSource.address,
        ...controllerSources.map((source) => source.address),
      ];
      const covenantUtxos = await rpc.getUtxosByAddresses({
        addresses: [...new Set(addresses)],
      });
      const bootstrapEntry = findExactEntry(
        covenantUtxos.entries,
        bootstrapSource,
      );
      assertCovenantSource(bootstrapEntry, {
        covenantId: bootstrapId,
        script: bootstrapScript,
        amount: prepared.bootstrapPlan.bootstrapCellKas,
        label: "snapshot bootstrap source",
      });
      const controllerEntries = controllerSources.map((source, index) => {
        const entry = findExactEntry(covenantUtxos.entries, source);
        assertCovenantSource(entry, {
          covenantId: prepared.shards[index].controllerId,
          script: controllerScripts[index],
          amount: prepared.controllerPlans[index].controllerCellKas,
          label: `snapshot controller ${index} source`,
        });
        return entry;
      });
      const walletUtxos = await rpc.getUtxosByAddresses({
        addresses: [walletAddress],
      });
      const requiredFunding = calculateSnapshotStartRequiredFunding(
        startPlan,
        prepared.shards.length,
        priorityFee(),
      );
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        requiredFunding > 0n ? requiredFunding : priorityFee() + 10_000n,
        [bootstrapEntry, ...controllerEntries],
        params.fundingOutpoint,
      );
      const tokenMetadata = requiredRecord(
        params.tokenMetadata,
        "snapshot token metadata",
      );
      const payload = buildSnapshotKcc20DeploymentPayload({
        creator: tokenMetadata.creator,
        ticker: tokenMetadata.ticker,
        name: tokenMetadata.name,
        displayScale: tokenMetadata.displayScale,
        totalSupply: params.totalSupply,
        holderExtensionCommitment: params.holderExtensionCommitment,
        migrationId: params.migrationCommitment ?? params.migrationId,
        manifestCommitment: params.manifestCommitment,
        reserves: startPlan.reserves,
        treasury: tokenMetadata.treasury ?? tokenMetadata.creator,
        protocolFeeRecipient:
          tokenMetadata.protocolFeeRecipient ?? tokenMetadata.creator,
        protocolFeeBps: tokenMetadata.protocolFeeBps ?? 0,
      });
      const built = buildSnapshotStartUnsignedTransaction(kaspaWasm, {
        plan: startPlan,
        bootstrapArtifact: artifacts.bootstrap,
        controllerArtifact: artifacts.controller,
        kcc20Artifact: artifacts.kcc20,
        bootstrapInput: portableInput(bootstrapEntry, network, bootstrapScript),
        controllerInputs: controllerEntries.map((entry, index) =>
          portableInput(entry, network, controllerScripts[index]),
        ),
        fundingInput: portableInput(fundingEntry, network),
        changeAddress: walletAddress,
        feeSompi: priorityFee(),
        payload,
      });
      const changeIndex = built.unsignedTransaction.outputs.length - 1;
      const adjusted = transactionWithCalculatedFeeChange(
        kaspaWasm,
        built.transaction,
        changeIndex,
        network,
        "signerless snapshot start",
      );
      return outputEnvelope(
        adjusted,
        [{ index: 1 + prepared.shards.length }],
        [],
        {
          migrationId: requireHex32(params.migrationId, "migration id"),
          stage: "snapshot-start",
          tokenId: prepared.tokenId,
          covenantId: prepared.tokenId,
          bootstrapId,
          bootstrapState: prepared.bootstrapPlan.bootstrapState,
          bootstrapConsumed: true,
          shards: prepared.shards.map((shard) => shard.shardIndex),
          maximumFeeSompi: feeOf(adjusted).toString(),
          intentInputs: [
            {
              role: "snapshot-bootstrap",
              index: 0,
              covenantId: bootstrapId,
              revealScriptHex: bytesToHex(bootstrapScript),
              staticSignatureScriptHex: signatureScriptHex(adjusted, 0),
            },
            ...prepared.shards.map((shard, index) => ({
              role: "snapshot-controller",
              index: index + 1,
              shard: shard.shardIndex,
              covenantId: shard.controllerId,
              revealScriptHex: bytesToHex(controllerScripts[index]),
              staticSignatureScriptHex: signatureScriptHex(adjusted, index + 1),
            })),
            { role: "creator-funding", index: 1 + prepared.shards.length },
          ],
          intentOutputs: [
            ...prepared.shards.map((shard, index) => ({
              role: "shard-reserve",
              index,
              shard: shard.shardIndex,
              covenantId: prepared.tokenId,
              tokenAmount: shard.allocationTotal.toString(),
              owner: shard.controllerId,
              ownerScheme: 4,
              borrowScheme: 0,
              borrowGuard: ZERO_HASH,
              extensionCommitment: requireHex32(
                params.holderExtensionCommitment,
                "holder extension commitment",
              ),
              revealScriptHex: bytesToHex(
                buildKcc20ScriptForState(
                  artifacts.kcc20,
                  kcc20State(startPlan.reserves[index]),
                ),
              ),
            })),
            ...prepared.shards.map((shard, index) => ({
              role: "snapshot-controller",
              index: prepared.shards.length + index,
              shard: shard.shardIndex,
              covenantId: shard.controllerId,
              revealScriptHex: bytesToHex(
                buildSignerlessControllerScript(
                  artifacts.controller,
                  startPlan.controllers[index].stateAfter,
                ),
              ),
            })),
          ],
        },
      );
    } finally {
      await rpc.disconnect();
    }
  }

  function signerlessDeploymentPlans(params, artifacts) {
    const shards = normalizedSignerlessShards(params.allShards);
    if (
      shards.some((shard) => !shard.controllerId || !shard.controllerSource)
    ) {
      throw new Error(
        "signerless bootstrap/start requires every indexed controller identity and source",
      );
    }
    const controllerPlans = shards.map((shard) =>
      signerlessControllerPlan(params, artifacts, shard, shards),
    );
    const startShards = shards.map((shard, index) => ({
      controllerId: shard.controllerId,
      state: controllerPlans[index].controllerState,
    }));
    const reserves = shards.map((shard) => ({
      amount: shard.allocationTotal.toString(),
      owner: shard.controllerId,
      ownerScheme: 4,
      borrowScheme: 0,
      borrowGuard: ZERO_HASH,
      extensionCommitment: requireHex32(
        params.holderExtensionCommitment,
        "holder extension commitment",
      ),
    }));
    const tokenId = deriveSnapshotTokenId(kaspaWasm, {
      controllerGenesisOutpoint: outpointOfSource(
        shards[0].controllerSource,
        "shard-zero controller source",
      ),
      reserves,
      kcc20Artifact: artifacts.kcc20,
      reserveCellKas: minimumCell(params.reserveCellKas, "reserve cell KAS"),
    });
    const bootstrapPlan = buildSignerlessBootstrapPlan({
      migrationId: requireHex32(params.migrationId, "migration id"),
      migrationCommitment: requireHex32(
        params.migrationCommitment ?? params.migrationId,
        "migration commitment",
      ),
      bootstrapArtifact: artifacts.bootstrap,
      controllerArtifact: artifacts.controller,
      kcc20Artifact: artifacts.kcc20,
      manifestCommitment: requireHex32(
        params.manifestCommitment,
        "manifest commitment",
      ),
      holderExtensionCommitment: requireHex32(
        params.holderExtensionCommitment,
        "holder extension commitment",
      ),
      totalSupply: positiveI64(params.totalSupply, "total supply"),
      claimNotBeforeDaaScore: positiveI64(
        params.claimNotBeforeDaaScore,
        "claim-not-before DAA score",
      ),
      expectedTokenId: tokenId,
      shards: startShards,
      reserveCellKas: minimumCell(params.reserveCellKas, "reserve cell KAS"),
      controllerCellKas: minimumCell(
        params.controllerCellKas,
        "controller cell KAS",
      ),
      bootstrapCellKas: minimumCell(
        params.bootstrapCellKas,
        "bootstrap cell KAS",
      ),
    });
    return { shards, controllerPlans, startShards, tokenId, bootstrapPlan };
  }

  function signerlessControllerPlan(params, artifacts, shard, allShards) {
    const common = {
      migrationId: requireHex32(params.migrationId, "migration id"),
      migrationCommitment: requireHex32(
        params.migrationCommitment ?? params.migrationId,
        "migration commitment",
      ),
      controllerArtifact: artifacts.controller,
      bootstrapArtifact: artifacts.bootstrap,
      kcc20Artifact: artifacts.kcc20,
      holderExtensionCommitment: requireHex32(
        params.holderExtensionCommitment,
        "holder extension commitment",
      ),
      manifestCommitment: requireHex32(
        params.manifestCommitment,
        "manifest commitment",
      ),
      context: requireHex32(params.snapshotContext, "snapshot context"),
      shardCount: allShards.length,
      controllerCellKas: minimumCell(
        params.controllerCellKas,
        "controller cell KAS",
      ),
      reserveCellKas: minimumCell(params.reserveCellKas, "reserve cell KAS"),
      recipientMinCellKas: minimumCell(
        params.recipientMinCellKas,
        "recipient minimum cell KAS",
      ),
      claimNotBeforeDaaScore: positiveI64(
        params.claimNotBeforeDaaScore,
        "claim-not-before DAA score",
      ),
    };
    if (shard.shardIndex !== 0) {
      return createSignerlessControllerPlan({
        ...common,
        shard,
        deploymentGuardCommitment: ZERO_HASH,
      });
    }
    const provisional = createSignerlessControllerPlan({
      ...common,
      shard,
      deploymentGuardCommitment: "01".repeat(32),
    });
    const peerPlans = allShards.slice(1).map((peer) => {
      if (!peer.controllerId)
        throw new Error(
          "deploy shard zero only after every peer controller is indexed",
        );
      const plan = createSignerlessControllerPlan({
        ...common,
        shard: peer,
        deploymentGuardCommitment: ZERO_HASH,
      });
      return { controllerId: peer.controllerId, state: plan.controllerState };
    });
    const guard = snapshotPeerPlanCommitment({
      migrationCommitment: common.migrationCommitment,
      manifestCommitment: common.manifestCommitment,
      shards: [
        { controllerId: "01".repeat(32), state: provisional.controllerState },
        ...peerPlans,
      ],
    });
    return createSignerlessControllerPlan({
      ...common,
      shard,
      deploymentGuardCommitment: guard,
    });
  }

  function normalizedSignerlessShards(values) {
    if (!Array.isArray(values) || values.length < 1 || values.length > 8) {
      throw new Error("signerless snapshot requires 1..8 ordered shards");
    }
    const shards = values.map((value) => ({
      ...snapshotShard(value),
      controllerId: value?.controllerId
        ? requireHex32(value.controllerId, "controller id")
        : undefined,
      controllerSource: value?.controllerSource,
    }));
    shards.sort((left, right) => left.shardIndex - right.shardIndex);
    if (shards.some((shard, index) => shard.shardIndex !== index)) {
      throw new Error(
        "signerless snapshot shards must be contiguous from zero",
      );
    }
    return shards;
  }

  function portableInput(entry, network, script) {
    return {
      previousOutpoint: entry.outpoint,
      utxo: entry,
      networkId: network,
      ...(script ? { script } : {}),
    };
  }

  function outpointOfSource(source, label) {
    return {
      transactionId: requireHex32(source?.txidHex, `${label} txid`),
      index: unsignedInteger(source?.vout, `${label} vout`),
    };
  }

  async function buildBootstrapCancellation(input) {
    const request = input.request || {};
    const params = request.params || {};
    const network = networkOf(request);
    const walletAddress = walletAddressOf(request);
    const artifacts = await readPinnedArtifacts(
      params.artifactPins,
      false,
      true,
    );
    const template = templateParts(artifacts.kcc20);
    const base = bootstrapBaseState(params, template);
    const migrationId = requireHex32(params.migrationId, "migration ID");
    const bootstrapId = requireHex32(params.bootstrapId, "bootstrap ID");
    const phase = String(params.bootstrapPhase || "").toUpperCase();
    if (!["UNBOUND", "TOKEN_BOUND", "SEALED"].includes(phase)) {
      throw new Error(
        "bootstrap cancellation phase is not terminally cancellable",
      );
    }
    const bound = phase !== "UNBOUND";
    const tokenId = bound
      ? requireHex32(params.tokenId, "token ID")
      : ZERO_HASH;
    const beforeState = {
      ...base,
      phase: phase === "UNBOUND" ? 0n : phase === "TOKEN_BOUND" ? 1n : 2n,
      tokenId: hexToBytes(tokenId),
      shardPlanCommitment:
        phase === "SEALED"
          ? hexToBytes(
              requireHex32(
                params.bootstrapShardPlanCommitment,
                "bootstrap shard plan commitment",
              ),
            )
          : hexToBytes(ZERO_HASH),
      activationDigest:
        phase === "SEALED"
          ? hexToBytes(
              requireHex32(
                params.bootstrapActivationDigest,
                "bootstrap activation digest",
              ),
            )
          : hexToBytes(ZERO_HASH),
      shardCount:
        phase === "SEALED"
          ? positiveI64(params.bootstrapShardCount, "bootstrap shard count")
          : 0n,
    };
    if (beforeState.shardCount > 8n) {
      throw new Error("bootstrap cancellation shard count exceeds policy");
    }
    const bootstrapScript = buildSnapshotBootstrapScriptForState(
      artifacts.bootstrap,
      beforeState,
    );
    const bootstrapSource = sourceDescriptor(
      params.bootstrapSource,
      "bootstrap source",
      scriptAddress(bootstrapScript, network),
    );
    const tokenState = bound
      ? kcc20State(params.tokenSource?.state)
      : undefined;
    if (
      tokenState &&
      (tokenState.amount !== base.totalSupply ||
        tokenState.ownerScheme !== 4 ||
        bytesToHex(tokenState.owner) !== bootstrapId ||
        bytesToHex(tokenState.extensionCommitment) !==
          bytesToHex(base.holderExtensionCommitment))
    ) {
      throw new Error("bootstrap cancellation token source does not match");
    }
    const tokenScript = tokenState
      ? buildKcc20ScriptForState(artifacts.kcc20, tokenState)
      : undefined;
    const tokenSource = tokenScript
      ? sourceDescriptor(
          params.tokenSource,
          "token source",
          scriptAddress(tokenScript, network),
        )
      : undefined;
    if (!bound && params.tokenSource != null) {
      throw new Error(
        "unbound bootstrap cancellation must not include a token",
      );
    }
    const sinkTokenState = tokenState
      ? {
          amount: base.totalSupply,
          owner: hexToBytes(SNAPSHOT_CANCEL_SINK_P2SH),
          ownerScheme: 3,
          borrowScheme: 0,
          borrowGuard: hexToBytes(ZERO_HASH),
          extensionCommitment: base.holderExtensionCommitment,
        }
      : undefined;
    const sinkTokenScript = sinkTokenState
      ? buildKcc20ScriptForState(artifacts.kcc20, sinkTokenState)
      : undefined;
    const rpc = rpcFor(network);
    await rpc.connect();
    try {
      const bootstrapPromise = rpc.getUtxosByAddresses({
        addresses: [bootstrapSource.address],
      });
      const tokenPromise = tokenSource
        ? rpc.getUtxosByAddresses({ addresses: [tokenSource.address] })
        : Promise.resolve({ entries: [] });
      const [bootstrapUtxos, tokenUtxos, walletUtxos] = await Promise.all([
        bootstrapPromise,
        tokenPromise,
        rpc.getUtxosByAddresses({ addresses: [walletAddress] }),
      ]);
      const bootstrapEntry = findExactEntry(
        bootstrapUtxos.entries,
        bootstrapSource,
      );
      assertCovenantSource(bootstrapEntry, {
        covenantId: bootstrapId,
        script: bootstrapScript,
        amount: base.bootstrapCellKas,
        label: "bootstrap cancellation source",
      });
      const tokenEntry = tokenSource
        ? findExactEntry(tokenUtxos.entries, tokenSource)
        : undefined;
      if (tokenEntry) {
        assertCovenantSource(tokenEntry, {
          covenantId: tokenId,
          script: tokenScript,
          amount: base.tokenCellKas,
          label: "bootstrap cancellation token",
        });
      }
      const consumed = [bootstrapEntry, ...(tokenEntry ? [tokenEntry] : [])];
      const fundingEntry = selectFundingEntry(
        withoutOutpoints(
          walletUtxos.entries,
          consumed.map(({ outpoint }) => outpoint),
        ),
        priorityFee() + 10_000n,
        [],
        params.fundingOutpoint,
      );
      const outputs = [];
      if (sinkTokenScript) {
        outputs.push(
          new kaspaWasm.TransactionOutput(
            base.tokenCellKas,
            kaspaWasm.payToScriptHashScript(sinkTokenScript),
            new kaspaWasm.CovenantBinding(1, new kaspaWasm.Hash(tokenId)),
          ),
        );
      }
      const sinkOutputIndex = outputs.length;
      outputs.push(
        new kaspaWasm.TransactionOutput(
          base.bootstrapCellKas,
          kaspaWasm.payToScriptHashScript(Uint8Array.of(0x6a)),
        ),
      );
      const fundingChangeOutputIndex = appendFundingChange(
        outputs,
        [...consumed, fundingEntry],
        walletAddress,
        base.bootstrapCellKas + (bound ? base.tokenCellKas : 0n),
        priorityFee(),
      );
      const inputs = [
        covenantInput(bootstrapEntry, BOOTSTRAP_COMPUTE_BUDGET),
        ...(tokenEntry
          ? [covenantInput(tokenEntry, KCC20_COMPUTE_BUDGET)]
          : []),
        publicInput(fundingEntry, PUBLIC_INPUT_COMPUTE_BUDGET),
      ];
      const transaction = new kaspaWasm.Transaction({
        version: 1,
        lockTime: 0n,
        inputs,
        outputs,
        subnetworkId: NATIVE_SUBNETWORK_ID,
        gas: 0n,
        payload: "",
      });
      setVersionOneInputMassFields(transaction, PUBLIC_INPUT_COMPUTE_BUDGET);
      transaction.inputs[0].computeBudget = BOOTSTRAP_COMPUTE_BUDGET;
      if (tokenEntry) {
        transaction.inputs[1].computeBudget = KCC20_COMPUTE_BUDGET;
      }
      const recipes = bootstrapApprovalRecipes(
        bytesToHex(bootstrapScript),
        bootstrapCancellationArgs(
          artifacts,
          bound,
          sinkOutputIndex,
          sinkTokenState,
        ),
      );
      transaction.inputs[0].signatureScript = encodeP2sh(
        signatureScriptArgsBytes(recipes.placeholder.args),
        bootstrapScript,
      );
      if (tokenEntry && tokenScript && sinkTokenState) {
        transaction.inputs[1].signatureScript = encodeP2sh(
          buildKcc20TransferSigScript(kaspaWasm, artifacts.kcc20, {
            nextStates: [sinkTokenState],
            witness: Uint8Array.of(0),
          }),
          tokenScript,
        );
      }
      const fundingInputIndex = inputs.length - 1;
      const adjusted = transactionWithCalculatedFeeChange(
        kaspaWasm,
        transaction,
        fundingChangeOutputIndex,
        network,
        "snapshot bootstrap cancellation",
        [recipes.approval],
      );
      return outputEnvelope(
        adjusted,
        [{ index: fundingInputIndex }],
        [recipes.approval],
        {
          migrationId,
          stage: "bootstrap-cancel",
          bootstrapId,
          ...(bound ? { tokenId } : {}),
          cancellationMode: bound ? "BOUND" : "UNBOUND",
          cancellationSinkP2sh: SNAPSHOT_CANCEL_SINK_P2SH,
          bootstrapState: {
            ...bootstrapStateReceipt(beforeState),
            phase,
          },
          bootstrapOutcome: "CANCELLED",
          maximumFeeSompi: feeOf(adjusted).toString(),
          intentInputs: [
            {
              role: "snapshot-bootstrap",
              index: 0,
              covenantId: bootstrapId,
              revealScriptHex: bytesToHex(bootstrapScript),
            },
            ...(tokenEntry && tokenScript
              ? [
                  {
                    role: "fixed-supply-token",
                    index: 1,
                    covenantId: tokenId,
                    revealScriptHex: bytesToHex(tokenScript),
                    staticSignatureScriptHex: signatureScriptHex(adjusted, 1),
                  },
                ]
              : []),
            { role: "creator-funding", index: fundingInputIndex },
          ],
          intentOutputs: [
            ...(sinkTokenScript && sinkTokenState
              ? [
                  {
                    role: "cancelled-token",
                    index: 0,
                    covenantId: tokenId,
                    revealScriptHex: bytesToHex(sinkTokenScript),
                    owner: SNAPSHOT_CANCEL_SINK_P2SH,
                    ownerScheme: 3,
                    borrowScheme: 0,
                    borrowGuard: ZERO_HASH,
                    extensionCommitment: bytesToHex(
                      sinkTokenState.extensionCommitment,
                    ),
                    tokenAmount: sinkTokenState.amount.toString(),
                  },
                ]
              : []),
            {
              role: "cancellation-sink",
              index: sinkOutputIndex,
              revealScriptHex: "6a",
            },
          ],
        },
      );
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildBootstrapBind(input) {
    const request = input.request || {};
    const params = request.params || {};
    const network = networkOf(request);
    const walletAddress = walletAddressOf(request);
    const artifacts = await readPinnedArtifacts(
      params.artifactPins,
      false,
      true,
    );
    const template = templateParts(artifacts.kcc20);
    const base = bootstrapBaseState(params, template);
    const bootstrapId = requireHex32(params.bootstrapId, "bootstrap ID");
    const tokenId = requireHex32(params.tokenId, "token ID");
    const tokenState = kcc20State(params.tokenSource?.state);
    if (
      tokenState.amount !== base.totalSupply ||
      tokenState.ownerScheme !== 4 ||
      bytesToHex(tokenState.owner) !== bootstrapId ||
      bytesToHex(tokenState.extensionCommitment) !==
        bytesToHex(base.holderExtensionCommitment)
    ) {
      throw new Error(
        "bootstrap bind token source does not match the migration",
      );
    }
    const beforeState = {
      ...base,
      phase: 0n,
      tokenId: hexToBytes(ZERO_HASH),
      shardPlanCommitment: hexToBytes(ZERO_HASH),
      activationDigest: hexToBytes(ZERO_HASH),
      shardCount: 0n,
    };
    const afterState = {
      ...base,
      phase: 1n,
      tokenId: hexToBytes(tokenId),
      shardPlanCommitment: hexToBytes(ZERO_HASH),
      activationDigest: hexToBytes(ZERO_HASH),
      shardCount: 0n,
    };
    const bootstrapScript = buildSnapshotBootstrapScriptForState(
      artifacts.bootstrap,
      beforeState,
    );
    const nextBootstrapScript = buildSnapshotBootstrapScriptForState(
      artifacts.bootstrap,
      afterState,
    );
    const tokenScript = buildKcc20ScriptForState(artifacts.kcc20, tokenState);
    const bootstrapSource = sourceDescriptor(
      params.bootstrapSource,
      "bootstrap source",
      scriptAddress(bootstrapScript, network),
    );
    const tokenSource = sourceDescriptor(
      params.tokenSource,
      "token source",
      scriptAddress(tokenScript, network),
    );
    const rpc = rpcFor(network);
    await rpc.connect();
    try {
      const [bootstrapUtxos, tokenUtxos, walletUtxos] = await Promise.all([
        rpc.getUtxosByAddresses({ addresses: [bootstrapSource.address] }),
        rpc.getUtxosByAddresses({ addresses: [tokenSource.address] }),
        rpc.getUtxosByAddresses({ addresses: [walletAddress] }),
      ]);
      const bootstrapEntry = findExactEntry(
        bootstrapUtxos.entries,
        bootstrapSource,
      );
      assertCovenantSource(bootstrapEntry, {
        covenantId: bootstrapId,
        script: bootstrapScript,
        amount: base.bootstrapCellKas,
        label: "bootstrap bind source",
      });
      const tokenEntry = findExactEntry(tokenUtxos.entries, tokenSource);
      assertCovenantSource(tokenEntry, {
        covenantId: tokenId,
        script: tokenScript,
        amount: base.tokenCellKas,
        label: "bootstrap bind token source",
      });
      const fundingEntry = selectFundingEntry(
        withoutOutpoints(walletUtxos.entries, [
          bootstrapEntry.outpoint,
          tokenEntry.outpoint,
        ]),
        priorityFee() + 10_000n,
        [],
        params.fundingOutpoint,
      );
      const outputs = [
        new kaspaWasm.TransactionOutput(
          base.tokenCellKas,
          kaspaWasm.payToScriptHashScript(tokenScript),
          new kaspaWasm.CovenantBinding(1, new kaspaWasm.Hash(tokenId)),
        ),
        new kaspaWasm.TransactionOutput(
          base.bootstrapCellKas,
          kaspaWasm.payToScriptHashScript(nextBootstrapScript),
          new kaspaWasm.CovenantBinding(0, new kaspaWasm.Hash(bootstrapId)),
        ),
      ];
      const fundingChangeOutputIndex = appendFundingChange(
        outputs,
        [bootstrapEntry, tokenEntry, fundingEntry],
        walletAddress,
        base.tokenCellKas + base.bootstrapCellKas,
        priorityFee(),
      );
      const transaction = new kaspaWasm.Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          covenantInput(bootstrapEntry, BOOTSTRAP_COMPUTE_BUDGET),
          covenantInput(tokenEntry, KCC20_COMPUTE_BUDGET),
          publicInput(fundingEntry, PUBLIC_INPUT_COMPUTE_BUDGET),
        ],
        outputs,
        subnetworkId: NATIVE_SUBNETWORK_ID,
        gas: 0n,
        payload: "",
      });
      setVersionOneInputMassFields(transaction, PUBLIC_INPUT_COMPUTE_BUDGET);
      transaction.inputs[0].computeBudget = BOOTSTRAP_COMPUTE_BUDGET;
      transaction.inputs[1].computeBudget = KCC20_COMPUTE_BUDGET;
      const recipes = bootstrapApprovalRecipes(
        bytesToHex(bootstrapScript),
        bootstrapBindArgs(artifacts, afterState, tokenState),
      );
      transaction.inputs[0].signatureScript = encodeP2sh(
        signatureScriptArgsBytes(recipes.placeholder.args),
        bootstrapScript,
      );
      transaction.inputs[1].signatureScript = encodeP2sh(
        buildKcc20TransferSigScript(kaspaWasm, artifacts.kcc20, {
          nextStates: [tokenState],
          witness: Uint8Array.of(0),
        }),
        tokenScript,
      );
      const adjusted = transactionWithCalculatedFeeChange(
        kaspaWasm,
        transaction,
        fundingChangeOutputIndex,
        network,
        "snapshot bootstrap bind",
        [recipes.approval],
      );
      return outputEnvelope(adjusted, [{ index: 2 }], [recipes.approval], {
        migrationId: requireHex32(params.migrationId, "migration ID"),
        stage: "bootstrap-bind",
        tokenId,
        bootstrapId,
        bootstrapState: {
          ...bootstrapStateReceipt(afterState),
          phase: "TOKEN_BOUND",
        },
        maximumFeeSompi: feeOf(adjusted).toString(),
        intentInputs: [
          {
            role: "snapshot-bootstrap",
            index: 0,
            covenantId: bootstrapId,
            revealScriptHex: bytesToHex(bootstrapScript),
          },
          {
            role: "fixed-supply-token",
            index: 1,
            covenantId: tokenId,
            revealScriptHex: bytesToHex(tokenScript),
            staticSignatureScriptHex: signatureScriptHex(adjusted, 1),
          },
          { role: "creator-funding", index: 2 },
        ],
        intentOutputs: [
          {
            role: "fixed-supply-token",
            index: 0,
            covenantId: tokenId,
            revealScriptHex: bytesToHex(tokenScript),
            owner: bootstrapId,
            ownerScheme: 4,
            borrowScheme: 0,
            borrowGuard: bytesToHex(tokenState.borrowGuard),
            extensionCommitment: bytesToHex(tokenState.extensionCommitment),
            tokenAmount: tokenState.amount.toString(),
          },
          {
            role: "snapshot-bootstrap",
            index: 1,
            covenantId: bootstrapId,
            revealScriptHex: bytesToHex(nextBootstrapScript),
          },
        ],
      });
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildBootstrapSeal(input) {
    const request = input.request || {};
    const params = request.params || {};
    const network = networkOf(request);
    const walletAddress = walletAddressOf(request);
    const artifacts = await readPinnedArtifacts(
      params.artifactPins,
      false,
      true,
    );
    const template = templateParts(artifacts.kcc20);
    const base = bootstrapBaseState(params, template);
    const migrationId = requireHex32(params.migrationId, "migration ID");
    const bootstrapId = requireHex32(params.bootstrapId, "bootstrap ID");
    const tokenId = requireHex32(params.tokenId, "token ID");
    const shards = reserveShards(params.shards, base.totalSupply);
    const shardPlanCommitment = snapshotShardPlanCommitment({
      migrationCommitment: migrationId,
      manifestCommitment: bytesToHex(base.manifestCommitment),
      tokenId,
      totalSupply: base.totalSupply,
      shards,
    });
    const beforeState = {
      ...base,
      phase: 1n,
      tokenId: hexToBytes(tokenId),
      shardPlanCommitment: hexToBytes(ZERO_HASH),
      activationDigest: hexToBytes(ZERO_HASH),
      shardCount: 0n,
    };
    const afterState = {
      ...base,
      phase: 2n,
      tokenId: hexToBytes(tokenId),
      shardPlanCommitment: hexToBytes(shardPlanCommitment),
      activationDigest: hexToBytes(
        requireHex32(params.activationDigest, "activation digest"),
      ),
      shardCount: BigInt(shards.length),
    };
    const bootstrapScript = buildSnapshotBootstrapScriptForState(
      artifacts.bootstrap,
      beforeState,
    );
    const nextBootstrapScript = buildSnapshotBootstrapScriptForState(
      artifacts.bootstrap,
      afterState,
    );
    const bootstrapSource = sourceDescriptor(
      params.bootstrapSource,
      "bootstrap source",
      scriptAddress(bootstrapScript, network),
    );
    const rpc = rpcFor(network);
    await rpc.connect();
    try {
      const [bootstrapUtxos, walletUtxos] = await Promise.all([
        rpc.getUtxosByAddresses({ addresses: [bootstrapSource.address] }),
        rpc.getUtxosByAddresses({ addresses: [walletAddress] }),
      ]);
      const bootstrapEntry = findExactEntry(
        bootstrapUtxos.entries,
        bootstrapSource,
      );
      assertCovenantSource(bootstrapEntry, {
        covenantId: bootstrapId,
        script: bootstrapScript,
        amount: base.bootstrapCellKas,
        label: "bootstrap seal source",
      });
      const fundingEntry = selectFundingEntry(
        withoutOutpoints(walletUtxos.entries, [bootstrapEntry.outpoint]),
        priorityFee() + 10_000n,
        [],
        params.fundingOutpoint,
      );
      const outputs = [
        new kaspaWasm.TransactionOutput(
          base.bootstrapCellKas,
          kaspaWasm.payToScriptHashScript(nextBootstrapScript),
          new kaspaWasm.CovenantBinding(0, new kaspaWasm.Hash(bootstrapId)),
        ),
      ];
      const fundingChangeOutputIndex = appendFundingChange(
        outputs,
        [bootstrapEntry, fundingEntry],
        walletAddress,
        base.bootstrapCellKas,
        priorityFee(),
      );
      const transaction = new kaspaWasm.Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          covenantInput(bootstrapEntry, BOOTSTRAP_COMPUTE_BUDGET),
          publicInput(fundingEntry, PUBLIC_INPUT_COMPUTE_BUDGET),
        ],
        outputs,
        subnetworkId: NATIVE_SUBNETWORK_ID,
        gas: 0n,
        payload: "",
      });
      setVersionOneInputMassFields(transaction, PUBLIC_INPUT_COMPUTE_BUDGET);
      transaction.inputs[0].computeBudget = BOOTSTRAP_COMPUTE_BUDGET;
      const recipes = bootstrapApprovalRecipes(
        bytesToHex(bootstrapScript),
        bootstrapSealArgs(artifacts, afterState),
      );
      transaction.inputs[0].signatureScript = encodeP2sh(
        signatureScriptArgsBytes(recipes.placeholder.args),
        bootstrapScript,
      );
      const adjusted = transactionWithCalculatedFeeChange(
        kaspaWasm,
        transaction,
        fundingChangeOutputIndex,
        network,
        "snapshot bootstrap seal",
        [recipes.approval],
      );
      return outputEnvelope(adjusted, [{ index: 1 }], [recipes.approval], {
        migrationId,
        stage: "bootstrap-seal",
        tokenId,
        bootstrapId,
        bootstrapState: {
          ...bootstrapStateReceipt(afterState),
          phase: "SEALED",
        },
        shardPlanCommitment,
        activationDigest: bytesToHex(afterState.activationDigest),
        shards: shards.map((shard) => shard.shardIndex),
        maximumFeeSompi: feeOf(adjusted).toString(),
        intentInputs: [
          {
            role: "snapshot-bootstrap",
            index: 0,
            covenantId: bootstrapId,
            revealScriptHex: bytesToHex(bootstrapScript),
          },
          { role: "creator-funding", index: 1 },
        ],
        intentOutputs: [
          {
            role: "snapshot-bootstrap",
            index: 0,
            covenantId: bootstrapId,
            revealScriptHex: bytesToHex(nextBootstrapScript),
          },
        ],
      });
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildBootstrapGenesis(input) {
    const request = input.request || {};
    const params = request.params || {};
    const network = networkOf(request);
    const walletAddress = walletAddressOf(request);
    const [kcc20, bootstrap] = await Promise.all([
      readPinnedArtifact(
        KCC20_ARTIFACT_PATH,
        params.artifactPins?.kcc20ArtifactSha256,
        "KCC20",
      ),
      readPinnedArtifact(
        BOOTSTRAP_ARTIFACT_PATH,
        params.artifactPins?.bootstrapArtifactSha256,
        "KCC20SnapshotBootstrap",
      ),
    ]);
    const template = templateParts(kcc20);
    const expectedTemplateHash = requireHex32(
      params.expectedKcc20TemplateHash,
      "KCC20 template hash",
    );
    if (bytesToHex(template.hash) !== expectedTemplateHash) {
      throw new Error("KCC20 template hash does not match the migration pin");
    }
    const approvalKey = requireHex32(
      params.approvalKey ?? params.approvalKeyA,
      "approval key",
    );
    if (approvalKey === ZERO_HASH) {
      throw new Error("bootstrap approval key must be nonzero");
    }
    const state = {
      migrationCommitment: hexToBytes(
        requireHex32(params.migrationCommitment, "migration commitment"),
      ),
      manifestCommitment: hexToBytes(
        requireHex32(params.manifestCommitment, "manifest commitment"),
      ),
      holderExtensionCommitment: hexToBytes(
        requireHex32(
          params.holderExtensionCommitment,
          "holder extension commitment",
        ),
      ),
      totalSupply: positiveI64(params.totalSupply, "total supply"),
      claimNotBeforeDaaScore: positiveI64(
        params.claimNotBeforeDaaScore,
        "claim-not-before DAA score",
      ),
      kcc20TemplateHash: hexToBytes(expectedTemplateHash),
      kcc20TemplatePrefixLen: BigInt(template.prefix.length),
      kcc20TemplateSuffixLen: BigInt(template.suffix.length),
      tokenCellKas: minimumCell(params.tokenCellKas, "token cell KAS"),
      reserveCellKas: minimumCell(params.reserveCellKas, "reserve cell KAS"),
      bootstrapCellKas: minimumCell(
        params.bootstrapCellKas,
        "bootstrap cell KAS",
      ),
      approvalKey: hexToBytes(approvalKey),
      phase: 0n,
      tokenId: hexToBytes(ZERO_HASH),
      shardPlanCommitment: hexToBytes(ZERO_HASH),
      activationDigest: hexToBytes(ZERO_HASH),
      shardCount: 0n,
    };
    if (state.claimNotBeforeDaaScore >= 500_000_000_000n) {
      throw new Error("claim-not-before must use DAA-score locktime mode");
    }
    const bootstrapScript = buildSnapshotBootstrapScriptForState(
      bootstrap,
      state,
    );
    const rpc = rpcFor(network);
    await rpc.connect();
    try {
      const walletUtxos = await rpc.getUtxosByAddresses({
        addresses: [walletAddress],
      });
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        state.bootstrapCellKas + priorityFee() + 10_000n,
        [],
        params.fundingOutpoint,
      );
      const outputs = [
        new kaspaWasm.TransactionOutput(
          state.bootstrapCellKas,
          kaspaWasm.payToScriptHashScript(bootstrapScript),
        ),
      ];
      const changeIndex = appendFundingChange(
        outputs,
        [fundingEntry],
        walletAddress,
        state.bootstrapCellKas,
        priorityFee(),
      );
      const stateReceipt = bootstrapStateReceipt(state);
      const transaction = new kaspaWasm.Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [publicInput(fundingEntry, PUBLIC_INPUT_COMPUTE_BUDGET)],
        outputs,
        subnetworkId: NATIVE_SUBNETWORK_ID,
        gas: 0n,
        payload: bytesToHex(
          new TextEncoder().encode(
            JSON.stringify({
              tn10: {
                v: 1,
                tmpl: "KCC20SnapshotBootstrap",
                args: [
                  {
                    name: "bootstrapState",
                    type: "object",
                    value: stateReceipt,
                  },
                ],
              },
            }),
          ),
        ),
      });
      setVersionOneInputMassFields(transaction, PUBLIC_INPUT_COMPUTE_BUDGET);
      transaction.populateGenesisCovenants([
        new kaspaWasm.GenesisCovenantGroup(0, [0]),
      ]);
      transaction.finalize();
      const covenantId = requireHex32(
        transaction.outputs[0]?.covenant?.covenantId?.toString(),
        "bootstrap covenant id",
      );
      const adjusted = transactionWithCalculatedFeeChange(
        kaspaWasm,
        transaction,
        changeIndex,
        network,
        "snapshot bootstrap genesis",
      );
      return outputEnvelope(adjusted, [{ index: 0 }], [], {
        migrationId: requireHex32(params.migrationId, "migration id"),
        stage: "bootstrap-deploy",
        covenantId,
        bootstrapState: { ...stateReceipt, phase: "UNBOUND" },
        maximumFeeSompi: feeOf(adjusted).toString(),
        intentInputs: [{ role: "creator-funding", index: 0 }],
        intentOutputs: [
          {
            role: "snapshot-bootstrap",
            index: 0,
            covenantId,
            revealScriptHex: bytesToHex(bootstrapScript),
          },
        ],
      });
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildControllerGenesis(input) {
    const request = input.request || {};
    const params = request.params || {};
    const network = networkOf(request);
    const walletAddress = walletAddressOf(request);
    const artifacts = await readPinnedArtifacts(params.artifactPins, true);
    const definition = snapshotDefinition(params, artifacts);
    const controllerState = initialControllerState(definition);
    const controllerScript = buildSnapshotControllerScriptForState(
      artifacts.controller,
      controllerState,
    );
    const outputSompi = definition.controllerCellKas;
    const rpc = rpcFor(network);
    await rpc.connect();
    try {
      const walletUtxos = await rpc.getUtxosByAddresses({
        addresses: [walletAddress],
      });
      const fundingEntry = selectFundingEntry(
        walletUtxos.entries,
        outputSompi + priorityFee() + 10_000n,
        [],
        params.fundingOutpoint,
      );
      const outputs = [
        new kaspaWasm.TransactionOutput(
          outputSompi,
          kaspaWasm.payToScriptHashScript(controllerScript),
        ),
      ];
      const fundingChangeOutputIndex = appendFundingChange(
        outputs,
        [fundingEntry],
        walletAddress,
        outputSompi,
        priorityFee(),
      );
      const transaction = new kaspaWasm.Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [publicInput(fundingEntry, PUBLIC_INPUT_COMPUTE_BUDGET)],
        outputs,
        subnetworkId: NATIVE_SUBNETWORK_ID,
        gas: 0n,
        payload: controllerDeploymentPayload(definition, controllerState),
      });
      setVersionOneInputMassFields(transaction, PUBLIC_INPUT_COMPUTE_BUDGET);
      transaction.populateGenesisCovenants([
        new kaspaWasm.GenesisCovenantGroup(0, [0]),
      ]);
      transaction.finalize();
      const controllerId = requireHex32(
        transaction.outputs[0]?.covenant?.covenantId?.toString(),
        "controller covenant id",
      );
      const adjusted = transactionWithCalculatedFeeChange(
        kaspaWasm,
        transaction,
        fundingChangeOutputIndex,
        network,
        "snapshot controller genesis",
      );
      return outputEnvelope(adjusted, [{ index: 0 }], [], {
        migrationId: definition.migrationId,
        stage: "controller-deploy",
        controllerId,
        shard: definition.shard.shardIndex,
        controllerStateCommitment:
          snapshotControllerStateCommitment(controllerState),
        holderExtensionCommitment: definition.holderExtensionCommitment,
        maximumFeeSompi: feeOf(adjusted).toString(),
        intentInputs: [{ role: "creator-funding", index: 0 }],
        intentOutputs: [
          {
            role: "snapshot-controller",
            index: 0,
            shard: definition.shard.shardIndex,
            covenantId: controllerId,
            revealScriptHex: bytesToHex(controllerScript),
          },
        ],
      });
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildReserveHandoff(input) {
    const request = input.request || {};
    const params = request.params || {};
    const network = networkOf(request);
    const walletAddress = walletAddressOf(request);
    const migrationId = requireHex32(params.migrationId, "migration id");
    const artifacts = await readPinnedArtifacts(
      params.artifactPins,
      false,
      true,
    );
    const bootstrapId = requireHex32(
      params.bootstrapId,
      "bootstrap covenant id",
    );
    const tokenId = requireHex32(params.tokenId, "token covenant id");
    const extensionCommitment = requireHex32(
      params.holderExtensionCommitment,
      "holder extension commitment",
    );
    const totalSupply = positiveI64(params.totalSupply, "total supply");
    const tokenState = kcc20State(params.tokenSource?.state);
    if (
      tokenState.amount !== totalSupply ||
      tokenState.ownerScheme !== 4 ||
      bytesToHex(tokenState.owner) !== bootstrapId ||
      bytesToHex(tokenState.extensionCommitment) !== extensionCommitment
    ) {
      throw new Error(
        "reserve handoff token source does not match the migration",
      );
    }
    const shards = reserveShards(params.shards, totalSupply);
    const template = templateParts(artifacts.kcc20);
    const expectedTemplateHash = requireHex32(
      params.kcc20TemplateHash,
      "KCC20 template hash",
    );
    if (bytesToHex(template.hash) !== expectedTemplateHash) {
      throw new Error("KCC20 template hash does not match the migration pin");
    }
    const shardPlanCommitment = snapshotShardPlanCommitment({
      migrationCommitment: migrationId,
      manifestCommitment: requireHex32(
        params.manifestCommitment,
        "manifest commitment",
      ),
      tokenId,
      totalSupply,
      shards,
    });
    if (
      shardPlanCommitment !==
      requireHex32(
        params.bootstrapShardPlanCommitment,
        "bootstrap shard plan commitment",
      )
    ) {
      throw new Error("activation shards do not match the sealed bootstrap");
    }
    const bootstrapState = {
      migrationCommitment: hexToBytes(migrationId),
      manifestCommitment: hexToBytes(
        requireHex32(params.manifestCommitment, "manifest commitment"),
      ),
      holderExtensionCommitment: hexToBytes(extensionCommitment),
      totalSupply,
      claimNotBeforeDaaScore: positiveI64(
        params.claimNotBeforeDaaScore,
        "claim-not-before DAA score",
      ),
      kcc20TemplateHash: hexToBytes(expectedTemplateHash),
      kcc20TemplatePrefixLen: BigInt(template.prefix.length),
      kcc20TemplateSuffixLen: BigInt(template.suffix.length),
      tokenCellKas: minimumCell(params.tokenCellKas, "token cell KAS"),
      reserveCellKas: minimumCell(params.reserveCellKas, "reserve cell KAS"),
      bootstrapCellKas: minimumCell(
        params.bootstrapCellKas,
        "bootstrap cell KAS",
      ),
      approvalKey: hexToBytes(
        requireHex32(params.approvalKey ?? params.approvalKeyA, "approval key"),
      ),
      phase: 2n,
      tokenId: hexToBytes(tokenId),
      shardPlanCommitment: hexToBytes(shardPlanCommitment),
      activationDigest: hexToBytes(
        requireHex32(
          params.bootstrapActivationDigest,
          "bootstrap activation digest",
        ),
      ),
      shardCount: BigInt(shards.length),
    };
    const bootstrapScript = buildSnapshotBootstrapScriptForState(
      artifacts.bootstrap,
      bootstrapState,
    );
    const bootstrapAddress = scriptAddress(bootstrapScript, network);
    const bootstrapSource = sourceDescriptor(
      params.bootstrapSource,
      "bootstrap source",
      bootstrapAddress,
    );
    const tokenScript = buildKcc20ScriptForState(artifacts.kcc20, tokenState);
    const tokenAddress = scriptAddress(tokenScript, network);
    const tokenSource = sourceDescriptor(
      params.tokenSource,
      "token source",
      tokenAddress,
    );
    const nextStates = shards.map((shard) => ({
      amount: shard.allocationTotal,
      owner: hexToBytes(shard.controllerId),
      ownerScheme: 4,
      borrowScheme: 0,
      borrowGuard: hexToBytes(ZERO_HASH),
      extensionCommitment: hexToBytes(extensionCommitment),
    }));
    const rpc = rpcFor(network);
    await rpc.connect();
    try {
      const [bootstrapUtxos, tokenUtxos, walletUtxos] = await Promise.all([
        rpc.getUtxosByAddresses({ addresses: [bootstrapAddress] }),
        rpc.getUtxosByAddresses({ addresses: [tokenAddress] }),
        rpc.getUtxosByAddresses({ addresses: [walletAddress] }),
      ]);
      const bootstrapEntry = findExactEntry(
        bootstrapUtxos.entries,
        bootstrapSource,
      );
      assertCovenantSource(bootstrapEntry, {
        covenantId: bootstrapId,
        script: bootstrapScript,
        amount: bootstrapState.bootstrapCellKas,
        label: "reserve activation bootstrap source",
      });
      const tokenEntry = findExactEntry(tokenUtxos.entries, tokenSource);
      assertCovenantSource(tokenEntry, {
        covenantId: tokenId,
        script: tokenScript,
        amount: bootstrapState.tokenCellKas,
        label: "reserve handoff token source",
      });
      const fundingEntry = selectFundingEntry(
        withoutOutpoints(walletUtxos.entries, [
          bootstrapEntry.outpoint,
          tokenEntry.outpoint,
        ]),
        priorityFee() + DEFAULT_CELL_SOMPI * BigInt(shards.length) + 10_000n,
        [],
        params.fundingOutpoint,
      );
      const outputs = nextStates.map(
        (state) =>
          new kaspaWasm.TransactionOutput(
            positiveI64(
              params.reserveCellKas ?? DEFAULT_CELL_SOMPI,
              "reserve cell KAS",
            ),
            kaspaWasm.payToScriptHashScript(
              buildKcc20ScriptForState(artifacts.kcc20, state),
            ),
            new kaspaWasm.CovenantBinding(1, new kaspaWasm.Hash(tokenId)),
          ),
      );
      const outputSompi = outputs.reduce(
        (sum, output) => sum + BigInt(output.value),
        0n,
      );
      const fundingChangeOutputIndex = appendFundingChange(
        outputs,
        [bootstrapEntry, tokenEntry, fundingEntry],
        walletAddress,
        outputSompi,
        priorityFee(),
      );
      const transaction = new kaspaWasm.Transaction({
        version: 1,
        lockTime: 0n,
        inputs: [
          covenantInput(bootstrapEntry, BOOTSTRAP_COMPUTE_BUDGET),
          covenantInput(tokenEntry, KCC20_COMPUTE_BUDGET),
          publicInput(fundingEntry, PUBLIC_INPUT_COMPUTE_BUDGET),
        ],
        outputs,
        subnetworkId: NATIVE_SUBNETWORK_ID,
        gas: 0n,
        payload: "",
      });
      setVersionOneInputMassFields(transaction, PUBLIC_INPUT_COMPUTE_BUDGET);
      transaction.inputs[0].computeBudget = BOOTSTRAP_COMPUTE_BUDGET;
      transaction.inputs[1].computeBudget = KCC20_COMPUTE_BUDGET;
      const bootstrapPrefix = new kaspaWasm.ScriptBuilder();
      for (const field of encodeKcc20StateRecordArrays(nextStates)) {
        bootstrapPrefix.addData(field);
      }
      bootstrapPrefix.addData(template.prefix);
      bootstrapPrefix.addData(template.suffix);
      bootstrapPrefix.addData(dispatchTagFor(artifacts.bootstrap, "activate"));
      transaction.inputs[0].signatureScript = encodeP2sh(
        bootstrapPrefix.drain(),
        bootstrapScript,
      );
      transaction.inputs[1].signatureScript = encodeP2sh(
        buildKcc20TransferSigScript(kaspaWasm, artifacts.kcc20, {
          nextStates,
          witness: Uint8Array.of(0),
        }),
        tokenScript,
      );
      const scripts = [];
      const adjusted = transactionWithCalculatedFeeChange(
        kaspaWasm,
        transaction,
        fundingChangeOutputIndex,
        network,
        "snapshot reserve handoff",
        scripts,
      );
      return outputEnvelope(adjusted, [{ index: 2 }], scripts, {
        migrationId,
        stage: "reserve-handoff",
        tokenId,
        bootstrapId,
        bootstrapState: {
          ...bootstrapStateReceipt(bootstrapState),
          phase: "ACTIVATED",
        },
        shardPlanCommitment,
        activationDigest: bytesToHex(bootstrapState.activationDigest),
        shards: shards.map((shard) => shard.shardIndex),
        maximumFeeSompi: feeOf(adjusted).toString(),
        intentInputs: [
          {
            role: "snapshot-bootstrap",
            index: 0,
            covenantId: bootstrapId,
            revealScriptHex: bytesToHex(bootstrapScript),
            staticSignatureScriptHex: signatureScriptHex(adjusted, 0),
          },
          {
            role: "fixed-supply-token",
            index: 1,
            covenantId: tokenId,
            revealScriptHex: bytesToHex(tokenScript),
            staticSignatureScriptHex: signatureScriptHex(adjusted, 1),
          },
          { role: "creator-funding", index: 2 },
        ],
        intentOutputs: shards.map((shard, index) => ({
          role: "shard-reserve",
          index,
          shard: shard.shardIndex,
          covenantId: tokenId,
          revealScriptHex: bytesToHex(
            buildKcc20ScriptForState(artifacts.kcc20, nextStates[index]),
          ),
          owner: shard.controllerId,
          ownerScheme: 4,
          borrowScheme: 0,
          borrowGuard: ZERO_HASH,
          extensionCommitment: bytesToHex(
            bootstrapState.holderExtensionCommitment,
          ),
          tokenAmount: shard.allocationTotal.toString(),
        })),
      });
    } finally {
      await rpc.disconnect();
    }
  }

  async function buildClaim(input) {
    const request = input.request || {};
    const params = request.params || {};
    const network = networkOf(request);
    const walletAddress = walletAddressOf(request);
    const owner = requireHex32(request.owner?.kcc20Owner, "claim owner");
    const artifacts = await readPinnedArtifacts(
      params.artifactPins,
      true,
      true,
    );
    const definition = snapshotDefinition(params, artifacts);
    const tokenId = definition.tokenId;
    const controllerId = requireHex32(params.controllerId, "controller id");
    const proof = claimProof(params.proof, definition.shard);
    if (proof.ownerScheme !== 0 && proof.ownerScheme !== 3) {
      throw new Error(
        "snapshot claim builder supports only P2PK Schnorr and P2SH entitlements",
      );
    }
    if (proof.ownerScheme === 0 && proof.owner !== owner) {
      throw new Error("P2PK claim proof owner does not match the wallet owner");
    }
    const p2shAuthority =
      proof.ownerScheme === 3
        ? p2shAuthorityDescriptor(
            params.p2shAuthority,
            proof.owner,
            network,
            "P2SH claim authority",
          )
        : null;
    const currentRoot = requireHex32(params.currentRoot, "current root");
    if (proof.previousRoot !== currentRoot) {
      throw new Error("claim proof is stale for the current shard root");
    }
    assertClaimProofRoots(proof, definition.snapshotContext, currentRoot);
    const currentReserveAmount = positiveI64(
      params.currentReserveAmount,
      "current reserve amount",
    );
    const currentClaimsProcessed = unsignedInteger(
      params.currentClaimsProcessed,
      "current claims processed",
    );
    const allShards = normalizedSignerlessShards(
      params.allShards ?? [params.shard],
    );
    const controllerGenesisPlan = signerlessControllerPlan(
      params,
      artifacts,
      definition.shard,
      allShards,
    );
    const claimPlan = buildSignerlessClaimPlan({
      migrationId: definition.migrationId,
      migrationCommitment: requireHex32(
        params.migrationCommitment ?? params.migrationId,
        "migration commitment",
      ),
      controllerArtifact: artifacts.controller,
      bootstrapArtifact: artifacts.bootstrap,
      kcc20Artifact: artifacts.kcc20,
      controllerId,
      tokenId,
      holderExtensionCommitment: definition.holderExtensionCommitment,
      manifestCommitment: definition.manifestCommitment,
      context: definition.snapshotContext,
      shard: definition.shard,
      shardCount: allShards.length,
      deploymentGuardCommitment:
        controllerGenesisPlan.controllerState.deploymentGuardCommitment,
      currentRoot,
      currentReserveAmount,
      currentClaimsProcessed,
      claim: {
        globalIndex: proof.globalIndex,
        shardLeafIndex: proof.shardLeafIndex,
        ownerScheme: proof.ownerScheme,
        owner: proof.owner,
        amount: proof.amount,
        siblings: proof.siblings,
      },
      controllerCellKas: definition.controllerCellKas,
      reserveCellKas: definition.reserveCellKas,
      recipientMinCellKas: definition.recipientMinCellKas,
      reserveInputCellKas: definition.reserveCellKas,
      claimNotBeforeDaaScore: definition.claimNotBeforeDaaScore,
    });
    const nextReserveAmount = currentReserveAmount - proof.amount;
    const terminal = claimPlan.terminal === true;
    const controllerState = claimPlan.controllerStateBefore;
    const nextControllerState = claimPlan.controllerStateAfter;
    const reserveState = {
      amount: currentReserveAmount,
      owner: hexToBytes(controllerId),
      ownerScheme: 4,
      borrowScheme: 0,
      borrowGuard: hexToBytes(ZERO_HASH),
      extensionCommitment: hexToBytes(definition.holderExtensionCommitment),
    };
    const nextReserveState = terminal
      ? null
      : { ...reserveState, amount: nextReserveAmount };
    const recipientState = {
      amount: proof.amount,
      owner: hexToBytes(proof.owner),
      ownerScheme: proof.ownerScheme,
      borrowScheme: 0,
      borrowGuard: hexToBytes(ZERO_HASH),
      extensionCommitment: hexToBytes(definition.holderExtensionCommitment),
    };
    const controllerScript = buildSignerlessControllerScript(
      artifacts.controller,
      controllerState,
    );
    const reserveScript = buildKcc20ScriptForState(
      artifacts.kcc20,
      reserveState,
    );
    const controllerSource = sourceDescriptor(
      params.controllerSource,
      "controller source",
      scriptAddress(controllerScript, network),
    );
    const reserveSource = sourceDescriptor(
      params.reserveSource,
      "reserve source",
      scriptAddress(reserveScript, network),
    );
    const rpc = rpcFor(network);
    await rpc.connect();
    try {
      const [controllerUtxos, reserveUtxos, walletUtxos, authorityUtxos] =
        await Promise.all([
          rpc.getUtxosByAddresses({ addresses: [controllerSource.address] }),
          rpc.getUtxosByAddresses({ addresses: [reserveSource.address] }),
          rpc.getUtxosByAddresses({ addresses: [walletAddress] }),
          ...(p2shAuthority
            ? [
                rpc.getUtxosByAddresses({
                  addresses: [p2shAuthority.source.address],
                }),
              ]
            : []),
        ]);
      const controllerEntry = findExactEntry(
        controllerUtxos.entries,
        controllerSource,
      );
      const reserveEntry = findExactEntry(reserveUtxos.entries, reserveSource);
      const authorityEntry = p2shAuthority
        ? findExactEntry(authorityUtxos.entries, p2shAuthority.source)
        : null;
      assertCovenantSource(controllerEntry, {
        covenantId: controllerId,
        script: controllerScript,
        amount: definition.controllerCellKas,
        label: "claim controller source",
      });
      assertCovenantSource(reserveEntry, {
        covenantId: tokenId,
        script: reserveScript,
        amount: definition.reserveCellKas,
        label: "claim reserve source",
      });
      if (p2shAuthority && authorityEntry) {
        assertScriptPublicKey(
          authorityEntry,
          p2shAuthority.scriptPublicKeyHex,
          "P2SH claim authority source",
        );
      }
      const fundingEntry = selectFundingEntry(
        withoutOutpoints(walletUtxos.entries, [
          controllerEntry.outpoint,
          reserveEntry.outpoint,
          ...(authorityEntry ? [authorityEntry.outpoint] : []),
        ]),
        priorityFee() + definition.recipientMinCellKas + 10_000n,
        [],
        params.fundingOutpoint,
      );
      const tokenStates = [
        ...(nextReserveState ? [nextReserveState] : []),
        recipientState,
      ];
      const outputs = tokenStates.map((state, index) => {
        const recipientIndex = tokenStates.length - 1;
        const cellKas =
          index === recipientIndex && terminal
            ? definition.reserveCellKas + definition.controllerCellKas
            : index === recipientIndex
              ? definition.recipientMinCellKas
              : definition.reserveCellKas;
        return new kaspaWasm.TransactionOutput(
          cellKas,
          kaspaWasm.payToScriptHashScript(
            buildKcc20ScriptForState(artifacts.kcc20, state),
          ),
          new kaspaWasm.CovenantBinding(1, new kaspaWasm.Hash(tokenId)),
        );
      });
      if (nextControllerState) {
        outputs.push(
          new kaspaWasm.TransactionOutput(
            definition.controllerCellKas,
            kaspaWasm.payToScriptHashScript(
              buildSignerlessControllerScript(
                artifacts.controller,
                nextControllerState,
              ),
            ),
            new kaspaWasm.CovenantBinding(0, new kaspaWasm.Hash(controllerId)),
          ),
        );
      }
      const authorityReturnIndex = authorityEntry ? outputs.length : null;
      if (authorityEntry) {
        outputs.push(
          new kaspaWasm.TransactionOutput(
            utxoAmountSompi(authorityEntry),
            authorityEntry.scriptPublicKey,
          ),
        );
      }
      const outputSompi = outputs.reduce(
        (sum, output) => sum + BigInt(output.value),
        0n,
      );
      const fundingChangeOutputIndex = appendFundingChange(
        outputs,
        [
          controllerEntry,
          reserveEntry,
          ...(authorityEntry ? [authorityEntry] : []),
          fundingEntry,
        ],
        walletAddress,
        outputSompi,
        priorityFee(),
      );
      const transaction = new kaspaWasm.Transaction({
        version: 1,
        lockTime: definition.claimNotBeforeDaaScore,
        inputs: [
          covenantInput(controllerEntry, CONTROLLER_COMPUTE_BUDGET),
          covenantInput(reserveEntry, KCC20_COMPUTE_BUDGET),
          ...(authorityEntry
            ? [publicInput(authorityEntry, PUBLIC_INPUT_COMPUTE_BUDGET)]
            : []),
          publicInput(fundingEntry, PUBLIC_INPUT_COMPUTE_BUDGET),
        ],
        outputs,
        subnetworkId: NATIVE_SUBNETWORK_ID,
        gas: 0n,
        payload: "",
      });
      setVersionOneInputMassFields(transaction, PUBLIC_INPUT_COMPUTE_BUDGET);
      transaction.inputs[0].computeBudget = CONTROLLER_COMPUTE_BUDGET;
      transaction.inputs[1].computeBudget = KCC20_COMPUTE_BUDGET;
      for (let index = 2; index < transaction.inputs.length; index += 1) {
        transaction.inputs[index].computeBudget = PUBLIC_INPUT_COMPUTE_BUDGET;
      }
      transaction.inputs[0].sequence = 0n;
      const template = templateParts(artifacts.kcc20);
      const controllerArgs = controllerClaimOrderedArgs({
        controllerArtifact: artifacts.controller,
        proof,
        nextReserveState,
        recipientState,
        template,
        ownerWitness:
          proof.ownerScheme === 3
            ? dataArg(Uint8Array.of(2))
            : { type: "signature" },
      });
      const controllerScriptHint = {
        inputIndex: 0,
        scriptHex: bytesToHex(controllerScript),
        signatureScript: { mode: "ordered-args", args: controllerArgs },
      };
      const reservePrefix = buildKcc20TransferSigScript(
        kaspaWasm,
        artifacts.kcc20,
        {
          nextStates: tokenStates,
          witness: Uint8Array.of(0),
        },
      );
      transaction.inputs[1].signatureScript = encodeP2sh(
        reservePrefix,
        reserveScript,
      );
      if (p2shAuthority && authorityEntry) {
        transaction.inputs[2].signatureScript = encodeP2sh(
          p2shAuthority.unlockPrefix,
          p2shAuthority.revealScript,
        );
      }
      const adjusted = transactionWithCalculatedFeeChange(
        kaspaWasm,
        transaction,
        fundingChangeOutputIndex,
        network,
        "snapshot claim",
        [controllerScriptHint],
      );
      const recipientIndex = tokenStates.length - 1;
      const reserveOutput = nextReserveState
        ? {
            role: "reserve-successor",
            index: 0,
            covenantId: tokenId,
            revealScriptHex: bytesToHex(
              buildKcc20ScriptForState(artifacts.kcc20, nextReserveState),
            ),
            owner: controllerId,
            ownerScheme: 4,
            borrowScheme: 0,
            borrowGuard: ZERO_HASH,
            extensionCommitment: definition.holderExtensionCommitment,
            tokenAmount: nextReserveAmount.toString(),
          }
        : null;
      const recipientOutput = {
        role: "recipient",
        index: recipientIndex,
        covenantId: tokenId,
        revealScriptHex: bytesToHex(
          buildKcc20ScriptForState(artifacts.kcc20, recipientState),
        ),
        owner: proof.owner,
        ownerScheme: proof.ownerScheme,
        borrowScheme: 0,
        borrowGuard: ZERO_HASH,
        extensionCommitment: definition.holderExtensionCommitment,
        tokenAmount: proof.amount.toString(),
      };
      const controllerOutput = nextControllerState
        ? {
            role: "controller-successor",
            index: tokenStates.length,
            covenantId: controllerId,
            revealScriptHex: bytesToHex(
              buildSignerlessControllerScript(
                artifacts.controller,
                nextControllerState,
              ),
            ),
          }
        : null;
      const authorityReturnOutput =
        authorityEntry && p2shAuthority && authorityReturnIndex !== null
          ? {
              role: "p2sh-authority-return",
              index: authorityReturnIndex,
              scriptPublicKey: p2shAuthority.scriptPublicKeyHex,
              valueSompi: utxoAmountSompi(authorityEntry).toString(),
            }
          : null;
      const fundingInputIndex = authorityEntry ? 3 : 2;
      return outputEnvelope(
        adjusted,
        [{ index: fundingInputIndex }],
        [controllerScriptHint],
        {
          migrationId: definition.migrationId,
          stage: "claim",
          tokenId,
          controllerId,
          shard: definition.shard.shardIndex,
          globalIndex: proof.globalIndex,
          terminal,
          recipient: proof.owner,
          recipientOwnerScheme: proof.ownerScheme,
          amount: proof.amount.toString(),
          previousRoot: currentRoot,
          nextRoot: proof.nextRoot,
          maximumFeeSompi: feeOf(adjusted).toString(),
          intentInputs: [
            {
              role: "controller",
              index: 0,
              covenantId: controllerId,
              revealScriptHex: bytesToHex(controllerScript),
            },
            {
              role: "reserve",
              index: 1,
              covenantId: tokenId,
              revealScriptHex: bytesToHex(reserveScript),
              staticSignatureScriptHex: signatureScriptHex(adjusted, 1),
            },
            ...(authorityEntry && p2shAuthority
              ? [
                  {
                    role: "p2sh-authority",
                    index: 2,
                    owner: proof.owner,
                    revealScriptHex: bytesToHex(p2shAuthority.revealScript),
                    scriptPublicKey: p2shAuthority.scriptPublicKeyHex,
                    staticSignatureScriptHex: signatureScriptHex(adjusted, 2),
                  },
                ]
              : []),
          ],
          intentOutputs: [
            ...(reserveOutput ? [reserveOutput] : []),
            recipientOutput,
            ...(controllerOutput ? [controllerOutput] : []),
            ...(authorityReturnOutput ? [authorityReturnOutput] : []),
          ],
        },
      );
    } finally {
      await rpc.disconnect();
    }
  }

  function snapshotDefinition(params, artifacts) {
    const migrationId = requireHex32(params.migrationId, "migration id");
    const tokenId = requireHex32(params.tokenId, "token covenant id");
    const holderExtensionCommitment = requireHex32(
      params.holderExtensionCommitment,
      "holder extension commitment",
    );
    const manifestCommitment = requireHex32(
      params.manifestCommitment,
      "manifest commitment",
    );
    const snapshotContext = requireHex32(
      params.snapshotContext,
      "snapshot context",
    );
    const claimNotBeforeDaaScore = positiveI64(
      params.claimNotBeforeDaaScore,
      "claim-not-before DAA score",
    );
    if (claimNotBeforeDaaScore >= 500_000_000_000n) {
      throw new Error("claim-not-before must use DAA-score locktime mode");
    }
    const shard = snapshotShard(params.shard);
    const controllerCellKas = minimumCell(
      params.controllerCellKas,
      "controller cell KAS",
    );
    const reserveCellKas = minimumCell(
      params.reserveCellKas,
      "reserve cell KAS",
    );
    const recipientMinCellKas = minimumCell(
      params.recipientMinCellKas,
      "recipient minimum cell KAS",
    );
    if (controllerCellKas + reserveCellKas < recipientMinCellKas) {
      throw new Error(
        "terminal cell disposition is below the recipient minimum",
      );
    }
    const template = templateParts(artifacts.kcc20);
    const expectedTemplateHash = requireHex32(
      params.kcc20TemplateHash,
      "KCC20 template hash",
    );
    if (bytesToHex(template.hash) !== expectedTemplateHash) {
      throw new Error("KCC20 template hash does not match the migration pin");
    }
    return {
      migrationId,
      tokenId,
      holderExtensionCommitment,
      manifestCommitment,
      snapshotContext,
      claimNotBeforeDaaScore,
      shard,
      controllerCellKas,
      reserveCellKas,
      recipientMinCellKas,
      kcc20TemplateHash: expectedTemplateHash,
      kcc20TemplatePrefixLen: template.prefix.length,
      kcc20TemplateSuffixLen: template.suffix.length,
    };
  }

  function initialControllerState(definition) {
    return {
      tokenId: hexToBytes(definition.tokenId),
      holderExtensionCommitment: hexToBytes(
        definition.holderExtensionCommitment,
      ),
      manifestCommitment: hexToBytes(definition.manifestCommitment),
      snapshotContext: hexToBytes(definition.snapshotContext),
      kcc20TemplateHash: hexToBytes(definition.kcc20TemplateHash),
      claimNotBeforeDaaScore: definition.claimNotBeforeDaaScore,
      shardIndex: BigInt(definition.shard.shardIndex),
      globalIndexStart: BigInt(definition.shard.globalIndexStart),
      holderCount: BigInt(definition.shard.holderCount),
      treeDepth: BigInt(definition.shard.depth),
      kcc20TemplatePrefixLen: BigInt(definition.kcc20TemplatePrefixLen),
      kcc20TemplateSuffixLen: BigInt(definition.kcc20TemplateSuffixLen),
      controllerCellKas: definition.controllerCellKas,
      reserveCellKas: definition.reserveCellKas,
      recipientMinCellKas: definition.recipientMinCellKas,
      remainingRoot: hexToBytes(definition.shard.initialRoot),
      remainingAmount: definition.shard.allocationTotal,
      claimsProcessed: 0n,
    };
  }

  function buildSnapshotControllerScriptForState(artifact, state) {
    const normalized = normalizeSilverScriptArtifact(artifact);
    const encoded = encodeControllerState(state);
    const start = normalized.state_layout?.start;
    const length = normalized.state_layout?.len;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(length) ||
      encoded.length !== length
    ) {
      throw new Error("snapshot controller artifact state layout is invalid");
    }
    return concatBytes(
      Uint8Array.from(normalized.script).slice(0, start),
      encoded,
      Uint8Array.from(normalized.script).slice(start + length),
    );
  }

  function buildSnapshotBootstrapScriptForState(artifact, state) {
    const normalized = normalizeSilverScriptArtifact(artifact);
    const encoded = encodeBootstrapState(state);
    const start = normalized.state_layout?.start;
    const length = normalized.state_layout?.len;
    if (
      normalized.contract_name !== "KCC20SnapshotBootstrap" ||
      !Number.isInteger(start) ||
      !Number.isInteger(length) ||
      encoded.length !== length
    ) {
      throw new Error("snapshot bootstrap artifact state layout is invalid");
    }
    return concatBytes(
      Uint8Array.from(normalized.script).slice(0, start),
      encoded,
      Uint8Array.from(normalized.script).slice(start + length),
    );
  }

  function encodeBootstrapState(state) {
    return concatBytes(
      pushData(state.migrationCommitment),
      pushData(state.manifestCommitment),
      pushData(state.holderExtensionCommitment),
      pushData(i64(state.totalSupply)),
      pushData(i64(state.claimNotBeforeDaaScore)),
      pushData(state.kcc20TemplateHash),
      pushData(i64(state.kcc20TemplatePrefixLen)),
      pushData(i64(state.kcc20TemplateSuffixLen)),
      pushData(i64(state.tokenCellKas)),
      pushData(i64(state.reserveCellKas)),
      pushData(i64(state.bootstrapCellKas)),
      pushData(state.approvalKey),
      pushData(i64(state.phase)),
      pushData(state.tokenId),
      pushData(state.shardPlanCommitment),
      pushData(state.activationDigest),
      pushData(i64(state.shardCount)),
    );
  }

  function bootstrapStateReceipt(state) {
    return {
      migrationCommitment: bytesToHex(state.migrationCommitment),
      manifestCommitment: bytesToHex(state.manifestCommitment),
      holderExtensionCommitment: bytesToHex(state.holderExtensionCommitment),
      totalSupply: state.totalSupply.toString(),
      claimNotBeforeDaaScore: state.claimNotBeforeDaaScore.toString(),
      kcc20TemplateHash: bytesToHex(state.kcc20TemplateHash),
      kcc20TemplatePrefixLen: state.kcc20TemplatePrefixLen.toString(),
      kcc20TemplateSuffixLen: state.kcc20TemplateSuffixLen.toString(),
      tokenCellKas: state.tokenCellKas.toString(),
      reserveCellKas: state.reserveCellKas.toString(),
      bootstrapCellKas: state.bootstrapCellKas.toString(),
      approvalKey: bytesToHex(state.approvalKey),
      phase: state.phase.toString(),
      tokenId: bytesToHex(state.tokenId),
      shardPlanCommitment: bytesToHex(state.shardPlanCommitment),
      activationDigest: bytesToHex(state.activationDigest),
      shardCount: state.shardCount.toString(),
    };
  }

  function bootstrapBaseState(params, template) {
    const approvalKey = requireHex32(
      params.approvalKey ?? params.approvalKeyA,
      "approval key",
    );
    if (approvalKey === ZERO_HASH) {
      throw new Error("bootstrap approval key must be nonzero");
    }
    const expectedTemplateHash = requireHex32(
      params.kcc20TemplateHash,
      "KCC20 template hash",
    );
    if (bytesToHex(template.hash) !== expectedTemplateHash) {
      throw new Error("KCC20 template hash does not match the migration pin");
    }
    const claimNotBeforeDaaScore = positiveI64(
      params.claimNotBeforeDaaScore,
      "claim-not-before DAA score",
    );
    if (claimNotBeforeDaaScore >= 500_000_000_000n) {
      throw new Error("claim-not-before must use DAA-score locktime mode");
    }
    return {
      migrationCommitment: hexToBytes(
        requireHex32(params.migrationId, "migration ID"),
      ),
      manifestCommitment: hexToBytes(
        requireHex32(params.manifestCommitment, "manifest commitment"),
      ),
      holderExtensionCommitment: hexToBytes(
        requireHex32(
          params.holderExtensionCommitment,
          "holder extension commitment",
        ),
      ),
      totalSupply: positiveI64(params.totalSupply, "total supply"),
      claimNotBeforeDaaScore,
      kcc20TemplateHash: hexToBytes(expectedTemplateHash),
      kcc20TemplatePrefixLen: BigInt(template.prefix.length),
      kcc20TemplateSuffixLen: BigInt(template.suffix.length),
      tokenCellKas: minimumCell(params.tokenCellKas, "token cell KAS"),
      reserveCellKas: minimumCell(params.reserveCellKas, "reserve cell KAS"),
      bootstrapCellKas: minimumCell(
        params.bootstrapCellKas,
        "bootstrap cell KAS",
      ),
      approvalKey: hexToBytes(approvalKey),
    };
  }

  function bootstrapStateArgs(state) {
    return [
      dataArg(state.migrationCommitment),
      dataArg(state.manifestCommitment),
      dataArg(state.holderExtensionCommitment),
      i64Arg(state.totalSupply),
      i64Arg(state.claimNotBeforeDaaScore),
      dataArg(state.kcc20TemplateHash),
      i64Arg(state.kcc20TemplatePrefixLen),
      i64Arg(state.kcc20TemplateSuffixLen),
      i64Arg(state.tokenCellKas),
      i64Arg(state.reserveCellKas),
      i64Arg(state.bootstrapCellKas),
      dataArg(state.approvalKey),
      i64Arg(state.phase),
      dataArg(state.tokenId),
      dataArg(state.shardPlanCommitment),
      dataArg(state.activationDigest),
      i64Arg(state.shardCount),
    ];
  }

  function bootstrapBindArgs(artifacts, nextBootstrapState, tokenState) {
    const template = templateParts(artifacts.kcc20);
    return [
      ...bootstrapStateArgs(nextBootstrapState),
      i64Arg(1),
      i64Arg(0),
      i64Arg(1),
      { type: "approval" },
      dataArg(template.prefix),
      dataArg(template.suffix),
      ...kcc20StateArgs(tokenState),
      dataArg(dispatchTagFor(artifacts.bootstrap, "bindToken")),
    ];
  }

  function bootstrapSealArgs(artifacts, nextBootstrapState) {
    return [
      ...bootstrapStateArgs(nextBootstrapState),
      i64Arg(0),
      { type: "approval" },
      dataArg(dispatchTagFor(artifacts.bootstrap, "seal")),
    ];
  }

  function bootstrapCancellationArgs(
    artifacts,
    bound,
    sinkOutputIndex,
    sinkTokenState,
  ) {
    return [
      { type: "approval" },
      i64Arg(sinkOutputIndex),
      ...(bound
        ? [
            i64Arg(0),
            dataArg(templateParts(artifacts.kcc20).prefix),
            dataArg(templateParts(artifacts.kcc20).suffix),
            ...kcc20StateArgs(sinkTokenState),
          ]
        : []),
      dataArg(
        dispatchTagFor(
          artifacts.bootstrap,
          bound ? "cancelBound" : "cancelUnbound",
        ),
      ),
    ];
  }

  function bootstrapApprovalRecipes(scriptHex, args) {
    const zeroSignature = "00".repeat(65);
    const replace = (dynamicSlot) =>
      args.map((arg) => {
        if (arg.type === dynamicSlot) return { type: "signature" };
        if (arg.type === "approval") {
          return { type: "data", hex: zeroSignature };
        }
        return arg;
      });
    const script = (normalizedArgs) => ({
      inputIndex: 0,
      scriptHex,
      signatureScript: { mode: "ordered-args", args: normalizedArgs },
    });
    return {
      placeholder: { args: replace("none") },
      approval: script(replace("approval")),
    };
  }

  function signatureScriptArgsBytes(args, signature = new Uint8Array(65)) {
    const builder = new kaspaWasm.ScriptBuilder({
      flags: { covenantsEnabled: true },
    });
    for (const arg of args || []) {
      if (arg.type === "i64") {
        builder.addI64(BigInt(arg.value));
      } else if (arg.type === "byte") {
        builder.addData(Uint8Array.of(arg.value));
      } else if (arg.type === "data") {
        builder.addData(hexToBytes(arg.hex));
      } else if (arg.type === "signature") {
        const prefix = hexToBytes(arg.prefixHex || "");
        builder.addData(concatBytes(prefix, signature));
      } else {
        throw new Error(`unsupported snapshot signature argument ${arg.type}`);
      }
    }
    return builder.drain();
  }

  function encodeControllerState(state) {
    return concatBytes(
      pushData(state.tokenId),
      pushData(state.holderExtensionCommitment),
      pushData(state.manifestCommitment),
      pushData(state.snapshotContext),
      pushData(state.kcc20TemplateHash),
      pushData(i64(state.claimNotBeforeDaaScore)),
      pushData(i64(state.shardIndex)),
      pushData(i64(state.globalIndexStart)),
      pushData(i64(state.holderCount)),
      pushData(i64(state.treeDepth)),
      pushData(i64(state.kcc20TemplatePrefixLen)),
      pushData(i64(state.kcc20TemplateSuffixLen)),
      pushData(i64(state.controllerCellKas)),
      pushData(i64(state.reserveCellKas)),
      pushData(i64(state.recipientMinCellKas)),
      pushData(state.remainingRoot),
      pushData(i64(state.remainingAmount)),
      pushData(i64(state.claimsProcessed)),
    );
  }

  function snapshotControllerStateCommitment(state): string {
    return bytesToHex(
      blake2b(
        concatBytes(
          CONTROLLER_STATE_COMMITMENT_DOMAIN,
          encodeControllerState(state),
        ),
        { dkLen: 32 },
      ),
    );
  }

  function controllerClaimOrderedArgs({
    controllerArtifact,
    proof,
    nextReserveState,
    recipientState,
    template,
    ownerWitness,
  }) {
    return [
      i64Arg(proof.globalIndex),
      i64Arg(proof.shardLeafIndex),
      byteArg(proof.ownerScheme),
      dataArg(hexToBytes(proof.owner)),
      ownerWitness,
      i64Arg(proof.amount),
      dataArg(concatBytes(...proof.siblings.map(hexToBytes))),
      ...kcc20StateArgs(nextReserveState),
      ...kcc20StateArgs(recipientState),
      dataArg(template.prefix),
      dataArg(template.suffix),
      dataArg(dispatchTagFor(controllerArtifact, "claim")),
    ];
  }

  function kcc20StateArgs(state) {
    const value =
      state ||
      ({
        amount: 0n,
        owner: hexToBytes(ZERO_HASH),
        ownerScheme: 0,
        borrowScheme: 0,
        borrowGuard: hexToBytes(ZERO_HASH),
        extensionCommitment: hexToBytes(ZERO_HASH),
      } as const);
    return [
      i64Arg(value.amount),
      dataArg(value.owner),
      byteArg(value.ownerScheme),
      byteArg(value.borrowScheme),
      dataArg(value.borrowGuard),
      dataArg(value.extensionCommitment),
    ];
  }

  function outputEnvelope(transaction, signInputs, scripts, metadata) {
    const psktTransactionJson = transaction.serializeToSafeJSON();
    if (typeof psktTransactionJson !== "string") {
      throw new Error("snapshot transaction serialization did not return JSON");
    }
    return {
      schema: OUTPUT_SCHEMA,
      psktTransactionJson,
      signInputs,
      ...(scripts.length ? { scripts } : {}),
      submitTransactionSupported: true,
      metadata,
    };
  }

  async function readPinnedArtifacts(
    pins,
    requireController,
    requireBootstrap = false,
  ) {
    const kcc20 = await readPinnedArtifact(
      KCC20_ARTIFACT_PATH,
      pins?.kcc20ArtifactSha256,
      "KCC20",
    );
    const controller = requireController
      ? await readPinnedArtifact(
          CONTROLLER_ARTIFACT_PATH,
          pins?.controllerArtifactSha256,
          "KCC20SnapshotController",
        )
      : undefined;
    const bootstrap = requireBootstrap
      ? await readPinnedArtifact(
          BOOTSTRAP_ARTIFACT_PATH,
          pins?.bootstrapArtifactSha256,
          "KCC20SnapshotBootstrap",
        )
      : undefined;
    dispatchTagFor(kcc20, "transfer");
    if (controller) dispatchTagFor(controller, "claim");
    if (bootstrap) dispatchTagFor(bootstrap, "start");
    return { kcc20, controller, bootstrap };
  }

  async function readPinnedArtifact(path, expectedHash, contractName) {
    const expected = requireHex32(
      expectedHash,
      `${contractName} artifact hash`,
    );
    let cached = artifactCache.get(path);
    if (!cached) {
      cached = Promise.resolve(
        options.artifacts?.[path] ?? options.artifactProvider?.(path),
      ).then(async (supplied) => {
        if (!supplied)
          throw new Error(`Missing supplied snapshot artifact: ${path}`);
        const envelope =
          supplied && typeof supplied === "object" && !Array.isArray(supplied)
            ? supplied
            : undefined;
        const artifactValue = envelope?.artifact ?? supplied;
        const rawValue = envelope?.rawBytes ?? envelope?.rawText;
        const raw =
          rawValue instanceof Uint8Array
            ? rawValue
            : typeof rawValue === "string"
              ? new TextEncoder().encode(rawValue)
              : typeof supplied === "string"
                ? new TextEncoder().encode(supplied)
                : undefined;
        if (!raw) {
          throw new Error(
            `${contractName} artifact provider must include the exact raw bytes`,
          );
        }
        const parsed =
          typeof artifactValue === "string"
            ? JSON.parse(artifactValue)
            : artifactValue;
        return {
          raw,
          artifact: normalizeSilverScriptArtifact(parsed),
        };
      });
      artifactCache.set(path, cached);
    }
    const value = await cached;
    const actual = bytesToHex(sha256(value.raw));
    if (actual !== expected) {
      throw new Error(
        `${contractName} artifact does not match the migration pin`,
      );
    }
    const artifact = value.artifact;
    if (artifact.contract_name !== contractName) {
      throw new Error(`pinned artifact is not ${contractName}`);
    }
    return artifact;
  }
  function snapshotShard(value) {
    const shard = value || {};
    const normalized = {
      shardIndex: unsignedInteger(shard.shardIndex, "shard index"),
      globalIndexStart: unsignedInteger(
        shard.globalIndexStart,
        "shard global index start",
      ),
      holderCount: unsignedInteger(shard.holderCount, "shard holder count"),
      depth: unsignedInteger(shard.depth, "shard tree depth"),
      allocationTotal: positiveI64(
        shard.allocationTotal,
        "shard allocation total",
      ),
      initialRoot: requireHex32(shard.initialRoot, "shard initial root"),
    };
    if (normalized.holderCount < 1)
      throw new Error("shard must contain holders");
    if (normalized.depth < 1 || normalized.depth > 32) {
      throw new Error("shard tree depth must be 1..32");
    }
    if (normalized.holderCount > 2 ** normalized.depth) {
      throw new Error("shard holder count exceeds its Merkle width");
    }
    return normalized;
  }

  function reserveShards(values, totalSupply) {
    if (!Array.isArray(values) || values.length < 1 || values.length > 8) {
      throw new Error("atomic reserve handoff requires 1..8 shards");
    }
    const indexes = new Set<number>();
    const controllerIds = new Set<string>();
    const shards = values.map((value) => {
      const shardIndex = unsignedInteger(value?.shardIndex, "shard index");
      const controllerId = requireHex32(value?.controllerId, "controller id");
      const allocationTotal = positiveI64(
        value?.allocationTotal,
        "shard allocation total",
      );
      if (indexes.has(shardIndex) || controllerIds.has(controllerId)) {
        throw new Error("reserve handoff shard identities must be unique");
      }
      indexes.add(shardIndex);
      controllerIds.add(controllerId);
      return { shardIndex, controllerId, allocationTotal };
    });
    if (
      shards.reduce((sum, shard) => sum + shard.allocationTotal, 0n) !==
      totalSupply
    ) {
      throw new Error("reserve handoff allocations do not equal total supply");
    }
    return shards.sort((left, right) => left.shardIndex - right.shardIndex);
  }

  function snapshotShardPlanCommitment({
    migrationCommitment,
    manifestCommitment,
    tokenId,
    totalSupply,
    shards,
  }) {
    return bytesToHex(
      blake2b(
        concatBytes(
          Uint8Array.of(0x20),
          hexToBytes(migrationCommitment),
          hexToBytes(manifestCommitment),
          hexToBytes(tokenId),
          i64(totalSupply),
          i64(BigInt(shards.length)),
          ...shards.flatMap((shard, index) => [
            i64(BigInt(index)),
            hexToBytes(shard.controllerId),
            i64(shard.allocationTotal),
          ]),
        ),
        { dkLen: 32 },
      ),
    );
  }

  function claimProof(value, shard) {
    const proof = value || {};
    const normalized = {
      globalIndex: unsignedInteger(proof.globalIndex, "claim global index"),
      shardIndex: unsignedInteger(proof.shardIndex, "claim shard index"),
      shardLeafIndex: unsignedInteger(
        proof.shardLeafIndex,
        "claim shard leaf index",
      ),
      ownerScheme: unsignedInteger(proof.ownerScheme, "claim owner scheme"),
      owner: requireHex32(proof.owner, "claim owner"),
      amount: positiveI64(proof.amount, "claim amount"),
      siblings: Array.isArray(proof.siblings)
        ? proof.siblings.map((value) => requireHex32(value, "proof sibling"))
        : [],
      previousRoot: requireHex32(proof.previousRoot, "proof previous root"),
      nextRoot: requireHex32(proof.nextRoot, "proof next root"),
    };
    if (
      normalized.shardIndex !== shard.shardIndex ||
      normalized.globalIndex !==
        shard.globalIndexStart + normalized.shardLeafIndex ||
      normalized.shardLeafIndex >= shard.holderCount ||
      normalized.siblings.length !== shard.depth
    ) {
      throw new Error("claim proof identity does not match the shard");
    }
    return normalized;
  }

  function assertClaimProofRoots(proof, snapshotContext, currentRoot) {
    const context = hexToBytes(snapshotContext);
    const entitlement = hashMerkle(
      Uint8Array.of(0x10),
      context,
      leI64(proof.globalIndex),
      Uint8Array.of(proof.ownerScheme),
      hexToBytes(proof.owner),
      leI64(proof.amount),
    );
    const claimed = hashMerkle(
      Uint8Array.of(0x12),
      context,
      leI64(proof.globalIndex),
    );
    const current = foldMerkle(
      entitlement,
      proof.siblings,
      proof.shardLeafIndex,
    );
    const next = foldMerkle(claimed, proof.siblings, proof.shardLeafIndex);
    if (bytesToHex(current) !== currentRoot) {
      throw new Error(
        "claim proof does not reconstruct the current shard root",
      );
    }
    if (bytesToHex(next) !== proof.nextRoot) {
      throw new Error("claim proof next root does not match leaf retirement");
    }
  }

  function foldMerkle(start, siblings, leafIndex) {
    let node = Uint8Array.from(start);
    let cursor = leafIndex;
    for (const siblingHex of siblings) {
      const sibling = hexToBytes(siblingHex);
      node =
        cursor % 2 === 0
          ? hashMerkle(Uint8Array.of(0x11), node, sibling)
          : hashMerkle(Uint8Array.of(0x11), sibling, node);
      cursor >>= 1;
    }
    return node;
  }

  function hashMerkle(...parts) {
    return Uint8Array.from(blake2b(concatBytes(...parts), { dkLen: 32 }));
  }

  function leI64(value) {
    let cursor = BigInt(value);
    const bytes = new Uint8Array(8);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number(cursor & 0xffn);
      cursor >>= 8n;
    }
    return bytes;
  }

  function kcc20State(value) {
    return {
      amount: positiveI64(value?.amount, "KCC20 amount"),
      owner: hexToBytes(requireHex32(value?.owner, "KCC20 owner")),
      ownerScheme: unsignedInteger(value?.ownerScheme, "KCC20 owner scheme"),
      borrowScheme: unsignedInteger(
        value?.borrowScheme ?? 0,
        "KCC20 borrow scheme",
      ),
      borrowGuard: hexToBytes(
        requireHex32(value?.borrowGuard ?? ZERO_HASH, "KCC20 borrow guard"),
      ),
      extensionCommitment: hexToBytes(
        requireHex32(value?.extensionCommitment, "KCC20 extension commitment"),
      ),
    };
  }

  function sourceDescriptor(value, label, derivedAddress) {
    const txid = requireHex32(value?.txidHex, `${label} txid`);
    const vout = unsignedInteger(value?.vout, `${label} vout`);
    if (vout > MAX_U32) {
      throw new Error(`${label} vout must fit in uint32`);
    }
    const suppliedAddress = String(value?.address || "")
      .trim()
      .toLowerCase();
    const address =
      suppliedAddress || String(derivedAddress || "").toLowerCase();
    if (!/^(?:kaspa|kaspatest):[a-z0-9]{40,100}$/.test(address)) {
      throw new Error(`${label} address is invalid`);
    }
    if (
      suppliedAddress &&
      derivedAddress &&
      suppliedAddress !== derivedAddress
    ) {
      throw new Error(`${label} address does not match reconstructed state`);
    }
    return { txid, vout, address };
  }

  function findExactEntry(entries, source) {
    const entry = (entries || []).find(
      (candidate) =>
        String(candidate.outpoint?.transactionId).toLowerCase() ===
          source.txid && Number(candidate.outpoint?.index) === source.vout,
    );
    if (!entry)
      throw new Error(`active UTXO ${source.txid}:${source.vout} not found`);
    return entry;
  }

  function assertCovenantId(entry, expected, label) {
    const candidates = [
      entry?.covenantId,
      entry?.entry?.covenantId,
      entry?.utxoEntry?.covenantId,
      entry?.covenant?.covenantId,
      entry?.entry?.covenant?.covenantId,
      entry?.utxoEntry?.covenant?.covenantId,
    ].filter((value) => value !== undefined && value !== null);
    const covenantIds = candidates.map((value) =>
      String(value?.toString?.() ?? value)
        .trim()
        .toLowerCase(),
    );
    if (covenantIds.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
      throw new Error(`${label} covenant ID is malformed`);
    }
    const unique = [...new Set(covenantIds)];
    if (unique.length > 1) {
      throw new Error(`${label} covenant ID fields conflict`);
    }
    const actual = unique[0] ?? "";
    if (actual !== expected)
      throw new Error(`${label} covenant ID does not match`);
  }

  function assertCovenantSource(entry, { covenantId, script, amount, label }) {
    assertCovenantId(entry, covenantId, label);
    const expectedScriptPublicKey = String(
      kaspaWasm.payToScriptHashScript(script).script,
    ).toLowerCase();
    const actualScriptPublicKey = scriptPublicKeyHex(entry?.scriptPublicKey);
    if (actualScriptPublicKey !== expectedScriptPublicKey) {
      throw new Error(`${label} script public key does not match`);
    }
    if (utxoAmountSompi(entry) !== BigInt(amount)) {
      throw new Error(`${label} cell KAS does not match`);
    }
  }

  function scriptPublicKeyHex(scriptPublicKey) {
    const hex = String(scriptPublicKey?.script ?? scriptPublicKey ?? "")
      .trim()
      .toLowerCase();
    if (!/^(?:[0-9a-f]{2})+$/.test(hex)) {
      throw new Error("snapshot source script public key is malformed");
    }
    return hex;
  }

  function assertScriptPublicKey(entry, expectedHex, label) {
    if (scriptPublicKeyHex(entry?.scriptPublicKey) !== expectedHex) {
      throw new Error(`${label} script public key does not match`);
    }
  }

  function p2shAuthorityDescriptor(value, expectedOwner, network, label) {
    const owner = requireHex32(expectedOwner, `${label} owner`);
    const revealScript = arbitraryBytes(
      value?.revealScriptHex,
      `${label} reveal script`,
    );
    const unlockPrefix = arbitraryBytes(
      value?.unlockPrefixHex ?? "",
      `${label} unlock prefix`,
      true,
    );
    const scriptPublicKey = kaspaWasm.payToScriptHashScript(revealScript);
    const scriptPublicKeyHexValue = scriptPublicKeyHex(scriptPublicKey);
    if (
      !scriptPublicKeyHexValue.match(/^aa20[0-9a-f]{64}87$/) ||
      scriptPublicKeyHexValue.slice(4, 68) !== owner
    ) {
      throw new Error(
        `${label} reveal script does not match the entitlement owner`,
      );
    }
    const address = kaspaWasm
      .addressFromScriptPublicKey(scriptPublicKey, network)
      .toString();
    const source = sourceDescriptor(value?.source, `${label} source`, address);
    return {
      owner,
      revealScript,
      unlockPrefix,
      scriptPublicKeyHex: scriptPublicKeyHexValue,
      source,
    };
  }

  function withoutOutpoints(entries, outpoints) {
    const excluded = new Set(
      outpoints.map(
        (outpoint) =>
          `${String(outpoint?.transactionId).toLowerCase()}:${Number(outpoint?.index)}`,
      ),
    );
    return (entries || []).filter(
      (entry) =>
        !excluded.has(
          `${String(entry.outpoint?.transactionId).toLowerCase()}:${Number(entry.outpoint?.index)}`,
        ),
    );
  }

  function appendFundingChange(
    outputs,
    inputs,
    walletAddress,
    covenantOutputSompi,
    minimumFee,
  ) {
    const inputSompi = inputs.reduce(
      (sum, entry) => sum + utxoAmountSompi(entry),
      0n,
    );
    const change =
      BigInt(inputSompi) - BigInt(covenantOutputSompi) - BigInt(minimumFee);
    if (change <= 10_000n) {
      throw new Error("snapshot builder selected insufficient funding change");
    }
    outputs.push(
      new kaspaWasm.TransactionOutput(
        change,
        kaspaWasm.payToAddressScript(walletAddress),
      ),
    );
    return outputs.length - 1;
  }

  function publicInput(entry, computeBudget) {
    return {
      previousOutpoint: entry.outpoint,
      utxo: entry,
      sequence: 0n,
      sigOpCount: 0,
      computeBudget,
    };
  }

  function covenantInput(entry, computeBudget) {
    return publicInput(entry, computeBudget);
  }

  function encodeP2sh(prefix, script) {
    return kaspaWasm.ScriptBuilder.fromScript(script, {
      flags: { covenantsEnabled: true },
    }).encodePayToScriptHashSignatureScript(prefix);
  }

  function feeOf(transaction) {
    const inputs = [...transaction.inputs].reduce(
      (sum, input) => sum + BigInt(input.utxo?.amount ?? input.utxo?.value),
      0n,
    );
    const outputs = [...transaction.outputs].reduce(
      (sum, output) => sum + BigInt(output.value ?? output.amount),
      0n,
    );
    return inputs - outputs;
  }

  function requiredRecord(value: unknown, label: string) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} is required`);
    }
    return value as Record<string, unknown>;
  }

  function signatureScriptHex(transaction, inputIndex) {
    const json = JSON.parse(transaction.serializeToSafeJSON());
    const value = json?.inputs?.[inputIndex]?.signatureScript;
    if (typeof value !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(value)) {
      throw new Error(
        "snapshot transaction static signature script is invalid",
      );
    }
    return value.toLowerCase();
  }

  function controllerDeploymentPayload(definition, state) {
    return bytesToHex(
      new TextEncoder().encode(
        JSON.stringify({
          tn10: {
            v: 1,
            tmpl: "KCC20SnapshotController",
            migrationId: definition.migrationId,
            manifestCommitment: definition.manifestCommitment,
            shardIndex: definition.shard.shardIndex,
            args: [
              {
                name: "controllerState",
                type: "object",
                value: jsonControllerState(state),
              },
            ],
          },
        }),
      ),
    );
  }

  function jsonControllerState(state) {
    return Object.fromEntries(
      Object.entries(state).map(([key, value]) => [
        key,
        value instanceof Uint8Array
          ? bytesToHex(value)
          : controllerInteger(value, key),
      ]),
    );
  }

  function controllerInteger(value: unknown, key: string): string {
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "bigint" &&
      typeof value !== "boolean"
    ) {
      throw new Error(`controller state ${key} is not an integer`);
    }
    return BigInt(value).toString();
  }

  function scriptAddress(script, network) {
    return kaspaWasm
      .addressFromScriptPublicKey(
        kaspaWasm.payToScriptHashScript(script),
        network,
      )
      .toString();
  }

  function rpcFor(network) {
    return new kaspaWasm.RpcClient({
      url: config.KASPA_WRPC_URL || DEFAULT_WRPC_URL,
      encoding: kaspaWasm.Encoding.Borsh,
      networkId: network,
    });
  }

  function networkOf(request) {
    const network = String(
      request.network || config.KASPA_NETWORK || "testnet-10",
    )
      .trim()
      .toLowerCase();
    if (!/^[a-z0-9-]{2,32}$/.test(network))
      throw new Error("network is invalid");
    return network;
  }

  function walletAddressOf(request) {
    const address = String(request.owner?.walletAddress || "")
      .trim()
      .toLowerCase();
    if (!/^(?:kaspa|kaspatest):[a-z0-9]{40,100}$/.test(address)) {
      throw new Error("authenticated wallet address is invalid");
    }
    return address;
  }

  function priorityFee() {
    return nonnegativeI64(
      config.KCC20_SNAPSHOT_PRIORITY_FEE_SOMPI || DEFAULT_PRIORITY_FEE,
      "snapshot priority fee",
    );
  }

  function minimumCell(value, label) {
    const amount = positiveI64(value ?? DEFAULT_CELL_SOMPI, label);
    if (amount < DEFAULT_CELL_SOMPI) {
      throw new Error(`${label} must be at least ${DEFAULT_CELL_SOMPI}`);
    }
    return amount;
  }

  function positiveI64(value, label) {
    let amount;
    try {
      if (typeof value === "number" && !Number.isSafeInteger(value)) {
        throw new Error("unsafe integer");
      }
      amount = BigInt(value);
    } catch {
      throw new Error(`${label} must be a positive signed 64-bit integer`);
    }
    if (amount <= 0n || amount > MAX_I64) {
      throw new Error(`${label} must be a positive signed 64-bit integer`);
    }
    return amount;
  }

  function nonnegativeI64(value, label) {
    let amount;
    try {
      if (typeof value === "number" && !Number.isSafeInteger(value)) {
        throw new Error("unsafe integer");
      }
      amount = BigInt(value);
    } catch {
      throw new Error(`${label} must be a nonnegative signed 64-bit integer`);
    }
    if (amount < 0n || amount > MAX_I64) {
      throw new Error(`${label} must be a nonnegative signed 64-bit integer`);
    }
    return amount;
  }

  function unsignedInteger(value, label) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new Error(`${label} must be a nonnegative safe integer`);
    }
    return number;
  }

  function dataArg(value) {
    return { type: "data", hex: bytesToHex(Uint8Array.from(value || [])) };
  }

  function arbitraryBytes(value, label, allowEmpty = false) {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (
      (!allowEmpty && normalized.length === 0) ||
      normalized.length % 2 !== 0
    ) {
      throw new Error(`${label} must be complete hexadecimal bytes`);
    }
    if (!/^[0-9a-f]*$/.test(normalized)) {
      throw new Error(`${label} must be complete hexadecimal bytes`);
    }
    return hexToBytes(normalized);
  }

  function byteArg(value) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > 255) {
      throw new Error("signature-script byte argument is invalid");
    }
    return { type: "byte", value: number };
  }

  function i64Arg(value) {
    return { type: "i64", value: BigInt(value).toString() };
  }

  function pushData(value) {
    const bytes = Uint8Array.from(value);
    if (bytes.length > 75)
      throw new Error("controller state push is too large");
    return concatBytes(Uint8Array.of(bytes.length), bytes);
  }

  function i64(value) {
    let cursor = nonnegativeI64(value, "controller state integer");
    const bytes = new Uint8Array(8);
    for (let index = 0; index < 8; index += 1) {
      bytes[index] = Number(cursor & 0xffn);
      cursor >>= 8n;
    }
    return bytes;
  }

  function concatBytes(...values) {
    const arrays = values.map((value) => Uint8Array.from(value));
    const output = new Uint8Array(
      arrays.reduce((sum, value) => sum + value.length, 0),
    );
    let offset = 0;
    for (const value of arrays) {
      output.set(value, offset);
      offset += value.length;
    }
    return output;
  }

  return buildSnapshotMigrationPskt;
}

/** Pure script constructors shared by browser verification and server projections. */
function buildSnapshotControllerScriptForState(artifact, state) {
  const normalized = normalizeSilverScriptArtifact(artifact);
  const encoded = encodePortableControllerState(state);
  const start = normalized.state_layout?.start;
  const length = normalized.state_layout?.len;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(length) ||
    encoded.length !== length
  ) {
    throw new Error("snapshot controller artifact state layout is invalid");
  }
  return portableConcatBytes(
    Uint8Array.from(normalized.script).slice(0, start),
    encoded,
    Uint8Array.from(normalized.script).slice(start + length),
  );
}

function buildSnapshotBootstrapScriptForState(artifact, state) {
  const normalized = normalizeSilverScriptArtifact(artifact);
  const encoded = encodePortableBootstrapState(state);
  const start = normalized.state_layout?.start;
  const length = normalized.state_layout?.len;
  if (
    normalized.contract_name !== "KCC20SnapshotBootstrap" ||
    !Number.isInteger(start) ||
    !Number.isInteger(length) ||
    encoded.length !== length
  ) {
    throw new Error("snapshot bootstrap artifact state layout is invalid");
  }
  return portableConcatBytes(
    Uint8Array.from(normalized.script).slice(0, start),
    encoded,
    Uint8Array.from(normalized.script).slice(start + length),
  );
}

function encodePortableControllerState(state) {
  return portableConcatBytes(
    portablePushData(state.tokenId),
    portablePushData(state.holderExtensionCommitment),
    portablePushData(state.manifestCommitment),
    portablePushData(state.snapshotContext),
    portablePushData(state.kcc20TemplateHash),
    portablePushData(portableI64(state.claimNotBeforeDaaScore)),
    portablePushData(portableI64(state.shardIndex)),
    portablePushData(portableI64(state.globalIndexStart)),
    portablePushData(portableI64(state.holderCount)),
    portablePushData(portableI64(state.treeDepth)),
    portablePushData(portableI64(state.kcc20TemplatePrefixLen)),
    portablePushData(portableI64(state.kcc20TemplateSuffixLen)),
    portablePushData(portableI64(state.controllerCellKas)),
    portablePushData(portableI64(state.reserveCellKas)),
    portablePushData(portableI64(state.recipientMinCellKas)),
    portablePushData(state.remainingRoot),
    portablePushData(portableI64(state.remainingAmount)),
    portablePushData(portableI64(state.claimsProcessed)),
  );
}

function encodePortableBootstrapState(state) {
  return portableConcatBytes(
    portablePushData(state.migrationCommitment),
    portablePushData(state.manifestCommitment),
    portablePushData(state.holderExtensionCommitment),
    portablePushData(portableI64(state.totalSupply)),
    portablePushData(portableI64(state.claimNotBeforeDaaScore)),
    portablePushData(state.kcc20TemplateHash),
    portablePushData(portableI64(state.kcc20TemplatePrefixLen)),
    portablePushData(portableI64(state.kcc20TemplateSuffixLen)),
    portablePushData(portableI64(state.tokenCellKas)),
    portablePushData(portableI64(state.reserveCellKas)),
    portablePushData(portableI64(state.bootstrapCellKas)),
    portablePushData(state.approvalKey ?? state.approvalKeyA),
    portablePushData(portableI64(state.phase)),
    portablePushData(state.tokenId),
    portablePushData(state.shardPlanCommitment),
    portablePushData(state.activationDigest),
    portablePushData(portableI64(state.shardCount)),
  );
}

function portablePushData(value) {
  const bytes = Uint8Array.from(value);
  if (bytes.length > 75) throw new Error("snapshot state push is too large");
  return portableConcatBytes(Uint8Array.of(bytes.length), bytes);
}

function portableI64(value) {
  let cursor = BigInt(value);
  if (cursor < 0n || cursor > 9_223_372_036_854_775_807n) {
    throw new Error("snapshot state integer is outside signed i64 range");
  }
  const bytes = new Uint8Array(8);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number(cursor & 0xffn);
    cursor >>= 8n;
  }
  return bytes;
}

function portableConcatBytes(...values) {
  const arrays = values.map((value) => Uint8Array.from(value));
  const output = new Uint8Array(
    arrays.reduce((sum, value) => sum + value.length, 0),
  );
  let offset = 0;
  for (const value of arrays) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}
