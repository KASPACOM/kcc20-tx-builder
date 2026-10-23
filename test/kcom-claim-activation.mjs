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
const read = name => JSON.parse(readFileSync(new URL(`../artifacts/${name}`, import.meta.url)));
const vectors = JSON.parse(readFileSync(new URL("./fixtures/kcom-claim-script-vectors.json", import.meta.url)));
const graph = read("KCOMClaimGraph.artifact.json");
const opening = read("KCOMClaimOpen.artifact.json");
const canonical = read("KCC20.placeholder.json");
const vesting = read("KCOMVesting.artifact.json");
const codec = kcomClaimCodec({ graph, opening });
const graphId = vectors.graphId, tokenId = vectors.tokenId;
const first = vectors.firstActivation;
const walletAddress = "kaspatest:qpttx29npj9ltqu7yszcw3u8jsytmvmzg8wfctnuvx065y4jjgykw8gm5kcnw";
const vaultState = {
  campaign: vectors.campaign, terms_hash: vectors.termsHash, token_id: tokenId,
  tge_ms: vectors.tgeMs, budget_raw: vectors.budgetRaw, extension: vectors.extension,
  treasury_scheme: vectors.treasuryScheme, treasury: vectors.treasury,
  first: vectors.factoryState.first, second: vectors.factoryState.second, third: vectors.factoryState.third,
  funded: true, opened: true, settled: true, recovered: true,
  liability_raw: vectors.liabilityRaw, activated_raw: "0",
};
const tokenState = {
  amount: vectors.liabilityRaw, owner: graphId, ownerScheme: 4, borrowScheme: 0,
  borrowGuard: vectors.extension, extensionCommitment: vectors.extension,
};
const tokenScript = buildKcc20ScriptForState(canonical, {
  amount: BigInt(tokenState.amount), owner: Buffer.from(graphId, "hex"), ownerScheme: 4,
  borrowScheme: 0, borrowGuard: new Uint8Array(32), extensionCommitment: new Uint8Array(32),
});
const source = (input, amount, scriptPublicKey, covenantId) => ({
  outpoint: { transactionId: input.transactionId, index: input.index },
  amount, scriptPublicKey, covenantId, entry: { covenantId }, blockDaaScore: 1n, isCoinbase: false,
});
const [v, e, t, f] = first.inputs;
const vault = source(v, 600000000n, kw.payToScriptHashScript(codec.script("KCOMVault", vaultState)), graphId);
const entitlement = source(e, 100000000n, kw.payToScriptHashScript(codec.script("KCOMEntitlement", first.entitlementState)), graphId);
const token = source(t, 100000000n, kw.payToScriptHashScript(tokenScript), tokenId);
const sponsor = source(f, 500000000n, kw.payToAddressScript(walletAddress), null);
const addr = entry => kw.addressFromScriptPublicKey(entry.scriptPublicKey, "testnet-10").toString();
const entries = new Map([[addr(vault), [vault]], [addr(entitlement), [entitlement]], [addr(token), [token]], [walletAddress, [sponsor]]]);
const rpc = {
  connect: async () => {}, disconnect: async () => {},
  getUtxosByAddresses: async ([address]) => ({ entries: entries.get(address) ?? [] }),
};
const build = createKcomClaimPsktBuilder({
  wasm: kw, artifacts: {
    "KCOMClaimGraph.artifact.json": graph, "KCOMClaimOpen.artifact.json": opening,
    "KCC20.placeholder.json": canonical, "KCOMVesting.artifact.json": vesting,
  }, rpcClientFactory: () => rpc,
});
const request = (extra = {}) => ({
  schema: "kcc20-in-process-pskt-builder-input/v1",
  request: { builderKey: "kcom-claim.activate", network: "testnet-10", owner: { walletAddress },
    params: { graphId, vaultState, entitlementState: first.entitlementState, tokenState,
      vault: vault.outpoint, entitlement: entitlement.outpoint, token: token.outpoint, ...extra } },
});
const built = await build(request());
const engine = createKcc20PsktBuilderEngine({
  wasm: kw, artifacts: {
    "KCOMClaimGraph.artifact.json": graph, "KCOMClaimOpen.artifact.json": opening,
    "KCC20.placeholder.json": canonical, "KCOMVesting.artifact.json": vesting,
  }, rpcClientFactory: () => rpc,
});
assert.equal((await engine.build(request())).metadata.positionId, first.positionId);
const tx = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
assert.deepEqual(built.signInputs, [{ index: 3, sighashType: 1 }]);
assert.equal(built.metadata.positionId, first.positionId);
assert.equal(built.metadata.allocationRaw, first.allocationRaw);
assert.equal(built.metadata.final, false);
assert.equal(tx.inputs.length, 4);
assert.equal(tx.outputs.length, 5);
assert.deepEqual(tx.outputs.slice(0, 4).map(out => out.scriptPublicKey.script), first.outputs.map(out => out.scriptPublicKeyHex));
assert.deepEqual(tx.outputs.slice(0, 4).map(out => String(out.value)), first.outputs.map(out => out.valueSompi));
assert.deepEqual(tx.outputs.slice(0, 4).map(out => String(out.covenant?.covenantId)), first.outputs.map(out => out.covenantId));
assert.equal(tx.outputs[4].value, sponsor.amount - 160000000n);
assert.equal(tx.inputs[0].computeBudget >= v.computeBudget, true);
assert.equal(tx.inputs[2].computeBudget >= t.computeBudget, true);
await assert.rejects(build(request({ entitlementState: { ...first.entitlementState, beneficiary: "ff".repeat(32) } })), /SOURCE_STALE/);
await assert.rejects(build(request({ tokenState: { ...tokenState, amount: "995" } })), /reserve does not match/);
await assert.rejects(build(request({ vaultState: { ...vaultState, settled: false } })), /not settled/);
await assert.rejects(build(request({ token: { ...token.outpoint, index: 9 } })), /SOURCE_STALE/);
const alteredFeeBuild = createKcomClaimPsktBuilder({
  wasm: kw, artifacts: {
    "KCOMClaimGraph.artifact.json": graph, "KCOMClaimOpen.artifact.json": opening,
    "KCC20.placeholder.json": canonical, "KCOMVesting.artifact.json": vesting,
  }, rpcClientFactory: () => rpc,
  transactionWithMinimumCalculatedFeeChange: (_runtime, transaction, changeIndex) => {
    assert.equal(changeIndex, 4);
    transaction.outputs[2].value -= 1n;
    return transaction;
  },
});
await assert.rejects(alteredFeeBuild(request()), /changed a custody output/);
const redirectedFeeBuild = createKcomClaimPsktBuilder({
  wasm: kw, artifacts: {
    "KCOMClaimGraph.artifact.json": graph, "KCOMClaimOpen.artifact.json": opening,
    "KCC20.placeholder.json": canonical, "KCOMVesting.artifact.json": vesting,
  }, rpcClientFactory: () => rpc,
  transactionWithMinimumCalculatedFeeChange: (_runtime, transaction, changeIndex) => {
    assert.equal(changeIndex, 4);
    transaction.outputs[changeIndex].scriptPublicKey = kw.payToScriptHashScript(codec.script("KCOMVault", vaultState));
    return transaction;
  },
});
await assert.rejects(redirectedFeeBuild(request()), /changed a custody output/);
entries.set(addr(entitlement), [{ ...entitlement, covenantId: tokenId, entry: { covenantId: tokenId } }]);
await assert.rejects(build(request()), /SOURCE_STALE/);
entries.set(addr(entitlement), [entitlement]);

