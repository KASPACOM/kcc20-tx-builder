# Native holder actions: 2026-11-24

Transfer and native consolidation authenticate holder scripts and covenant identity independently of deployment completion or market eligibility. Trading and wrapping checks remain unchanged.

## Diagnosis

QDEC3 is an unverified deployment with holders matching the current bundled artifact. The verified-token lookup excluded it. PACK2 uses the September 11 artifact, absent from the bundled registry. The frontend also fetched the verification-gated token detail before building, so a backend-only correction was insufficient.

The new authenticated holder-sources route supplies one complete snapshot and a matched profile to the browser builder. Claimed metadata must reproduce the holder commitment; incompatible scripts and conflicting identities remain rejected. It does not change claimVerified or approve a market.

PACK2 compatibility is restricted to transfer/consolidation. Archived artifact source: KASPACOM/kaspa-covenants commit 53175f6f21faf9cbd8dd31c51b677ae2aacc5fcf, wallet-lab/vendor/kcc20/KCC20.placeholder.json. SHA256: 961e14663608026a8b8fc082f8494ca3a35d274db74674ac995ccd1f63878840. Its older keyed public-key hash remains scoped to its pinned standard revision.

Existing limitation: signed consolidation currently supports owner scheme 0 only. Revision-aware hashed-owner selection is tested, but it does not establish scheme-1 consolidation support. The supplied PACK2 holder uses scheme 0.

## Evidence and checklist

- [x] Captured QDEC3 and PACK2 holder scripts authenticate against their respective artifacts.
- [x] Claimed metadata tampering, script tampering, missing identity, empty holdings and upstream failures covered.
- [x] Authenticated snapshot reused for transfer and consolidation; no second source read.
- [x] Backend: 746 tests across 36 suites passed; build, lint, product invariants and OpenAPI drift passed.
- [x] Frontend: 37 focused browser tests passed; lint, typecheck, product invariants and production build passed (existing build warnings remain).
- [x] Builder full npm test passed, including archived-profile transfers and signed consolidation construction. Fixed owner-hash vector included.
- [x] Both consumers tested with the locally packed 0.8.3-fee.8 package.
- [x] Full local backend HTTP request connected to DEV with isolated local Mongo/Redis and transaction workers disabled.
- [ ] Successful live holder-source responses: both QDEC3 and PACK2 were blocked by upstream /covenants HTTP 503 canonical_recovery_in_progress. Local route correctly returned retryable 502, not token-not-found. Evidence: /root/work/kcc20-transfer-investigation-20261124/local-http-holder-sources.json.
- [ ] Funded transfers and consolidation with this adapter; no transaction broadcast during this work. Signed construction tests are not consensus or node acceptance proof.
- [ ] Builder review, normal release publication, then consumer clean-install CI. fee.8 is an unpublished intended version; consumer lockfiles reflect the locally tested tarball and must be checked against the published integrity before merge.
- [ ] Backend rollout before frontend. No merge or deployment performed.
