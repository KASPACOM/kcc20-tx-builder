/* Ported from kaspa-covenants d968dca9; parity covered by snapshot tests. */
// @ts-nocheck
import { bytesToHex, hexToBytes } from "./encoding.js";
import { blake2b } from "@noble/hashes/blake2b";
import {
  buildKcc20TransferSigScript,
  dispatchTagFor,
  holderExtensionCommitment,
  templateParts,
} from "./abi.js";

export const SNAPSHOT_CODEC = "kasmelt-snapshot-v2/blake2b256/sharded-full-claim";
export const SNAPSHOT_CONTROLLER_STATE_COMMITMENT_DOMAIN = "kcc20-snapshot-controller-state/v2";
export const OWNER_P2PK_SCHNORR = 0;
export const OWNER_P2PKH_SCHNORR = 1;
export const OWNER_P2PKH_ECDSA = 2;
export const OWNER_P2SH = 3;
export const OWNER_COVENANT_ID = 4;
export const BORROW_DISABLED = 0;
export const MIN_KCC20_CELL_SOMPI = 50_000_000n;
export const MAX_I64 = 9_223_372_036_854_775_807n;
export const MAX_SEQUENCE = 18_446_744_073_709_551_615n;
export const LOCK_TIME_THRESHOLD = 500_000_000_000n;
export const MAX_SNAPSHOT_SHARDS = 8;
export const ZERO_32 = new Uint8Array(32);

const CLAIMABLE_SOURCE_OWNER_SCHEMES = [OWNER_P2PK_SCHNORR, OWNER_P2SH];

export function buildSnapshotTokenMetadata({
  migrationId,
  creator,
  ticker,
  name,
  displayScale,
  totalAllocation,
  treasury = creator,
  protocolFeeRecipient,
  protocolFeeBps = 0n,
}) {
  const amount = positiveI64(totalAllocation, "total allocation");
  const extension = {
    kind: 1,
    creator: bytes32(creator, "creator"),
    ticker: bytes32(ticker, "ticker"),
    name: bytes32(name, "name"),
    displayScale: positiveI64(displayScale, "display scale"),
    maxSupply: amount,
    mintLaneCount: 1,
    mintPolicy: 0,
    mintPriceSompi: 0n,
    treasury: bytes32(treasury, "treasury"),
    protocolFeeRecipient: bytes32(protocolFeeRecipient, "protocol fee recipient"),
    protocolFeeBps: nonnegativeI64(protocolFeeBps, "protocol fee bps"),
  };
  if (extension.protocolFeeBps > 10_000n) throw new Error("protocol fee bps exceeds 10000");
  return operation("snapshot-token-metadata", migrationId, {
    totalSupply: amount.toString(),
    holderExtensionCommitment: hex(holderExtensionCommitment(extension)),
    mintPolicy: "fixed_supply",
  });
}

export function buildControllerGenesisPlan({
  migrationId,
  migrationCommitment,
  controllerArtifact,
  bootstrapArtifact,
  kcc20Artifact,
  holderExtensionCommitment: extensionCommitment,
  manifestCommitment,
  context,
  shard,
  shardCount,
  deploymentGuardCommitment = ZERO_32,
  controllerCellKas = MIN_KCC20_CELL_SOMPI,
  reserveCellKas = MIN_KCC20_CELL_SOMPI,
  recipientMinCellKas = MIN_KCC20_CELL_SOMPI,
  claimNotBeforeDaaScore,
}) {
  requireArtifacts({ controllerArtifact, bootstrapArtifact, kcc20Artifact });
  const normalizedShard = normalizeShard(shard);
  const count = boundedShardCount(shardCount);
  if (normalizedShard.shardIndex >= count) throw new Error("shard index must be below shard count");
  const guard = bytes32(deploymentGuardCommitment, "deployment guard commitment");
  if ((normalizedShard.shardIndex === 0) === equalBytes(guard, ZERO_32)) {
    throw new Error("only shard zero must commit to the nonzero peer deployment plan");
  }
  const kcc20Template = templateParts(kcc20Artifact);
  const bootstrapTemplate = templateParts(bootstrapArtifact);
  const cells = validateCells({ controllerCellKas, reserveCellKas, recipientMinCellKas });
  const state = normalizeControllerState({
    migrationId: migrationCommitment,
    tokenId: ZERO_32,
    holderExtensionCommitment: extensionCommitment,
    manifestCommitment,
    snapshotContext: context,
    kcc20TemplateHash: kcc20Template.hash,
    bootstrapTemplateHash: bootstrapTemplate.hash,
    deploymentGuardCommitment: guard,
    claimNotBeforeDaaScore: claimActivation(claimNotBeforeDaaScore).lockTime,
    shardIndex: normalizedShard.shardIndex,
    globalIndexStart: normalizedShard.globalIndexStart,
    holderCount: normalizedShard.holderCount,
    treeDepth: normalizedShard.depth,
    kcc20TemplatePrefixLen: kcc20Template.prefix.length,
    kcc20TemplateSuffixLen: kcc20Template.suffix.length,
    bootstrapTemplatePrefixLen: bootstrapTemplate.prefix.length,
    bootstrapTemplateSuffixLen: bootstrapTemplate.suffix.length,
    shardCount: count,
    ...cells,
    remainingRoot: normalizedShard.initialRoot,
    remainingAmount: normalizedShard.allocationTotal,
    claimsProcessed: 0n,
  }, false);
  return operation("snapshot-controller-genesis-plan", migrationId, {
    contract: "KCC20SnapshotController",
    entrypoint: "genesis",
    controllerState: serializeState(state),
    controllerStateCommitment: snapshotControllerStateCommitment(state),
    shard: serializeShard(normalizedShard),
    ...serializeCells(cells),
  });
}

export function snapshotPeerPlanCommitment({ migrationCommitment, manifestCommitment, shards }) {
  const normalized = normalizeStartShards(shards, false);
  return hash256(
    Uint8Array.of(0x21),
    bytes32(migrationCommitment, "migration commitment"),
    bytes32(manifestCommitment, "manifest commitment"),
    leI64(normalized.length),
    ...normalized.slice(1).flatMap(shardPlanParts),
  );
}

