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
      totalSupply: positiveWideAmount(params.totalSupply, "total supply"),
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

  function positiveWideAmount(value, label) {
    let amount;
    try {
      if (typeof value === "number" && !Number.isSafeInteger(value)) {
        throw new Error("unsafe integer");
      }
      amount = BigInt(value);
    } catch {
      throw new Error(`${label} must be a positive unsigned two-limb integer`);
    }
    if (amount <= 0n || amount > (1n << 126n) - 1n) {
      throw new Error(`${label} must be a positive unsigned two-limb integer`);
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
