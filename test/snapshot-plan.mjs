import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  buildControllerGenesisPlan,
  buildSnapshotTokenMetadata,
  claimActivation,
  entitlementLeaf,
  branchNode,
  foldProof,
  transitionClaim,
} from "../dist/snapshot-signerless.js";
const artifact = (name) =>
  readFile(new URL(`../artifacts/${name}`, import.meta.url), "utf8");
const pins = {
  "KCC20.placeholder.json":
    "a45d06e8351421dac1ef73f3595c6f34068e4fa1e13d3f8fa1c88be518c6e56f",
  "KCC20SnapshotBootstrap.placeholder.json":
    "daddabe50454e1c6c187c0b027cc8887f79f0f0086a14f26c6a2a56054991ebb",
  "KCC20SnapshotController.placeholder.json":
    "a73727cfe03108097e1226566cff9dbbbf42a5dc8526aac3196817ffc642212f",
};
for (const [name, hash] of Object.entries(pins))
  assert.equal(
    createHash("sha256")
      .update(await artifact(name))
      .digest("hex"),
    hash,
  );
const artifacts = {
  kcc20Artifact: JSON.parse(await artifact("KCC20.placeholder.json")),
  bootstrapArtifact: JSON.parse(
    await artifact("KCC20SnapshotBootstrap.placeholder.json"),
  ),
  controllerArtifact: JSON.parse(
    await artifact("KCC20SnapshotController.placeholder.json"),
  ),
};
const hex = (value) => value.repeat(64);
const definition = {
  ...artifacts,
  migrationId: hex("1"),
  migrationCommitment: hex("1"),
  manifestCommitment: hex("2"),
  context: hex("3"),
  holderExtensionCommitment: hex("4"),
  deploymentGuardCommitment: hex("5"),
  claimNotBeforeDaaScore: "100",
  shardCount: 1,
  shard: {
    shardIndex: 0,
    globalIndexStart: 0,
    holderCount: 1,
    depth: 1,
    initialRoot: hex("6"),
    allocationTotal: "123",
  },
};
const plan = buildControllerGenesisPlan(definition);
assert.equal(plan.controllerState.tokenId, hex("0"));
assert.equal(plan.controllerState.remainingAmount, "123");
assert.equal(plan.controllerState.shardCount, "1");
assert.throws(() =>
  buildControllerGenesisPlan({ ...definition, shardCount: 9 }),
);
assert.throws(() =>
  buildControllerGenesisPlan({
    ...definition,
    shard: { ...definition.shard, depth: 33 },
  }),
);
assert.throws(() =>
  buildControllerGenesisPlan({
    ...definition,
    deploymentGuardCommitment: hex("0"),
  }),
);
assert.throws(() =>
  buildControllerGenesisPlan({
    ...definition,
    shard: { ...definition.shard, allocationTotal: "9223372036854775808" },
  }),
);
assert.throws(() => claimActivation(100n, 99n, 0n));
assert.throws(() => claimActivation(100n, 101n, 0n));
assert.throws(() => claimActivation(100n, 100n, 1n));
assert.equal(claimActivation(100n).lockTime, 100n);
assert.throws(() => claimActivation(500000000000n));
const wideMetadata = buildSnapshotTokenMetadata({
  migrationId: "nacho-wide-supply",
  creator: hex("1"),
  ticker: hex("2"),
  name: hex("3"),
  displayScale: "100000000",
  totalAllocation: "28700000000000000000",
  protocolFeeRecipient: hex("4"),
});
assert.equal(wideMetadata.totalSupply, "28700000000000000000");
assert.match(wideMetadata.holderExtensionCommitment, /^[0-9a-f]{64}$/);
const ascii32 = (value) => {
  const result = new Uint8Array(32);
  result.set(new TextEncoder().encode(value));
  return result;
};
const nachoMetadata = buildSnapshotTokenMetadata({
  migrationId: "nacho-holder-v2-vector",
  creator: hex("1"),
  ticker: ascii32("NACHO"),
  name: ascii32("NACHO"),
  displayScale: "100000000",
  totalAllocation: "28700000000000000000",
  treasury: hex("2"),
  protocolFeeRecipient: hex("3"),
});
assert.equal(
  nachoMetadata.holderExtensionCommitment,
  "d4ce4bdf083185b68eca5a30bf98aa065ed1cbebc8d366d08c3c79d49d49ad0e",
);
console.log(
  "snapshot artifact pins, immutable controller state, shard/depth/supply limits and scheduled claims passed",
);