export function snapshotStartPlanCommitment({
  migrationCommitment,
  manifestCommitment,
  holderExtensionCommitment: extensionCommitment,
  tokenId,
  totalSupply,
  claimNotBeforeDaaScore,
  shards,
}) {
  const normalized = normalizeStartShards(shards, false);
  return hash256(
    Uint8Array.of(0x22),
    bytes32(migrationCommitment, "migration commitment"),
    bytes32(manifestCommitment, "manifest commitment"),
    bytes32(extensionCommitment, "holder extension commitment"),
    nonzeroBytes32(tokenId, "token id"),
    leI64(positiveI64(totalSupply, "total supply")),
    leI64(claimActivation(claimNotBeforeDaaScore).lockTime),
    leI64(normalized.length),
    ...normalized.flatMap(shardPlanParts),
  );
}

export function buildBootstrapGenesisPlan({
  migrationId,
  migrationCommitment,
  bootstrapArtifact,
  controllerArtifact,
  kcc20Artifact,
  manifestCommitment,
  holderExtensionCommitment: extensionCommitment,
  totalSupply,
  claimNotBeforeDaaScore,
  expectedTokenId,
  shards,
  reserveCellKas = MIN_KCC20_CELL_SOMPI,
  controllerCellKas = MIN_KCC20_CELL_SOMPI,
  bootstrapCellKas = MIN_KCC20_CELL_SOMPI,
}) {
  requireArtifacts({ controllerArtifact, bootstrapArtifact, kcc20Artifact });
  const normalized = normalizeStartShards(shards, false);
  const migration = nonzeroBytes32(migrationCommitment, "migration commitment");
  const manifest = nonzeroBytes32(manifestCommitment, "manifest commitment");
  const extension = nonzeroBytes32(extensionCommitment, "holder extension commitment");
  const token = nonzeroBytes32(expectedTokenId, "expected token id");
  const supply = positiveI64(totalSupply, "total supply");
  const activation = claimActivation(claimNotBeforeDaaScore).lockTime;
  const bootstrapTemplate = templateParts(bootstrapArtifact);
  validateStartShards(normalized, {
    migrationId: migration,
    manifestCommitment: manifest,
    holderExtensionCommitment: extension,
    totalSupply: supply,
    claimNotBeforeDaaScore: activation,
    bootstrapTemplateHash: bootstrapTemplate.hash,
    bootstrapTemplatePrefixLen: bootstrapTemplate.prefix.length,
    bootstrapTemplateSuffixLen: bootstrapTemplate.suffix.length,
    controllerCellKas,
    reserveCellKas,
  });
  const peerPlanCommitment = snapshotPeerPlanCommitment({
    migrationCommitment: migration,
    manifestCommitment: manifest,
    shards: normalized,
  });
  if (!equalBytes(normalized[0].state.deploymentGuardCommitment, peerPlanCommitment)) {
    throw new Error("shard-zero controller does not commit to the exact peer controller plan");
  }
  const startPlanCommitment = snapshotStartPlanCommitment({
    migrationCommitment: migration,
    manifestCommitment: manifest,
    holderExtensionCommitment: extension,
    tokenId: token,
    totalSupply: supply,
    claimNotBeforeDaaScore: activation,
    shards: normalized,
  });
  const kcc20Template = templateParts(kcc20Artifact);
  const controllerTemplate = templateParts(controllerArtifact);
  const state = normalizeBootstrapState({
    migrationId: migration,
    manifestCommitment: manifest,
    holderExtensionCommitment: extension,
    totalSupply: supply,
    claimNotBeforeDaaScore: activation,
    expectedTokenId: token,
    kcc20TemplateHash: kcc20Template.hash,
    kcc20TemplatePrefixLen: kcc20Template.prefix.length,
    kcc20TemplateSuffixLen: kcc20Template.suffix.length,
    controllerTemplateHash: controllerTemplate.hash,
    controllerTemplatePrefixLen: controllerTemplate.prefix.length,
    controllerTemplateSuffixLen: controllerTemplate.suffix.length,
    bootstrapTemplateHash: bootstrapTemplate.hash,
    bootstrapTemplatePrefixLen: bootstrapTemplate.prefix.length,
    bootstrapTemplateSuffixLen: bootstrapTemplate.suffix.length,
    reserveCellKas,
    controllerCellKas,
    bootstrapCellKas,
    shardCount: normalized.length,
    peerPlanCommitment,
    startPlanCommitment,
  });
  return operation("snapshot-bootstrap-genesis-plan", migrationId, {
    contract: "KCC20SnapshotBootstrap",
    entrypoint: "genesis",
    bootstrapState: serializeState(state),
    bootstrapCellKas: state.bootstrapCellKas.toString(),
    tokenId: hex(token),
  });
}

export function buildSnapshotStartPlan({
  migrationId,
  bootstrapArtifact,
  controllerArtifact,
  kcc20Artifact,
  bootstrapId,
  bootstrapState,
  shards,
}) {
  requireArtifacts({ controllerArtifact, bootstrapArtifact, kcc20Artifact });
  const state = normalizeBootstrapState(bootstrapState);
  const normalized = normalizeStartShards(shards, false);
  validateStartShards(normalized, state);
  const peer = snapshotPeerPlanCommitment({
    migrationCommitment: state.migrationId,
    manifestCommitment: state.manifestCommitment,
    shards: normalized,
  });
  const start = snapshotStartPlanCommitment({
    migrationCommitment: state.migrationId,
    manifestCommitment: state.manifestCommitment,
    holderExtensionCommitment: state.holderExtensionCommitment,
    tokenId: state.expectedTokenId,
    totalSupply: state.totalSupply,
    claimNotBeforeDaaScore: state.claimNotBeforeDaaScore,
    shards: normalized,
  });
  if (!equalBytes(peer, state.peerPlanCommitment)
    || !equalBytes(start, state.startPlanCommitment)
    || !equalBytes(normalized[0].state.deploymentGuardCommitment, peer)) {
    throw new Error("controllers do not match the immutable bootstrap start commitments");
  }
  return operation("snapshot-start-plan", migrationId, {
    contract: "KCC20SnapshotBootstrap",
    entrypoint: "start",
    approvalPolicy: "permissionless-exact-commitment",
    bootstrapId: hex(nonzeroBytes32(bootstrapId, "bootstrap covenant id")),
    bootstrapState: serializeState(state),
    bootstrapCellKas: state.bootstrapCellKas.toString(),
    controllerCellKas: state.controllerCellKas.toString(),
    reserveCellKas: state.reserveCellKas.toString(),
    tokenId: hex(state.expectedTokenId),
    controllers: normalized.map((shard) => ({
      controllerId: hex(shard.controllerId),
      stateBefore: serializeState(shard.state),
      stateAfter: serializeState({ ...shard.state, tokenId: state.expectedTokenId }),
    })),
    reserves: normalized.map((shard) => serializeKcc20State(kcc20State(
      shard.state.remainingAmount,
      shard.controllerId,
      OWNER_COVENANT_ID,
      state.holderExtensionCommitment,
    ))),
    bootstrapSuccessor: null,
  });
}

