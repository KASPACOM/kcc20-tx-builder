# Wallet integration checklist

Scope: external wallet quantities, native sends, wrap/unwrap, existing public reads.
No new indexer endpoints, frontend merges, trading screens, import or snapshots.
Status and evidence describe this integration, not older internal proofs.

| ID | Capability | Inventory | Implementation | Local test | Funded TN10 test |
| --- | --- | --- | --- | --- | --- |
| W01 | Public installation and runtime pins | Exists | Published 0.8.3-fee.4 | Credential-free public installation, 49 tests, build and 24 browser recipe comparisons pass | N/A |
| W02 | Directory, decimals, metadata fallback | Exists | Documented | Missing precision stays explicit; unknown holdings remain visible | Live directory and native proof balance agree on decimals 2 |
| W03 | Native/wrapped balances and exact formatting | Exists | PR #689 deployed | Exact formatting and grouping pass | Funded November 11: deployed API groups 99000 native + 1000 wrapped under one canonical token; partial unwrap gives 99400 + 600 |
| W04 | Search, pagination, filters, sorts | Exists | Existing query contract documented | Existing service filter/sort tests and URL tests pass | Combined search/native/quantity/pagination/sort query returned expected 100000-unit row |
| W05 | Open ask quantities, no bid token credit | Exists | Source audit complete | Existing projection inspected | Real ask showed 990 native + 10 open; cancel accepted |
| W06 | Honest profile/action capabilities | Exists | PR #689 merged after independent review | 13 focused tests and hosted functional checks pass | Zero production audit findings; both DEV replicas updated; native-only holder resolves current fee market |
| W07 | Native partial/full send | Exists | Public helper implemented | Build and sign tested | Four backend-built sends signed and broadcast: partial, full recipient return, full consolidated balance and full return; all accepted/indexed |
| W08 | Fragmented inputs and consolidation | Exists | Existing helper reused | Full fragmented send rejects before signing | Prior five-holder proof plus fresh four-holder consolidation using fee.4; full 100000-unit backend sends accepted in both directions |
| W09 | Fee-market wrap and partial/full unwrap | Exists | Example implemented | Existing 111 signed wrapper tests pass | Repeated with published fee.4: wrap 1000, unwrap 400 then 600 accepted/indexed; balances verified at each stage |
| W10 | Direct wrapped send | Missing | Not advertised; unwrap then send | N/A | N/A |
| W11 | Public mint | Exists | Published helper and guide; policy-dependent | Non-owner paused mint rejects before signing | Two real non-owner mints accepted/indexed; pause/re-enable and final supply verified; 200 base units in wallet B |
| W12 | General token burn | Missing | No public generic burn operation advertised | Source operation registry checked | N/A |
| W13 | FeeTickets | Exists | Separate coupon reference; admin/trading deferred | N/A | N/A |
| W14 | Activity | Exists | Optional existing route only | N/A | Both public mint IDs appear as mint_public with 100 base units each; optional UI not built |
| W15 | Freshness, confirmation and retry handling | Exists | Implemented with explicit stale state | Stale source, rejected wallet, spent input and journal-before-submit checks pass | Latest read: ok=false, stale=false; no overall health claim |
| W16 | Browser and Node examples | Exists | Shared build/sign flow implemented | 49 tests and browser build pass | Node adapter funded; real extension/browser signing not tested |
| W17 | Independent review | Complete | All five review findings fixed; independent review approved | Base units, input recheck, durable pre-submit persistence tested | N/A |
| W18 | Prerelease and registry rerun | Exists | 0.8.3-fee.4 public; release workflow passed | Exact registry version installed without credentials; 49 examples/build/browser pass | November 11 funded wrap/order/cancel/unwrap/consolidation uses public fee.4; deployed backend transfer engine remains pinned fee.3, signed with fee.4 examples |
| W19 | Deployed docs verification | Exists | Builder guide public and byte-verified | Backend docs linked in PR #689 | Served public-testnet-api.md byte-matches #689 and includes wallet guide/checklist links |

## Evidence rules

Record package/runtime/artifact revisions, operation, test command, transaction ID,
acceptance result and balance changes. Separate submitted, accepted and indexed.
Never record wallet secrets. Failed or skipped checks stay open. HTTP response
creation time and recent local fetches do not prove chain/indexer freshness.

PR #60 merged before this work. #686 is the prior backend documentation change;
it merged as `91eadbf3` on November 11. Work in progress in the
previous public-integration checkout is preserved. This checklist supersedes
that broader trading lifecycle for this wallet-focused task only.

Evidence: [native funded run](evidence/wallet-native-tn10-20261110.json). The RPC outputs and public settlement/balance reads agree for these transfers; global freshness remains stale.

Funded wrapper evidence: [fee-market lifecycle](evidence/wallet-fee-tn10-20261110.json).

Backend discovery uses existing authenticated fee-market reads, at most 64 held identities
and four concurrent lookups per request. Excess identities remain visible with send/wrap
capabilities disabled. Builder hosted CI and publication passed. Backend hosted lint, tests, typecheck,
build, database proof, OpenAPI and production dependency audit passed at aaffb54b.
Backend #689 merged; frontend remains unmerged.

Before #689 rollout, backend-assisted transfer building timed out after 25 seconds.
Post-rollout unsigned builds now pass on the public route and both replicas (evidence below).
Local builder construction and funded submission passed independently; the November 11
backend-generated requests were signed, broadcast, accepted and decoded with controlled Node wallets.

## Delivery evidence, November 10

