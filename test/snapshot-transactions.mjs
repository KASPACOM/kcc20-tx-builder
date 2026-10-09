#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
const wasmPath = process.env.SNAPSHOT_TEST_WASM;
if (!wasmPath) throw new Error("SNAPSHOT_TEST_WASM must point to the pinned kaspa-wasm-toc directory");
async function initKaspa() {
  const kw = await import(pathToFileURL(`${wasmPath}/kaspa.js`));
  kw.initSync(await readFile(`${wasmPath}/kaspa_bg.wasm`));
  return kw;
}
import { templateParts } from "../dist/abi.js";
import {
  buildBootstrapGenesisPlan,
  buildControllerGenesisPlan,
  buildSnapshotStartPlan,
  buildSnapshotTokenMetadata,
  snapshotPeerPlanCommitment,
  ZERO_32,
} from "../dist/snapshot-signerless.js";
import {
  buildBootstrapGenesisUnsignedTransaction,
  buildControllerGenesisUnsignedTransaction,
  buildSnapshotStartUnsignedTransaction,
  buildSnapshotBootstrapScriptForState,
  buildSnapshotControllerScriptForState,
  deriveSnapshotTokenId,
} from "../dist/snapshot-signerless-transactions.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const readJson = async (path) => JSON.parse(await readFile(`${repoRoot}/${path}`, "utf8"));
const [bootstrapArtifact, controllerArtifact, kcc20Artifact, standardsLock] = await Promise.all([
  readJson("artifacts/KCC20SnapshotBootstrap.placeholder.json"),
  readJson("artifacts/KCC20SnapshotController.placeholder.json"),
  readJson("artifacts/KCC20.placeholder.json"),
  readJson("artifacts/snapshot-standards.lock.json"),
]);
const kw = await initKaspa();
const bytes = (value) => Uint8Array.from({ length: 32 }, () => value);
const hex = (value) => Buffer.from(value).toString("hex");
const migration = bytes(0x10);
const manifest = bytes(0x20);
const context = bytes(0x30);
const root = bytes(0x40);
const fundingOwner = bytes(0x99);
const fundingSpk = new kw.ScriptPublicKey(0, `20${hex(fundingOwner)}ac`);
const changeAddress = kw.addressFromScriptPublicKey(fundingSpk, "testnet-10").toString();
let marker = 1;
const funding = (amount = 1_000_000_000n) => {
  const outpoint = { transactionId: `${(marker++).toString(16).padStart(2, "0")}`.repeat(32), index: 0 };
  return {
    previousOutpoint: outpoint,
    utxo: { outpoint, amount, scriptPublicKey: fundingSpk, blockDaaScore: 1n, isCoinbase: false },
    networkId: "testnet-10",
  };
};

assert.deepEqual(Object.keys(bootstrapArtifact.contracts.KCC20SnapshotBootstrap.entries), ["start"]);
assert.equal(bootstrapArtifact.program_information.administrative_signatures, 0);

for (const artifact of [bootstrapArtifact, controllerArtifact]) {
  assert.equal(
    Object.hasOwn(artifact.generation, "silverscript_release_asset"),
    false,
    "tracked artifacts must not depend on the host release asset",
  );
  assert.equal(
    Object.hasOwn(artifact.generation, "silverscript_release_asset_sha256"),
    false,
    "tracked artifacts must not depend on the host release-asset hash",
  );
  assert.equal(artifact.generation.silverscript_tag, standardsLock.silverscriptKcc20.tag);
  assert.equal(artifact.generation.silverscript_commit, standardsLock.silverscriptKcc20.commit);
  assert.equal(artifact.generation.silverscript_tree, standardsLock.silverscriptKcc20.tree);
}
assert.ok(standardsLock.silverscriptKcc20.releaseAssets["linux-x64"]);
assert.ok(standardsLock.silverscriptKcc20.releaseAssets["win32-x64"]);