export function buildSnapshotStartSignatureScripts(kw, {
  plan,
  bootstrapArtifact,
  controllerArtifact,
  kcc20Artifact,
  bootstrapInputIndex = 0,
  controllerInputStart = 1,
}) {
  requireArtifacts({ controllerArtifact, bootstrapArtifact, kcc20Artifact });
  if (plan?.kind !== "snapshot-start-plan") throw new Error("snapshot start plan is required");
  const controllers = plan.controllers.map((entry) => normalizeControllerState(entry.stateAfter, true));
  const reserves = plan.reserves.map(normalizeKcc20State);
  const kcc20Template = templateParts(kcc20Artifact);
  const controllerTemplate = templateParts(controllerArtifact);
  const bootstrapBuilder = new kw.ScriptBuilder({ flags: { covenantsEnabled: true } });
  for (const field of encodeControllerStateRecordArrays(controllers)) bootstrapBuilder.addData(field);
  for (const field of encodeKcc20StateRecordArrays(reserves)) bootstrapBuilder.addData(field);
  bootstrapBuilder.addData(kcc20Template.prefix);
  bootstrapBuilder.addData(kcc20Template.suffix);
  bootstrapBuilder.addData(controllerTemplate.prefix);
  bootstrapBuilder.addData(controllerTemplate.suffix);
  bootstrapBuilder.addData(dispatchTagFor(bootstrapArtifact, "start"));
  const controllerSignatureScripts = controllers.map((state, index) => {
    const builder = new kw.ScriptBuilder({ flags: { covenantsEnabled: true } });
    addControllerState(builder, state);
    builder.addI64(BigInt(bootstrapInputIndex));
    builder.addI64(BigInt(index));
    builder.addI64(BigInt(controllers.length + index));
    addKcc20State(builder, reserves[index]);
    builder.addData(kcc20Template.prefix);
    builder.addData(kcc20Template.suffix);
    builder.addData(dispatchTagFor(controllerArtifact, "start"));
    return { inputIndex: controllerInputStart + index, signatureScript: builder.drain() };
  });
  return { bootstrapSignatureScript: bootstrapBuilder.drain(), controllerSignatureScripts };
}

export function buildClaimPlan({
  migrationId,
  migrationCommitment,
  controllerArtifact,
  bootstrapArtifact,
  kcc20Artifact,
  controllerId,
  tokenId,
  holderExtensionCommitment: extensionCommitment,
  manifestCommitment,
  context,
  shard,
  shardCount,
  deploymentGuardCommitment = ZERO_32,
  currentRoot,
  currentReserveAmount,
  currentClaimsProcessed,
  claim,
  controllerCellKas,
  reserveCellKas,
  recipientMinCellKas = MIN_KCC20_CELL_SOMPI,
  reserveInputCellKas = reserveCellKas,
  claimNotBeforeDaaScore,
  lockTime = claimNotBeforeDaaScore,
  controllerInputSequence = 0n,
}) {
  requireArtifacts({ controllerArtifact, bootstrapArtifact, kcc20Artifact });
  const normalizedShard = normalizeShard(shard);
  const count = boundedShardCount(shardCount);
  const cells = validateCells({ controllerCellKas, reserveCellKas, recipientMinCellKas });
  const activation = claimActivation(claimNotBeforeDaaScore, lockTime, controllerInputSequence);
  if (nonnegativeI64(reserveInputCellKas, "reserve input cell KAS") !== cells.reserveCellKas) {
    throw new Error("reserve input cell KAS does not match the controller binding");
  }
  const result = transitionClaim({ context, shard: normalizedShard, currentRoot, currentReserveAmount, claim });
  const claimsProcessed = nonnegativeI64(currentClaimsProcessed, "current claims processed");
  const nextClaimsProcessed = claimsProcessed + 1n;
  if (claimsProcessed >= BigInt(normalizedShard.holderCount)
    || result.terminal !== (nextClaimsProcessed === BigInt(normalizedShard.holderCount))) {
    throw new Error("remaining amount and processed claim count disagree on terminal state");
  }
  const controller = nonzeroBytes32(controllerId, "controller id");
  const extension = nonzeroBytes32(extensionCommitment, "holder extension commitment");
  const token = nonzeroBytes32(tokenId, "token id");
  const kcc20Template = templateParts(kcc20Artifact);
  const bootstrapTemplate = templateParts(bootstrapArtifact);
  const before = normalizeControllerState({
    migrationId: migrationCommitment,
    tokenId: token,
    holderExtensionCommitment: extension,
    manifestCommitment,
    snapshotContext: context,
    kcc20TemplateHash: kcc20Template.hash,
    bootstrapTemplateHash: bootstrapTemplate.hash,
    deploymentGuardCommitment,
    claimNotBeforeDaaScore: activation.lockTime,
    shardIndex: normalizedShard.shardIndex,
    globalIndexStart: normalizedShard.globalIndexStart,
    holderCount: normalizedShard.holderCount,
    treeDepth: normalizedShard.depth,
    kcc20TemplatePrefixLen: kcc20Template.prefix.length,
    kcc20TemplateSuffixLen: kcc20Template.suffix.length,
    bootstrapTemplatePrefixLen: bootstrapTemplate.prefix.length,
    bootstrapTemplateSuffixLen: bootstrapTemplate.suffix.length,
    shardCount: count,
    ...cells,
    remainingRoot: currentRoot,
    remainingAmount: currentReserveAmount,
    claimsProcessed,
  }, true);
  const recipientState = kcc20State(result.claimAmount, result.owner, result.ownerScheme, extension);
  const tokenOutputs = [];
  if (!result.terminal) {
    tokenOutputs.push({
      role: "reserve",
      cellKas: cells.reserveCellKas.toString(),
      state: serializeKcc20State(kcc20State(result.remainingAmount, controller, OWNER_COVENANT_ID, extension)),
    });
  }
  tokenOutputs.push({
    role: "recipient",
    cellKas: (result.terminal ? cells.reserveCellKas + cells.controllerCellKas : cells.recipientMinCellKas).toString(),
    state: serializeKcc20State(recipientState),
  });
  return operation("snapshot-claim-plan", migrationId, {
    transaction: {
      version: 1,
      lockTime: activation.lockTime.toString(),
      controllerInputSequence: activation.controllerInputSequence.toString(),
      sequenceSetBeforeSigning: true,
    },
    contract: "KCC20SnapshotController",
    entrypoint: "claim",
    kcc20Entrypoint: "transfer",
    controllerId: hex(controller),
    tokenId: hex(token),
    shardIndex: normalizedShard.shardIndex,
    globalIndex: result.globalIndex,
    shardLeafIndex: result.shardLeafIndex,
    proofSiblings: normalizeSiblings(claim.siblings, normalizedShard.depth).map(hex),
    previousRoot: hex(bytes32(currentRoot, "current root")),
    nextRoot: hex(result.nextRoot),
    claimAmount: result.claimAmount.toString(),
    claimOwner: hex(result.owner),
    claimOwnerScheme: result.ownerScheme,
    authorizationRequired: result.ownerScheme === OWNER_P2PK_SCHNORR
      ? "kcc2-p2pk-schnorr-signature"
      : "kcc2-p2sh-participating-input",
    terminal: result.terminal,
    tokenOutputs,
    controllerSuccessor: result.terminal ? null : {
      cellKas: cells.controllerCellKas.toString(),
      remainingRoot: hex(result.nextRoot),
      remainingAmount: result.remainingAmount.toString(),
      claimsProcessed: nextClaimsProcessed.toString(),
    },
    controllerStateBefore: serializeState(before),
    controllerStateAfter: result.terminal ? null : serializeState({
      ...before,
      remainingRoot: result.nextRoot,
      remainingAmount: result.remainingAmount,
      claimsProcessed: nextClaimsProcessed,
    }),
  });
}

