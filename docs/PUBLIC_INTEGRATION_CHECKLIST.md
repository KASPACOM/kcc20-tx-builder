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
| PUB-05 | Operation and public-route support matrix | In progress | Follow-up / 0.8.3-fee.3 | PUBLIC_OPERATION_MATRIX.md traces planners and registry; funded HTTP support pending | Pending supported HTTP journeys |
| PUB-23 | Wallet-provider balances/transfer guide | In progress | Follow-up / 0.8.3-fee.3 | Current public OpenAPI confirms decimals and all balance query fields; PUBLIC_WALLET_PROVIDER.md | Pending transfer journey |
| PUB-06 | IDs, policies, fees, refunds and lifecycle diagram | In progress | Follow-up / 0.8.3-fee.3 | Source-backed documentation | Pending lifecycle reconciliation |
| PUB-07 | Exact runtime/artifact pins and clean install | In progress | Follow-up / 0.8.3-fee.3 | Existing compatibility manifest and example lockfile | Not applicable |
| PUB-08 | Shared browser/Node build, sign and broadcast adapters | In progress | Follow-up / 0.8.3-fee.3 | 53 example tests pass; signed mass, zero-signature witnesses, source rechecks and finalized transaction IDs | Native deploy and self-transfer accepted; full lifecycle pending |
| PUB-09 | Deploy token and creator settings | In progress | Follow-up / 0.8.3-fee.3 engine | Published deploy helper and local runner | PUBDOC1 deploy accepted; creator configuration pending |
| PUB-10 | Fee accounts, consent, genesis and binding | In progress | Follow-up / 0.8.3-fee.3 engine | Signed bind fixtures at 0/1/5 percent | 0-percent market genesis, activation and account binding accepted; creator consent journey pending |
| PUB-11 | Mint, transfer and native consolidation | In progress | Follow-up / 0.8.3-fee.3 engine | Native transfer runner | Self-transfer accepted, indexed total preserved; distinct recipient and mint pending |
| PUB-12 | Wrap, unwrap and wrapped consolidation | In progress | Follow-up / 0.8.3-fee.3 engine | Exact-source normalization regression passes | Wrap and buyer unwrap accepted; consolidation pending |
| PUB-13 | Asks/bids, partial/final fills and cancellations | In progress | Follow-up / 0.8.3-fee.3 engine | Runner build/tests pass | Ask and full distinct-wallet buy accepted; remaining shapes pending |
| PUB-14 | Two-ask buy and 3-/10-bid seller sweeps | Not started | Pending | Pending | Pending |
| PUB-15 | FeeTicket creation, transfer, waiver, burn/refund | Not started | Pending | Pending | Pending |
| PUB-16 | Protocol/creator claims, 1–5 receipts, both orders | In progress | Follow-up / 0.8.3-fee.3 engine | Runner tests pass | One protocol receipt claimed, account principal preserved; creator/batches pending |
| PUB-17 | Authority rotation and supported recipient adapter | Not started | Pending | Pending | Pending |
| PUB-18 | Resumption, stale inputs, wallet/RPC/indexing failures | Not started | Pending | Pending | Pending |
| PUB-19 | Creator 0/1/5%, fee floors and signed mass matrix | Not started | Pending | Pending | Pending |
| PUB-20 | Independent final example/security-boundary review | In progress | Follow-up | Reviewer found resume mismatch-ID omission; fixed with regression test. Follow-up reviewer unavailable due auth profile | Not applicable |
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
this new token despite its indexed holder. Metadata/discovery investigation
remains open. This is not a verified backend transfer journey.

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
cancellations, multiple-receipt claims, account rotation, recipient adapter,
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