const metadata = buildSnapshotTokenMetadata({
  migrationId: "signerless-test",
  creator: bytes(0x50),
  ticker: bytes(0x51),
  name: bytes(0x52),
  displayScale: 100n,
  totalAllocation: 1_000n,
  protocolFeeRecipient: bytes(0x53),
});
const shard = {
  shardIndex: 0,
  globalIndexStart: 0,
  holderCount: 1,
  depth: 1,
  allocationTotal: 1_000n,
  initialRoot: root,
};
const provisional = buildControllerGenesisPlan({
  migrationId: "signerless-test",
  migrationCommitment: migration,
  controllerArtifact,
  bootstrapArtifact,
  kcc20Artifact,
  holderExtensionCommitment: metadata.holderExtensionCommitment,
  manifestCommitment: manifest,
  context,
  shard,
  shardCount: 1,
  deploymentGuardCommitment: bytes(0x01),
  claimNotBeforeDaaScore: 100n,
});
const peerPlan = snapshotPeerPlanCommitment({
  migrationCommitment: migration,
  manifestCommitment: manifest,
  shards: [{ controllerId: bytes(0x01), state: provisional.controllerState }],
});
const controllerPlan = buildControllerGenesisPlan({
  migrationId: "signerless-test",
  migrationCommitment: migration,
  controllerArtifact,
  bootstrapArtifact,
  kcc20Artifact,
  holderExtensionCommitment: metadata.holderExtensionCommitment,
  manifestCommitment: manifest,
  context,
  shard,
  shardCount: 1,
  deploymentGuardCommitment: peerPlan,
  claimNotBeforeDaaScore: 100n,
});
const controllerDeployment = buildControllerGenesisUnsignedTransaction(kw, {
  plan: controllerPlan,
  controllerArtifact,
  fundingInput: funding(),
  changeAddress,
  feeSompi: 300_000n,
});
const controllerTx = controllerDeployment.unsignedTransaction;
const controllerId = controllerTx.outputs[0].covenant.covenantId;
const controllerOutpoint = { transactionId: controllerTx.id, index: 0 };
const reserves = [{
  amount: "1000",
  owner: controllerId,
  ownerScheme: 4,
  borrowScheme: 0,
  borrowGuard: "00".repeat(32),
  extensionCommitment: metadata.holderExtensionCommitment,
}];
const tokenId = deriveSnapshotTokenId(kw, {
  controllerGenesisOutpoint: controllerOutpoint,
  reserves,
  kcc20Artifact,
  reserveCellKas: 50_000_000n,
});
assert.match(tokenId, /^[0-9a-f]{64}$/);

const bootstrapPlan = buildBootstrapGenesisPlan({
  migrationId: "signerless-test",
  migrationCommitment: migration,
  bootstrapArtifact,
  controllerArtifact,
  kcc20Artifact,
  manifestCommitment: manifest,
  holderExtensionCommitment: metadata.holderExtensionCommitment,
  totalSupply: 1_000n,
  claimNotBeforeDaaScore: 100n,
  expectedTokenId: tokenId,
  shards: [{ controllerId, state: controllerPlan.controllerState }],
});
assert.equal(bootstrapPlan.bootstrapState.expectedTokenId, tokenId);
assert.equal(bootstrapPlan.bootstrapState.approvalKey, undefined);
const bootstrapDeployment = buildBootstrapGenesisUnsignedTransaction(kw, {
  plan: bootstrapPlan,
  bootstrapArtifact,
  fundingInput: funding(),
  changeAddress,
  feeSompi: 300_000n,
});
const bootstrapTx = bootstrapDeployment.unsignedTransaction;
const bootstrapId = bootstrapTx.outputs[0].covenant.covenantId;
const startPlan = buildSnapshotStartPlan({
  migrationId: "signerless-test",
  bootstrapArtifact,
  controllerArtifact,
  kcc20Artifact,
  bootstrapId,
  bootstrapState: bootstrapPlan.bootstrapState,
  shards: [{ controllerId, state: controllerPlan.controllerState }],
});
const covenantInput = (tx, script, covenantId) => ({
  previousOutpoint: { transactionId: tx.id, index: 0 },
  utxo: {
    outpoint: { transactionId: tx.id, index: 0 },
    amount: BigInt(tx.outputs[0].value),
    scriptPublicKey: kw.payToScriptHashScript(script),
    covenantId,
    blockDaaScore: 1n,
    isCoinbase: false,
  },
  networkId: "testnet-10",
  script,
});
const bootstrapScript = buildSnapshotBootstrapScriptForState(
  bootstrapArtifact,
  bootstrapPlan.bootstrapState,
);
const controllerScript = buildSnapshotControllerScriptForState(
  controllerArtifact,
  controllerPlan.controllerState,
);
const start = buildSnapshotStartUnsignedTransaction(kw, {
  plan: startPlan,
  bootstrapArtifact,
  controllerArtifact,
  kcc20Artifact,
  bootstrapInput: covenantInput(bootstrapTx, bootstrapScript, bootstrapId),
  controllerInputs: [covenantInput(controllerTx, controllerScript, controllerId)],
  fundingInput: funding(),
  changeAddress,
  feeSompi: 300_000n,
});
assert.deepEqual(start.signInputs, [{ inputIndex: 2, role: "funding-owner", ownerScheme: 0 }]);
assert.equal(start.unsignedTransaction.outputs.length, 3);
assert.equal(start.unsignedTransaction.outputs[0].covenant.covenantId, tokenId);
assert.equal(start.unsignedTransaction.outputs[1].covenant.covenantId, controllerId);
assert.equal(start.unsignedTransaction.outputs[2].covenant, null);
assert.deepEqual(start.unsignedTransaction.inputs.map((input) => input.computeBudget), [1_000, 100, 30]);
assert.equal(start.intent.bootstrapSuccessor, null);

