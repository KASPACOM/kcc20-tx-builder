# Changelog

## 0.8.1-kcom.1 (unpublished)

- Combine the current fee-market builder with the KCOM vesting and claim transaction builders for branch integration tests.
- Keep package publication and runtime enablement pending independent review and funded campaign evidence.

## 0.8.0-fee.6

- Expose the existing fee-market holder merge and seller sweep PSKT handlers through the public builder key registry.
- Keep transaction construction, contract artifacts, legacy operations and snapshot operations unchanged.

## 0.8.0-fee.5

- Add signed fee-market setup, wrap, unwrap, orders, fills, two-ask buyer groups, seller sweeps, holder consolidation, claims and account rotation.
- Check live covenant inputs and fixed market policy before signing. Carry reusable creator consent and the authenticated token holder extension in creator-fee wraps.
- Keep legacy and snapshot builders available. New fee-market creation remains disabled in the application.

## 0.8.0-fee.4

- Require the fee-account owner key to match the connected Schnorr funding wallet for creation and binding.
- Exclude the account source outpoint from binding funding and reject duplicate inputs.

## 0.8.0-fee.3

- Build wallet-signable fee-account genesis and one-time market binding PSKTs from the pinned escrow artifact.
- Keep the account's full KAS principal and lineage during binding; check current node UTXOs, signed fees and mass.
- Return a creation hint for the first bind, since the account state is not visible from an unspent P2SH genesis output.
- Keep fee-market trading, claims, rotation and new-market creation disabled in this prerelease.

## 0.8.0-fee.2

- Verify fee receipts and fee accounts against the pinned escrow artifact and fresh node UTXOs before claim construction.
- Plan independent protocol or creator claims while preserving the other share and matching the signed consensus commitment.
- Keep signing, complete transaction mass checks, and market creation disabled in this prerelease.

## 0.8.0-fee.1

- Package the pinned fee v1 contract artifacts and fixed policy manifest for integration work.
- Verify the raw artifact bytes and policy template tuples in the package test.
- Signed fee-market trade and claim construction remains unavailable in this prerelease.

## 0.8.0-fee.0

- Add fee arithmetic, grouped quotes, policy encoding, creator consent and claim commitments for DEV integration tests.
- Keep transaction construction on the legacy market path; this prerelease does not build or authorize fee-market spends.

## 0.7.0

- Remove duplicate nested snapshot artifact files while preserving their public package subpaths as aliases to the canonical root artifacts.
- Support fixed snapshot supplies above one signed-64-bit KCC1 integer while keeping every holder and reserve amount signed-64-bit.
- Bind wide fixed supplies with the domain-separated `KASPACOM/KCC20/HOLDER/V2` commitment and preserve V1 commitments for ordinary supplies.
- Package the two-limb snapshot bootstrap/controller artifacts and encode their updated immutable state and start-plan commitments.

## 0.6.2

- Reuse authenticated profile scripts during native holder consolidation, including the independent Argent implementation.
- Use each authenticated token profile's consolidation input limit: eight for platform KCC20 and three for Argent. Keep transaction mass and signature checks. Wrapped orderbook limits are unchanged.
- Native consolidation planning now requires `tokenProfileId` from authenticated token readiness; unknown profiles fail before signing. The engine independently authenticates source scripts and does not trust requested limits.


## 0.6.0

- Remove manual token profile review and funded proof flags from runtime capability checks.
- Keep authenticated registry digests, artifact hashes, operation limits, and transaction validation.
- Publish one verified tarball to npmjs and GitHub Packages after a successful version bump on `main`.

## 0.5.0 (unreleased)

- Remove the obsolete operator-controlled snapshot cancellation constant and
  builders; signerless start is the only supported snapshot lifecycle.
- Return canonical start payload bytes from `snapshotStartPayload` so callers
  cannot accidentally reinterpret binary payload data as text.

- Add signerless snapshot deployment, start, claim, transfer, and verification builders with pinned contract artifacts and transaction tests.
- Reject conflicting explicit native covenant IDs during transfer while retaining legacy alias resolution.
- Preserve pre-authorized covenant witnesses and validate wallet signature encodings and sighash bytes.
- Add 24 executable operation scenarios, a validated live-transfer source adapter, and tests run from extracted package contents.
- Add integration and API guides, including amount examples, host-supplied WASM,
  artifact loading, source transport, request schemas, signing, and errors.
- Include guides, release instructions, and security reporting in the npm tarball.
- Replace the README's host-specific bridge example with the exported engine API.
- Document public npm registry overrides and replace obsolete first-release steps.

The engine RPC adapter now supports frozen WASM exports from browser bundlers.

### Public integration examples

- Add runnable browser and Node deploy/transfer examples with WASM and offline fixtures.
- Fix the engine RPC adapter for frozen WASM module exports produced by bundlers.
- Verify packed-package browser/Node parity without external network requests.