export function buildClaimSignatureScripts(kw, {
  controllerArtifact,
  kcc20Artifact,
  claim,
  reserveNext,
  recipient,
  kcc20TemplatePrefix,
  kcc20TemplateSuffix,
  nextTokenStates,
}) {
  requireControllerArtifact(controllerArtifact);
  requireKcc20Artifact(kcc20Artifact);
  requireOwnerWitness(claim.ownerScheme, claim.ownerWitness);
  const builder = new kw.ScriptBuilder({ flags: { covenantsEnabled: true } });
  builder.addI64(BigInt(claim.globalIndex));
  builder.addI64(BigInt(claim.shardLeafIndex));
  addByte(builder, claim.ownerScheme);
  builder.addData(bytes32(claim.owner, "claim owner"));
  builder.addData(Uint8Array.from(claim.ownerWitness ?? []));
  builder.addI64(positiveI64(claim.amount, "claim amount"));
  builder.addData(concatSiblings(claim.siblings));
  addKcc20State(builder, reserveNext);
  addKcc20State(builder, recipient);
  builder.addData(Uint8Array.from(kcc20TemplatePrefix));
  builder.addData(Uint8Array.from(kcc20TemplateSuffix));
  builder.addData(dispatchTagFor(controllerArtifact, "claim"));
  return {
    controllerSignatureScript: builder.drain(),
    kcc20SignatureScript: buildKcc20TransferSigScript(kw, kcc20Artifact, {
      nextStates: nextTokenStates,
      witness: Uint8Array.of(0),
    }),
  };
}

export function snapshotTradingSetupIdentity({ tokenId, wrapperId, orderbookId }) {
  const token = bytes32(tokenId, "token covenant id");
  const wrapper = bytes32(wrapperId, "wrapper covenant id");
  const orderbook = bytes32(orderbookId, "orderbook covenant id");
  if (equalBytes(token, wrapper) || equalBytes(token, orderbook) || equalBytes(wrapper, orderbook)) {
    throw new Error("snapshot trading setup token, wrapper, and orderbook ids must be distinct");
  }
  return { tokenId: hex(token), wrapperId: hex(wrapper), orderbookId: hex(orderbook) };
}

export function transitionClaim({ context, shard, currentRoot, currentReserveAmount, claim }) {
  const normalizedShard = normalizeShard(shard);
  const globalIndex = integer(claim.globalIndex, "global index");
  const shardLeafIndex = integer(claim.shardLeafIndex, "shard leaf index");
  if (globalIndex !== normalizedShard.globalIndexStart + shardLeafIndex) {
    throw new Error("global index does not match shard-local position");
  }
  if (shardLeafIndex < 0 || shardLeafIndex >= normalizedShard.holderCount) {
    throw new Error("shard leaf index is outside the real holder set");
  }
  const ownerScheme = Number(claim.ownerScheme);
  if (!CLAIMABLE_SOURCE_OWNER_SCHEMES.includes(ownerScheme)) throw new Error("unsupported snapshot owner scheme");
  const owner = bytes32(claim.owner, "claim owner");
  const claimAmount = positiveI64(claim.amount, "claim amount");
  const reserve = positiveI64(currentReserveAmount, "current reserve amount");
  if (claimAmount > reserve) throw new Error("claim exceeds current reserve");
  const siblings = normalizeSiblings(claim.siblings, normalizedShard.depth);
  const ctx = bytes32(context, "snapshot context");
  const oldLeaf = entitlementLeaf(ctx, { globalIndex, ownerScheme, owner, amount: claimAmount });
  if (!equalBytes(foldProof(oldLeaf, siblings, shardLeafIndex), bytes32(currentRoot, "current root"))) {
    throw new Error("claim proof does not match current shard root");
  }
  const nextRoot = foldProof(claimedLeaf(ctx, globalIndex), siblings, shardLeafIndex);
  const remainingAmount = reserve - claimAmount;
  return { globalIndex, shardLeafIndex, ownerScheme, owner, claimAmount, nextRoot, remainingAmount, terminal: remainingAmount === 0n };
}

export function entitlementLeafPreimage(context, { globalIndex, ownerScheme, owner, amount }) {
  return concat(
    Uint8Array.of(0x10),
    bytes32(context, "snapshot context"),
    leI64(globalIndex),
    Uint8Array.of(ownerScheme),
    bytes32(owner, "owner"),
    leI64(amount),
  );
}

