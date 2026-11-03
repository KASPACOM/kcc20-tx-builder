import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadPinnedKaspaWasm } from "./load-kaspa-wasm.mjs";
import { createKcomClaimPsktBuilder, createKcomClaimTn10ProofPolicy,
  kcomClaimCodec } from "../dist/index.js";

const kw = await loadPinnedKaspaWasm(process.env.SNAPSHOT_TEST_WASM);
const artifact = name => JSON.parse(readFileSync(new URL(`../artifacts/${name}`, import.meta.url)));
const graph = artifact("KCOMClaimGraph.artifact.json"), opening = artifact("KCOMClaimOpen.artifact.json");
const vector = JSON.parse(readFileSync(new URL("./fixtures/kcom-claim-script-vectors.json", import.meta.url)));
const scenario = JSON.parse(readFileSync(new URL("./fixtures/kcom-claim-initialization-vector.json", import.meta.url)));
const codec = kcomClaimCodec({ graph, opening });
assert.equal(Buffer.from(codec.linkedTemplateParts("KCOMFactory").hash).toString("hex"),
  "02d6cdc1ef7dc2c239f5fd33b210dc2f87f967011a1de0083294094c9fcced66");
assert.notEqual(Buffer.from(codec.templateParts("KCOMFactory").hash).toString("hex"),
  Buffer.from(codec.linkedTemplateParts("KCOMFactory").hash).toString("hex"));
const substitutedGraph = structuredClone(graph);
substitutedGraph.argent.template_plan.templates.find(item => item.actor === "KCOMFactory")
  .actor_type_handle.template.hash[0] ^= 1;
assert.throws(() => kcomClaimCodec({ graph: substitutedGraph, opening })
  .linkedTemplateParts("KCOMFactory"), /Invalid linked KCOMFactory template hash/);
const initState = { ...vector.factoryState };
delete initState.next_shard; delete initState.opened;
const proofPolicy = createKcomClaimTn10ProofPolicy({ network: "testnet-10",
  tokenId: vector.tokenId, campaignBudgetRaw: vector.budgetRaw });
const manifest = proofPolicy.buildManifest({ campaignId: vector.campaign, tokenId: vector.tokenId,
  provenance: { materializationHash: "11".repeat(32), membershipSnapshotHash: "22".repeat(32),
    integrityManifestHash: "33".repeat(32), sourceManifestHashes: ["44".repeat(32)],
    cutoffMs: "1794700800000" }, entitlements: scenario.leaves.map(leaf => ({
      authority: leaf.authority, baseEntitlementRaw: leaf.baseEntitlementRaw,
    })) });
assert.equal(manifest.root, initState.eligibility_root);
const sponsorPair = kw.Keypair.random(), sponsorKey = new kw.PrivateKey(sponsorPair.privateKey);
const sponsorAddress = sponsorPair.toAddress("testnet-10").toString();
const sponsor = { outpoint: { transactionId: "d1".repeat(32), index: 0 }, amount: 2000000000n,
  scriptPublicKey: kw.payToAddressScript(sponsorAddress), covenantId: null,
  entry: { covenantId: null }, blockDaaScore: 1n, isCoinbase: false };
const entries = new Map([[sponsorAddress, [sponsor]]]);
const rpc = { connect: async () => {}, disconnect: async () => {},
  getUtxosByAddresses: async ([addr]) => ({ entries: entries.get(addr) ?? [] }) };
const options = { wasm: kw, artifacts: { "KCOMClaimGraph.artifact.json": graph,
  "KCOMClaimOpen.artifact.json": opening }, rpcClientFactory: () => rpc };
const builder = createKcomClaimPsktBuilder(options);
const base = { initState, termsHex: scenario.termsPreimageHex,
  eligibilityManifest: manifest, expectedManifestContentHash: manifest.contentHash };
const request = (key, params) => ({ schema: "kcc20-in-process-pskt-builder-input/v1",
  request: { builderKey: key, network: "testnet-10",
    owner: { walletAddress: sponsorAddress }, params } });
