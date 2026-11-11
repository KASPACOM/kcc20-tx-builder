# Public integration delivery checklist

Authoritative tracker for the public KCC20 lifecycle. Statuses: Not started,
In progress, Blocked, Verified. Local validation and funded chain verification
are separate. An existing internal proof does not verify a new public example.

Target: DEV TN10; deployment, mint, transfer, market setup, wrap/unwrap, trading,
FeeTickets and escrow claims. Import, snapshots, holder rewards, lightweight
index server and frontend merges are excluded. Public backend gaps are documented,
not filled by adding endpoints. Keep npm `latest` unchanged.

## Evidence ledger

| ID | Deliverable | Status | PR / package | Local evidence | Funded TN10 evidence |
| --- | --- | --- | --- | --- | --- |
| PUB-01 | Public repository and npm access | Verified | #60 / 0.8.3-fee.3 | Anonymous tarball retrieval; PACKAGE_CONTENT_REVIEW.md | Not applicable |
| PUB-02 | Reviewed published archive | Verified | #60 / 0.8.3-fee.3 | Scoped credential-pattern scan, archive SHA-256 recorded | Not applicable |
| PUB-03 | Builder-first guide and baseline examples | Verified | #60 merged / 0.8.3-fee.3 | 42 example tests; build; offline deploy/transfer; fee quote; hosted CI | Not claimed |
| PUB-04 | Backend public guides deployed | In progress | #686 / 0.8.3-fee.3 | 11 tests, build, product invariants; hosted CI blocked by production dependency audit (10 findings, including critical Mongoose); guide link now resolves | Not applicable |
| PUB-05 | Operation and public-route support matrix | In progress | [#63](https://github.com/KASPACOM/kcc20-tx-builder/pull/63), [#64](https://github.com/KASPACOM/kcc20-tx-builder/pull/64), [#65](https://github.com/KASPACOM/kcc20-tx-builder/pull/65) / 0.8.3-fee.3 | PUBLIC_OPERATION_MATRIX.md traces planners and registry; funded HTTP support pending | Pending supported HTTP journeys |
| PUB-23 | Wallet-provider balances/transfer guide | In progress | [#63](https://github.com/KASPACOM/kcc20-tx-builder/pull/63), [#64](https://github.com/KASPACOM/kcc20-tx-builder/pull/64), [#65](https://github.com/KASPACOM/kcc20-tx-builder/pull/65) / 0.8.3-fee.3 | Current public OpenAPI confirms decimals and all balance query fields; PUBLIC_WALLET_PROVIDER.md | Pending transfer journey |
| PUB-06 | IDs, policies, fees, refunds and lifecycle diagram | In progress | [#63](https://github.com/KASPACOM/kcc20-tx-builder/pull/63), [#64](https://github.com/KASPACOM/kcc20-tx-builder/pull/64), [#65](https://github.com/KASPACOM/kcc20-tx-builder/pull/65) / 0.8.3-fee.3 | Source-backed documentation | Pending lifecycle reconciliation |
| PUB-07 | Exact runtime/artifact pins and clean install | In progress | [#63](https://github.com/KASPACOM/kcc20-tx-builder/pull/63), [#64](https://github.com/KASPACOM/kcc20-tx-builder/pull/64), [#65](https://github.com/KASPACOM/kcc20-tx-builder/pull/65) / 0.8.3-fee.3 | Existing compatibility manifest and example lockfile | Not applicable |
| PUB-08 | Shared browser/Node build, sign and broadcast adapters | In progress | [#63](https://github.com/KASPACOM/kcc20-tx-builder/pull/63), [#64](https://github.com/KASPACOM/kcc20-tx-builder/pull/64), [#65](https://github.com/KASPACOM/kcc20-tx-builder/pull/65) / 0.8.3-fee.3 | 57 example tests pass; signed mass, zero-signature witnesses, source rechecks and finalized transaction IDs | Native deploy and self-transfer accepted; full lifecycle pending |
| PUB-09 | Deploy token and creator settings | In progress | [#63](https://github.com/KASPACOM/kcc20-tx-builder/pull/63), [#64](https://github.com/KASPACOM/kcc20-tx-builder/pull/64), [#65](https://github.com/KASPACOM/kcc20-tx-builder/pull/65) / 0.8.3-fee.3 engine | Published deploy helper and local runner | PUBDOC1 and PUBDOC2 accepted; 1-percent creator configuration bound |
| PUB-10 | Fee accounts, consent, genesis and binding | In progress | [#63](https://github.com/KASPACOM/kcc20-tx-builder/pull/63), [#64](https://github.com/KASPACOM/kcc20-tx-builder/pull/64), [#65](https://github.com/KASPACOM/kcc20-tx-builder/pull/65) / 0.8.3-fee.3 engine | Signed bind fixtures at 0/1/5 percent | 0-percent and 1-percent market setup accepted, including creator consent and both account bindings |
| PUB-11 | Mint, transfer and native consolidation | In progress | [#63](https://github.com/KASPACOM/kcc20-tx-builder/pull/63), [#64](https://github.com/KASPACOM/kcc20-tx-builder/pull/64), [#65](https://github.com/KASPACOM/kcc20-tx-builder/pull/65) / 0.8.3-fee.3 engine | Native transfer runner | Self-transfer, distinct-recipient transfer, paid public mint and native consolidation accepted |
| PUB-12 | Wrap, unwrap and wrapped consolidation | In progress | [#63](https://github.com/KASPACOM/kcc20-tx-builder/pull/63), [#64](https://github.com/KASPACOM/kcc20-tx-builder/pull/64), [#65](https://github.com/KASPACOM/kcc20-tx-builder/pull/65) / 0.8.3-fee.3 engine | Exact-source normalization regression passes | Wrap, buyer unwrap and two-holder consolidation accepted |
| PUB-13 | Asks/bids, partial/final fills and cancellations | In progress | [#63](https://github.com/KASPACOM/kcc20-tx-builder/pull/63), [#64](https://github.com/KASPACOM/kcc20-tx-builder/pull/64), [#65](https://github.com/KASPACOM/kcc20-tx-builder/pull/65) / 0.8.3-fee.3 engine | Runner build/tests pass | Asks, partial/final buys, bids and both cancellations accepted |
| PUB-14 | Two-ask buy and 3-/10-bid seller sweeps | In progress | #65 / 0.8.3-fee.3 | Packed tests pass | Two-ask ticket buy, three-bid sale and ten-bid sales with/without a ticket accepted; small-payout limitation retained |
| PUB-15 | FeeTicket creation, transfer, waiver, burn/refund | In progress | [#63](https://github.com/KASPACOM/kcc20-tx-builder/pull/63), [#64](https://github.com/KASPACOM/kcc20-tx-builder/pull/64), [#65](https://github.com/KASPACOM/kcc20-tx-builder/pull/65) / 0.8.3-fee.3 | Published recipe and signed runner | Public mint, ticket creation/transfer, two-ask waiver and full refund accepted/indexed; misuse rejection pending |
| PUB-16 | Protocol/creator claims, 1–5 receipts, both orders | In progress | [#63](https://github.com/KASPACOM/kcc20-tx-builder/pull/63), [#64](https://github.com/KASPACOM/kcc20-tx-builder/pull/64), [#65](https://github.com/KASPACOM/kcc20-tx-builder/pull/65) / 0.8.3-fee.3 engine | Runner tests pass | 1–5 selected receipts accepted; creator-first and protocol-first journeys covered; exact per-count/party coverage below |
| PUB-17 | Authority rotation and supported recipient adapter | In progress | #65 / 0.8.3-fee.3 | Rotation runner | Wallet rotation, pinned recipient-covenant two-receipt claim and rotation back accepted |
| PUB-18 | Resumption, stale inputs, wallet/RPC/indexing failures | In progress | #65 / 0.8.3-fee.3 | 57 example tests include signer/RPC/source failures and mismatch-ID resume | Accepted-ID resumption works; spent-ask rebuild rejects before signing; broader matrix pending |
| PUB-19 | Creator 0/1/5%, fee floors and signed mass matrix | In progress | #65 / 0.8.3-fee.3 | Signed fixtures and recorded masses | 0/1/5-percent markets, fee floors, grouped waiver and above-floor 51-KAS trade accepted |
| PUB-20 | Independent final example/security-boundary review | In progress | Follow-up | Reviewer found resume mismatch-ID omission; fixed with regression test. Final static review APPROVE for 0c55e7c; no tests run by reviewer | Not applicable |
| PUB-21 | Immutable prerelease and fresh registry smoke checks | Not started | Pending | No new version published | Pending published-version proof |
| PUB-22 | Served docs/OpenAPI/link parity and CI checks | Not started | Pending | Pending | Not applicable |

## Completion requirements

Each funded result must identify the operation, package/runtime/artifact pins,
transaction ID, signed mass values, canonical acceptance and indexed result.
Reconcile token amounts, refunds, account principal and both fee entitlements.
Record delayed indexing separately from rejection. Never include private keys,
seed phrases, auth headers or signed login challenges in evidence.

Review/merge #60 before #686. Follow-up work must update this ledger in the same
PR. Publish only after review and required local/funded gates pass; then repeat
registry installation and verification against the published version.

## Funded public-runner evidence, 2026-11-10

These runs use the published 0.8.3-fee.3 engine with unpublished example changes.
They do not establish verification of a released example package.

| Operation | Accepted transaction ID | Compute / transient / storage mass | Result |
| --- | --- | --- | --- |
| Native deployment | `ac1fc780b68e210e2092cbf293d54f0b67cb31bbaad634a03507fb8d83dce9ba` | 5128 / 5592 / 43168 | Accepted; holder indexed |
| Isolated test fee account | `f2a802f0ef3fef0c57ef4e1d684c9e17237c7fa88b1fbdef121994524a6126c0` | 4083 / 1412 / 81394 | Accepted; binding still pending |
| Native self-transfer | `450aa0f4d623d2165b4a227c7c79bbbfc7b4142cd869a921152cffdaaf9af0be` | 50775 / 106700 / 137510 | Accepted; two indexed holders total 100000 base units |

Token: `a5860c75f30bbec32fbe1f1d6e919717ac1868a9d95b746b72bc2fe10f34afc7`,
1000 tokens at two decimals. Account authority belongs to the dedicated test
wallet, not the platform protocol recipient.

The first deployment exposed an SDK cached-ID issue in the example adapter.
The node accepted it; the original journal was retained and the accepted ID
recovered without rebroadcasting. The adapter now finalizes before recording
the signed ID and retains any differing broadcast ID. Final review of this
last correction remains pending.

The backend-assisted transfer returned HTTP 400, `KCC20 token not found`, for
this new token despite its indexed holder. The later investigation below identified the missing reveal stage. This is not a verified backend transfer journey.

## Discovery and cache investigation, 2026-11-11

PUBDOC1 is now in the public directory with decimals 2 and display scale 100;
its creator-evidence route returns verified/matched. `claimVerifiedAtMs` is
1794347443732, exactly the first self-transfer's block time. The original
backend request preceded this reveal. Added `reveal-request` and documented
recognition as a distinct lifecycle gate. No verification checks were bypassed.

Source cache inspection: canonical single-token lookup reads the indexer without
Redis caching. Wallet directory seed uses 30 seconds; its content-addressed
result uses 24 hours. Owner balances use 10 seconds. Directory identity includes
name, ticker, decimals and verification state, so a changed canonical token set
gets a new cache key. Mutable app metadata has its own refresh considerations;
no permanent cache of balances or canonical verification has been introduced.

Backend transfer retry after recognition exceeded a 30-second client deadline;
this is a separate unresolved build/availability observation, not another
`token not found` result. Full backend-assisted transfer proof remains open.

## Funded 0-percent market continuation, 2026-11-11

[Public evidence](evidence/public-lifecycle-20261111.json) records accepted market
creation, activation, account binding, wrap, ask creation, a distinct-wallet buy,
protocol escrow claim and buyer unwrap through the public runner. The indexer/API
show 100000 total native base units, 900 reserve units matching 900 remaining
wrapped units, zero outstanding protocol fees and the unchanged 50000000-sompi
account principal. The trade accrued and claimed 50000000 sompi. These sequential
snapshots are not an atomic watermark or reorg proof.

The wrap run found a source-shape mismatch: public snapshots expose amountSompi
while the fee engine requires amountSompiExact. The recipe adapter now preserves
exact integers, rejects unsafe numeric values and has a regression test.
54 example tests and example build pass after this fix. 51 targeted backend
cache/directory/metadata tests also pass, including metadata-write invalidation.

Still pending: 5-percent and above-floor public journeys, FeeTickets, sweeps,
multiple-receipt claims, account rotation, recipient adapter,
backend transfer timeout diagnosis and release-package verification. No new npm
release, backend deployment or frontend merge occurred in this run.

Public read checks returned HTTP 200 for health, freshness, settlement status and
filtered owner balances. Settlement reports indexed/decoded. Freshness returned
`ok: false`, so HTTP 200 is not a healthy-source verdict. Wallet-provider balances
show this token's native balance but do not include the locally created fee market
(`wrappedMarketId: null`), consistent with separate platform market registration.
Full wallet-provider fee-market balance agreement remains unverified.

A separate in-progress backend RPC recovery checkout contains a bounded cached
connection fix for the transfer timeout. It has not been deployed or verified by
this public-example run; no competing runtime patch was made here.

The independent reviewer requested both transaction IDs be checked on resume
after a broadcast-ID mismatch. This is fixed with a regression test; 55 examples
pass. Follow-up review could not start because its auth profile was temporarily
unavailable. No release or approval is claimed.

## Creator fees and direct public-source transfers

[Creator lifecycle evidence](evidence/public-creator-lifecycle-20261111.json)
records a fresh 1-percent market, authenticated creator consent, partial/final
fills and independent single-receipt claims in both party orders. Each party
accrued and claimed 1 KAS over two fills. Both outstanding balances are zero;
both account principals remain 0.5 KAS. These fills exercise fee floors, not the
above-floor percentage branch.

The public snapshot transfer adapter now accepts the backend covenant envelope,
checks the node's network/sync state and reads SDK nested UTXO entries. A funded
transfer to the second wallet passed through the documented source URL:
`1ce1955884d834337bc60aee8275231e5931bf28eca18feca903b4cd334f76e0`.
57 example tests pass after these source adapter regressions. Backend-assisted
construction remains a separate unresolved route.

The reviewer found stale documentation requiring signatures for argument-only
inputs; wording now agrees with signingInputs. Final review must cover the latest
source adapter and CLI additions before release.

## Public utility mint and FeeTicket continuation, 2026-11-11

[Ticket evidence](evidence/public-ticket-lifecycle-20261111.json) records accepted
public mint, ticket creation and transfer using the configured KCOMV3 utility
token and current platform root. Minting 1209 tokens satisfied the existing paid
mint floor. Ticket creation consumed 20 tokens and left 1189 in the dedicated
wallet. The transferred ticket is indexed under the recipient wallet with its
full 1-KAS principal. Trade waiver, refund and misuse rejection remain pending.

The current example suite passes 57 tests. Final packed validation passed: 300 package tests, 57 example tests and browser/Node
parity for 24 recipes. Independent static review approved 0c55e7c after the signing
guidance correction. No release or merge is claimed.

## Grouped ticket trade and creator claim, 2026-11-11

[Grouped trade evidence](evidence/public-grouped-ticket-20261111.json) records
13 accepted transactions for a fresh 5-percent market bound to the current
platform FeeTicket root. One transferred ticket paid for a two-ask buy: protocol
fees were zero; creator fees were 0.5 KAS per fill, grouped into one 1-KAS receipt.
The ticket's full 1 KAS returned to its owner. Both sellers' ask deposits were
included in their payouts. The creator claimed the receipt, leaving no outstanding
receipt and preserving the 0.5-KAS fee-account principal.

Signed grouped-buy mass: compute 465140, transient 878360, storage 172028. The
node accepted it through the published engine and public example runner. This
exceeds the old conservative 450000 compute target but fits the engine's existing
accepted-shape policy; no cutoff was changed in this work.

Open public proofs: above-floor percentage cases, seller sweeps, consolidation,
2–5-receipt batches, rotation, recipient adapter and negative/failure journeys.
Backend-assisted transfer and standalone-market wallet-provider parity remain
separate open checks. The funded observations do not establish reorg recovery.

## Follow-up checks, 2026-11-11

The grouped-trade evidence now includes accepted buyer-holder consolidation and
creator-account rotation to the other test wallet and back. The account identity
and 0.5-KAS principal remained unchanged. Rebuilding the spent two-ask trade
failed before signing with `fee-market ask 0 is spent or unavailable`. This
establishes stale-order rejection, not a separate malicious-ticket rejection.

Backend transfer build returned HTTP 201 in 901 ms after the independently
delivered RPC recovery fix (#690). DEV pods reported image 90b5dd9626143dfe6aa7ae61e4fb69eec66ef9c9.
That request was built only; signing, submission and settlement remain pending.
No backend fix was duplicated in these documentation/example PRs.

## Seller sweeps and delegated claims, 2026-11-11

[Funded evidence](evidence/public-sweeps-recipient-20261111.json) records 22
additional canonically accepted transactions. A three-bid sale persisted one
receipt with 1.5 KAS owed to each party. A ten-bid ticket sale waived protocol
fees, retained 5 KAS for the creator and returned the seller/ticket principals.

The creator delegated its account to the pinned recipient covenant and claimed
both receipts together (6.5 KAS). The replacement retained the protocol's full
1.5 KAS, which the protocol wallet then claimed. The delegated account rotated
back to the creator wallet through the recipient adapter.

Retained failure: the same ten 1.2-KAS bids without a ticket leave 0.2 KAS per
seller payout. The published builder rejects that shape before signing at
341213 compute / 519292 transient / 579019 storage mass. No limit, fee or
output was changed to hide this failure. The ticket form was accepted at
406996 / 540984 / 211318. Unticketed low-proceeds ten-bid support remains open.

Some snapshots lagged accepted continuations. Subsequent construction used saved
transaction outpoints and node revalidation; later REST confirmed all 22 IDs.
Funding consolidation also produced two node-rejected low-network-fee probes;
separate journaled rebuilds with adequate fees were accepted. No rejected
transaction is counted as completed.

Independent review approved the coherent updated stack at #63 2ceb5a1, #64
7a27e6e and #65 31b4735. New exact-head hosted CI was queued when checked.
Frontend remains unmerged.

## Completed additional funded cases, 2026-11-11

- [Claim batches](evidence/public-claim-batches-20261111.json): three and five
  receipts claimed by the creator first; four claimed by the protocol first.
  Each opposing entitlement was then claimed independently. Together with the
  two-receipt wallet and recipient cases, funded runs cover counts 1–5. This is
  not every count × party × authority permutation.
- [Percentage fees](evidence/public-percentage-fees-20261111.json): a 51-KAS
  fill accrued 0.51 KAS protocol and 2.55 KAS creator fees, verified in the
  indexed receipt. Both percentages exceed their respective fee floors.
- [Other journeys](evidence/public-remaining-flows-20261111.json): ten
  unticketed bids at 2 KAS per fill passed, plus native consolidation, bid
  cancellation and a backend-built transfer signed and broadcast by the wallet.
  Transfer settlement reports indexed and decoded. Authenticated backend
  submission itself was not exercised.
- [Final accounting](evidence/public-final-accounting-20261111.json): zero
  outstanding fee receipts in the test market, 1000 wrapped units and 100000
  native units including reserve. Both fee accounts retain 0.5 KAS and their
  original wallet authorities. These are sequential observations, not a
  reorg/atomic-watermark proof.

The successful unticketed ten-bid sale measured 341213 compute, 519292 transient
and 229156 storage mass. The earlier small-payout failure remains valid and is
not silently converted into a passing result.

Funding needs headroom for the fully signed network fee. A 2.7-KAS funding UTXO
failed the 1-KAS ask buy before signing; an explicitly selected 3.2-KAS input
passed. A funding-consolidation race in the test harness was node-rejected; the
rebuild waited for settlement and used fresh inputs. These host-test failures
were not deployed changes or successful transactions.

Release gates still open: immutable example prerelease and registry replay,
served backend guide deployment, final hosted CI, remaining negative/source
failure coverage and complete API agreement for standalone markets. Wallet
authorities beyond the tested Schnorr and pinned recipient paths retain their
separate proof scope. No frontend merge or mainnet action.