export const entitlementLeaf = (context, holder) => hash256(entitlementLeafPreimage(context, holder));
export const claimedLeafPreimage = (context, globalIndex) => concat(
  Uint8Array.of(0x12),
  bytes32(context, "snapshot context"),
  leI64(globalIndex),
);
export const claimedLeaf = (context, globalIndex) => hash256(claimedLeafPreimage(context, globalIndex));
export const paddingLeafPreimage = (context, shardIndex, shardLeafIndex) => concat(
  Uint8Array.of(0x13),
  bytes32(context, "snapshot context"),
  leI64(shardIndex),
  leI64(shardLeafIndex),
);
export const paddingLeaf = (context, shardIndex, shardLeafIndex) => hash256(
  paddingLeafPreimage(context, shardIndex, shardLeafIndex),
);
export const branchNodePreimage = (left, right) => concat(
  Uint8Array.of(0x11),
  bytes32(left, "left node"),
  bytes32(right, "right node"),
);
export const branchNode = (left, right) => hash256(branchNodePreimage(left, right));

export function foldProof(leaf, siblings, shardLeafIndex) {
  let node = bytes32(leaf, "leaf");
  let cursor = integer(shardLeafIndex, "shard leaf index");
  for (const sibling of siblings) {
    node = cursor % 2 === 0 ? branchNode(node, sibling) : branchNode(sibling, node);
    cursor = Math.floor(cursor / 2);
  }
  return node;
}

export function claimActivation(claimNotBeforeDaaScore, lockTime = claimNotBeforeDaaScore, controllerInputSequence = 0n) {
  const notBefore = positiveI64(claimNotBeforeDaaScore, "claim-not-before DAA score");
  if (notBefore >= LOCK_TIME_THRESHOLD) throw new Error("claim-not-before must use DAA-score locktime mode");
  const actualLockTime = nonnegativeI64(lockTime, "claim locktime");
  if (actualLockTime !== notBefore) throw new Error("claim locktime must equal the controller claim-not-before DAA score");
  const sequence = BigInt(controllerInputSequence);
  if (sequence !== 0n) {
    if (sequence === MAX_SEQUENCE) throw new Error("all-final input sequence bypass is forbidden");
    throw new Error("controller input sequence must be zero before signing");
  }
  return { lockTime: actualLockTime, controllerInputSequence: sequence };
}

export function snapshotControllerStateCommitment(state) {
  const normalized = normalizeControllerState(state, null);
  return hex(hash256(
    new TextEncoder().encode(SNAPSHOT_CONTROLLER_STATE_COMMITMENT_DOMAIN),
    encodeSnapshotControllerState(normalized),
  ));
}

export function encodeSnapshotControllerState(state) {
  const value = normalizeControllerState(state, null);
  return concat(
    push(value.migrationId),
    push(value.tokenId),
    push(value.holderExtensionCommitment),
    push(value.manifestCommitment),
    push(value.snapshotContext),
    push(value.kcc20TemplateHash),
    push(value.bootstrapTemplateHash),
    push(value.deploymentGuardCommitment),
    push(leI64(value.claimNotBeforeDaaScore)),
    push(leI64(value.shardIndex)),
    push(leI64(value.globalIndexStart)),
    push(leI64(value.holderCount)),
    push(leI64(value.treeDepth)),
    push(leI64(value.kcc20TemplatePrefixLen)),
    push(leI64(value.kcc20TemplateSuffixLen)),
    push(leI64(value.bootstrapTemplatePrefixLen)),
    push(leI64(value.bootstrapTemplateSuffixLen)),
    push(leI64(value.shardCount)),
    push(leI64(value.controllerCellKas)),
    push(leI64(value.reserveCellKas)),
    push(leI64(value.recipientMinCellKas)),
    push(value.remainingRoot),
    push(leI64(value.remainingAmount)),
    push(leI64(value.claimsProcessed)),
  );
}

export function encodeSnapshotBootstrapState(state) {
  const value = normalizeBootstrapState(state);
  return concat(
    push(value.migrationId),
    push(value.manifestCommitment),
    push(value.holderExtensionCommitment),
    push(leI64(value.totalSupply)),
    push(leI64(value.claimNotBeforeDaaScore)),
    push(value.expectedTokenId),
    push(value.kcc20TemplateHash),
    push(leI64(value.kcc20TemplatePrefixLen)),
    push(leI64(value.kcc20TemplateSuffixLen)),
    push(value.controllerTemplateHash),
    push(leI64(value.controllerTemplatePrefixLen)),
    push(leI64(value.controllerTemplateSuffixLen)),
    push(value.bootstrapTemplateHash),
    push(leI64(value.bootstrapTemplatePrefixLen)),
    push(leI64(value.bootstrapTemplateSuffixLen)),
    push(leI64(value.reserveCellKas)),
    push(leI64(value.controllerCellKas)),
    push(leI64(value.bootstrapCellKas)),
    push(leI64(value.shardCount)),
    push(value.peerPlanCommitment),
    push(value.startPlanCommitment),
  );
}

export const parseSnapshotControllerState = (state) => normalizeControllerState(state, null);
export const parseSnapshotBootstrapState = (state) => normalizeBootstrapState(state);

function operation(kind, migrationId, fields) {
  if (typeof migrationId !== "string" || migrationId.length === 0) throw new Error("migration id is required");
  return {
    schema: "kaspacom-snapshot-wallet-operation/v2",
    kind,
    migrationId,
    planOnly: true,
    transaction: { version: 1, lockTime: "0", inputSequence: "0" },
    ...fields,
  };
}

function requireArtifacts({ controllerArtifact, bootstrapArtifact, kcc20Artifact }) {
  requireControllerArtifact(controllerArtifact);
  requireBootstrapArtifact(bootstrapArtifact);
  requireKcc20Artifact(kcc20Artifact);
}

function requireKcc20Artifact(artifact) {
  if (artifact?.contract_name !== "KCC20" || artifact?.program_information?.convention !== "KCC20") {
    throw new Error("canonical KCC20 artifact is required");
  }
  dispatchTagFor(artifact, "transfer");
}

function requireControllerArtifact(artifact) {
  if (artifact?.contract_name !== "KCC20SnapshotController"
    || artifact?.program_information?.start_entrypoint !== "start"
    || artifact?.program_information?.claim_entrypoint !== "claim") {
    throw new Error("signerless KCC20 snapshot controller artifact is required");
  }
  dispatchTagFor(artifact, "start");
  dispatchTagFor(artifact, "claim");
}

function requireBootstrapArtifact(artifact) {
  const entrypoints = Object.keys(artifact?.contracts?.KCC20SnapshotBootstrap?.entries ?? {});
  if (artifact?.contract_name !== "KCC20SnapshotBootstrap"
    || artifact?.program_information?.start_entrypoint !== "start"
    || entrypoints.length !== 1
    || entrypoints[0] !== "start") {
    throw new Error("immutable signerless KCC20 snapshot bootstrap artifact is required");
  }
  dispatchTagFor(artifact, "start");
}

