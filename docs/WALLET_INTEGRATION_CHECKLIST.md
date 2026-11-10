# Wallet integration checklist

Scope: external wallet quantities, native sends, wrap/unwrap, existing public reads.
No new indexer endpoints, frontend merges, trading screens, import or snapshots.
Status and evidence describe this integration, not older internal proofs.

| ID | Capability | Inventory | Implementation | Local test | Funded TN10 test |
| --- | --- | --- | --- | --- | --- |
| W01 | Public installation and runtime pins | Exists | In progress | 49 example tests passed on 0.8.3-fee.3; clean install and browser build passed | N/A |
| W02 | Directory, decimals, metadata fallback | Exists | Auditing | Pending | Live route verified; holdings parity pending |
| W03 | Native/wrapped balances and exact formatting | Needs correction | Fee-market grouping fix written | Exact formatting and grouping pass | Recorded live data reproduces incorrect native labeling; corrected local service groups 990 native + 10 wrapped |
| W04 | Search, pagination, filters, sorts | Exists | Auditing | Pending | Live Swagger confirms all queries |
| W05 | Open ask quantities, no bid token credit | Exists | Source audit complete | Existing projection inspected | Real ask showed 990 native + 10 open; cancel accepted |
| W06 | Honest profile/action capabilities | Needs correction | Unknown holding capability fix written | 13 backend tests pass | Live deployment not yet changed |
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
| W17 | Independent review | In progress | All five review findings fixed; independent review approved | Base units, input recheck, durable pre-submit persistence tested | N/A |
| W18 | Prerelease and registry rerun | In progress | 0.8.3-fee.4 prepared, not published | Current funded examples use published 0.8.3-fee.3 | Exact new prerelease rerun pending |
| W19 | Deployed docs verification | Missing | Pending | Pending | N/A |

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
capabilities disabled. Final hosted CI, package publication and deployed documentation
checks remain separate gates.

Backend-assisted transfer build did not return within 25 seconds during the final
probe. Local builder construction and funded submission passed independently.
Do not describe the backend-assisted path as verified end to end.
