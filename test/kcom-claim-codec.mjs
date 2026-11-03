import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  KCOM_CLAIM_GRAPH_ARTIFACT_ID,
  KCOM_CLAIM_OPEN_ARTIFACT_ID,
  kcomClaimCodec,
} from "../dist/index.js";

const graphBytes = readFileSync(new URL("../artifacts/KCOMClaimGraph.artifact.json", import.meta.url));
const openingBytes = readFileSync(new URL("../artifacts/KCOMClaimOpen.artifact.json", import.meta.url));
const graph = JSON.parse(graphBytes), opening = JSON.parse(openingBytes);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const vaultState = {
  campaign: "aa".repeat(32), terms_hash: "bb".repeat(32), token_id: "11".repeat(32),
  tge_ms: "1797897600000", budget_raw: "1000", extension: "00".repeat(32),
  treasury_scheme: 0, treasury: "cc".repeat(32),
  first: "05".repeat(32), second: "06".repeat(32), third: "07".repeat(32),
  funded: true, opened: true, settled: true, recovered: false,
  liability_raw: "996", activated_raw: "0",
};

test("campaign artifacts and all actor templates match the published contract revision", () => {
  assert.equal(sha(graphBytes), "6664cb2d914e6ed995cb02fe8c4ec98299a2fe6366c659ad0d74cd92e4ed1385");
  assert.equal(sha(openingBytes), "a930cae913dbd2dabab6e2b0296a6a211ce6558a177078d1a6a0f9939a8e9092");
  const codec = kcomClaimCodec({ graph, opening });
  assert.equal(codec.graphArtifactId, KCOM_CLAIM_GRAPH_ARTIFACT_ID);
  assert.equal(codec.openingArtifactId, KCOM_CLAIM_OPEN_ARTIFACT_ID);
  for (const artifact of [graph, opening]) {
    for (const plan of artifact.argent.template_plan.templates) {
      assert.equal(codec.templateHash(plan.actor), Buffer.from(plan.sil_template_hash).toString("hex"));
    }
  }
});

test("vault script derives generated template context and dispatch tags from the pinned ABI", () => {
  const codec = kcomClaimCodec({ graph, opening });
  const script = codec.script("KCOMVault", vaultState);
  const contract = graph.sil_abi.contracts.KCOMVault;
  assert.equal(script.length, contract.compiled.bytecode.length);
  assert.equal(script[1], 32);
  const entitlement = graph.argent.template_plan.templates.find(plan => plan.actor === "KCOMEntitlement");
  assert.equal(Buffer.from(script.slice(2, 34)).toString("hex"), Buffer.from(entitlement.sil_template_hash).toString("hex"));
  for (const entry of ["fund", "seal", "activate_partial", "activate_final", "recover_partial", "recover_final"]) {
    assert.equal(Buffer.from(codec.dispatch("KCOMVault", entry)).toString("hex"), contract.entries[entry].dispatch_tag);
  }
  assert.notDeepEqual(codec.script("KCOMVault", { ...vaultState, recovered: true }), script);
});

test("caller cannot supply generated context or malformed campaign state", () => {
  const codec = kcomClaimCodec({ graph, opening });
  const invalid = [
    { ...vaultState, gen__kcom_entitlement_template: "ff".repeat(32) },
    { ...vaultState, first: "aa" },
    { ...vaultState, budget_raw: "9223372036854775808" },
    { ...vaultState, budget_raw: "01" },
    { ...vaultState, recovered: 1 },
    { ...vaultState, treasury_scheme: 256 },
  ];
  for (const state of invalid) assert.throws(() => codec.script("KCOMVault", state));
  assert.throws(() => codec.dispatch("KCOMVault", "unknown"));
  assert.throws(() => codec.script("Unknown", vaultState));
  assert.throws(() => kcomClaimCodec({ graph: { ...graph, id: "ff".repeat(32) }, opening }));
  assert.throws(() => kcomClaimCodec({ graph: { ...graph, sil_abi: { ...graph.sil_abi, contracts: {} } }, opening }));
  const tampered = structuredClone(graph);
  tampered.argent.template_plan.templates[0].sil_template_hash[0] ^= 1;
  assert.throws(() => kcomClaimCodec({ graph: tampered, opening }));
});

test("CommonJS and ESM use the same campaign artifact pins", () => {
  const require = createRequire(import.meta.url);
  const cjs = require("../dist/cjs/index.js");
  assert.equal(cjs.KCOM_CLAIM_GRAPH_ARTIFACT_ID, KCOM_CLAIM_GRAPH_ARTIFACT_ID);
  assert.deepEqual(cjs.kcomClaimCodec({ graph, opening }).script("KCOMVault", vaultState), kcomClaimCodec({ graph, opening }).script("KCOMVault", vaultState));
});