function requireOwnerWitness(ownerScheme, witness) {
  const scheme = Number(ownerScheme);
  const value = Uint8Array.from(witness ?? []);
  if (scheme === OWNER_P2PK_SCHNORR && value.length !== 65) {
    throw new Error("P2PK Schnorr entitlement witness must be 65 bytes");
  }
  if (scheme === OWNER_P2SH && value.length !== 1) {
    throw new Error("P2SH entitlement witness must identify one participating input");
  }
  if (!CLAIMABLE_SOURCE_OWNER_SCHEMES.includes(scheme)) throw new Error("unsupported snapshot owner scheme");
}

function normalizeShard(shard) {
  if (!shard || typeof shard !== "object") throw new Error("shard is required");
  const value = {
    shardIndex: integer(shard.shardIndex, "shard index"),
    globalIndexStart: integer(shard.globalIndexStart, "global index start"),
    holderCount: integer(shard.holderCount, "holder count"),
    depth: integer(shard.depth ?? shard.treeDepth, "tree depth"),
    allocationTotal: positiveI64(shard.allocationTotal ?? shard.remainingAmount, "shard allocation total"),
    initialRoot: nonzeroBytes32(shard.initialRoot ?? shard.remainingRoot, "initial root"),
  };
  if (value.shardIndex < 0 || value.globalIndexStart < 0 || value.holderCount < 1) {
    throw new Error("shard indexes must be nonnegative and holder count positive");
  }
  if (value.depth < 1 || value.depth > 20 || value.holderCount > 2 ** value.depth) {
    throw new Error("shard tree depth or holder count is invalid");
  }
  return value;
}

function normalizeStartShards(shards, initialized) {
  if (!Array.isArray(shards) || shards.length < 1 || shards.length > MAX_SNAPSHOT_SHARDS) {
    throw new Error("snapshot start requires 1..8 shards");
  }
  const seen = new Set();
  return shards.map((entry, index) => {
    const controllerId = nonzeroBytes32(entry?.controllerId, "controller id");
    const key = hex(controllerId);
    if (seen.has(key)) throw new Error("controller ids must be unique");
    seen.add(key);
    const state = normalizeControllerState(entry?.state ?? entry?.controllerState ?? entry?.stateBefore, initialized);
    if (Number(state.shardIndex) !== index) throw new Error("snapshot shards must be ordered contiguously from zero");
    return { controllerId, state };
  });
}

function validateStartShards(shards, expected) {
  let total = 0n;
  for (const [index, shard] of shards.entries()) {
    const state = shard.state;
    if (!equalBytes(state.migrationId, expected.migrationId)
      || !equalBytes(state.manifestCommitment, expected.manifestCommitment)
      || !equalBytes(state.holderExtensionCommitment, expected.holderExtensionCommitment)
      || !equalBytes(state.bootstrapTemplateHash, expected.bootstrapTemplateHash)
      || state.bootstrapTemplatePrefixLen !== BigInt(expected.bootstrapTemplatePrefixLen)
      || state.bootstrapTemplateSuffixLen !== BigInt(expected.bootstrapTemplateSuffixLen)
      || !equalBytes(state.tokenId, ZERO_32)
      || state.claimNotBeforeDaaScore !== BigInt(expected.claimNotBeforeDaaScore)
      || state.shardCount !== BigInt(shards.length)
      || state.controllerCellKas !== BigInt(expected.controllerCellKas)
      || state.reserveCellKas !== BigInt(expected.reserveCellKas)
      || state.claimsProcessed !== 0n) {
      throw new Error(`shard ${index} does not match immutable start policy`);
    }
    if (index > 0 && !equalBytes(state.deploymentGuardCommitment, ZERO_32)) {
      throw new Error("peer controllers must not contain a deployment guard");
    }
    total += state.remainingAmount;
  }
  if (total !== BigInt(expected.totalSupply)) throw new Error("shard allocations do not equal fixed token supply");
}

function shardPlanParts(shard) {
  const state = shard.state;
  return [
    leI64(state.shardIndex),
    shard.controllerId,
    state.remainingRoot,
    leI64(state.remainingAmount),
    leI64(state.globalIndexStart),
    leI64(state.holderCount),
    leI64(state.treeDepth),
    state.snapshotContext,
  ];
}

function validateCells({ controllerCellKas, reserveCellKas, recipientMinCellKas }) {
  const controller = positiveI64(controllerCellKas, "controller cell KAS");
  const reserve = positiveI64(reserveCellKas, "reserve cell KAS");
  const recipient = positiveI64(recipientMinCellKas, "recipient minimum cell KAS");
  if (controller < MIN_KCC20_CELL_SOMPI || reserve < MIN_KCC20_CELL_SOMPI || recipient < MIN_KCC20_CELL_SOMPI) {
    throw new Error("controller and KCC20 cells must be at least 50000000 sompi");
  }
  if (controller > MAX_I64 - reserve || controller + reserve < recipient) {
    throw new Error("terminal KAS disposition is invalid");
  }
  return { controllerCellKas: controller, reserveCellKas: reserve, recipientMinCellKas: recipient };
}

