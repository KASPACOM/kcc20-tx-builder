# Offline TN10 proof budgets

Production claim APIs retain the 100M KCOM budget at eight decimals. Their canonical manifest/reference outputs remain unchanged. They reject manifests created by the explicit TN10 proof policy.

Use `createKcomClaimTn10ProofPolicy({ network: "testnet-10", tokenId, campaignBudgetRaw: "1000" })` for dedicated test tokens. The context accepts only 10–20,000 raw units, divisible by ten. It fixes 20% base, 30% Medium/Long and 50% Long pools, preserving floor dust and all existing entitlement rules.

```ts
const policy = createKcomClaimTn10ProofPolicy({
  network: "testnet-10",
  tokenId: dedicatedTestTokenId,
  campaignBudgetRaw: "1000",
});
const manifest = policy.buildManifest({ campaignId, tokenId: dedicatedTestTokenId, provenance, entitlements });
policy.verifyManifest(manifest, independentlyTrustedContentHash);
const proofs = policy.createProofs(manifest);
const reference = policy.settleReference(manifest, selections);
```

Manifests carry an explicit `proofPolicy` label. The policy captures trusted token/budget options; it never infers its permissions from manifest metadata. Manifest reconstruction, proof export and reference settlement all use that context. Changing a returned manifest or the caller's original options cannot change the captured context. Proof membership verification remains a root/leaf check; callers must authenticate their campaign root and policy separately.

At a 1,000-raw budget, frozen entitlements `[27, 38, 61, 72]` leave two raw units of base floor dust. Short/Long/Medium/Long choices produce `[27, 276, 168, 525]`, totaling 996 with four raw units remaining. A lone Long receives 998; no-Long Short/Medium choices total 388 with 612 remaining. Tests check these worked values, context tampering, bounds, unchanged production hashes and ESM/CommonJS consumers.

This API is offline. It does not build, sign, submit or fund a transaction, establish that a token exists on TN10, or prove that it is dedicated to testing. The caller must separately verify accepted token/deployment evidence and enforce the aggregate allowance across campaigns. A per-policy 20,000-raw cap does not reset or enlarge the user's aggregate 20,000-raw/150-test-KAS authorization. No package publication or deployment is included.
