# Changelog

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
