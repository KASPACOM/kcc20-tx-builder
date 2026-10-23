import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadPinnedKaspaWasm } from "./load-kaspa-wasm.mjs";
import { createKcomClaimPsktBuilder, kcomClaimCodec } from "../dist/index.js";

const kw = await loadPinnedKaspaWasm(process.env.SNAPSHOT_TEST_WASM);
const read = name => JSON.parse(readFileSync(new URL(`../artifacts/${name}`, import.meta.url)));
const graph = read("KCOMClaimGraph.artifact.json"), opening = read("KCOMClaimOpen.artifact.json");
const vector = JSON.parse(readFileSync(new URL("./fixtures/kcom-claim-script-vectors.json", import.meta.url)));
const codec = kcomClaimCodec({ graph, opening });
const administrators = [kw.Keypair.random(), kw.Keypair.random(), kw.Keypair.random()];
const keys = administrators.map(pair => new kw.PrivateKey(pair.privateKey));
const publicKeys = administrators.map(pair => String(pair.xOnlyPublicKey));
const factoryState = {
  ...vector.factoryState, first: publicKeys[0], second: publicKeys[1], third: publicKeys[2],
  next_shard: "0", opened: false,
};
const vaultState = {
  campaign: vector.campaign, terms_hash: vector.termsHash, token_id: vector.tokenId,
  tge_ms: vector.tgeMs, budget_raw: vector.budgetRaw, extension: vector.extension,
  treasury_scheme: vector.treasuryScheme, treasury: vector.treasury,
  first: publicKeys[0], second: publicKeys[1], third: publicKeys[2],
  funded: true, opened: false, settled: false, recovered: false,
  liability_raw: "0", activated_raw: "0",
};
const source = (transactionId, amount, scriptPublicKey, covenantId) => ({
  outpoint: { transactionId, index: 0 }, amount, scriptPublicKey, covenantId,
  entry: { covenantId }, blockDaaScore: 1n, isCoinbase: false,
});
const factory = source("f3".repeat(32), 500000000n,
  kw.payToScriptHashScript(codec.script("KCOMFactory", factoryState)), vector.graphId);
const vault = source("f4".repeat(32), 100000000n,
  kw.payToScriptHashScript(codec.script("KCOMVault", vaultState)), vector.graphId);
const sponsorAddress = "kaspatest:qpttx29npj9ltqu7yszcw3u8jsytmvmzg8wfctnuvx065y4jjgykw8gm5kcnw";
const sponsor = source("f5".repeat(32), 1000000000n, kw.payToAddressScript(sponsorAddress), null);
const address = entry => kw.addressFromScriptPublicKey(entry.scriptPublicKey, "testnet-10").toString();
const entries = new Map([[address(factory), [factory]], [address(vault), [vault]], [sponsorAddress, [sponsor]]]);
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
  request: { builderKey: "kcom-claim.open", network: "testnet-10", owner: { walletAddress: sponsorAddress },
    params: { graphId: vector.graphId, factoryState, vaultState, factory: factory.outpoint,
      vault: vault.outpoint, adminPublicKeys: publicKeys.slice(0, 2), ...extra } },
});
const prepared = await build(request());
assert.equal(prepared.submitTransactionSupported, false);
assert.deepEqual(prepared.signInputs, []);
assert.equal(prepared.metadata.adminSigning.status, "awaiting-two-signatures");
const unsigned = kw.Transaction.deserializeFromSafeJSON(prepared.psktTransactionJson);
assert.equal(unsigned.outputs[0].value, factory.amount);
assert.equal(unsigned.outputs[1].value, vault.amount);
assert.equal(String(unsigned.outputs[0].covenant?.covenantId), vector.graphId);
assert.equal(String(unsigned.outputs[1].covenant?.covenantId), vector.graphId);
const approvals = keys.slice(0, 2).map((key, i) => {
  const script = Buffer.from(String(kw.createInputSignature(unsigned, 0, key, kw.SighashType.All)), "hex");
  assert.equal(script[0], 65);
  return { publicKey: publicKeys[i], signature: script.subarray(1).toString("hex") };
});
const finalized = await build(request({ adminApprovals: approvals,
  expectedSigningCommitment: prepared.metadata.adminSigning.signingCommitment }));
assert.equal(finalized.submitTransactionSupported, true);
assert.deepEqual(finalized.signInputs, [{ index: 2, sighashType: 1 }]);
assert.equal(finalized.metadata.adminSigning.status, "collected");
const finalTx = kw.Transaction.deserializeFromSafeJSON(finalized.psktTransactionJson);
assert.deepEqual(finalTx.outputs.slice(0, 2).map(output => output.scriptPublicKey.script),
  unsigned.outputs.slice(0, 2).map(output => output.scriptPublicKey.script));
await assert.rejects(build(request({ adminPublicKeys: [publicKeys[0], publicKeys[0]] })), /distinct frozen/);
await assert.rejects(build(request({ adminApprovals: approvals,
  expectedSigningCommitment: "ff".repeat(32) })), /SIGNING_INTENT_STALE/);
await assert.rejects(build(request({ adminApprovals: [approvals[0], { ...approvals[1], signature: "00" }],
  expectedSigningCommitment: prepared.metadata.adminSigning.signingCommitment })), /SIGHASH_ALL/);
await assert.rejects(build(request({ vault: { ...vault.outpoint, index: 1 } })), /SOURCE_STALE/);
const alteredFee = createKcomClaimPsktBuilder({ ...options,
  transactionWithMinimumCalculatedFeeChange: (_runtime, tx, changeIndex) => {
    assert.equal(changeIndex, 2);
    tx.outputs[1].value -= 1n;
    return tx;
  },
});
await assert.rejects(alteredFee(request()), /changed a custody output/);
console.log("ok KCOM opening prepares distinct admin signing, locks its intent and guards both actor outputs");
