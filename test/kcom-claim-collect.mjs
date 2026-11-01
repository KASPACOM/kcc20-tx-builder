import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blake3 } from "@noble/hashes/blake3";
import { loadPinnedKaspaWasm } from "./load-kaspa-wasm.mjs";
import { createKcomClaimPsktBuilder, kcomClaimCodec } from "../dist/index.js";

const kw = await loadPinnedKaspaWasm(process.env.SNAPSHOT_TEST_WASM);
const read = name => JSON.parse(readFileSync(new URL(`../artifacts/${name}`, import.meta.url)));
const graph = read("KCOMClaimGraph.artifact.json"), opening = read("KCOMClaimOpen.artifact.json");
const codec = kcomClaimCodec({ graph, opening });
const vector = JSON.parse(readFileSync(new URL("./fixtures/kcom-claim-script-vectors.json", import.meta.url)));
const enc = new TextEncoder();
const digest = (name, ...parts) => blake3(Buffer.concat([
  enc.encode(`kcom.claim.summary.${name}/v1\0`), ...parts,
]));
const campaign = Buffer.from(vector.campaign, "hex");
const shardIndex = Buffer.alloc(4);
const closed = {
  campaign: vector.campaign, terms_hash: vector.termsHash, token_id: vector.tokenId,
  budget_raw: vector.budgetRaw, manifest_total: "198", eligibility_root: vector.seal.collectorState.eligibility_root,
  used_root: "12".repeat(32), leaf_count: "4", selected_count: "1", all_weight: "27",
  boosted_weight: "0", long_weight: "0", shard: "0", shard_count: "1",
  first: vector.factoryState.first, second: vector.factoryState.second, third: vector.factoryState.third,
  opens_ms: "1700000000000", closes_ms: "1702592000000", tge_ms: "1703196800000", closed: true,
};
const initialRoot = Buffer.from(digest("empty", campaign, shardIndex)).toString("hex");
const collectorState = {
  ...vector.seal.collectorState, shard_count: "1", next_shard: "0", selected_count: "0",
  all_weight: "0", boosted_weight: "0", long_weight: "0", summaries_root: initialRoot,
  opens_ms: closed.opens_ms, closes_ms: closed.closes_ms, tge_ms: closed.tge_ms,
  collection_complete: false, settled_count: "0", liability_raw: "0", settlement_complete: false,
};
const source = (transactionId, amount, scriptPublicKey, covenantId) => ({
  outpoint: { transactionId, index: 0 }, amount, scriptPublicKey, covenantId,
  entry: { covenantId }, blockDaaScore: 1n, isCoinbase: false,
});
const nativeAddress = "kaspatest:qpttx29npj9ltqu7yszcw3u8jsytmvmzg8wfctnuvx065y4jjgykw8gm5kcnw";
const collector = source("e4".repeat(32), 100000000n,
  kw.payToScriptHashScript(codec.script("KCOMSettlement", collectorState)), vector.graphId);
const shard = source("e5".repeat(32), 100000000n,
  kw.payToScriptHashScript(codec.script("KCOMClaimShard", closed)), vector.graphId);
const sponsor = source("e6".repeat(32), 500000000n, kw.payToAddressScript(nativeAddress), null);
const address = entry => kw.addressFromScriptPublicKey(entry.scriptPublicKey, "testnet-10").toString();
const entries = new Map([[address(collector), [collector]], [address(shard), [shard]], [nativeAddress, [sponsor]]]);
const rpc = {
  connect: async () => {}, disconnect: async () => {},
  getUtxosByAddresses: async ([addr]) => ({ entries: entries.get(addr) ?? [] }),
};
const options = { wasm: kw, artifacts: {
  "KCOMClaimGraph.artifact.json": graph, "KCOMClaimOpen.artifact.json": opening,
}, rpcClientFactory: () => rpc };
const build = createKcomClaimPsktBuilder(options);
const request = (extra = {}) => ({
  schema: "kcc20-in-process-pskt-builder-input/v1",
  request: { builderKey: "kcom-claim.collect", network: "testnet-10", owner: { walletAddress: nativeAddress },
    params: { graphId: vector.graphId, collectorState, closedShardState: closed, depth: 0,
      unusedProof: "", collector: collector.outpoint, closedShard: shard.outpoint, ...extra } },
});
const result = await build(request());
assert.deepEqual(result.signInputs, [{ index: 2, sighashType: 1 }]);
const tx = kw.Transaction.deserializeFromSafeJSON(result.psktTransactionJson);
assert.equal(tx.lockTime, BigInt(closed.closes_ms) + 2n);
assert.equal(tx.outputs[0].value, collector.amount + shard.amount);
assert.equal(String(tx.outputs[0].covenant?.covenantId), vector.graphId);
assert.equal(tx.outputs[1].value, sponsor.amount - 60000000n);
assert.equal(tx.outputs[1].scriptPublicKey.script, kw.payToAddressScript(nativeAddress).script);
assert.equal(result.metadata.shard, "0");
await assert.rejects(build(request({ collectorState: { ...collectorState, summaries_root: "ff".repeat(32) } })), /empty summary slot/);
await assert.rejects(build(request({ closedShardState: { ...closed, used_root: "ff".repeat(32) } })), /SOURCE_STALE/);
await assert.rejects(build(request({ closedShard: { ...shard.outpoint, index: 5 } })), /SOURCE_STALE/);
await assert.rejects(build(request({ depth: 1 })), /not ready for collection/);
const mutated = createKcomClaimPsktBuilder({ ...options,
  transactionWithMinimumCalculatedFeeChange: (_runtime, transaction, index) => {
    assert.equal(index, 1);
    transaction.outputs[0].value -= 1n;
    return transaction;
  },
});
await assert.rejects(mutated(request()), /changed a custody output/);
const alteredWitness = createKcomClaimPsktBuilder({ ...options,
  transactionWithMinimumCalculatedFeeChange: (_runtime, transaction) => {
    transaction.inputs[1].signatureScript = "";
    return transaction;
  },
});
await assert.rejects(alteredWitness(request()), /changed a custody output/);
const alteredTime = createKcomClaimPsktBuilder({ ...options,
  transactionWithMinimumCalculatedFeeChange: (_runtime, transaction) => {
    transaction.lockTime = 0n;
    return transaction;
  },
});
await assert.rejects(alteredTime(request()), /changed a custody output/);
console.log("ok KCOM closed-shard collection reconstructs summary state and guards source and custody outputs");
