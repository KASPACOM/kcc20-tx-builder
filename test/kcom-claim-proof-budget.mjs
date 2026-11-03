import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as sdk from '../dist/index.js';
const hex = n => BigInt(n).toString(16).padStart(64, '0');
const provenance = { materializationHash: hex(10), membershipSnapshotHash: hex(11), integrityManifestHash: hex(12), sourceManifestHashes: [hex(13)], cutoffMs: '1794700800000' };
const options = { network: 'testnet-10', tokenId: hex(2), campaignBudgetRaw: '1000' };
const input = { campaignId: hex(1), tokenId: hex(2), provenance, entitlements: [27, 38, 61, 72].map((n, i) => ({ authority: { scheme: 0, identifier: hex(i + 1) }, baseEntitlementRaw: String(n) })) };
test('explicit TN10 proof policy preserves 20/30/50 economics and production APIs reject its manifests', () => {
  const policy = sdk.createKcomClaimTn10ProofPolicy(options);
  const m = policy.buildManifest(input);
  assert.equal(m.campaignBudgetRaw, '1000'); assert.equal(m.basePoolRaw, '200');
  assert.equal(m.totalBaseEntitlementRaw, '198'); assert.equal(m.baseRoundingReserveRaw, '2');
  assert.equal(m.proofPolicy.network, 'testnet-10');
  policy.verifyManifest(m, m.contentHash);
  for (const proof of policy.createProofs(m)) sdk.verifyKcomClaimProof({ proof, campaignId: m.campaignId, root: m.root, leafCount: 4 });
  const choices = [1, 3, 2, 3].map((tier, leafIndex) => ({ leafIndex, tier, beneficiary: { scheme: 0, identifier: hex(100 + leafIndex) } }));
  const result = policy.settleReference(m, choices);
  assert.deepEqual(result.allocations.map(r => r.finalAllocationRaw), ['27', '276', '168', '525']);
  assert.equal(result.liabilityRaw, '996'); assert.equal(result.treasuryRaw, '4');
  assert.throws(() => sdk.verifyKcomClaimManifest(m, m.contentHash));
  assert.throws(() => sdk.createKcomClaimProofs(m));
  assert.throws(() => sdk.settleKcomClaimReference(m, choices));
});

test('proof mode rejects other networks, unsupported budgets, tokens and extra options', () => {
  for (const network of ['mainnet', 'testnet-11', '', null]) assert.throws(() => sdk.createKcomClaimTn10ProofPolicy({ ...options, network }));
  for (const campaignBudgetRaw of ['0', '9', '11', '1001', '20010', '10000000000000000', '-10', '010', 1000]) assert.throws(() => sdk.createKcomClaimTn10ProofPolicy({ ...options, campaignBudgetRaw }));
  assert.throws(() => sdk.createKcomClaimTn10ProofPolicy({ ...options, tokenId: 'invalid' }));
  assert.throws(() => sdk.createKcomClaimTn10ProofPolicy({ ...options, allowMainnet: true }));
  const policy = sdk.createKcomClaimTn10ProofPolicy(options);
  assert.throws(() => policy.buildManifest({ ...input, tokenId: hex(3) }), /trusted policy/);
  assert.throws(() => policy.buildManifest({ ...input, entitlements: [{ authority: input.entitlements[0].authority, baseEntitlementRaw: '1' }] }), /floor-rounding/);
});

test('minimum and capped test budgets conserve their exact raw amounts', () => {
  for (const raw of ['10', '20000']) {
    const policy = sdk.createKcomClaimTn10ProofPolicy({ ...options, campaignBudgetRaw: raw });
    const m = policy.buildManifest({ ...input, entitlements: [{ authority: input.entitlements[0].authority, baseEntitlementRaw: (BigInt(raw) / 5n).toString() }] });
    const r = policy.settleReference(m, [{ leafIndex: 0, tier: 3, beneficiary: { scheme: 0, identifier: hex(100) } }]);
    assert.equal(r.liabilityRaw, raw); assert.equal(r.treasuryRaw, '0');
    assert.equal(policy.createProof(m, 0).siblings.length, 0);
  }
});

test('no-Long, empty and unequal Long redistribution use independently worked small-unit results', () => {
  const policy = sdk.createKcomClaimTn10ProofPolicy(options), m = policy.buildManifest(input);
  const choose = (leafIndex, tier) => ({ leafIndex, tier, beneficiary: { scheme: 0, identifier: hex(100 + leafIndex) } });
  assert.equal(policy.settleReference(m, []).treasuryRaw, '1000');
  const noLong = policy.settleReference(m, [choose(0, 1), choose(2, 2)]);
  assert.equal(noLong.liabilityRaw, '388'); assert.equal(noLong.treasuryRaw, '612');
  const single = policy.settleReference(m, [choose(1, 3)]);
  assert.equal(single.liabilityRaw, '998'); assert.equal(single.treasuryRaw, '2');
  const long = policy.settleReference(m, [choose(0, 1), choose(1, 3), choose(3, 3)]);
  assert.equal(long.liabilityRaw, '995'); assert.equal(long.treasuryRaw, '5');
  assert.deepEqual(long.allocations.filter(a => a.tier === 3).map(a => a.unclaimedRedistributionRaw), ['21', '39']);
  assert.throws(() => policy.settleReference(m, [choose(0, 1), choose(0, 3)]), /duplicate original/);
});

test('trusted proof context and content hash cannot be changed by untrusted manifest metadata', () => {
  const mutableOptions = { ...options }, policy = sdk.createKcomClaimTn10ProofPolicy(mutableOptions);
  mutableOptions.campaignBudgetRaw = '20000'; mutableOptions.tokenId = hex(3);
  const m = policy.buildManifest(input);
  assert.equal(m.campaignBudgetRaw, '1000');
  assert.throws(() => policy.verifyManifest(m, hex(99)), /trusted hash/);
  const other = sdk.createKcomClaimTn10ProofPolicy({ ...options, campaignBudgetRaw: '2000' });
  assert.throws(() => other.verifyManifest(m, m.contentHash));
  const forged = structuredClone(m); forged.campaignBudgetRaw = '2000'; forged.proofPolicy.campaignBudgetRaw = '2000';
  const { contentHash, ...unsigned } = forged; forged.contentHash = sdk.kcomClaimContentHash(unsigned);
  assert.throws(() => policy.verifyManifest(forged, forged.contentHash), /canonical reconstruction/);
  m.proofPolicy.campaignBudgetRaw = '20000';
  assert.equal(policy.buildManifest(input).proofPolicy.campaignBudgetRaw, '1000');
  assert.throws(() => policy.createProof(m, 0));
});

test('production content hash stays identical and proof policy is available in CommonJS', async () => {
  const m = sdk.buildKcomClaimManifest({ ...input, entitlements: input.entitlements.map(r => ({ ...r, baseEntitlementRaw: '500000000000000' })) });
  assert.equal(m.contentHash, '7585da07bee327058619fedaa2c8f3a3ccecc25235aa5c59d1a4f39bda111139');
  assert.equal(m.campaignBudgetRaw, '10000000000000000'); assert(!('proofPolicy' in m));
  const { createRequire } = await import('node:module');
  const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
  assert.deepEqual(cjs.createKcomClaimTn10ProofPolicy(options).buildManifest(input), sdk.createKcomClaimTn10ProofPolicy(options).buildManifest(input));
  assert.throws(() => cjs.verifyKcomClaimManifest(sdk.createKcomClaimTn10ProofPolicy(options).buildManifest(input), hex(99)));
});