function normalizeControllerState(state, initialized) {
  if (!state || typeof state !== "object") throw new Error("controller state is required");
  const value = {
    migrationId: nonzeroBytes32(state.migrationId, "migration id"),
    tokenId: bytes32(state.tokenId, "token id"),
    holderExtensionCommitment: nonzeroBytes32(state.holderExtensionCommitment, "holder extension commitment"),
    manifestCommitment: nonzeroBytes32(state.manifestCommitment, "manifest commitment"),
    snapshotContext: nonzeroBytes32(state.snapshotContext, "snapshot context"),
    kcc20TemplateHash: nonzeroBytes32(state.kcc20TemplateHash, "KCC20 template hash"),
    bootstrapTemplateHash: nonzeroBytes32(state.bootstrapTemplateHash, "bootstrap template hash"),
    deploymentGuardCommitment: bytes32(state.deploymentGuardCommitment, "deployment guard commitment"),
    claimNotBeforeDaaScore: positiveI64(state.claimNotBeforeDaaScore, "claim-not-before DAA score"),
    shardIndex: nonnegativeI64(state.shardIndex, "shard index"),
    globalIndexStart: nonnegativeI64(state.globalIndexStart, "global index start"),
    holderCount: positiveI64(state.holderCount, "holder count"),
    treeDepth: positiveI64(state.treeDepth, "tree depth"),
    kcc20TemplatePrefixLen: positiveI64(state.kcc20TemplatePrefixLen, "KCC20 template prefix length"),
    kcc20TemplateSuffixLen: positiveI64(state.kcc20TemplateSuffixLen, "KCC20 template suffix length"),
    bootstrapTemplatePrefixLen: positiveI64(state.bootstrapTemplatePrefixLen, "bootstrap template prefix length"),
    bootstrapTemplateSuffixLen: positiveI64(state.bootstrapTemplateSuffixLen, "bootstrap template suffix length"),
    shardCount: positiveI64(state.shardCount, "shard count"),
    controllerCellKas: positiveI64(state.controllerCellKas, "controller cell KAS"),
    reserveCellKas: positiveI64(state.reserveCellKas, "reserve cell KAS"),
    recipientMinCellKas: positiveI64(state.recipientMinCellKas, "recipient minimum cell KAS"),
    remainingRoot: nonzeroBytes32(state.remainingRoot, "remaining root"),
    remainingAmount: positiveI64(state.remainingAmount, "remaining amount"),
    claimsProcessed: nonnegativeI64(state.claimsProcessed, "claims processed"),
  };
  if (value.claimNotBeforeDaaScore >= LOCK_TIME_THRESHOLD
    || value.treeDepth > 32n
    || value.shardCount > BigInt(MAX_SNAPSHOT_SHARDS)
    || value.shardIndex >= value.shardCount
    || value.claimsProcessed >= value.holderCount) {
    throw new Error("controller state configuration is invalid");
  }
  if (initialized === true && equalBytes(value.tokenId, ZERO_32)) throw new Error("initialized controller token id is zero");
  if (initialized === false && !equalBytes(value.tokenId, ZERO_32)) throw new Error("uninitialized controller token id is nonzero");
  return value;
}

function normalizeBootstrapState(state) {
  if (!state || typeof state !== "object") throw new Error("bootstrap state is required");
  const value = {
    migrationId: nonzeroBytes32(state.migrationId, "migration id"),
    manifestCommitment: nonzeroBytes32(state.manifestCommitment, "manifest commitment"),
    holderExtensionCommitment: nonzeroBytes32(state.holderExtensionCommitment, "holder extension commitment"),
    totalSupply: positiveI64(state.totalSupply, "total supply"),
    claimNotBeforeDaaScore: positiveI64(state.claimNotBeforeDaaScore, "claim-not-before DAA score"),
    expectedTokenId: nonzeroBytes32(state.expectedTokenId, "expected token id"),
    kcc20TemplateHash: nonzeroBytes32(state.kcc20TemplateHash, "KCC20 template hash"),
    kcc20TemplatePrefixLen: positiveI64(state.kcc20TemplatePrefixLen, "KCC20 template prefix length"),
    kcc20TemplateSuffixLen: positiveI64(state.kcc20TemplateSuffixLen, "KCC20 template suffix length"),
    controllerTemplateHash: nonzeroBytes32(state.controllerTemplateHash, "controller template hash"),
    controllerTemplatePrefixLen: positiveI64(state.controllerTemplatePrefixLen, "controller template prefix length"),
    controllerTemplateSuffixLen: positiveI64(state.controllerTemplateSuffixLen, "controller template suffix length"),
    bootstrapTemplateHash: nonzeroBytes32(state.bootstrapTemplateHash, "bootstrap template hash"),
    bootstrapTemplatePrefixLen: positiveI64(state.bootstrapTemplatePrefixLen, "bootstrap template prefix length"),
    bootstrapTemplateSuffixLen: positiveI64(state.bootstrapTemplateSuffixLen, "bootstrap template suffix length"),
    reserveCellKas: positiveI64(state.reserveCellKas, "reserve cell KAS"),
    controllerCellKas: positiveI64(state.controllerCellKas, "controller cell KAS"),
    bootstrapCellKas: positiveI64(state.bootstrapCellKas, "bootstrap cell KAS"),
    shardCount: positiveI64(state.shardCount, "shard count"),
    peerPlanCommitment: nonzeroBytes32(state.peerPlanCommitment, "peer plan commitment"),
    startPlanCommitment: nonzeroBytes32(state.startPlanCommitment, "start plan commitment"),
  };
  if (value.claimNotBeforeDaaScore >= LOCK_TIME_THRESHOLD
    || value.shardCount > BigInt(MAX_SNAPSHOT_SHARDS)
    || value.reserveCellKas < MIN_KCC20_CELL_SOMPI
    || value.controllerCellKas < MIN_KCC20_CELL_SOMPI
    || value.bootstrapCellKas < MIN_KCC20_CELL_SOMPI) {
    throw new Error("bootstrap state configuration is invalid");
  }
  return value;
}

function normalizeKcc20State(state) {
  if (!state || typeof state !== "object") throw new Error("KCC20 state is required");
  return {
    amount: positiveI64(state.amount, "KCC20 amount"),
    owner: bytes32(state.owner, "KCC20 owner"),
    ownerScheme: Number(state.ownerScheme),
    borrowScheme: Number(state.borrowScheme),
    borrowGuard: bytes32(state.borrowGuard, "KCC20 borrow guard"),
    extensionCommitment: bytes32(state.extensionCommitment, "KCC20 extension commitment"),
  };
}

function kcc20State(amount, owner, ownerScheme, extensionCommitment) {
  return normalizeKcc20State({
    amount,
    owner,
    ownerScheme,
    borrowScheme: BORROW_DISABLED,
    borrowGuard: ZERO_32,
    extensionCommitment,
  });
}

function encodeControllerStateRecordArrays(states) {
  const fields = [
    ["migrationId", "bytes"], ["tokenId", "bytes"], ["holderExtensionCommitment", "bytes"],
    ["manifestCommitment", "bytes"], ["snapshotContext", "bytes"], ["kcc20TemplateHash", "bytes"],
    ["bootstrapTemplateHash", "bytes"], ["deploymentGuardCommitment", "bytes"],
    ["claimNotBeforeDaaScore", "int"], ["shardIndex", "int"], ["globalIndexStart", "int"],
    ["holderCount", "int"], ["treeDepth", "int"], ["kcc20TemplatePrefixLen", "int"],
    ["kcc20TemplateSuffixLen", "int"], ["bootstrapTemplatePrefixLen", "int"],
    ["bootstrapTemplateSuffixLen", "int"], ["shardCount", "int"], ["controllerCellKas", "int"],
    ["reserveCellKas", "int"], ["recipientMinCellKas", "int"], ["remainingRoot", "bytes"],
    ["remainingAmount", "int"], ["claimsProcessed", "int"],
  ];
  return fields.map(([field, kind]) => concat(...states.map((state) => (
    kind === "int" ? leI64(state[field]) : state[field]
  ))));
}

