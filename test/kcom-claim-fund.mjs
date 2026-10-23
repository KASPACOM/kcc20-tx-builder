import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadPinnedKaspaWasm } from "./load-kaspa-wasm.mjs";
import {
  buildKcc20ScriptForState,
  createKcc20PsktBuilderEngine,
  createKcomClaimPsktBuilder,
  kcomClaimCodec,
} from "../dist/index.js";

const kw = await loadPinnedKaspaWasm(process.env.SNAPSHOT_TEST_WASM);
const read = (name) => JSON.parse(readFileSync(new URL(`../artifacts/${name}`, import.meta.url)));
const graph = read("KCOMClaimGraph.artifact.json"), opening = read("KCOMClaimOpen.artifact.json"), canonical = read("KCC20.placeholder.json");
const codec = kcomClaimCodec({ graph, opening });
const vectors = JSON.parse(readFileSync(new URL("./fixtures/kcom-claim-script-vectors.json", import.meta.url)));
const graphId = vectors.graphId, tokenId = vectors.tokenId, extension = vectors.extension;
const admin = { 5: "62c0a046dacce86ddd0343c6d3c7c79c2208ba0d9c9cf24a6d046d21d21f90f7", 6: "f006a18d5653c4edf5391ff23a61f03ff83d237e880ee61187fa9f379a028e0a", 7: "989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f" };
const vaultState = {
  campaign: vectors.campaign, terms_hash: vectors.termsHash, token_id: tokenId,
  tge_ms: vectors.tgeMs, budget_raw: vectors.budgetRaw, extension,
  treasury_scheme: vectors.treasuryScheme, treasury: vectors.treasury,
  first: admin[5], second: admin[6], third: admin[7],
  funded: false, opened: false, settled: false, recovered: false,
  liability_raw: "0", activated_raw: "0",
};
const tokenState = {
  amount: vectors.budgetRaw, owner: graphId, ownerScheme: 4,
  borrowScheme: 0, borrowGuard: extension, extensionCommitment: extension,
};
const tokenScript = buildKcc20ScriptForState(canonical, {
  amount: BigInt(vectors.budgetRaw), owner: Buffer.from(graphId, "hex"), ownerScheme: 4,
  borrowScheme: 0, borrowGuard: new Uint8Array(32), extensionCommitment: new Uint8Array(32),
});
const vaultScript = codec.script("KCOMVault", vaultState);
assert.equal(kw.payToScriptHashScript(vaultScript).script, vectors.outputs.initialize.outputs[1], "Argent vault creation script must match builder reconstruction");
const walletAddress = "kaspatest:qpttx29npj9ltqu7yszcw3u8jsytmvmzg8wfctnuvx065y4jjgykw8gm5kcnw";
let serial = 1;
const entry = (script, covenantId, amount) => ({
  outpoint: { transactionId: (serial++).toString(16).padStart(64, "0"), index: 0 },
  amount, scriptPublicKey: script, blockDaaScore: 1n, isCoinbase: false,
  covenantId, entry: { covenantId },
});
const vault = entry(kw.payToScriptHashScript(vaultScript), graphId, 100000000n);
const token = entry(kw.payToScriptHashScript(tokenScript), tokenId, 100000000n);
const funding = entry(kw.payToAddressScript(walletAddress), null, 1000000000n);
const address = (e) => kw.addressFromScriptPublicKey(e.scriptPublicKey, "testnet-10").toString();
const entries = new Map([[address(vault), [vault]], [address(token), [token]], [walletAddress, [funding]]]);
const rpc = {
  connect: async () => {}, disconnect: async () => {},
  getUtxosByAddresses: async ([addr]) => ({ entries: entries.get(addr) ?? [] }),
};
const artifacts = {
  "KCOMClaimGraph.artifact.json": graph,
  "KCOMClaimOpen.artifact.json": opening,
  "KCC20.placeholder.json": canonical,
};
const build = createKcomClaimPsktBuilder({ wasm: kw, artifacts, rpcClientFactory: () => rpc });
const request = (extra = {}) => ({
  schema: "kcc20-in-process-pskt-builder-input/v1",
  request: { builderKey: "kcom-claim.fund-vault", network: "testnet-10", owner: { walletAddress },
    params: { graphId, vaultState, tokenState, vault: vault.outpoint, token: token.outpoint, ...extra } },
});
const result = await build(request());
assert.deepEqual(result.signInputs, [{ index: 2, sighashType: 1 }]);
assert.equal(result.metadata.budgetRaw, "1000");
const tx = kw.Transaction.deserializeFromSafeJSON(result.psktTransactionJson);
assert.equal(tx.inputs.length, 3);
assert.deepEqual(tx.inputs.map(input => Number(input.computeBudget)), [60, 20, 10]);
assert.equal(tx.outputs.length, 3);
assert.equal(String(tx.inputs[0].previousOutpoint.transactionId), vault.outpoint.transactionId);
assert.equal(String(tx.inputs[1].previousOutpoint.transactionId), token.outpoint.transactionId);
assert.equal(String(tx.outputs[0].covenant.covenantId), graphId);
assert.equal(String(tx.outputs[1].covenant.covenantId), tokenId);
assert.equal(tx.outputs[0].scriptPublicKey.script, vectors.outputs["fund-reserve"].outputs[0], "Argent funded vault successor must match builder output");
assert.equal(tx.outputs[1].scriptPublicKey.script, vectors.outputs["fund-reserve"].outputs[1], "Argent canonical reserve must match builder output");
assert(tx.inputs[0].computeBudget >= vectors.outputs["fund-reserve"].computeBudgets[0]);
assert(tx.inputs[1].computeBudget >= vectors.outputs["fund-reserve"].computeBudgets[1]);
assert.equal(tx.outputs[0].value, vault.amount);
assert.equal(tx.outputs[1].value, token.amount);
assert.equal(tx.outputs[2].value, funding.amount - 60000000n);
assert.equal(address({ scriptPublicKey: tx.outputs[0].scriptPublicKey }), address({ scriptPublicKey: kw.payToScriptHashScript(codec.script("KCOMVault", { ...vaultState, funded: true })) }));
assert.equal(address({ scriptPublicKey: tx.outputs[1].scriptPublicKey }), address(token));

