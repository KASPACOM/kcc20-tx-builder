import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadPinnedKaspaWasm } from "./load-kaspa-wasm.mjs";
import { buildKcc20ScriptForState, createKcomClaimPsktBuilder, kcomClaimCodec } from "../dist/index.js";

const kw = await loadPinnedKaspaWasm(process.env.SNAPSHOT_TEST_WASM);
const read = name => JSON.parse(readFileSync(new URL(`../artifacts/${name}`, import.meta.url)));
const vector = JSON.parse(readFileSync(new URL("./fixtures/kcom-claim-script-vectors.json", import.meta.url)));
const graph = read("KCOMClaimGraph.artifact.json"), opening = read("KCOMClaimOpen.artifact.json");
const canonical = read("KCC20.placeholder.json"), codec = kcomClaimCodec({ graph, opening });
const graphId = vector.graphId, tokenId = vector.tokenId, zero = "00".repeat(32);
const adminKeys = [5, 6].map(n => new kw.PrivateKey(n.toString(16).padStart(2, "0").repeat(32)));
const adminPublicKeys = [vector.factoryState.first, vector.factoryState.second];
const sponsorPair = kw.Keypair.random(), sponsorAddress = sponsorPair.toAddress("testnet-10").toString();
const source = (id, amount, scriptPublicKey, covenantId) => ({
  outpoint: { transactionId: id, index: 0 }, amount, scriptPublicKey, covenantId,
  entry: { covenantId }, blockDaaScore: 1n, isCoinbase: false,
});
const sponsor = source("c3".repeat(32), 500000000n, kw.payToAddressScript(sponsorAddress), null);
const addr = entry => kw.addressFromScriptPublicKey(entry.scriptPublicKey, "testnet-10").toString();
const entries = new Map([[sponsorAddress, [sponsor]]]);
const rpc = { connect: async () => {}, disconnect: async () => {},
  getUtxosByAddresses: async ([address]) => ({ entries: entries.get(address) ?? [] }) };
const options = { wasm: kw, artifacts: { "KCOMClaimGraph.artifact.json": graph,
  "KCOMClaimOpen.artifact.json": opening, "KCC20.placeholder.json": canonical },
  rpcClientFactory: () => rpc };
const build = createKcomClaimPsktBuilder(options);
const baseState = {
  campaign: vector.campaign, terms_hash: vector.termsHash, token_id: tokenId,
  tge_ms: vector.tgeMs, budget_raw: vector.budgetRaw, extension: vector.extension,
  treasury_scheme: vector.treasuryScheme, treasury: vector.treasury,
  first: vector.factoryState.first, second: vector.factoryState.second,
  third: vector.factoryState.third,
  funded: true, opened: true, settled: true, recovered: false, activated_raw: "0",
};
const tokenState = { amount: vector.budgetRaw, owner: graphId, ownerScheme: 4,
  borrowScheme: 0, borrowGuard: zero, extensionCommitment: vector.extension };
const tokenScript = buildKcc20ScriptForState(canonical, {
  amount: BigInt(tokenState.amount), owner: Buffer.from(graphId, "hex"), ownerScheme: 4,
  borrowScheme: 0, borrowGuard: Buffer.alloc(32), extensionCommitment: Buffer.alloc(32),
});
const token = source("c2".repeat(32), 100000000n, kw.payToScriptHashScript(tokenScript), tokenId);
entries.set(addr(token), [token]);
const request = (vaultState, vault, extra = {}) => ({
  schema: "kcc20-in-process-pskt-builder-input/v1",
  request: { builderKey: "kcom-claim.recover", network: "testnet-10",
    owner: { walletAddress: sponsorAddress }, params: {
      graphId, vaultState, vault: vault.outpoint, tokenState, token: token.outpoint,
      adminPublicKeys, ...extra,
    } },
});
for (const [name, liability, partial] of [["partial", vector.liabilityRaw, true], ["final", "0", false]]) {
  const vaultState = { ...baseState, liability_raw: liability };
  const vault = source(partial ? "c1".repeat(32) : "c4".repeat(32), 600000000n,
    kw.payToScriptHashScript(codec.script("KCOMVault", vaultState)), graphId);
  entries.set(addr(vault), [vault]);
  const prepared = await build(request(vaultState, vault));
  assert.equal(prepared.submitTransactionSupported, false);
  const unsigned = kw.Transaction.deserializeFromSafeJSON(prepared.psktTransactionJson);
  assert.equal(unsigned.outputs.length, partial ? 4 : 3);
  assert.equal(unsigned.outputs[0].scriptPublicKey.script,
    kw.payToScriptHashScript(codec.script("KCOMVault", { ...vaultState, recovered: true })).script);
  assert.equal(prepared.metadata.surplusRaw,
    String(BigInt(vector.budgetRaw) - BigInt(liability)));
  assert.equal(prepared.metadata.remainingLiabilityRaw, liability);
  if (partial) {
    assert.deepEqual(unsigned.outputs.slice(0, 3).map(output => output.scriptPublicKey.script),
      vector.outputs["recover-partial"].outputs);
    assert.equal(unsigned.outputs[2].value, 100000000n);
  }
  const approvals = adminKeys.map((key, i) => {
    const script = Buffer.from(String(kw.createInputSignature(unsigned, 0, key, kw.SighashType.All)), "hex");
    assert.equal(script[0], 65);
    return { publicKey: adminPublicKeys[i], signature: script.subarray(1).toString("hex") };
  });
  const finalized = await build(request(vaultState, vault, { adminApprovals: approvals,
    expectedSigningCommitment: prepared.metadata.adminSigning.signingCommitment }));
  assert.equal(finalized.submitTransactionSupported, true);
  assert.deepEqual(finalized.signInputs, [{ index: 2, sighashType: 1 }]);
  await assert.rejects(build(request(vaultState, vault, { adminApprovals: approvals,
    expectedSigningCommitment: "ff".repeat(32) })), /SIGNING_INTENT_STALE/);
  await assert.rejects(build(request(vaultState, vault, { tokenState: { ...tokenState,
    amount: "999" } })), /Vault reserve does not match/);
  await assert.rejects(build(request(vaultState, vault, { vault: { ...vault.outpoint,
    index: 1 } })), /SOURCE_STALE/);
  const altered = createKcomClaimPsktBuilder({ ...options,
    transactionWithMinimumCalculatedFeeChange: (_runtime, tx, index) => {
      assert.equal(index, partial ? 3 : 2);
      tx.outputs[1].value -= 1n; return tx;
    } });
  await assert.rejects(altered(request(vaultState, vault)), /changed a custody output/);
  console.log(`ok KCOM ${name} surplus recovery preserves immutable liabilities`);
}
