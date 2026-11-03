import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadPinnedKaspaWasm } from "./load-kaspa-wasm.mjs";
import { createKcomClaimPsktBuilder, kcomClaimCodec } from "../dist/index.js";

const kw = await loadPinnedKaspaWasm(process.env.SNAPSHOT_TEST_WASM);
const artifact = name => JSON.parse(readFileSync(new URL(`../artifacts/${name}`, import.meta.url)));
const graph = artifact("KCOMClaimGraph.artifact.json"), opening = artifact("KCOMClaimOpen.artifact.json");
const vector = JSON.parse(readFileSync(new URL("./fixtures/kcom-claim-script-vectors.json", import.meta.url)));
const fixture = JSON.parse(readFileSync(new URL("./fixtures/kcom-claim-selection-vector.json", import.meta.url)));
const step = fixture.step, args = step.args, codec = kcomClaimCodec({ graph, opening });
const dates = { opens_ms: "1700000000000", closes_ms: "1702592000000", tge_ms: String(step.before.tge_ms) };
const admins = { first: vector.factoryState.first, second: vector.factoryState.second,
  third: vector.factoryState.third };
const decimalFields = new Set(["budget_raw", "manifest_total", "leaf_count", "selected_count",
  "all_weight", "boosted_weight", "long_weight", "shard", "shard_count", "tge_ms"]);
const normalized = state => Object.fromEntries(Object.entries(state).map(([key, value]) =>
  [key, decimalFields.has(key) ? String(value) : value]));
const shardState = { ...normalized(step.before), ...dates, ...admins, closed: false };
const nextState = { ...normalized(step.after), ...dates, ...admins, closed: false };
const authority = new kw.PrivateKey("04".repeat(32));
const sponsorPair = kw.Keypair.random(), sponsorKey = new kw.PrivateKey(sponsorPair.privateKey);
const sponsorAddress = sponsorPair.toAddress("testnet-10").toString();
const source = (id, amount, scriptPublicKey, covenantId) => ({
  outpoint: { transactionId: id, index: 0 }, amount, scriptPublicKey, covenantId,
  entry: { covenantId }, blockDaaScore: 1n, isCoinbase: false,
});
const graphId = vector.graphId;
const shard = source("ad".repeat(32), 100000000n,
  kw.payToScriptHashScript(codec.script("KCOMClaimShard", shardState)), graphId);
const sponsor = source("ae".repeat(32), 1000000000n, kw.payToAddressScript(sponsorAddress), null);
const shardAddress = kw.addressFromScriptPublicKey(shard.scriptPublicKey, "testnet-10").toString();
const rpc = {
  connect: async () => {}, disconnect: async () => {},
  getUtxosByAddresses: async ([address]) => ({ entries: address === shardAddress ? [shard] :
    address === sponsorAddress ? [sponsor] : [] }),
};
const builder = createKcomClaimPsktBuilder({ wasm: kw, artifacts: {
  "KCOMClaimGraph.artifact.json": graph, "KCOMClaimOpen.artifact.json": opening,
}, rpcClientFactory: () => rpc });
const proof = { campaignId: shardState.campaign, leafCount: Number(shardState.leaf_count),
  leaf: { index: args.index, authority: { scheme: 0, identifier: args.key },
    baseEntitlementRaw: String(args.weight) },
  siblings: args.membershipProof.match(/.{64}/g) };
const params = { graphId, shardState, shard: shard.outpoint,
  eligibilityProof: proof, authorityPublicKey: args.key, tier: args.tier,
  beneficiary: { scheme: args.scheme, identifier: args.beneficiary }, unusedProof: args.unusedProof };
const request = (overrides = {}) => ({ schema: "kcc20-in-process-pskt-builder-input/v1",
  request: { builderKey: "kcom-claim.select", network: "testnet-10",
    owner: { walletAddress: sponsorAddress }, params: { ...params, ...overrides } } });
const prepared = await builder(request());
assert.equal(prepared.submitTransactionSupported, false);
const unsigned = kw.Transaction.deserializeFromSafeJSON(prepared.psktTransactionJson);
assert.equal(unsigned.lockTime, BigInt(dates.opens_ms) + 1n);
assert.equal(unsigned.outputs[0].scriptPublicKey.script,
  kw.payToScriptHashScript(codec.script("KCOMClaimShard", nextState)).script);
assert.equal(unsigned.outputs[1].value, 100000000n);
const script = Buffer.from(String(kw.createInputSignature(unsigned, 0, authority, kw.SighashType.All)), "hex");
assert.equal(script[0], 65);
const approval = { publicKey: args.key, signature: script.subarray(1).toString("hex") };
const finalized = await builder(request({ authorityApproval: approval,
  expectedSigningCommitment: prepared.metadata.authoritySigning.signingCommitment }));
assert.equal(finalized.submitTransactionSupported, true);
assert.deepEqual(finalized.signInputs, [{ index: 1, sighashType: 1 }]);
const tx = kw.Transaction.deserializeFromSafeJSON(finalized.psktTransactionJson);
tx.inputs[1].signatureScript = kw.createInputSignature(tx, 1, sponsorKey, kw.SighashType.All);
assert.equal(tx.outputs[0].value, shard.amount);
await assert.rejects(builder(request({ tier: 4 })), /invalid/);
await assert.rejects(builder(request({ authorityPublicKey: "ff".repeat(32) })), /original eligible/);
await assert.rejects(builder(request({ unusedProof: "00".repeat(64) })), /already been selected/);
await assert.rejects(builder(request({ eligibilityProof: { ...proof,
  leaf: { ...proof.leaf, baseEntitlementRaw: "1" } } })), /eligibility proof does not open root/);
await assert.rejects(builder(request({ eligibilityProof: { ...proof,
  leaf: { ...proof.leaf, authority: { scheme: 2, identifier: args.key } } } })), /native Schnorr/);
await assert.rejects(builder(request({ beneficiary: { scheme: 5, identifier: args.beneficiary } })), /invalid/);
await assert.rejects(builder(request({ authorityApproval: approval,
  expectedSigningCommitment: "ff".repeat(32) })), /SIGNING_INTENT_STALE/);
await assert.rejects(builder(request({ shard: { ...shard.outpoint, index: 1 } })), /SOURCE_STALE/);
const alteredFee = createKcomClaimPsktBuilder({ wasm: kw, artifacts: {
  "KCOMClaimGraph.artifact.json": graph, "KCOMClaimOpen.artifact.json": opening,
}, rpcClientFactory: () => rpc,
transactionWithMinimumCalculatedFeeChange: (_runtime, tx, changeIndex) => {
  assert.equal(changeIndex, 2);
  tx.outputs[1].value -= 1n;
  return tx;
} });
await assert.rejects(alteredFee(request()), /changed a claim output/);
console.log("ok KCOM native Schnorr tier selection binds proof, beneficiary, continuation and fee sponsor");