assert.throws(() => buildBootstrapGenesisPlan({
  migrationId: "signerless-test",
  migrationCommitment: migration,
  bootstrapArtifact,
  controllerArtifact,
  kcc20Artifact,
  manifestCommitment: manifest,
  holderExtensionCommitment: metadata.holderExtensionCommitment,
  totalSupply: 999n,
  claimNotBeforeDaaScore: 100n,
  expectedTokenId: tokenId,
  shards: [{ controllerId, state: controllerPlan.controllerState }],
}), /allocations do not equal fixed token supply/);

assert.throws(() => buildBootstrapGenesisPlan({
  migrationId: "signerless-test",
  migrationCommitment: migration,
  bootstrapArtifact,
  controllerArtifact,
  kcc20Artifact,
  manifestCommitment: manifest,
  holderExtensionCommitment: metadata.holderExtensionCommitment,
  totalSupply: 1_000n,
  claimNotBeforeDaaScore: 100n,
  expectedTokenId: tokenId,
  shards: [{
    controllerId,
    state: { ...controllerPlan.controllerState, bootstrapTemplateHash: hex(bytes(0xee)) },
  }],
}), /immutable start policy/);

const invalidBudgetControllerInput = covenantInput(controllerTx, controllerScript, controllerId);
invalidBudgetControllerInput.computeBudget = 500_000;
assert.throws(() => buildSnapshotStartUnsignedTransaction(kw, {
  plan: startPlan,
  bootstrapArtifact,
  controllerArtifact,
  kcc20Artifact,
  bootstrapInput: covenantInput(bootstrapTx, bootstrapScript, bootstrapId),
  controllerInputs: [invalidBudgetControllerInput],
  fundingInput: funding(),
  changeAddress,
  feeSompi: 300_000n,
}), /unsigned 16-bit integer/);

assert.throws(() => buildSnapshotStartPlan({
  migrationId: "signerless-test",
  bootstrapArtifact,
  controllerArtifact,
  kcc20Artifact,
  bootstrapId,
  bootstrapState: { ...bootstrapPlan.bootstrapState, expectedTokenId: hex(bytes(0xee)) },
  shards: [{ controllerId, state: controllerPlan.controllerState }],
}), /start commitments/);

assert.deepEqual(ZERO_32, new Uint8Array(32));


console.log("snapshot signerless funded transaction tests passed");

