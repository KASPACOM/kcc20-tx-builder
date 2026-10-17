import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import {
  buildKcomClaimManifest, verifyKcomClaimManifest, createKcomClaimProof, verifyKcomClaimProof,
  kcomClaimNullifier, reviewKcomClaimSelection, settleKcomClaimReference,
  importKcomClaimMaterialization, kcomClaimContentHash, kcomClaimAuthorityFromScript,
  KCOM_CLAIM_BASE_RAW as BASE, KCOM_CLAIM_BUDGET_RAW as BUDGET,
} from "../dist/index.js";
const require = createRequire(import.meta.url);
const hex = (n) => BigInt(n).toString(16).padStart(64, "0");
const auth = (n, scheme = 0) => ({ scheme, identifier: hex(n) });
const provenance = {
  materializationHash: hex(10), membershipSnapshotHash: hex(11), integrityManifestHash: hex(12),
  sourceManifestHashes: [hex(15), hex(13), hex(14)], cutoffMs: "1794700800000",
};
const make = (n = 3) => buildKcomClaimManifest({
  campaignId: hex(1), tokenId: hex(2), provenance,
  entitlements: Array.from({ length: n }, (_, i) => ({ authority: auth(i + 1), baseEntitlementRaw: (BASE / BigInt(n)).toString() })),
});
const selection = (index, tier = 3, beneficiary = auth(index + 10000)) => ({ leafIndex: index, tier, beneficiary });
const mutate = (v, fn) => { const copy = structuredClone(v); fn(copy); return copy; };
const checkProof = (m, proof) => verifyKcomClaimProof({ proof, campaignId: m.campaignId, root: m.root, leafCount: m.leaves.length });
const UNIT = 100000000n;
test("canonical ordering, explicit padding, reproducible manifest and trusted content anchor", () => {
  const m = make(5);
  verifyKcomClaimManifest(m, m.contentHash);
  assert.deepEqual(buildKcomClaimManifest({ campaignId: m.campaignId, tokenId: m.tokenId, provenance, entitlements: [...m.leaves].reverse() }), m);
  for (const leaf of m.leaves) { const proof = createKcomClaimProof(m, leaf.index); assert.equal(proof.siblings.length, 3); checkProof(m, proof); }
  assert.throws(() => verifyKcomClaimManifest(m, hex(99)), /trusted hash/);
  assert.throws(() => verifyKcomClaimManifest(mutate(m, (x) => x.leaves.reverse()), m.contentHash), /canonical reconstruction/);
});
test("one leaf, odd count and scheme-separated identical identifiers", () => {
  const one = make(1); assert.equal(createKcomClaimProof(one, 0).siblings.length, 0); checkProof(one, createKcomClaimProof(one, 0));
  const m = buildKcomClaimManifest({ campaignId: hex(1), tokenId: hex(2), provenance, entitlements: [
    { authority: auth(7, 0), baseEntitlementRaw: (BASE / 2n).toString() },
    { authority: auth(7, 1), baseEntitlementRaw: (BASE / 2n).toString() },
  ] }); assert.equal(m.leaves.length, 2);
});
test("membership rejects every field mutation, cross-campaign, proof reorder, truncation and padding", () => {
  const m = make(5), p = createKcomClaimProof(m, 2);
  for (const change of [
    (x) => x.leaf.authority.identifier = hex(55), (x) => x.leaf.authority.scheme = 1,
    (x) => x.leaf.baseEntitlementRaw = "1", (x) => x.leaf.index = 1,
    (x) => x.campaignId = hex(22), (x) => x.leafCount = 4,
    (x) => x.siblings[0] = hex(44), (x) => x.siblings.reverse(),
    (x) => x.siblings.pop(), (x) => x.siblings.push(hex(33)), (x) => x.leaf.index = 5,
  ]) assert.throws(() => checkProof(m, mutate(p, change)));
});
test("duplicates aggregate before leaves; unsafe canonical amounts, authorities and pool gaps fail", () => {
  const one = make(1);
  const m = buildKcomClaimManifest({ campaignId: hex(1), tokenId: hex(2), provenance, entitlements: [
    { authority: auth(1), baseEntitlementRaw: (BASE / 2n).toString() },
    { authority: auth(1), baseEntitlementRaw: (BASE / 2n).toString() },
  ] }); assert.deepEqual(m, one);
  for (const value of ["0", "-1", "01", "1.0", "1e10", Number(BASE), "9223372036854775808", (BASE + 1n).toString(), "1"]) {
    assert.throws(() => buildKcomClaimManifest({ campaignId: hex(1), tokenId: hex(2), provenance, entitlements: [{ authority: auth(1), baseEntitlementRaw: value }] }));
  }
  for (const bad of [{ scheme: 5, identifier: hex(1) }, { scheme: 0, identifier: "bad" }, { ...auth(1), privateKey: "do-not-copy" }]) {
    assert.throws(() => buildKcomClaimManifest({ campaignId: hex(1), tokenId: hex(2), provenance, entitlements: [{ authority: bad, baseEntitlementRaw: BASE.toString() }] }));
  }
  assert.throws(() => buildKcomClaimManifest({ campaignId: hex(1), tokenId: hex(2), provenance, entitlements: [] }));
});
test("claim nullifier binds original identity, not destination/tier; selection digest binds redirected terms", () => {
  const m = make();
  const a = reviewKcomClaimSelection(m, selection(0, 1)), b = reviewKcomClaimSelection(m, selection(0, 3, auth(222)));
  assert.equal(a.nullifier, b.nullifier); assert.notEqual(a.selectionDigest, b.selectionDigest);
  assert.notEqual(a.nullifier, kcomClaimNullifier(hex(44), m.leaves[0].authority));
  assert.notEqual(a.nullifier, kcomClaimNullifier(m.campaignId, { ...m.leaves[0].authority, scheme: 1 }));
  assert.equal(a.requiresOriginalAuthorityAuthorization, true); assert.match(a.status, /not-authorized/);
  assert.throws(() => settleKcomClaimReference(m, [selection(0, 1), selection(0, 3, auth(222))]), /duplicate original/);
});
test("1000 equal wallets: 100 Short, 200 Medium, 300 Long, 400 unclaimed", () => {
  const m = make(1000);
  const choices = Array.from({ length: 600 }, (_, i) => selection(i, i < 100 ? 1 : i < 300 ? 2 : 3));
  const result = settleKcomClaimReference(m, choices), sum = (tier) => result.allocations.filter((a) => a.tier === tier).reduce((n, a) => n + BigInt(a.finalAllocationRaw), 0n);
  assert.equal(sum(1), 2000000n * UNIT);
  assert.equal(sum(2), 16000000n * UNIT);
  // Each Long gets independently floored 50M/300 and 8M/300 shares.
  assert.equal(sum(3), 300n * (20000n * UNIT + 60000n * UNIT + 50000000n * UNIT / 300n + 8000000n * UNIT / 300n));
  assert.equal(result.treasuryRaw, "400");
  assert.equal(BigInt(result.liabilityRaw) + BigInt(result.treasuryRaw), BUDGET);
  assert.deepEqual(settleKcomClaimReference(m, [...choices].reverse()), result);
  assert.match(result.status, /not-chain-settlement/);
});
test("zero claims, no Long, no Medium, single Long, all Short and duplicate destinations conserve exact budget", () => {
  const m = make(2), empty = settleKcomClaimReference(m, []);
  assert.equal(empty.treasuryRaw, BUDGET.toString()); assert.equal(empty.liabilityRaw, "0");
  const short = settleKcomClaimReference(m, [selection(0, 1)]);
  assert.equal(short.liabilityRaw, (BASE / 2n).toString());
  const medium = settleKcomClaimReference(m, [selection(0, 2)]);
  assert.equal(medium.liabilityRaw, (BASE / 2n + 30000000n * UNIT).toString());
  const long = settleKcomClaimReference(m, [selection(0, 3)]);
  assert.equal(long.liabilityRaw, BUDGET.toString()); assert.equal(long.treasuryRaw, "0");
  const shared = settleKcomClaimReference(m, [selection(0, 3, auth(99)), selection(1, 3, auth(99))]);
  assert.equal(shared.allocations.length, 2); assert.notEqual(shared.allocations[0].nullifier, shared.allocations[1].nullifier);
});
test("unequal weights and base dust remain separate from unclaimed Long redistribution", () => {
  const m = buildKcomClaimManifest({ campaignId: hex(1), tokenId: hex(2), provenance, entitlements: [
    { authority: auth(1), baseEntitlementRaw: "1" },
    { authority: auth(2), baseEntitlementRaw: (BASE - 2n).toString() },
  ] });
  assert.equal(m.baseRoundingReserveRaw, "1");
  const result = settleKcomClaimReference(m, [selection(0, 3)]);
  assert.equal(result.treasuryRaw, "1");
  assert.equal(result.liabilityRaw, (BUDGET - 1n).toString());
  assert.equal(BigInt(result.allocations[0].unclaimedRedistributionRaw), BASE - 2n);
});
test("invalid tier, index, noncanonical beneficiary and private selection fields fail", () => {
  const m = make();
  for (const bad of [selection(-1), selection(3), selection(0, 4), selection(0, 0), selection(0, 3, auth(3, 7)), { ...selection(0), signature: "must-not-publish" }]) assert.throws(() => settleKcomClaimReference(m, [bad]));
});
function sealed() {
  const raw = {
    policyVersion: "kcom-86-10-4-v1", integrityManifestHash: hex(12),
    allocation: {
      treasuryWeightBps: 0,
      bucketTotals: [
        { bucket: "l1", weightBps: 8600, rawMicroPoints: "100000000", empty: false },
        { bucket: "l2-production", weightBps: 1000, rawMicroPoints: "100000000", empty: false },
        { bucket: "l2-testnet", weightBps: 400, rawMicroPoints: "100000000", empty: false },
      ],
      destinations: [
        { destination: "a", rank: 1, shareNumerator: "581", shareDenominator: "1000", buckets: [
          { bucket: "l1", rawMicroPoints: "60000000", shareNumerator: "129", shareDenominator: "250" },
          { bucket: "l2-production", rawMicroPoints: "25000000", shareNumerator: "1", shareDenominator: "40" },
          { bucket: "l2-testnet", rawMicroPoints: "100000000", shareNumerator: "1", shareDenominator: "25" },
        ] },
        { destination: "b", rank: 2, shareNumerator: "419", shareDenominator: "1000", buckets: [
          { bucket: "l1", rawMicroPoints: "40000000", shareNumerator: "43", shareDenominator: "125" },
          { bucket: "l2-production", rawMicroPoints: "75000000", shareNumerator: "3", shareDenominator: "40" },
        ] },
      ],
    }, unlinked: [], excluded: [],
  };
  return { ...raw, contentHash: kcomClaimContentHash(raw) };
}
function importMaterialization(materialization, expectedMaterializationHash = materialization.contentHash) {
  return importKcomClaimMaterialization({ materialization, expectedMaterializationHash, campaignId: hex(1), tokenId: hex(2), provenance: { ...provenance, materializationHash: expectedMaterializationHash }, destinationScriptForAddress: (address) => `20${hex(address === "a" ? 1 : 2)}ac` });
}
test("backend-v2 sealed shares import exactly, rechecking 86/10/4 rather than rescoring", () => {
  const m = importMaterialization(sealed());
  assert.equal(m.leaves[0].baseEntitlementRaw, "1162000000000000");
  assert.equal(m.leaves[1].baseEntitlementRaw, "838000000000000");
  assert.equal(m.baseRoundingReserveRaw, "0");
  assert.equal(m.provenance.integrityManifestHash, hex(12));
});
test("sealed import rejects hash tampering, changed scores/weights/fractions, duplicates and empty source buckets", () => {
  const original = sealed();
  assert.throws(() => importMaterialization(mutate(original, (x) => x.allocation.destinations[0].shareNumerator = "580"), original.contentHash), /hash mismatch/);
  for (const change of [
    (x) => x.allocation.bucketTotals[0].weightBps = 8500,
    (x) => x.allocation.destinations[0].shareNumerator = "580",
    (x) => x.allocation.destinations[0].buckets[0].rawMicroPoints = "60000001",
    (x) => x.allocation.destinations.push(structuredClone(x.allocation.destinations[0])),
    (x) => x.allocation.treasuryWeightBps = 400,
    (x) => x.allocation.destinations[0].buckets[0].shareDenominator = "0",
  ]) {
    const m = mutate(original, change); const { contentHash, ...raw } = m; m.contentHash = kcomClaimContentHash(raw);
    assert.throws(() => importMaterialization(m));
  }
});
test("authority scripts map canonical native Schnorr/ECDSA/P2SH; unsupported scripts fail", () => {
  assert.deepEqual(kcomClaimAuthorityFromScript(`20${hex(9)}ac`), auth(9));
  assert.deepEqual(kcomClaimAuthorityFromScript(`aa20${hex(8)}87`), auth(8, 3));
  assert.equal(kcomClaimAuthorityFromScript(`2102${hex(1)}ab`).scheme, 2);
  for (const script of ["51", `20${hex(1)}ab`, `2104${hex(1)}ab`]) assert.throws(() => kcomClaimAuthorityFromScript(script));
});
test("ESM and CommonJS produce identical manifest, nullifier and allocation results", () => {
  const cjs = require("../dist/cjs/index.js"), m = make(3);
  assert.equal(cjs.kcomClaimNullifier(m.campaignId, m.leaves[0].authority), kcomClaimNullifier(m.campaignId, m.leaves[0].authority));
  assert.deepEqual(cjs.settleKcomClaimReference(m, [selection(0)]), settleKcomClaimReference(m, [selection(0)]));
});

