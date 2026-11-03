import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadPinnedKaspaWasm } from "./load-kaspa-wasm.mjs";
import { createKcomClaimPsktBuilder, kcomClaimCodec } from "../dist/index.js";

const kw = await loadPinnedKaspaWasm(process.env.SNAPSHOT_TEST_WASM);
const artifact = name => JSON.parse(readFileSync(new URL(`../artifacts/${name}`, import.meta.url)));
const graph = artifact("KCOMClaimGraph.artifact.json"), opening = artifact("KCOMClaimOpen.artifact.json");
const vector = JSON.parse(readFileSync(new URL("./fixtures/kcom-claim-script-vectors.json", import.meta.url)));
const fixture = JSON.parse(readFileSync(new URL("./fixtures/kcom-claim-settlement-vector.json", import.meta.url)));
const step = fixture.step, codec = kcomClaimCodec({ graph, opening });
const numbers = new Set(["budget_raw", "manifest_total", "leaf_count", "selected_count", "all_weight",
  "boosted_weight", "long_weight", "shard", "shard_count", "next_shard", "tge_ms",
  "settled_count", "liability_raw", "index", "weight", "tier"]);
const normalize = state => Object.fromEntries(Object.entries(state).map(([key, value]) =>
  [key, numbers.has(key) ? String(value) : value]));
const dates = { opens_ms: "1700000000000", closes_ms: "1702592000000", tge_ms: String(step.before.tge_ms) };
const admins = { first: vector.factoryState.first, second: vector.factoryState.second,
  third: vector.factoryState.third };
const collectorState = { ...normalize(step.before), ...dates, ...admins };
const nextState = { ...normalize(step.after), ...dates, ...admins };
const commitmentState = normalize(step.claim), entitlementState = normalize(step.entitlement);
const sponsorPair = kw.Keypair.random(), sponsorAddress = sponsorPair.toAddress("testnet-10").toString();
const source = (id, amount, scriptPublicKey, covenantId) => ({
  outpoint: { transactionId: id, index: 0 }, amount, scriptPublicKey, covenantId,
  entry: { covenantId }, blockDaaScore: 1n, isCoinbase: false,
});
const graphId = vector.graphId;
const collector = source("b1".repeat(32), 100000000n,
  kw.payToScriptHashScript(codec.script("KCOMSettlement", collectorState)), graphId);
const commitment = source("b2".repeat(32), 100000000n,
  kw.payToScriptHashScript(codec.script("KCOMClaimCommitment", commitmentState)), graphId);
const sponsor = source("b3".repeat(32), 1000000000n, kw.payToAddressScript(sponsorAddress), null);
const address = entry => kw.addressFromScriptPublicKey(entry.scriptPublicKey, "testnet-10").toString();
const entries = new Map([[address(collector), [collector]], [address(commitment), [commitment]],
  [sponsorAddress, [sponsor]]]);
const rpc = { connect: async () => {}, disconnect: async () => {},
  getUtxosByAddresses: async ([addr]) => ({ entries: entries.get(addr) ?? [] }) };
const options = { wasm: kw, artifacts: { "KCOMClaimGraph.artifact.json": graph,
  "KCOMClaimOpen.artifact.json": opening }, rpcClientFactory: () => rpc };
const builder = createKcomClaimPsktBuilder(options);
const params = { graphId, collectorState, commitmentState, closedShardSummary: step.summary,
  collector: collector.outpoint, commitment: commitment.outpoint,
  summaryProof: step.summaryProof, summaryDepth: step.summaryDepth,
  usedProof: step.usedProof, usedDepth: step.usedDepth };
const request = (extra = {}) => ({ schema: "kcc20-in-process-pskt-builder-input/v1",
  request: { builderKey: "kcom-claim.settle", network: "testnet-10",
    owner: { walletAddress: sponsorAddress }, params: { ...params, ...extra } } });
const built = await builder(request());
assert.equal(built.submitTransactionSupported, true);
assert.deepEqual(built.signInputs, [{ index: 2, sighashType: 1 }]);
assert.equal(built.metadata.allocationRaw, step.totalRaw);
const tx = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
assert.equal(tx.lockTime, BigInt(dates.closes_ms) + 2n);
assert.equal(tx.outputs[0].scriptPublicKey.script,
  kw.payToScriptHashScript(codec.script("KCOMSettlement", nextState)).script);
assert.equal(tx.outputs[1].scriptPublicKey.script,
  kw.payToScriptHashScript(codec.script("KCOMEntitlement", entitlementState)).script);
assert.equal(tx.outputs[0].value, collector.amount);
assert.equal(tx.outputs[1].value, commitment.amount);
await assert.rejects(builder(request({ summaryProof: "00".repeat(64) })), /summary does not open/);
await assert.rejects(builder(request({ usedProof: "00".repeat(64) })), /does not open its final used root/);
await assert.rejects(builder(request({ commitmentState: { ...commitmentState,
  beneficiary: "ff".repeat(32) } })), /does not open its final used root/);
await assert.rejects(builder(request({ commitment: { ...commitment.outpoint, index: 1 } })), /SOURCE_STALE/);
const alteredFee = createKcomClaimPsktBuilder({ ...options,
  transactionWithMinimumCalculatedFeeChange: (_runtime, tx, index) => {
    assert.equal(index, 2); tx.outputs[1].value -= 1n; return tx;
  } });
await assert.rejects(alteredFee(request()), /changed an entitlement or source/);
console.log("ok KCOM selected commitment settles into exact immutable entitlement");