const { verifySnapshotDeploymentTransaction, snapshotStartPayload } = await import('../dist/snapshot-verification.js');
const { prepareSnapshotDeployment } = await import('../dist/snapshot-deployment.js');
const artifacts = { bootstrapArtifact, controllerArtifact, kcc20Artifact };
for (const count of [1, 2, 8]) {
  const definition = {
    migrationId: hex(migration), manifestCommitment: hex(manifest), context: hex(context),
    creator: hex(bytes(0x50)), ticker: 'TEST', displayScale: '100', totalSupply: String(count * 1000),
    claimNotBeforeDaaScore: '100', shards: Array.from({length: count}, (_, shardIndex) => ({
      shardIndex, globalIndexStart: shardIndex, holderCount: 1, depth: 1,
      allocationTotal: '1000', initialRoot: hex(root),
    })),
  };
  const deployments = new Map();
  const order = [...Array.from({length: count - 1}, (_, index) => index + 1), 0];
  for (const expectedShard of order) {
    const prepared = prepareSnapshotDeployment(kw, definition, artifacts);
    assert.equal(prepared.stage, 'controller-deploy');
    assert.equal(prepared.shard, expectedShard);
    const deploy = buildControllerGenesisUnsignedTransaction(kw, {
      plan: prepared.plan, controllerArtifact, fundingInput: funding(), changeAddress, feeSompi: 300000n,
    });
    const tx = deploy.unsignedTransaction;
    const current = definition.shards[expectedShard];
    current.controllerId = tx.outputs[0].covenant.covenantId;
    current.genesisOutpoint = { transactionId: tx.id, index: 0 };
    deployments.set(expectedShard, {tx, plan: prepared.plan});
  }
  const bootstrap = prepareSnapshotDeployment(kw, definition, artifacts);
  assert.equal(bootstrap.stage, 'bootstrap-deploy');
  const deploy = buildBootstrapGenesisUnsignedTransaction(kw, {
    plan: bootstrap.plan, bootstrapArtifact, fundingInput: funding(), changeAddress, feeSompi: 300000n,
  });
  definition.bootstrapId = deploy.unsignedTransaction.outputs[0].covenant.covenantId;
  definition.bootstrapOutpoint = {transactionId: deploy.unsignedTransaction.id, index: 0};
  const prepared = prepareSnapshotDeployment(kw, definition, artifacts);
  assert.equal(prepared.stage, 'snapshot-start');
  const args = {
    ...artifacts, plan: prepared.plan, changeAddress, feeSompi: 300000n,
    fundingInput: funding(10000000000n), payload: snapshotStartPayload(definition, prepared),
    bootstrapInput: covenantInput(deploy.unsignedTransaction,
      buildSnapshotBootstrapScriptForState(bootstrapArtifact, bootstrap.plan.bootstrapState), definition.bootstrapId),
    controllerInputs: definition.shards.map((shard, index) => covenantInput(deployments.get(index).tx,
      buildSnapshotControllerScriptForState(controllerArtifact, deployments.get(index).plan.controllerState), shard.controllerId)),
  };
  const started = buildSnapshotStartUnsignedTransaction(kw, args);
  const verifyArgs = { definition, artifacts, stage: 'snapshot-start', walletAddress: changeAddress,
    maximumFeeSompi: '300000', signingInputIndexes: [count + 1], transactionJson: JSON.stringify(started.unsignedTransaction) };
  verifySnapshotDeploymentTransaction(kw, verifyArgs);
  assert.throws(() => verifySnapshotDeploymentTransaction(kw, {...verifyArgs, signingInputIndexes: [0, count + 1]}), /funding input/);
  const mutated = structuredClone(started.unsignedTransaction);
  mutated.outputs[0].value = '49999999';
  assert.throws(() => verifySnapshotDeploymentTransaction(kw, {...verifyArgs, transactionJson: JSON.stringify(mutated)}));
  assert.equal(started.unsignedTransaction.inputs.length, count + 2);
  assert.equal(started.unsignedTransaction.outputs.length, count * 2 + 1);
  assert.deepEqual(started.signInputs.map(input => input.inputIndex), [count + 1]);
  assert.ok(started.unsignedTransaction.inputs.slice(0, count + 1).every(input => input.signatureScript.length > 100));
  assert.ok(started.unsignedTransaction.outputs.slice(0, count).every(output => output.covenant.covenantId === bootstrap.tokenId));
  assert.throws(() => buildSnapshotStartUnsignedTransaction(kw, {...args, controllerInputs: []}), /every committed controller/);
  assert.throws(() => prepareSnapshotDeployment(kw, {...definition, totalSupply: '1'}, artifacts), /allocations/);
  assert.throws(() => prepareSnapshotDeployment(kw, {...definition, shards: definition.shards.map(s => ({...s, depth: 21}))}, artifacts), /depth/);
  assert.throws(() => prepareSnapshotDeployment(kw, definition, {...artifacts,
    bootstrapArtifact: {...bootstrapArtifact, script: [0]}}), /hash mismatch/);
}
console.log('1, 2, and 8 shard deployment order, atomic start, mutation and signature tests passed');
