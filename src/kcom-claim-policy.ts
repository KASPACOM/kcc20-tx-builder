/** Draft, offline-only campaign policy. No function in this module builds a transaction. */
import { blake3 } from "@noble/hashes/blake3";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, concatByteArrays } from "./encoding.js";
import { KCC20_SNAPSHOT_TOKEN_TEMPLATE_PIN } from "./artifacts.js";

export const KCOM_CLAIM_FORMAT = "kcom-claim-eligibility/v1" as const;
export const KCOM_CLAIM_DECIMALS = 8;
export const KCOM_CLAIM_BUDGET_RAW = 10_000_000_000_000_000n;
export const KCOM_CLAIM_BASE_RAW = 2_000_000_000_000_000n;
export const KCOM_CLAIM_MEDIUM_RAW = 3_000_000_000_000_000n;
export const KCOM_CLAIM_LONG_RAW = 5_000_000_000_000_000n;
const MAX_RAW = (1n << 63n) - 1n;
const MAX_LEAVES = 1 << 20;
const encoder = new TextEncoder();
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`KCOM claim: ${message}`);
}
function hex32(value: string, label: string): string {
  check(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), `${label} must be canonical lowercase bytes32`);
  return value;
}
function integer(value: string, label: string, max = MAX_RAW): bigint {
  check(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 155, `${label} must be a canonical unsigned decimal string`);
  const n = BigInt(value);
  check(n <= max, `${label} exceeds supported range`);
  return n;
}
function fixedInteger(value: bigint, size: number): Uint8Array {
  const result = new Uint8Array(size);
  for (let i = 0; i < size; i++) { result[i] = Number(value & 255n); value >>= 8n; }
  check(value === 0n, "integer encoding overflow");
  return result;
}
function digest(domain: string, ...parts: Uint8Array[]): string {
  return bytesToHex(blake3(concatByteArrays(encoder.encode(`kcom.claim.${domain}/v1\0`), ...parts)));
}
export interface KcomClaimAuthority { scheme: number; identifier: string }
export interface KcomClaimEntitlement { authority: KcomClaimAuthority; baseEntitlementRaw: string }
export interface KcomClaimLeaf extends KcomClaimEntitlement { index: number }
export interface KcomClaimProvenance {
  materializationHash: string;
  membershipSnapshotHash: string;
  integrityManifestHash: string;
  sourceManifestHashes: string[];
  cutoffMs: string;
}
export interface KcomClaimEligibilityManifest {
  schema: typeof KCOM_CLAIM_FORMAT;
  status: "draft-offline-unapproved-contract-format";
  campaignId: string;
  tokenId: string;
  decimals: 8;
  basePoolRaw: string;
  campaignBudgetRaw: string;
  totalBaseEntitlementRaw: string;
  baseRoundingReserveRaw: string;
  provenance: KcomClaimProvenance;
  root: string;
  contentHash: string;
  leaves: KcomClaimLeaf[];
}
export interface KcomClaimProof {
  campaignId: string;
  leaf: KcomClaimLeaf;
  leafCount: number;
  siblings: string[];
}
function authority(value: KcomClaimAuthority): string {
  check(value && Object.keys(value).sort().join(",") === "identifier,scheme", "authority must contain only scheme and identifier");
  check(value && Number.isInteger(value.scheme) && value.scheme >= 0 && value.scheme <= 4, "unsupported authority scheme");
  return `${value.scheme}:${hex32(value.identifier, "authority identifier")}`;
}
function provenance(value: KcomClaimProvenance): KcomClaimProvenance {
  check(value && Object.keys(value).sort().join(",") === "cutoffMs,integrityManifestHash,materializationHash,membershipSnapshotHash,sourceManifestHashes", "unexpected provenance fields");
  hex32(value.materializationHash, "materialization hash");
  hex32(value.membershipSnapshotHash, "membership snapshot hash");
  hex32(value.integrityManifestHash, "integrity manifest hash");
  integer(value.cutoffMs, "cutoff");
  check(Array.isArray(value.sourceManifestHashes) && value.sourceManifestHashes.length > 0, "source manifest hashes required");
  value.sourceManifestHashes.forEach((h) => hex32(h, "source manifest hash"));
  check(new Set(value.sourceManifestHashes).size === value.sourceManifestHashes.length, "duplicate source manifest hash");
  return { ...value, sourceManifestHashes: [...value.sourceManifestHashes].sort() };
}
export function kcomCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { check(Number.isSafeInteger(value), "non-integer JSON number"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(kcomCanonicalJson).join(",")}]`;
  check(typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype, "unsupported JSON value");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${kcomCanonicalJson(record[key])}`).join(",")}}`;
}
export function kcomClaimContentHash(value: unknown): string { return bytesToHex(sha256(encoder.encode(kcomCanonicalJson(value)))); }
function leafHash(campaignId: string, leaf: KcomClaimLeaf): string {
  check(leaf && Object.keys(leaf).sort().join(",") === "authority,baseEntitlementRaw,index", "unexpected leaf fields");
  authority(leaf.authority);
  check(Number.isSafeInteger(leaf.index) && leaf.index >= 0 && leaf.index < MAX_LEAVES, "invalid leaf index");
  const amount = integer(leaf.baseEntitlementRaw, "base entitlement");
  check(amount > 0n, "zero base entitlement");
  return digest("eligibility.leaf", hexToBytes(hex32(campaignId, "campaign ID")), fixedInteger(BigInt(leaf.index), 4), new Uint8Array([leaf.authority.scheme]), hexToBytes(leaf.authority.identifier), fixedInteger(amount, 8));
}
function levels(campaignId: string, leaves: readonly KcomClaimLeaf[]): string[][] {
  const count = leaves.length;
  check(count > 0 && count <= MAX_LEAVES, "leaf count must be 1..1048576");
  let width = 1;
  while (width < count) width *= 2;
  let row = Array.from({ length: width }, (_, i) => i < count ? leafHash(campaignId, leaves[i]) : digest("eligibility.padding", hexToBytes(campaignId), fixedInteger(BigInt(i), 4)));
  const result = [row];
  while (row.length > 1) {
    const next = [];
    for (let i = 0; i < row.length; i += 2) next.push(digest("eligibility.node", hexToBytes(row[i]), hexToBytes(row[i + 1])));
    row = next; result.push(row);
  }
  return result;
}
export function buildKcomClaimManifest(input: {
  campaignId: string; tokenId: string; provenance: KcomClaimProvenance; entitlements: readonly KcomClaimEntitlement[];
}): KcomClaimEligibilityManifest {
  hex32(input.campaignId, "campaign ID"); hex32(input.tokenId, "token ID");
  const aggregated = new Map<string, KcomClaimEntitlement>();
  for (const row of input.entitlements) {
    const key = authority(row.authority), n = integer(row.baseEntitlementRaw, "base entitlement");
    check(n > 0n, "zero base entitlement");
    const sum = n + BigInt(aggregated.get(key)?.baseEntitlementRaw ?? "0");
    check(sum <= MAX_RAW, "aggregated entitlement overflow");
    aggregated.set(key, { authority: { ...row.authority }, baseEntitlementRaw: sum.toString() });
  }
  const sorted = [...aggregated].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row], index) => ({ index, ...row }));
  const total = sorted.reduce((n, row) => n + BigInt(row.baseEntitlementRaw), 0n);
  check(total <= KCOM_CLAIM_BASE_RAW, "base entitlements exceed base pool");
  const dust = KCOM_CLAIM_BASE_RAW - total;
  // Only floor rounding is accepted, not a discretionary underallocation.
  check(dust < BigInt(sorted.length), "base allocation gap exceeds floor-rounding bound");
  const tree = levels(input.campaignId, sorted);
  const unsigned = {
    schema: KCOM_CLAIM_FORMAT, status: "draft-offline-unapproved-contract-format" as const,
    campaignId: input.campaignId, tokenId: input.tokenId, decimals: 8 as const,
    basePoolRaw: KCOM_CLAIM_BASE_RAW.toString(), campaignBudgetRaw: KCOM_CLAIM_BUDGET_RAW.toString(),
    totalBaseEntitlementRaw: total.toString(), baseRoundingReserveRaw: dust.toString(),
    provenance: provenance(input.provenance), root: tree[tree.length - 1][0], leaves: sorted,
  };
  return { ...unsigned, contentHash: kcomClaimContentHash(unsigned) };
}
export function verifyKcomClaimManifest(manifest: KcomClaimEligibilityManifest, expectedContentHash: string): void {
  hex32(expectedContentHash, "expected manifest hash");
  const rebuilt = buildKcomClaimManifest({ campaignId: manifest.campaignId, tokenId: manifest.tokenId, provenance: manifest.provenance, entitlements: manifest.leaves });
  check(kcomCanonicalJson(manifest) === kcomCanonicalJson(rebuilt), "manifest differs from canonical reconstruction");
  check(manifest.contentHash === expectedContentHash, "manifest trusted hash mismatch");
}
export function createKcomClaimProof(manifest: KcomClaimEligibilityManifest, index: number): KcomClaimProof {
  verifyKcomClaimManifest(manifest, manifest.contentHash);
  check(Number.isSafeInteger(index) && index >= 0 && index < manifest.leaves.length, "proof index out of range");
  const tree = levels(manifest.campaignId, manifest.leaves), siblings = [];
  let at = index;
  for (const row of tree.slice(0, -1)) { siblings.push(row[at ^ 1]); at = Math.floor(at / 2); }
  return { campaignId: manifest.campaignId, leaf: structuredClone(manifest.leaves[index]), leafCount: manifest.leaves.length, siblings };
}
/** Batch export validates and hashes the tree once, then emits O(N log N) proof data. */
export function createKcomClaimProofs(manifest: KcomClaimEligibilityManifest): KcomClaimProof[] {
  verifyKcomClaimManifest(manifest, manifest.contentHash);
  const tree = levels(manifest.campaignId, manifest.leaves);
  return manifest.leaves.map((leaf) => {
    let at = leaf.index;
    const siblings = tree.slice(0, -1).map((row) => { const sibling = row[at ^ 1]; at = Math.floor(at / 2); return sibling; });
    return { campaignId: manifest.campaignId, leaf: structuredClone(leaf), leafCount: manifest.leaves.length, siblings };
  });
}
export function verifyKcomClaimProof(input: { proof: KcomClaimProof; campaignId: string; root: string; leafCount: number }): void {
  const { proof } = input;
  check(proof.campaignId === hex32(input.campaignId, "campaign ID"), "proof campaign mismatch");
  hex32(input.root, "eligibility root");
  check(Number.isSafeInteger(input.leafCount) && input.leafCount > 0 && input.leafCount <= MAX_LEAVES && proof.leafCount === input.leafCount, "proof leaf count mismatch");
  check(proof.leaf.index < input.leafCount, "proof index is padding");
  let depth = 0, width = 1;
  while (width < input.leafCount) { depth++; width *= 2; }
  check(Array.isArray(proof.siblings) && proof.siblings.length === depth, "invalid proof depth");
  let hash = leafHash(proof.campaignId, proof.leaf), index = proof.leaf.index;
  for (const sibling of proof.siblings) {
    hex32(sibling, "proof sibling");
    hash = index % 2 === 0 ? digest("eligibility.node", hexToBytes(hash), hexToBytes(sibling)) : digest("eligibility.node", hexToBytes(sibling), hexToBytes(hash));
    index = Math.floor(index / 2);
  }
  check(hash === input.root, "eligibility proof does not open root");
}
export function kcomClaimNullifier(campaignId: string, original: KcomClaimAuthority): string {
  authority(original);
  return digest("nullifier", hexToBytes(hex32(campaignId, "campaign ID")), new Uint8Array([original.scheme]), hexToBytes(original.identifier));
}
export interface KcomClaimSelection { leafIndex: number; tier: 1 | 2 | 3; beneficiary: KcomClaimAuthority }
function validateSelection(manifest: KcomClaimEligibilityManifest, selection: KcomClaimSelection): KcomClaimLeaf {
  check(selection && Object.keys(selection).sort().join(",") === "beneficiary,leafIndex,tier", "unexpected selection fields");
  check(Number.isSafeInteger(selection.leafIndex) && selection.leafIndex >= 0 && selection.leafIndex < manifest.leaves.length, "selection index out of range");
  check([1, 2, 3].includes(selection.tier), "invalid tier"); authority(selection.beneficiary);
  return manifest.leaves[selection.leafIndex];
}
export function reviewKcomClaimSelection(manifest: KcomClaimEligibilityManifest, selection: KcomClaimSelection) {
  verifyKcomClaimManifest(manifest, manifest.contentHash);
  const leaf = validateSelection(manifest, selection), nullifier = kcomClaimNullifier(manifest.campaignId, leaf.authority);
  return {
    status: "offline-review-not-authorized-or-submitted" as const,
    originalAuthority: { ...leaf.authority }, beneficiary: { ...selection.beneficiary }, tier: selection.tier,
    nullifier, requiresOriginalAuthorityAuthorization: true as const,
    selectionDigest: digest("selection", hexToBytes(manifest.campaignId), hexToBytes(manifest.root), hexToBytes(nullifier), new Uint8Array([selection.tier, selection.beneficiary.scheme]), hexToBytes(selection.beneficiary.identifier)),
  };
}
export function settleKcomClaimReference(manifest: KcomClaimEligibilityManifest, selections: readonly KcomClaimSelection[]) {
  verifyKcomClaimManifest(manifest, manifest.contentHash);
  const used = new Set<number>();
  const rows = selections.map((selection) => {
    const leaf = validateSelection(manifest, selection);
    check(!used.has(leaf.index), "duplicate original eligibility commitment"); used.add(leaf.index);
    return { ...selection, beneficiary: { ...selection.beneficiary }, originalAuthority: { ...leaf.authority }, baseRaw: leaf.baseEntitlementRaw, nullifier: kcomClaimNullifier(manifest.campaignId, leaf.authority) };
  }).sort((a, b) => a.leafIndex - b.leafIndex);
  const claimedBase = rows.reduce((s, r) => s + BigInt(r.baseRaw), 0n);
  const mediumWeight = rows.reduce((s, r) => s + (r.tier >= 2 ? BigInt(r.baseRaw) : 0n), 0n);
  const longWeight = rows.reduce((s, r) => s + (r.tier === 3 ? BigInt(r.baseRaw) : 0n), 0n);
  const unclaimedBase = BigInt(manifest.totalBaseEntitlementRaw) - claimedBase;
  const ratio = (budget: bigint, weight: bigint, denominator: bigint) => denominator === 0n ? 0n : budget * weight / denominator;
  let mediumPaid = 0n, longPaid = 0n, redistributed = 0n;
  const allocations = rows.map((row) => {
    const base = BigInt(row.baseRaw);
    const medium = row.tier >= 2 ? ratio(KCOM_CLAIM_MEDIUM_RAW, base, mediumWeight) : 0n;
    const long = row.tier === 3 ? ratio(KCOM_CLAIM_LONG_RAW, base, longWeight) : 0n;
    const unclaimed = row.tier === 3 ? ratio(unclaimedBase, base, longWeight) : 0n;
    const total = base + medium + long + unclaimed;
    check(total > 0n && total <= MAX_RAW, "final allocation outside contract integer range");
    mediumPaid += medium; longPaid += long; redistributed += unclaimed;
    return { ...row, mediumBoostRaw: medium.toString(), longBoostRaw: long.toString(), unclaimedRedistributionRaw: unclaimed.toString(), finalAllocationRaw: total.toString() };
  });
  const liabilities = allocations.reduce((s, r) => s + BigInt(r.finalAllocationRaw), 0n);
  const treasuryRaw = KCOM_CLAIM_BUDGET_RAW - liabilities;
  const report = {
    schema: "kcom-claim-settlement-reference/v1" as const, status: "offline-reference-not-chain-settlement" as const,
    campaignId: manifest.campaignId, manifestHash: manifest.contentHash, manifestRoot: manifest.root,
    claimedBaseRaw: claimedBase.toString(), mediumWeightRaw: mediumWeight.toString(), longWeightRaw: longWeight.toString(), unclaimedBaseRaw: unclaimedBase.toString(),
    liabilityRaw: liabilities.toString(), treasuryRaw: treasuryRaw.toString(),
    treasuryBreakdown: {
      baseRoundingRaw: manifest.baseRoundingReserveRaw,
      mediumUnallocatedOrDustRaw: (KCOM_CLAIM_MEDIUM_RAW - mediumPaid).toString(),
      longUnallocatedOrDustRaw: (KCOM_CLAIM_LONG_RAW - longPaid).toString(),
      unclaimedBaseWithoutLongOrDustRaw: (unclaimedBase - redistributed).toString(),
    },
    allocations,
  };
  check(Object.values(report.treasuryBreakdown).reduce((s, n) => s + BigInt(n), 0n) === treasuryRaw, "surplus/liability reconciliation failed");
  check(liabilities + treasuryRaw === KCOM_CLAIM_BUDGET_RAW && treasuryRaw >= 0n, "campaign conservation failed");
  return { ...report, contentHash: kcomClaimContentHash(report) };
}

/** Matches the sealed backend-v2 materialization, without introducing another points scorer. */
export interface KcomSealedAllocationMaterialization {
  policyVersion: string;
  integrityManifestHash: string;
  allocation: {
    treasuryWeightBps: number;
    bucketTotals: Array<{ bucket: string; weightBps: number; rawMicroPoints: string; empty: boolean }>;
    destinations: Array<{
      destination: string; rank: number; shareNumerator: string; shareDenominator: string;
      buckets: Array<{ bucket: string; rawMicroPoints: string; shareNumerator: string; shareDenominator: string }>;
    }>;
  };
  unlinked: unknown[];
  excluded: unknown[];
  contentHash: string;
}
function gcd(a: bigint, b: bigint): bigint { while (b !== 0n) { const next = a % b; a = b; b = next; } return a; }
function addFraction(a: [bigint, bigint], b: [bigint, bigint]): [bigint, bigint] {
  const n = a[0] * b[1] + b[0] * a[1], d = a[1] * b[1], g = gcd(n, d);
  return [n / g, d / g];
}
function fraction(n: string, d: string): [bigint, bigint] {
  const numerator = integer(n, "share numerator", (1n << 512n) - 1n), denominator = integer(d, "share denominator", (1n << 512n) - 1n);
  check(denominator > 0n && numerator <= denominator, "invalid allocation fraction");
  return [numerator, denominator];
}
/** The caller decodes an authenticated Kaspa address through its pinned WASM. */
export function kcomClaimAuthorityFromScript(scriptPublicKeyHex: string): KcomClaimAuthority {
  check(typeof scriptPublicKeyHex === "string", "destination script required");
  let match = /^20([0-9a-f]{64})ac$/.exec(scriptPublicKeyHex);
  if (match) return { scheme: 0, identifier: match[1] };
  match = /^aa20([0-9a-f]{64})87$/.exec(scriptPublicKeyHex);
  if (match) return { scheme: 3, identifier: match[1] };
  match = /^21((?:02|03)[0-9a-f]{64})ab$/.exec(scriptPublicKeyHex);
  if (match) return { scheme: 2, identifier: bytesToHex(blake3(hexToBytes(match[1]))) };
  throw new Error("KCOM claim: unsupported destination script");
}
export function importKcomClaimMaterialization(input: {
  materialization: KcomSealedAllocationMaterialization;
  expectedMaterializationHash: string;
  campaignId: string; tokenId: string;
  provenance: KcomClaimProvenance;
  destinationScriptForAddress: (address: string) => string;
}): KcomClaimEligibilityManifest {
  const m = input.materialization;
  check(Object.keys(m).sort().join(",") === "allocation,contentHash,excluded,integrityManifestHash,policyVersion,unlinked", "unexpected sealed materialization schema");
  hex32(input.expectedMaterializationHash, "trusted materialization hash");
  const { contentHash, ...unsigned } = m;
  check(contentHash === input.expectedMaterializationHash && kcomClaimContentHash(unsigned) === contentHash, "sealed materialization hash mismatch");
  check(input.provenance.materializationHash === contentHash && input.provenance.integrityManifestHash === m.integrityManifestHash, "materialization provenance mismatch");
  check(typeof m.policyVersion === "string" && m.policyVersion.trim() !== "" && m.policyVersion !== "current", "immutable policy version required");
  check(Array.isArray(m.unlinked) && Array.isArray(m.excluded), "materialization audit rows required");
  check(m.allocation.treasuryWeightBps === 0, "empty source buckets require an explicit campaign policy; do not silently redistribute");
  const expected = new Map([["l1", 8600], ["l2-production", 1000], ["l2-testnet", 400]]);
  const totals = new Map<string, bigint>();
  check(m.allocation.bucketTotals.length === 3, "all three source buckets required");
  for (const bucket of m.allocation.bucketTotals) {
    check(expected.get(bucket.bucket) === bucket.weightBps && !totals.has(bucket.bucket) && bucket.empty === false, "source bucket weights/identity mismatch");
    const total = integer(bucket.rawMicroPoints, "bucket micro-points", (1n << 256n) - 1n);
    check(total > 0n, "empty source bucket"); totals.set(bucket.bucket, total);
  }
  const seen = new Set<string>(), byBucket = new Map<string, bigint>();
  let sum: [bigint, bigint] = [0n, 1n];
  check(m.allocation.destinations.length > 0 && m.allocation.destinations.length <= MAX_LEAVES, "invalid destination count");
  const destinationShares = m.allocation.destinations.map((row) => {
    check(typeof row.destination === "string" && !seen.has(row.destination), "duplicate destination row"); seen.add(row.destination);
    const actual = fraction(row.shareNumerator, row.shareDenominator);
    let computed: [bigint, bigint] = [0n, 1n];
    const buckets = new Set<string>();
    for (const b of row.buckets) {
      check(expected.has(b.bucket) && !buckets.has(b.bucket), "invalid destination bucket"); buckets.add(b.bucket);
      const points = integer(b.rawMicroPoints, "destination micro-points", (1n << 256n) - 1n), total = totals.get(b.bucket)!;
      check(points > 0n && points <= total, "destination points exceed bucket");
      byBucket.set(b.bucket, (byBucket.get(b.bucket) ?? 0n) + points);
      const part = fraction(b.shareNumerator, b.shareDenominator);
      check(part[0] * (10000n * total) === BigInt(expected.get(b.bucket)!) * points * part[1], "source contribution mismatch");
      computed = addFraction(computed, part);
    }
    check(actual[0] > 0n && computed[0] * actual[1] === actual[0] * computed[1], "destination share mismatch");
    sum = addFraction(sum, actual);
    return { authority: kcomClaimAuthorityFromScript(input.destinationScriptForAddress(row.destination)), share: actual };
  });
  check(sum[0] === sum[1], "source shares do not total one");
  for (const [bucket, total] of totals) check(byBucket.get(bucket) === total, "source micro-points do not reconcile");
  // Alias addresses may decode to one original authority. Combine exact shares
  // before rounding so aliases do not lose allocation or create extra claims.
  const byAuthority = new Map<string, { authority: KcomClaimAuthority; share: [bigint, bigint] }>();
  for (const row of destinationShares) {
    const key = authority(row.authority), previous = byAuthority.get(key);
    byAuthority.set(key, { authority: row.authority, share: addFraction(previous?.share ?? [0n, 1n], row.share) });
  }
  const entitlements = [...byAuthority.values()].map((row) => {
    const base = KCOM_CLAIM_BASE_RAW * row.share[0] / row.share[1];
    check(base > 0n, "source share rounds to zero entitlement; resolve before freezing manifest");
    return { authority: row.authority, baseEntitlementRaw: base.toString() };
  });
  return buildKcomClaimManifest({ campaignId: input.campaignId, tokenId: input.tokenId, provenance: input.provenance, entitlements });
}

/** Pure preview for the already-reviewed standalone vesting ABI. Never an activation proof. */
export function reviewKcomClaimActivation(input: {
  manifest: KcomClaimEligibilityManifest;
  selections: readonly KcomClaimSelection[];
  leafIndex: number;
  tgeMs: string;
  extensionCommitment: string;
}) {
  const report = settleKcomClaimReference(input.manifest, input.selections);
  const allocation = report.allocations.find((a) => a.leafIndex === input.leafIndex);
  check(allocation, "unselected eligibility cannot activate");
  const tge = integer(input.tgeMs, "TGE");
  check(tge >= 500000000000n && tge <= 9000000000000000n, "TGE outside reviewed contract bounds");
  hex32(input.extensionCommitment, "token extension");
  const template = KCC20_SNAPSHOT_TOKEN_TEMPLATE_PIN;
  return {
    status: "offline-preview-not-an-activation-transaction" as const,
    settlementReferenceHash: report.contentHash,
    nullifier: allocation.nullifier,
    activationExpiry: null,
    requiresBeneficiarySignature: false,
    requiresAuthenticatedClaimAndSettlement: true,
    immediateBeneficiaryTokenOutputRaw: "0",
    state: {
      token_id: input.manifest.tokenId,
      beneficiary: allocation.beneficiary.identifier,
      beneficiary_scheme: allocation.beneficiary.scheme,
      extension: input.extensionCommitment,
      total: allocation.finalAllocationRaw,
      released: "0",
      tier: allocation.tier,
      tge_ms: input.tgeMs,
      token_prefix_len: template.prefixLength,
      token_suffix_len: template.suffixLength,
      token_template_hash: template.hash,
    },
  };
}