function encodeKcc20StateRecordArrays(states) {
  return [
    concat(...states.map((state) => leI64(state.amount))),
    concat(...states.map((state) => state.owner)),
    Uint8Array.from(states.map((state) => state.ownerScheme)),
    Uint8Array.from(states.map((state) => state.borrowScheme)),
    concat(...states.map((state) => state.borrowGuard)),
    concat(...states.map((state) => state.extensionCommitment)),
  ];
}

function addControllerState(builder, state) {
  const byteFields = new Set([
    "migrationId", "tokenId", "holderExtensionCommitment", "manifestCommitment",
    "snapshotContext", "kcc20TemplateHash", "bootstrapTemplateHash",
    "deploymentGuardCommitment", "remainingRoot",
  ]);
  for (const field of [
    "migrationId", "tokenId", "holderExtensionCommitment", "manifestCommitment",
    "snapshotContext", "kcc20TemplateHash", "bootstrapTemplateHash",
    "deploymentGuardCommitment", "claimNotBeforeDaaScore", "shardIndex",
    "globalIndexStart", "holderCount", "treeDepth", "kcc20TemplatePrefixLen",
    "kcc20TemplateSuffixLen", "bootstrapTemplatePrefixLen", "bootstrapTemplateSuffixLen",
    "shardCount", "controllerCellKas", "reserveCellKas", "recipientMinCellKas",
    "remainingRoot", "remainingAmount", "claimsProcessed",
  ]) {
    if (byteFields.has(field)) builder.addData(state[field]);
    else builder.addI64(state[field]);
  }
}

function addKcc20State(builder, state) {
  const value = state?.amount === 0n ? state : normalizeKcc20State(state);
  builder.addI64(BigInt(value?.amount ?? 0));
  builder.addData(bytes32(value?.owner ?? ZERO_32, "KCC20 owner"));
  addByte(builder, value?.ownerScheme ?? 0);
  addByte(builder, value?.borrowScheme ?? BORROW_DISABLED);
  builder.addData(bytes32(value?.borrowGuard ?? ZERO_32, "KCC20 borrow guard"));
  builder.addData(bytes32(value?.extensionCommitment ?? ZERO_32, "KCC20 extension commitment"));
}

function addByte(builder, value) {
  const byte = Number(value);
  if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error("value must be a byte");
  builder.addOps([0x01, byte]);
}

function normalizeSiblings(siblings, depth) {
  if (!Array.isArray(siblings) || siblings.length !== depth) {
    throw new Error(`proof must contain exactly ${depth} siblings`);
  }
  return siblings.map((sibling) => bytes32(sibling, "proof sibling"));
}

function concatSiblings(siblings) {
  return concat(...siblings.map((sibling) => bytes32(sibling, "proof sibling")));
}

function serializeState(state) {
  return Object.fromEntries(Object.entries(state).map(([key, value]) => [
    key,
    value instanceof Uint8Array ? hex(value) : value.toString(),
  ]));
}

function serializeKcc20State(state) {
  return {
    amount: state.amount.toString(),
    owner: hex(state.owner),
    ownerScheme: state.ownerScheme,
    borrowScheme: state.borrowScheme,
    borrowGuard: hex(state.borrowGuard),
    extensionCommitment: hex(state.extensionCommitment),
  };
}

function serializeShard(shard) {
  return {
    shardIndex: shard.shardIndex,
    globalIndexStart: shard.globalIndexStart,
    holderCount: shard.holderCount,
    depth: shard.depth,
    allocationTotal: shard.allocationTotal.toString(),
    initialRoot: hex(shard.initialRoot),
  };
}

function serializeCells(cells) {
  return {
    controllerCellKas: cells.controllerCellKas.toString(),
    reserveCellKas: cells.reserveCellKas.toString(),
    recipientMinCellKas: cells.recipientMinCellKas.toString(),
  };
}

function boundedShardCount(value) {
  const count = integer(value, "shard count");
  if (count < 1 || count > MAX_SNAPSHOT_SHARDS) throw new Error("shard count must be 1..8");
  return count;
}

function hash256(...parts) {
  return Uint8Array.from(blake2b(concat(...parts), { dkLen: 32 }));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function leI64(value) {
  const amount = BigInt(value);
  if (amount < 0n || amount > MAX_I64) throw new Error("integer is outside nonnegative signed 64-bit range");
  const bytes = new Uint8Array(8);
  let cursor = amount;
  for (let index = 0; index < 8; index += 1) {
    bytes[index] = Number(cursor & 0xffn);
    cursor >>= 8n;
  }
  return bytes;
}

function push(value) {
  const bytes = Uint8Array.from(value);
  if (bytes.length > 75) throw new Error("snapshot state push is too large");
  return concat(Uint8Array.of(bytes.length), bytes);
}

function bytes32(value, label) {
  let bytes;
  if (typeof value === "string") {
    const normalized = value.replace(/^0x/, "");
    if (!/^(?:[0-9a-fA-F]{2}){32}$/.test(normalized)) throw new Error(`${label} must be 32 bytes`);
    bytes = hexToBytes(normalized);
  } else {
    bytes = Uint8Array.from(value ?? []);
  }
  if (bytes.length !== 32) throw new Error(`${label} must be 32 bytes`);
  return bytes;
}

function nonzeroBytes32(value, label) {
  const bytes = bytes32(value, label);
  if (equalBytes(bytes, ZERO_32)) throw new Error(`${label} must be nonzero`);
  return bytes;
}

function integer(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} must be a safe integer`);
  return number;
}

function nonnegativeI64(value, label) {
  const number = BigInt(value);
  if (number < 0n || number > MAX_I64) {
    throw new Error(`${label} must be a nonnegative signed 64-bit integer`);
  }
  return number;
}

function positiveI64(value, label) {
  const number = BigInt(value);
  if (number <= 0n || number > MAX_I64) {
    throw new Error(`${label} must be a positive signed 64-bit integer`);
  }
  return number;
}

function equalBytes(a, b) {
  const left = Uint8Array.from(a ?? []);
  const right = Uint8Array.from(b ?? []);
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function hex(value) {
  return bytesToHex(value);
}
