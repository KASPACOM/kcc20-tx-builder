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
    "5f0caea9818f5bd6110023a7f089a0d26f87d3fd0901cb52e24a32bd1853b302",
  "KCC20SnapshotController.placeholder.json":
    "8c5d2056bb0a445ffc1a6967238fac46378372b5f357524c6795201699bf2b2f",
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
console.log(
  "snapshot artifact pins, immutable controller state, shard/depth/supply limits and scheduled claims passed",
);
