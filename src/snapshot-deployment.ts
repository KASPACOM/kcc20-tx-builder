import { bytesToHex, asciiToBytes32 } from "./encoding.js";
import { assertKcc20ArtifactScriptHash } from "./artifacts.js";
import {
  buildControllerGenesisPlan, buildBootstrapGenesisPlan,
  buildSnapshotStartPlan, buildSnapshotTokenMetadata, snapshotPeerPlanCommitment,
} from "./snapshot-signerless.js";
import { deriveSnapshotTokenId } from "./snapshot-signerless-transactions.js";

export const SNAPSHOT_DEPLOYMENT_PROTOCOL = "signerless-start-v2" as const;
// A covenant UTXO occupies two Toccata storage units. Two KAS keeps all
// sixteen covenant outputs at the supported eight-shard maximum safely below
// the 500k persistent-storage mass limit; 0.5 KAS does not.
export const SNAPSHOT_DEPLOYMENT_CELL_SOMPI = 200_000_000n;
export interface SnapshotDeploymentShard {
  shardIndex: number;
  globalIndexStart: number;
  holderCount: number;
  depth: number;
  allocationTotal: string;
  initialRoot: string;
  controllerId?: string;
  genesisOutpoint?: { transactionId: string; index: number };
}
export interface SnapshotDeploymentDefinition {
  migrationId: string;
  manifestCommitment: string;
  context: string;
  creator: string;
  ticker: string;
  displayScale: string;
  totalSupply: string;
  claimNotBeforeDaaScore: string;
  shards: SnapshotDeploymentShard[];
  /** Exact committed controller, reserve and bootstrap principal; defaults to 2 KAS. */
  cellSompi?: string;
  bootstrapId?: string;
  bootstrapOutpoint?: { transactionId: string; index: number };
}
export interface SnapshotArtifacts {
  controllerArtifact: any;
  bootstrapArtifact: any;
  kcc20Artifact: any;
}

/** Pure deterministic planning. IDs must come from independently confirmed genesis outputs. */
export function prepareSnapshotDeployment(kw: any, definition: SnapshotDeploymentDefinition, artifacts: SnapshotArtifacts) {
  assertKcc20ArtifactScriptHash("KCC20.placeholder.json", artifacts.kcc20Artifact);
  assertKcc20ArtifactScriptHash("KCC20SnapshotBootstrap.placeholder.json", artifacts.bootstrapArtifact);
  assertKcc20ArtifactScriptHash("KCC20SnapshotController.placeholder.json", artifacts.controllerArtifact);
  const rawCell = definition.cellSompi === undefined
    ? SNAPSHOT_DEPLOYMENT_CELL_SOMPI.toString() : definition.cellSompi;
  if (typeof rawCell !== "string" || !/^[1-9][0-9]*$/.test(rawCell)) {
    throw new Error("snapshot cellSompi must be a canonical positive integer");
  }
  const cellSompi = BigInt(rawCell);
  if (cellSompi < 50_000_000n || cellSompi > 9_223_372_036_854_775_807n) {
    throw new Error("snapshot cellSompi must be at least 0.5 KAS and fit signed 64 bits");
  }
  const shards = [...definition.shards].sort((a, b) => a.shardIndex - b.shardIndex);
  if (!shards.length || shards.length > 8 || shards.some((s, i) => s.shardIndex !== i)) {
    throw new Error("snapshot requires 1..8 contiguous shards");
  }
  if (shards.reduce((sum, shard) => sum + BigInt(shard.allocationTotal), 0n) !== BigInt(definition.totalSupply)) {
    throw new Error("shard allocations do not equal fixed token supply");
  }
  const extension = {
    kind: BigInt(definition.totalSupply) > 9_223_372_036_854_775_807n ? 2 : 1,
    creator: definition.creator, ticker: bytesToHex(asciiToBytes32(definition.ticker)),
    name: bytesToHex(asciiToBytes32(definition.ticker)), displayScale: definition.displayScale,
    maxSupply: definition.totalSupply, mintLaneCount: 1, mintPolicy: 0, mintPriceSompi: "0",
    treasury: definition.creator, protocolFeeRecipient: definition.creator, protocolFeeBps: "0",
  };
  const metadata = buildSnapshotTokenMetadata({
    ...extension, migrationId: definition.migrationId, totalAllocation: definition.totalSupply,
  } as any);
  const common = {
    ...artifacts, migrationId: definition.migrationId, migrationCommitment: definition.migrationId,
    manifestCommitment: definition.manifestCommitment, context: definition.context,
    holderExtensionCommitment: metadata.holderExtensionCommitment,
    claimNotBeforeDaaScore: definition.claimNotBeforeDaaScore, shardCount: shards.length,
    controllerCellKas: cellSompi,
    reserveCellKas: cellSompi,
  };
  const placeholder = "01".repeat(32);
  const controllerPlans = shards.map(shard => buildControllerGenesisPlan({
    ...common, shard, deploymentGuardCommitment: shard.shardIndex === 0 ? placeholder : "00".repeat(32),
  } as any));
  const peerPending = shards.slice(1).find(s => !s.controllerId || !s.genesisOutpoint);
  if (peerPending) return {
    stage: "controller-deploy" as const, shard: peerPending.shardIndex,
    plan: controllerPlans[peerPending.shardIndex], holderExtensionCommitment: metadata.holderExtensionCommitment,
    extension,
  };
  const peerCommitment = snapshotPeerPlanCommitment({
    migrationCommitment: definition.migrationId, manifestCommitment: definition.manifestCommitment,
    shards: shards.map((shard, i) => ({ controllerId: shard.controllerId ?? placeholder, state: controllerPlans[i].controllerState })),
  });
  controllerPlans[0] = buildControllerGenesisPlan({
    ...common, shard: shards[0], deploymentGuardCommitment: peerCommitment,
  } as any);
  if (!shards[0].controllerId || !shards[0].genesisOutpoint) return {
    stage: "controller-deploy" as const, shard: 0, plan: controllerPlans[0],
    holderExtensionCommitment: metadata.holderExtensionCommitment, extension,
  };
  const committedShards = shards.map((shard, i) => ({ controllerId: shard.controllerId!, state: controllerPlans[i].controllerState }));
  const reserves = shards.map(shard => ({
    amount: shard.allocationTotal, owner: shard.controllerId!, ownerScheme: 4,
    borrowScheme: 0, borrowGuard: "00".repeat(32), extensionCommitment: metadata.holderExtensionCommitment,
  }));
  const tokenId = deriveSnapshotTokenId(kw, {
    controllerGenesisOutpoint: shards[0].genesisOutpoint, reserves, kcc20Artifact: artifacts.kcc20Artifact,
    reserveCellKas: cellSompi,
  });
  const bootstrapPlan = buildBootstrapGenesisPlan({
    ...common, expectedTokenId: tokenId, totalSupply: definition.totalSupply, shards: committedShards,
    bootstrapCellKas: cellSompi,
  } as any);
  return {
    stage: definition.bootstrapId ? "snapshot-start" as const : "bootstrap-deploy" as const,
    plan: definition.bootstrapId ? buildSnapshotStartPlan({
      ...artifacts, migrationId: definition.migrationId, bootstrapId: definition.bootstrapId,
      bootstrapState: bootstrapPlan.bootstrapState, shards: committedShards,
    }) : bootstrapPlan,
    tokenId, holderExtensionCommitment: metadata.holderExtensionCommitment,
    extension, controllers: committedShards,
  };
}
