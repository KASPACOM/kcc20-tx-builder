# Configurable KCOM v2 (experimental)

This implements transaction construction for a new, separately pinned Argent
artifact family. Existing v1 artifacts and their default builders remain intact.
V2 is selected per request with `params.artifactProfile: "kcom-configurable-v2"`.
The backend must derive this from its authenticated campaign or position record.
Omitting the profile selects existing v1; unknown profiles fail closed. Source
UTXOs and reconstructed scripts must match the selected pinned family. One
builder instance can serve both versions concurrently. V2 remains TN10-only.

Supply KCOMVestingV2.artifact.json, KCOMClaimGraphV2.artifact.json and
KCOMClaimOpenV2.artifact.json through the existing artifact provider. Their
identities, ABIs and linked genesis template hashes are pinned. Unknown artifacts
and mixed versions fail validation.

Terms v3 are 373 bytes: the existing 277-byte layout with version domain v3 and
the new vesting identity, followed by three 32-byte tier schedules. Each schedule
contains four signed little-endian i64 values: period milliseconds, first release
period, number of releases and TGE basis points. Initialization validates all
three. Activation requires `termsHex` and derives its schedule from those frozen
terms, never an unsigned schedule override.

Window: positive, at most 366 days. Period: 1 second to 366 days. First release
period and release count: 1 to 1200. Upfront: 0 to 10000 basis points. The KCOM
preset preserves existing economics and schedules; fast TN10 uses one-minute
periods. Closing remains an explicit administrator transaction.

## Validation

- Existing full package tests and v1 campaign builder regressions pass locally.
- V2 deploy/partial/final vesting, initializer signing and activation PSKTs pass.
- Initializer and activation outputs match independent Argent engine receipts.
- Changed terms, stale sources, redirected fees and changed custody outputs fail.

Run `SNAPSHOT_TEST_WASM=/path/to/pinned/wasm npm run test:kcom-configurable`.
Fixtures originate in the configurable contract engine, not these builders.
Regeneration scripts require explicit contract checkout and receipt paths.

Pending: independent final review, exact-head CI, decoder/backend/frontend
integration and funded TN10 acceptance. This package change does not establish
browser journey readiness and must not enable an unreviewed live campaign.