- Builder [PR #61](https://github.com/KASPACOM/kcc20-tx-builder/pull/61) merged as `8e94e70c70e0b99a76578d059d4806280a68fe09`.
- [Publication run](https://github.com/KASPACOM/kcc20-tx-builder/actions/runs/42914638428) verified both registries for `0.8.3-fee.4`.
- Public tarball examples: `npm ci`, install exact `@kaspacom/kcc20-tx-builder@0.8.3-fee.4`, `npm run build`, `npm test`, `npm run test:browser`, all passed without repository/npm credentials.
- Backend [PR #689](https://github.com/KASPACOM/kcc20-backend/pull/689) merged as `90b5dd9626143dfe6aa7ae61e4fb69eec66ef9c9`. [CI](https://github.com/KASPACOM/kcc20-backend/actions/runs/42920180200) passed, including the corrected production audit with zero vulnerabilities. DEV image workflow `42921820052` passed. Both replicas run the merge revision and `/health` returns HTTP 200.
- Final funded return is indexed and decoded. Wallet A has `100000` base units in one holder; wallet B has no nonzero holding of the proof token.
- Global freshness remains stale. Backend-assisted transfer building recovered after rollout, as recorded below. Real extension-wallet interaction and optional public mint were not exercised.

- Backend transfer timeout follow-up: [PR #690](https://github.com/KASPACOM/kcc20-backend/pull/690), commit `bc5d9dd70a40125095a3f1e42a9f773d4d0c9435`. Independent source review approved and the PR merged as `44460ea2`. Full CI subsequently failed an older shutdown lifecycle assertion; the test-only follow-up [#692](https://github.com/KASPACOM/kcc20-backend/pull/692) passes both RPC suites locally (215 tests), is independently approved, and passed [full CI](https://github.com/KASPACOM/kcc20-backend/actions/runs/42925498123). It merged as `474786d8db3f866d38377226172b441f8b5058cd`. The DEV image pipeline passed and both API replicas now run that revision. The PR contains its repeatable read-only transport proof.

Deployed follow-up: [recorded backend checks](evidence/wallet-backend-rollout-20261110.json). After #689 rolled out, the public transfer build returned HTTP 201 and ready-to-sign in 1.335 seconds. Each replica also passed the origin build (799 ms / 752 ms). Display amount 1 became 100 base units. These unsigned builds were not broadcast. Those first checks established fresh-process recovery, separately from the final timeout-fix verification below; they do not prove historical freshness.

Final backend verification, November 11: #690 and its test correction #692 are
merged and deployed at `474786d8`. Full hosted CI passed 3,254 tests across 294
suites and the production audit found zero vulnerabilities. The public unsigned
transfer build returned HTTP 201 / ready-to-sign in 684 ms; both API replicas
passed direct checks (1,373 ms / 1,004 ms). `/health` returned HTTP 200. Evidence
is in the finalVerification section of the rollout JSON. No frontend was merged.
The funded proof below now covers backend signing and broadcasting with controlled
Node wallets. At that checkpoint browser interaction, optional mint and historical freshness remained open; the funded mint results below close optional mint.

## Funded TN10 verification, November 11

[Transaction IDs, mass, fees, settlement results and balance snapshots](evidence/wallet-funded-tn10-20261111.json).

Ten fresh transactions were broadcast, observed in the node UTXO set and decoded
through the existing settlement API: four backend-built sends, wrap, ask placement,
cancel, partial unwrap, full unwrap and four-holder consolidation. The test token
finished with all 100000 base units in wallet A, in one native holder; wallet B,
wrapped holdings and the test order are empty. Total network fees: 1.703669 KAS
on TN10. No frontend merge or new indexer API was involved.

The live backend rejected an invalid recipient (400), a spent holder (422), and
insufficient token balance (422). Fragmented full sending required consolidation
before signing. The first transfer needed more than the initial 30-second wait;
we checked the saved transaction ID and resumed without rebroadcasting it.

These tests cover the wallet integration flows listed above. They do not prove
browser-extension UX, optional public mint, every owner authority scheme, or
historical indexer completeness. `/trading/freshness` still reports stale.


## Funded public mint, November 12 (Israel time)

[Six transaction IDs, exact KAS accounting and API/node results](evidence/wallet-public-mint-tn10-20261112.json).
The UTC verification timestamp is recorded in the evidence. A fresh WMINT token
has two decimals, 200 base units maximum supply and no premint. A different wallet
minted 100 units twice using the public path from published `0.8.3-fee.4`.
The creator enabled minting, paused it after the first mint, then re-enabled it.
Both paused attempts were rejected locally before signing.

Each public mint paid 0.5 KAS to the token treasury and 0.5 KAS to the protocol
wallet. Network fees are accounted for separately. Both holder outputs remain
in the node UTXO set, wallet balance is 200 base units, and no mint authority
remains. The existing activity route includes both transactions and quantities.
The backend correctly rejected a further mint with HTTP 400, but its original
pause wording was misleading after exhaustion; [backend #698](https://github.com/KASPACOM/kcc20-backend/pull/698) corrects that diagnostic and has passed independent review; deployment verification is pending.

### Remaining boundaries

- Browser examples build and pass recipe tests; an actual third-party extension's
  approval/rejection UI still requires that wallet's integration test.
- These controlled wallets prove Schnorr P2PK integration, not every authority scheme.
- Global historical freshness remains an operational gate; recent accepted
  transactions do not establish historical completeness.
- Direct wrapped sending, generic burn, coupon administration and trading UI
  remain outside this integration. No new API or frontend merge is required.

Release candidate `0.8.3-fee.5` packages these docs and proof without changing
contract artifacts or transaction construction. Examples pin tested `fee.4`.
Local package tests, compatibility verification, 49 example tests, example build
and 24 browser/Node recipe comparisons passed. Publication and exact-registry
rerun remain pending until this PR merges.