const deploy = await builder(request("kcom-claim.deploy-initializer",
  { ...base, initializerValueSompi: "600000000" }));
assert.equal(deploy.submitTransactionSupported, true);
assert.deepEqual(deploy.signInputs, [{ index: 0, sighashType: 1 }]);
const deployTx = kw.Transaction.deserializeFromSafeJSON(deploy.psktTransactionJson);
deployTx.inputs[0].signatureScript = kw.createInputSignature(deployTx, 0, sponsorKey, kw.SighashType.All);
assert.equal(String(deployTx.outputs[0].covenant.covenantId), deploy.metadata.initializerId);
assert.equal(deployTx.outputs[0].value, 600000000n);
const initializerAddress = kw.addressFromScriptPublicKey(deployTx.outputs[0].scriptPublicKey,
  "testnet-10").toString();
const initializer = { outpoint: { transactionId: String(deployTx.id), index: 0 },
  amount: deployTx.outputs[0].value, scriptPublicKey: deployTx.outputs[0].scriptPublicKey,
  covenantId: deploy.metadata.initializerId, entry: { covenantId: deploy.metadata.initializerId },
  blockDaaScore: 1n, isCoinbase: false };
entries.set(initializerAddress, [initializer]);
const admins = [5, 6].map(n => new kw.PrivateKey(n.toString(16).padStart(2, "0").repeat(32)));
const adminPublicKeys = [initState.first, initState.second];
const initializeParams = { ...base, initializerId: deploy.metadata.initializerId,
  initializer: initializer.outpoint, adminPublicKeys };
const prepared = await builder(request("kcom-claim.initialize", initializeParams));
assert.equal(prepared.submitTransactionSupported, false);
const unsigned = kw.Transaction.deserializeFromSafeJSON(prepared.psktTransactionJson);
assert.equal(unsigned.outputs[0].value, 500000000n);
assert.equal(unsigned.outputs[1].value, 100000000n);
assert.equal(String(unsigned.outputs[0].covenant.covenantId), prepared.metadata.graphId);
assert.equal(String(unsigned.outputs[1].covenant.covenantId), prepared.metadata.graphId);
assert.deepEqual(unsigned.outputs.slice(0, 2).map(output => output.scriptPublicKey.script),
  vector.outputs.initialize.outputs);
const approvals = admins.map((key, i) => {
  const script = Buffer.from(String(kw.createInputSignature(unsigned, 0, key, kw.SighashType.All)), "hex");
  assert.equal(script[0], 65);
  return { publicKey: adminPublicKeys[i], signature: script.subarray(1).toString("hex") };
});
const finalized = await builder(request("kcom-claim.initialize", { ...initializeParams,
  adminApprovals: approvals,
  expectedSigningCommitment: prepared.metadata.adminSigning.signingCommitment }));
assert.equal(finalized.submitTransactionSupported, true);
assert.deepEqual(finalized.signInputs, [{ index: 1, sighashType: 1 }]);
await assert.rejects(builder(request("kcom-claim.initialize", { ...initializeParams,
  adminApprovals: approvals, expectedSigningCommitment: "ff".repeat(32) })), /SIGNING_INTENT_STALE/);
await assert.rejects(builder(request("kcom-claim.deploy-initializer", { ...base,
  initializerValueSompi: "500000000" })), /does not fund/);
await assert.rejects(builder(request("kcom-claim.deploy-initializer", { ...base,
  expectedManifestContentHash: "ff".repeat(32), initializerValueSompi: "600000000" })), /trusted hash/);
await assert.rejects(builder(request("kcom-claim.deploy-initializer", { ...base,
  termsHex: "00" + scenario.termsPreimageHex.slice(2), initializerValueSompi: "600000000" })), /terms preimage/);
await assert.rejects(builder(request("kcom-claim.initialize", { ...initializeParams,
  initializer: { ...initializer.outpoint, index: 1 } })), /SOURCE_STALE/);
console.log("ok KCOM initializer deploy and two-admin graph creation preserve reviewed terms and manifest");
