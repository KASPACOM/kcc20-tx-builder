# KCOM claim shard sizing probe, 2 November 2026

The [receipt](kcom-claim-shard-load-local-20261102.json) comes from
`SNAPSHOT_TEST_WASM=examples/vendor/kaspa node test/kcom-claim-shard-load.mjs`
at builder commit `ae75dd1bbab592843bced1fdc723900d886b2bb7`.

The script builds 1,024 and 4,096 authority manifests, checks the Merkle
proofs through the shared builder, constructs and signs a first Long selection,
and asks the pinned Kaspa WASM for standard transaction mass. Both cases
reported mass 79,705 of the 100,000 limit. Witness sizes were 21,534 and
21,661 bytes. Merkle siblings alone were 320 and 384 bytes. The equal mass
results are reported as measured; proof growth did not increase total mass in
these two cases.

The script also routes 4,096 deterministic identities through 4, 16, 64,
and 256 shards. This is a hash-distribution model, not a throughput or
retry test. At the current one-KAS value per claim shard, these configurations
lock 4, 16, 64, and 256 KAS in the shard outputs alone. The 256-shard model
exceeds the 150-KAS campaign proof cap before fees or other actors.

All UTXOs in this probe are synthetic. The receipt records no TN10 submission,
acceptance, chain contention, indexer result, or production sizing decision.
Actual same-shard conflicts, independent-shard parallelism, fees, and lockup
must be measured with funded transactions before choosing the production count.
