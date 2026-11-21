# RT2-96 / RT2-97: verification and mint lane capacity

## Diagnosis

A paid ESCP-style deployment with 900 tokens, ten lanes, no premint and a 0.01 KAS price passed deployment validation. Deployment checked aggregate mint supply against a 0.5 KAS fee floor. Verification instead requires an exact paid amount worth at least 1 KAS, with a default of at least one display token, from one lane. Each lane held only 90 tokens; verification needed 100. A regression assertion against the original builder reproduced this before editing.

The mint form advertised 100,000 display tokens without reading the available lane capacities. The backend planner already checked individual lanes, but browser-built operations use the shared builder directly. The original builder rejected insufficient lanes with a generic error, and the queue offered Retry with the same invalid amount.

## Changes

- Frontend and backend deployment guards compare the exact verification requirement with the largest initial lane. Shared builder validation enforces the same rule. No fee or contract policy changed.
- Backend verification checks the selected authenticated lane rather than aggregate supply and prefers the larger remainder lane. Free verification can consume a fractional lane in the backend and new builder instead of requiring a whole display token.
- Mint forms load the existing covenant UTXO snapshot, show the largest lane capped by the existing public-mint limit, and round paid maximums down to an exact-sompi amount. No lanes are summed to authorize a transaction.
- Loading and unavailable lane evidence block mint submission. Same-token supply refresh and route changes refresh capacity; late responses cannot overwrite a new route. The build path obtains a fresh snapshot again. The existing PSKT engine also checks the chosen outpoint against the node before building.
- Invalid amounts produce an actionable message and cannot be retried or signed through the queue. Source/network errors retain recovery behavior. No token authorities were changed.

## Verification ledger

| Case | Evidence | Result |
|---|---|---|
| RT2-96 reported 90-token lane vs 100-token verification | Builder red assertion; frontend deployment guard; backend policy regression | Local pass |
| Below / exactly at / above requirement | Builder matrix, decimals 0/2/8 and lanes 1/3/10 | Local pass |
| Unequal remainder lanes | Backend selects authenticated 301-unit lane over 300-unit lane | Local pass |
| Explicit verify request above selected lane despite sufficient aggregate | Backend verification planner | Local pass |
| Fixed / controlled / zero-price deploys | Existing and added policy tests | Local pass |
| Free fractional verification | Backend and builder tests select 9 base units at 2 decimals | Local pass; builder consumer rollout pending |
| RT2-97 partial lanes / exact maximum / one unit over | 90+40 lane fixture permits 90, rejects 91 | Local pass |
| Exhausted lanes | Empty/zero lane fixtures block mint and show no capacity | Local pass |
| Decimals and exact sompi | 0/2/8-decimal caps; 199 units at scale 100 and 3 sompi rounds maximum to 100 | Local pass |
| Concurrent consumption / changed quote | Fresh snapshot reduces lane 90 to 89; previous 90 request rejected | Local simulated pass, not funded concurrency proof |
| Known-invalid config never reaches signing | Deployment build guard and queue signer spies | Local pass |
| Impossible retry | Queue card and direct retry method both refuse unchanged invalid amount | Local pass |
| Source error, refresh, route race | Async capacity effect regressions | Local pass |
| Browser component flow | 389 headless Angular tests across deploy, token page, mint panel/dialog, action API and queue; final 200-test targeted rerun after UI polish | Pass |
| Backend suites | 67 tests: deploy policy, verification, mint planner, revealability | Pass |
| Builder | Full npm test, including new boundary tests, smoke/CommonJS, token profiles, escrow and funding suites | Pass |
| Independent review | Separate agent source review; no blocking findings; refresh-button inconsistency corrected | Pass |
| Funded TN10 transactions / DEV behavior | Not run for these changes; fixtures used and no settings changed | Pending approved rollout |

## Delivery

Frontend and backend PRs target develop from isolated worktrees. Builder targets main because the repository has no develop branch and the user approved main. No PR uses #373 as its base. No merge, deployment, package publication, or authority/configuration change is included.

Frontend/backend retain their current published builder pins. Their application guards use existing published APIs. The builder's new standalone validation and fractional-free local verification require a later package release and consumer pin update; an unpublished version is not referenced by these PRs.

Durable test logs are copied to `/root/work/kcc20-mint-lane-evidence-20261121/`. A read-only visual attempt captured the loading shell while DEV token details were unavailable; it does not count as a successful live mint-flow check.

Evidence: /tmp/mint-lane-red.log, /tmp/mint-fe-tests.log, /tmp/mint-back-tests.log, /tmp/mint-builder-tests-final.log. Build and lint logs use /tmp/mint-{fe,back}-*.log. These are local checks, not deployed evidence.