test("independent Python BLAKE3/SHA256 golden vectors agree on 1/3/5-leaf roots, proofs, hashes and nullifiers", async () => {
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/kcom-claim-policy-golden.json", import.meta.url)));
  for (const row of fixture.cases) {
    const m = row.manifest;
    verifyKcomClaimManifest(m, m.contentHash);
    const built = buildKcomClaimManifest({ campaignId: m.campaignId, tokenId: m.tokenId, provenance: m.provenance, entitlements: m.leaves });
    assert.deepEqual(built, m);
    for (let i = 0; i < m.leaves.length; i++) {
      assert.deepEqual(createKcomClaimProof(built, i), row.proofs[i]);
      checkProof(m, row.proofs[i]);
      assert.equal(kcomClaimNullifier(m.campaignId, m.leaves[i].authority), row.nullifiers[i]);
    }
  }
});
test("activation preview funds full allocation in real vesting ABI with released=0, no direct TGE payout and no expiry", async () => {
  const { readFileSync } = await import("node:fs");
  const { reviewKcomClaimActivation, kcomVestingCodec } = await import("../dist/index.js");
  const artifact = JSON.parse(readFileSync(new URL("../artifacts/KCOMVesting.artifact.json", import.meta.url)));
  const codec = kcomVestingCodec(artifact), m = make(3), selections = [selection(0, 1), selection(1, 2), selection(2, 3)];
  for (const tier of [1, 2, 3]) {
    const preview = reviewKcomClaimActivation({ manifest: m, selections, leafIndex: tier - 1, tgeMs: "1800000000000", extensionCommitment: hex(19) });
    codec.validate(preview.state);
    assert(codec.script(preview.state).length > 0);
    assert.equal(preview.state.released, "0");
    assert.equal(preview.immediateBeneficiaryTokenOutputRaw, "0");
    assert.equal(preview.activationExpiry, null);
    assert.equal(preview.requiresAuthenticatedClaimAndSettlement, true);
    const total = BigInt(preview.state.total);
    assert.equal(codec.availability(preview.state, 1800000000000n).vested, total * BigInt(tier === 1 ? 1000 : tier === 2 ? 500 : 0) / 10000n);
    assert.equal(codec.availability(preview.state, 1800000000000n + 46n * 2592000000n).vested, total);
  }
  assert.throws(() => reviewKcomClaimActivation({ manifest: m, selections: [], leafIndex: 0, tgeMs: "1800000000000", extensionCommitment: hex(19) }), /unselected/);
});
test("batch proof export matches individual paths and does not rebuild a tree for each wallet", async () => {
  const { createKcomClaimProofs } = await import("../dist/index.js"), m = make(1000);
  const proofs = createKcomClaimProofs(m);
  assert.equal(proofs.length, 1000);
  for (const i of [0, 1, 499, 999]) { assert.deepEqual(proofs[i], createKcomClaimProof(m, i)); checkProof(m, proofs[i]); }
});
test("source importer aggregates alias authorities before floor rounding", () => {
  const m = sealed();
  m.allocation.bucketTotals.forEach((b) => b.rawMicroPoints = "3");
  m.allocation.destinations = ["a", "b", "c"].map((destination, i) => ({
    destination, rank: i + 1, shareNumerator: "1", shareDenominator: "3", buckets: [
      { bucket: "l1", rawMicroPoints: "1", shareNumerator: "43", shareDenominator: "150" },
      { bucket: "l2-production", rawMicroPoints: "1", shareNumerator: "1", shareDenominator: "30" },
      { bucket: "l2-testnet", rawMicroPoints: "1", shareNumerator: "1", shareDenominator: "75" },
    ],
  }));
  const { contentHash, ...raw } = m; m.contentHash = kcomClaimContentHash(raw);
  const result = importKcomClaimMaterialization({ materialization: m, expectedMaterializationHash: m.contentHash, campaignId: hex(1), tokenId: hex(2), provenance: { ...provenance, materializationHash: m.contentHash }, destinationScriptForAddress: (address) => `20${hex(address === "c" ? 2 : 1)}ac` });
  assert.equal(result.leaves.length, 2);
  assert.equal(result.leaves[0].baseEntitlementRaw, (BASE * 2n / 3n).toString());
  assert.equal(result.baseRoundingReserveRaw, "1");
});
test("real existing backend-v2 service fixture imports with excluded/unlinked rows retained in audit but absent from allocations", async () => {
  const { readFileSync } = await import("node:fs");
  const f = JSON.parse(readFileSync(new URL("./fixtures/kcom-backend-materialization.json", import.meta.url)));
  const m = importKcomClaimMaterialization({ materialization: f.materialization, expectedMaterializationHash: f.materialization.contentHash, campaignId: f.campaignId, tokenId: f.tokenId, provenance: f.provenance, destinationScriptForAddress: (address) => f.destinationScripts[address] });
  assert.equal(m.leaves.length, 2);
  assert.equal(f.materialization.unlinked.length, 1); assert.equal(f.materialization.excluded.length, 1);
  assert.equal(m.leaves.reduce((s, r) => s + BigInt(r.baseEntitlementRaw), 0n), BASE);
  assert.deepEqual(m.leaves.map((r) => r.baseEntitlementRaw).sort(), ["1162000000000000", "838000000000000"].sort());
});
test("independent Python allocation vectors cover all 64 absent/Short/Medium/Long combinations at unequal weights", async () => {
  const { readFileSync } = await import("node:fs");
  const f = JSON.parse(readFileSync(new URL("./fixtures/kcom-claim-settlement-golden.json", import.meta.url)));
  const m = buildKcomClaimManifest({ campaignId: hex(1), tokenId: hex(2), provenance, entitlements: f.baseEntitlementsRaw.map((n, i) => ({ authority: auth(i + 1), baseEntitlementRaw: n })) });
  assert.equal(f.cases.length, 64);
  for (const row of f.cases) {
    const result = settleKcomClaimReference(m, row.tiers.flatMap((tier, i) => tier ? [selection(i, tier)] : []));
    assert.equal(result.liabilityRaw, row.liabilityRaw);
    assert.equal(result.treasuryRaw, row.treasuryRaw);
    for (let i = 0; i < row.allocations.length; i++) for (const [key, expected] of Object.entries(row.allocations[i])) assert.equal(result.allocations[i][key], expected);
  }
});
test("cached selection reviewer authenticates once, isolates caller mutations and preserves unsigned review semantics", async () => {
  const { createKcomClaimSelectionReviewer } = await import("../dist/index.js");
  const m = make(1000), choice = selection(999, 3);
  const expected = reviewKcomClaimSelection(m, choice);
  const reviewer = createKcomClaimSelectionReviewer(m, m.contentHash);
  m.leaves[999].authority.identifier = hex(222);
  m.root = hex(333);
  assert.deepEqual(reviewer.review(choice), expected);
  assert.throws(() => reviewer.review(selection(1000, 3)), /out of range/);
  assert.throws(() => createKcomClaimSelectionReviewer(make(), hex(99)), /trusted hash/);
});