const engine = createKcc20PsktBuilderEngine({ wasm: kw, artifacts, rpcClientFactory: () => rpc });
assert.equal((await engine.build(request())).metadata.graphArtifactId, graph.id);
const alteredFeeBuilder = createKcomClaimPsktBuilder({ wasm: kw, artifacts, rpcClientFactory: () => rpc,
  transactionWithMinimumCalculatedFeeChange: (_runtime, transaction) => {
    transaction.outputs[0].value -= 1n;
    return transaction;
  } });
await assert.rejects(alteredFeeBuilder(request()), /changed a custody output/);
const redirectedFeeBuilder = createKcomClaimPsktBuilder({ wasm: kw, artifacts, rpcClientFactory: () => rpc,
  transactionWithMinimumCalculatedFeeChange: (_runtime, transaction, changeIndex) => {
    assert.equal(changeIndex, 2, "campaign fee must adjust sponsor change");
    transaction.outputs[changeIndex].scriptPublicKey = kw.payToScriptHashScript(vaultScript);
    return transaction;
  } });
await assert.rejects(redirectedFeeBuilder(request()), /changed a custody output/);
await assert.rejects(build(request({ tokenState: { ...tokenState, owner: "ff".repeat(32) } })), /graph owned/);
await assert.rejects(build(request({ tokenState: { ...tokenState, amount: "999" } })), /graph owned/);
await assert.rejects(build(request({ vaultState: { ...vaultState, funded: true } })), /awaiting complete funding/);
await assert.rejects(build(request({ vault: { ...vault.outpoint, index: 1 } })), /SOURCE_STALE/);
entries.set(address(vault), [{ ...vault, scriptPublicKey: kw.payToAddressScript(walletAddress) }]);
await assert.rejects(build(request()), /source script differs/);
entries.set(address(vault), [vault]);
entries.set(address(token), [{ ...token, covenantId: "ff".repeat(32), entry: { covenantId: "ff".repeat(32) } }]);
await assert.rejects(build(request()), /SOURCE_STALE/);
entries.set(address(token), [token]);
entries.set(address(vault), []);
await assert.rejects(build(request()), /SOURCE_STALE/);