const last = vectors.lastActivation;
const finalVaultState = { ...vaultState, activated_raw: String(BigInt(vectors.liabilityRaw) - BigInt(last.allocationRaw)) };
const finalTokenState = { ...tokenState, amount: last.allocationRaw };
const finalTokenScript = buildKcc20ScriptForState(canonical, {
  amount: BigInt(last.allocationRaw), owner: Buffer.from(graphId, "hex"), ownerScheme: 4,
  borrowScheme: 0, borrowGuard: new Uint8Array(32), extensionCommitment: new Uint8Array(32),
});
const [fv, fe, ft] = last.inputs;
const finalVault = source(fv, 600000000n, kw.payToScriptHashScript(codec.script("KCOMVault", finalVaultState)), graphId);
const finalEntitlement = source(fe, 100000000n, kw.payToScriptHashScript(codec.script("KCOMEntitlement", last.entitlementState)), graphId);
const finalToken = source(ft, 100000000n, kw.payToScriptHashScript(finalTokenScript), tokenId);
for (const entry of [finalVault, finalEntitlement, finalToken]) entries.set(addr(entry), [entry]);
const finalResult = await build(request({
  vaultState: finalVaultState, entitlementState: last.entitlementState, tokenState: finalTokenState,
  vault: finalVault.outpoint, entitlement: finalEntitlement.outpoint, token: finalToken.outpoint,
}));
const finalTx = kw.Transaction.deserializeFromSafeJSON(finalResult.psktTransactionJson);
assert.equal(finalResult.metadata.final, true);
assert.equal(finalResult.metadata.positionId, last.positionId);
assert.deepEqual(finalResult.signInputs, [{ index: 3, sighashType: 1 }]);
assert.equal(finalTx.outputs.length, 4);
assert.deepEqual(finalTx.outputs.slice(0, 3).map(out => out.scriptPublicKey.script), last.outputs.map(out => out.scriptPublicKeyHex));
assert.deepEqual(finalTx.outputs.slice(0, 3).map(out => String(out.covenant?.covenantId)), last.outputs.map(out => out.covenantId));
assert.equal(finalTx.outputs[3].value, sponsor.amount - 60000000n);
assert.equal(finalTx.inputs[0].computeBudget >= fv.computeBudget, true);
assert.equal(finalTx.inputs[2].computeBudget >= ft.computeBudget, true);
console.log("ok KCOM claim partial/final activation PSKTs match Argent outputs and position IDs");
