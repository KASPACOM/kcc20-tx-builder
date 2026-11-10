# Wallet integration checklist

Scope: external wallet quantities, native sends, wrap/unwrap, existing public reads.
No new indexer endpoints, frontend merges, trading screens, import or snapshots.
Status and evidence describe this integration, not older internal proofs.

| ID | Capability | Inventory | Implementation | Local test | Funded TN10 test |
| --- | --- | --- | --- | --- | --- |
| W01 | Public installation and runtime pins | Exists | Published 0.8.3-fee.4 | Credential-free public installation, 49 tests, build and 24 browser recipe comparisons pass | N/A |
| W02 | Directory, decimals, metadata fallback | Exists | Documented | Missing precision stays explicit; unknown holdings remain visible | Live directory and native proof balance agree on decimals 2 |
| W03 | Native/wrapped balances and exact formatting | Needs correction | PR #689 deployed | Exact formatting and grouping pass | Recorded live data reproduces incorrect native labeling; corrected local service groups 990 native + 10 wrapped |
| W04 | Search, pagination, filters, sorts | Exists | Existing query contract documented | Existing service filter/sort tests and URL tests pass | Combined search/native/quantity/pagination/sort query returned expected 100000-unit row |
| W05 | Open ask quantities, no bid token credit | Exists | Source audit complete | Existing projection inspected | Real ask showed 990 native + 10 open; cancel accepted |
| W06 | Honest profile/action capabilities | Needs correction | PR #689 merged after independent review | 13 focused tests and hosted functional checks pass | Zero production audit findings; both DEV replicas updated; native-only holder resolves current fee market |
| W07 | Native partial/full send | Exists | Public helper implemented | Build and sign tested | Partial A-to-B and full B-to-A accepted, indexed; A returned to 100000 base units |
| W08 | Fragmented inputs and consolidation | Exists | Existing helper reused | Full fragmented send rejects before signing | Five holders consolidated; full 100000-unit A-to-B and B-to-A transactions accepted using final adapter |
| W09 | Fee-market wrap and partial/full unwrap | Exists | Example implemented | Existing 111 signed wrapper tests pass | Wrap 1000, unwrap 400 then 600 accepted; another wrap/unwrap accepted |
| W10 | Direct wrapped send | Missing | Not advertised; unwrap then send | N/A | N/A |
| W11 | Public mint | Exists | Conditional on token policy | Pending | Pending |
| W12 | General token burn | Missing | No public generic burn operation advertised | Source operation registry checked | N/A |
| W13 | FeeTickets | Exists | Separate coupon reference; admin/trading deferred | N/A | N/A |
| W14 | Activity | Exists | Optional existing route only | N/A | Existing activity route returned HTTP 200 for proof token; optional UI not built |
| W15 | Freshness, confirmation and retry handling | Exists | Implemented with explicit stale state | Stale source, rejected wallet, spent input and journal-before-submit checks pass | Live freshness remains stale; no overall health claim |
| W16 | Browser and Node examples | Exists | Shared build/sign flow implemented | 49 tests and browser build pass | Node adapter funded; real extension/browser signing not tested |
| W17 | Independent review | Complete | All five review findings fixed; independent review approved | Base units, input recheck, durable pre-submit persistence tested | N/A |
| W18 | Prerelease and registry rerun | Exists | 0.8.3-fee.4 public; release workflow passed | Exact registry version installed without credentials; 49 examples/build/browser pass | Funded operations used 0.8.3-fee.3; engine/artifacts unchanged in fee.4 |
| W19 | Deployed docs verification | Partial | Builder guide public and byte-verified | Backend docs linked in PR #689 | Backend deployed; served documentation comparison pending |

## Evidence rules

Record package/runtime/artifact revisions, operation, test command, transaction ID,
acceptance result and balance changes. Separate submitted, accepted and indexed.
Never record wallet secrets. Failed or skipped checks stay open. HTTP response
creation time and recent local fetches do not prove chain/indexer freshness.

PR #60 merged before this work. #686 is the prior backend documentation change;
it remains open as checked on November 10. Work in progress in the
previous public-integration checkout is preserved. This checklist supersedes
that broader trading lifecycle for this wallet-focused task only.

Evidence: [native funded run](evidence/wallet-native-tn10-20261110.json). The RPC outputs and public settlement/balance reads agree for these transfers; global freshness remains stale.

Funded wrapper evidence: [fee-market lifecycle](evidence/wallet-fee-tn10-20261110.json).

Backend discovery uses existing authenticated fee-market reads, at most 64 held identities
and four concurrent lookups per request. Excess identities remain visible with send/wrap
capabilities disabled. Builder hosted CI and publication passed. Backend hosted lint, tests, typecheck,
build, database proof, OpenAPI and production dependency audit passed at aaffb54b.
Backend #689 merged; frontend remains unmerged.

Backend-assisted transfer build did not return within 25 seconds during the final
probe. Local builder construction and funded submission passed independently.
Do not describe the backend-assisted path as verified end to end.

## Delivery evidence, November 10

- Builder [PR #61](https://github.com/KASPACOM/kcc20-tx-builder/pull/61) merged as `8e94e70c70e0b99a76578d059d4806280a68fe09`.
- [Publication run](https://github.com/KASPACOM/kcc20-tx-builder/actions/runs/42914638428) verified both registries for `0.8.3-fee.4`.
- Public tarball examples: `npm ci`, install exact `@kaspacom/kcc20-tx-builder@0.8.3-fee.4`, `npm run build`, `npm test`, `npm run test:browser`, all passed without repository/npm credentials.
- Backend [PR #689](https://github.com/KASPACOM/kcc20-backend/pull/689) merged as `90b5dd9626143dfe6aa7ae61e4fb69eec66ef9c9`. [CI](https://github.com/KASPACOM/kcc20-backend/actions/runs/42920180200) passed, including the corrected production audit with zero vulnerabilities. DEV image workflow `42921820052` passed. Both replicas run the merge revision and `/health` returns HTTP 200.
- Final funded return is indexed and decoded. Wallet A has `100000` base units in one holder; wallet B has no nonzero holding of the proof token.
- Global freshness remains stale. Backend-assisted transfer building timed out. Real extension-wallet interaction and optional public mint were not exercised.

- Backend transfer timeout follow-up: [PR #690](https://github.com/KASPACOM/kcc20-backend/pull/690), commit `bc5d9dd70a40125095a3f1e42a9f773d4d0c9435`. Independent source review approved and the PR merged as `44460ea2`. Full CI subsequently failed an older shutdown lifecycle assertion; the test-only follow-up [#692](https://github.com/KASPACOM/kcc20-backend/pull/692) passes both RPC suites locally (215 tests), is independently approved, and is running full CI. The timeout fix is not yet verified deployed. The PR contains its repeatable read-only transport proof.

Deployed follow-up: [recorded backend checks](evidence/wallet-backend-rollout-20261110.json). After #689 rolled out, the public transfer build returned HTTP 201 and ready-to-sign in 1.335 seconds. Each replica also passed the origin build (799 ms / 752 ms). Display amount 1 became 100 base units. These unsigned builds were not broadcast. Fresh-process recovery does not replace the pending timeout fix in #690 or prove historical freshness.