const factoryState = vectors.factoryState;
const factoryScript = codec.script("KCOMFactory", factoryState);
assert.equal(kw.payToScriptHashScript(factoryScript).script, vectors.outputs["open-funded-campaign"].outputs[0]);
const factory = entry(kw.payToScriptHashScript(factoryScript), graphId, 500000000n);
entries.set(address(factory), [factory]);
const shardRequest = (extra = {}) => ({
  schema: "kcc20-in-process-pskt-builder-input/v1",
  request: { builderKey: "kcom-claim.create-shard", network: "testnet-10", owner: { walletAddress },
    params: { graphId, factoryState, factory: factory.outpoint, ...extra } },
});
const shardBuilt = await build(shardRequest());
assert.deepEqual(shardBuilt.signInputs, [{ index: 1, sighashType: 1 }]);
assert.equal(shardBuilt.metadata.shard, "0");
assert.equal((await engine.build(shardRequest())).metadata.shard, "0");
const shardTx = kw.Transaction.deserializeFromSafeJSON(shardBuilt.psktTransactionJson);
assert.deepEqual(shardTx.inputs.map(input => Number(input.computeBudget)), [30, 10]);
assert.equal(shardTx.outputs.length, 3);
assert.equal(shardTx.outputs[0].scriptPublicKey.script, vectors.outputs["create-shard"].outputs[0]);
assert.equal(shardTx.outputs[1].scriptPublicKey.script, vectors.outputs["create-shard"].outputs[1]);
assert.equal(shardTx.outputs[0].value, 400000000n);
assert.equal(shardTx.outputs[1].value, 100000000n);
assert.equal(shardTx.outputs[2].value, funding.amount - 60000000n);
assert(Number(shardTx.inputs[0].computeBudget) >= vectors.outputs["create-shard"].computeBudgets[0]);
for (let i = 1; i < vectors.createShardSequence.length; i++) {
  const state = { ...factoryState, next_shard: String(i) };
  const sourceScript = codec.script("KCOMFactory", state);
  const sourceSpk = kw.payToScriptHashScript(sourceScript);
  assert.equal(sourceSpk.script, vectors.createShardSequence[i - 1].outputs[0]);
  const source = entry(sourceSpk, graphId, 500000000n - BigInt(i) * 100000000n);
  entries.set(address(source), [source]);
  const built = await build(shardRequest({ factoryState: state, factory: source.outpoint }));
  const transaction = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  const expected = vectors.createShardSequence[i];
  assert.equal(built.metadata.shard, String(i));
  assert.deepEqual(transaction.outputs.slice(0, 2).map(o => o.scriptPublicKey.script), expected.outputs);
  assert.deepEqual(transaction.outputs.slice(0, 2).map(o => String(o.value)), expected.valuesSompi);
  assert(Number(transaction.inputs[0].computeBudget) >= expected.computeBudgets[0]);
}
await assert.rejects(build(shardRequest({ factoryState: { ...factoryState, opened: false } })), /not open/);
await assert.rejects(build(shardRequest({ factoryState: { ...factoryState, next_shard: "4" } })), /No claim shard/);
await assert.rejects(build(shardRequest({ factory: { ...factory.outpoint, index: 1 } })), /SOURCE_STALE/);
entries.set(address(factory), [{ ...factory, scriptPublicKey: kw.payToAddressScript(walletAddress) }]);
await assert.rejects(build(shardRequest()), /SOURCE_STALE/);
entries.set(address(factory), [{ ...factory, covenantId: "ff".repeat(32), entry: { covenantId: "ff".repeat(32) } }]);
await assert.rejects(build(shardRequest()), /SOURCE_STALE/);
entries.set(address(factory), []);
await assert.rejects(build(shardRequest()), /SOURCE_STALE/);
entries.set(address(factory), [factory]);
const alteredShardFeeBuilder = createKcomClaimPsktBuilder({ wasm: kw, artifacts, rpcClientFactory: () => rpc,
  transactionWithMinimumCalculatedFeeChange: (_runtime, transaction) => {
    transaction.outputs[1].value -= 1n;
    return transaction;
  } });
await assert.rejects(alteredShardFeeBuilder(shardRequest()), /changed a shard output/);
await assert.rejects(redirectedFeeBuilder(shardRequest()), /changed a shard output/);
console.log("ok KCOM claim vault funding and shard creation PSKTs, live-source checks and output reconstruction");
