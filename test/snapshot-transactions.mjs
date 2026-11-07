#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadPinnedKaspaWasm } from "./load-kaspa-wasm.mjs";
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
  assertSnapshotStartPredictedSignedMass,
  calculateSnapshotStartPredictedSignedMass,
  deriveSnapshotTokenId,
  parseSnapshotKcc20DeploymentPayload,
  SNAPSHOT_START_MASS_LIMITS,
} from "../dist/snapshot-signerless-transactions.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const readJson = async (path) => JSON.parse(await readFile(`${repoRoot}/${path}`, "utf8"));
const [bootstrapArtifact, controllerArtifact, kcc20Artifact, standardsLock] = await Promise.all([
  readJson("artifacts/KCC20SnapshotBootstrap.placeholder.json"),
  readJson("artifacts/KCC20SnapshotController.placeholder.json"),
  readJson("artifacts/KCC20.placeholder.json"),
  readJson("artifacts/snapshot-standards.lock.json"),
]);
const kw = await loadPinnedKaspaWasm(process.env.SNAPSHOT_TEST_WASM);
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
const deploymentAllocations = [
  ['1000'],
  ['1000', '1000'],
  Array.from({ length: 8 }, () => '1000'),
  [
    '6155259898638223950',
    '5951866420246839519',
    '5757775773333178726',
    '5919898242175782749',
    '4915199665605975056',
  ],
];
for (const { allocations, cellSompi } of [
  ...deploymentAllocations.map(allocations => ({ allocations, cellSompi: undefined })),
  { allocations: ['1000'], cellSompi: '50000000' },
]) {
  const count = allocations.length;
  const definition = {
    ...(cellSompi ? { cellSompi } : {}),
    migrationId: hex(migration), manifestCommitment: hex(manifest), context: hex(context),
    creator: hex(bytes(0x50)), ticker: 'TEST', displayScale: '100',
    totalSupply: allocations.reduce((sum, allocation) => sum + BigInt(allocation), 0n).toString(),
    claimNotBeforeDaaScore: '100', shards: Array.from({length: count}, (_, shardIndex) => ({
      shardIndex, globalIndexStart: shardIndex, holderCount: 1, depth: 1,
      allocationTotal: allocations[shardIndex], initialRoot: hex(root),
    })),
  };
  const expectedCell = cellSompi ?? '200000000';
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
    assert.equal(String(tx.outputs[0].value), expectedCell);
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
  assert.equal(String(deploy.unsignedTransaction.outputs[0].value), expectedCell);
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
  assert.ok(started.unsignedTransaction.outputs.slice(0, count * 2).every(output => String(output.value) === expectedCell));
  const predictedMass = calculateSnapshotStartPredictedSignedMass(
    started.unsignedTransaction,
    count + 1,
  );
  assert.ok(predictedMass.computeMass <= SNAPSHOT_START_MASS_LIMITS.compute);
  assert.ok(predictedMass.storageMass <= SNAPSHOT_START_MASS_LIMITS.storage);
  assert.ok(predictedMass.transientMass <= SNAPSHOT_START_MASS_LIMITS.transient);
  if (allocations.length === 5) {
    assert.ok(predictedMass.computeMass < 400_000n);
    assert.ok(predictedMass.storageMass < 300_000n);
    assert.ok(predictedMass.transientMass < 700_000n);
    assert.ok(
      started.unsignedTransaction.inputs
        .slice(1, count + 1)
        .every((input) => input.signatureScript.length / 2 < 20_000),
    );
    const oversizedStart = structuredClone(started.unsignedTransaction);
    oversizedStart.payload += "00".repeat(100_000);
    assert.throws(
      () => assertSnapshotStartPredictedSignedMass(oversizedStart, count + 1),
      /transient .*\/1000000/,
    );
    const payloadBytes = Buffer.from(started.unsignedTransaction.payload, 'hex');
    const parsed = parseSnapshotKcc20DeploymentPayload(payloadBytes);
    assert.equal(parsed.maxSupply, 28_700_000_000_000_000_000n);
    assert.equal(parsed.premintSupply, parsed.maxSupply);
    assert.deepEqual(parsed.maxSupplyLimbs, {
      high: 3n,
      low: 1_029_883_889_435_672_576n,
    });
    assert.deepEqual(parsed.premintSupplyLimbs, parsed.maxSupplyLimbs);
    assert.deepEqual(
      parsed.reserves.map((reserve) => reserve.amount.toString()),
      allocations,
    );

    const decodedPayload = JSON.parse(payloadBytes.toString('utf8'));
    const maxSupplyArgument = decodedPayload.tn10.args.find(
      (argument) => argument.name === 'maxSupply',
    );
    const premintSupplyArgument = decodedPayload.tn10.args.find(
      (argument) => argument.name === 'premintSupply',
    );
    assert.deepEqual(maxSupplyArgument, {
      name: 'maxSupply',
      type: 'u64[2]',
      value: ['3', '1029883889435672576'],
    });
    assert.deepEqual(premintSupplyArgument, {
      name: 'premintSupply',
      type: 'u64[2]',
      value: ['3', '1029883889435672576'],
    });

    maxSupplyArgument.type = 'u64';
    maxSupplyArgument.value = '28700000000000000000';
    assert.throws(
      () => parseSnapshotKcc20DeploymentPayload(
        new TextEncoder().encode(JSON.stringify(decodedPayload)),
      ),
      /maxSupply scalar deployment argument exceeds signed-64/,
    );
  }
  const verifyArgs = { definition, artifacts, stage: 'snapshot-start', walletAddress: changeAddress,
    maximumFeeSompi: '300000', signingInputIndexes: [count + 1], transactionJson: JSON.stringify(started.unsignedTransaction) };
  verifySnapshotDeploymentTransaction(kw, verifyArgs);
  assert.throws(() => verifySnapshotDeploymentTransaction(kw, {
    ...verifyArgs, definition: { ...definition, cellSompi: expectedCell === '50000000' ? '200000000' : '50000000' },
  }), undefined, 'changing committed principal must not verify');
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
  assert.throws(
    () => prepareSnapshotDeployment(kw, {...definition, shards: definition.shards.map(s => ({...s, depth: 33}))}, artifacts),
    /shard tree configuration|depth/,
  );
  assert.throws(() => prepareSnapshotDeployment(kw, definition, {...artifacts,
    bootstrapArtifact: {...bootstrapArtifact, script: [0]}}), /hash mismatch/);
}
console.log('1, 2, 8, and wide 5 shard deployment order, atomic start, mutation and signature tests passed');

for (const cellSompi of ['', '0', '-1', '49999999', '050000000', '50000000.0', '1e8', '9223372036854775808', 50000000, null]) {
  assert.throws(() => prepareSnapshotDeployment(kw, {
    cellSompi, migrationId: hex(migration), shards: [],
  }, artifacts), /cellSompi/, String(cellSompi));
}
console.log('explicit 0.5 KAS and default 2 KAS deployment principals verified without changing mass gates');
