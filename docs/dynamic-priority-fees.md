# TN10 dynamic priority fees

## Contract

The host supplies a priority quote with network, source, observation time and a
decimal sompi-per-normalized-mass rate. Construction rejects quotes older than
ten seconds, future observations and mismatched networks. This release qualifies
the Toccata policy for testnet-10 only. No contract artifacts change.

Required network fee is the larger of the relay floor and the ceiling of the
priority rate times max(compute, storage, ceil(transient / 2)). All arithmetic
uses integers. Each build has its own quote; concurrent requests cannot replace
one another's rate. Funding change is recalculated until the complete shape
pays enough. Other outputs, deposits and entitlements cannot fund network fees.

Browser and backend hosts must opt into the quote provider. Omission preserves
the existing package API for offline callers; it does not provide priority
pricing. Consumers must not silently omit it when a quote fetch fails.

The browser polls through its existing RPC every five seconds while visible.
Wallet approval remains the only approval. Quotes are fixed for the constructed
transaction. Post-signing checks may reject a transaction but never rewrite it.

## Acceptance checklist

- [x] Reproduce storage underpricing through a real deployment builder.
- [x] Decimal rate rounding, relay minimum, overflow and freshness unit tests.
- [x] Deployment construction converges using contextual storage mass.
- [x] Existing package test suite passes (300 node tests plus smoke/pinned suites).
- [x] Captured signed regression fixtures for both reported eight-output deployments: normalized mass 280,000.
- [x] Dynamic-rate trading/claim matrix: 178 cases at 250 sompi per normalized mass.
- [x] Snapshot priority conservation: 30 bootstrap/controller/start shapes; existing claim suite passes.
- [x] Dynamic legacy deploy, mint-lane, transfer and reveal cases: 8 passed.
- [x] Snapshot claim/transfer fee conservation: 4 shapes.
- [x] Dynamic legacy FeeTicket structural regression: 5 passed with fee-dependent change and unchanged ticket/refund amounts.
- [x] Verify actual signed mass before wallet or backend broadcast.
- [x] Backend activation and saved public build receipts validate the supplied build quote.
- [x] Browser polling, source replacement, timeout and wallet tests: 94 passed.
- [ ] Independent review of final changes.
- [x] Funded DEV deployment plus eight market/account/trade/claim transactions accepted and indexed.
- [ ] Published-package browser and authenticated backend lifecycle completion evidence.
- [ ] Immutable prerelease published and integrity checked in both registries.
- [ ] Matching backend/frontend pins verified against the published package.
- [ ] Backend rollout verified; frontend remains unmerged.

Pending-input exclusion and explicit replacement of the original pending
deployment are separate follow-ups. Never release its reservation merely because
a retry was requested. No automatic replacements are part of this change.

## Funded evidence

[Recorded TN10 proof](evidence/dynamic-priority-tn10-20261112.json) includes the
quote, signed masses, paid fee, broadcast start and acceptance block time.
The deployment paid 61,523,137 sompi. The market buy paid 43,090,976 sompi in
network fees and a separate 50,000,000-sompi protocol entitlement. Claiming that
entitlement paid 14,242,375 sompi in network fees and preserved its account's
100,000,000-sompi principal. Source block times were approximately 0.3–1.1 seconds
after local broadcast starts in this sample. These times are observations.

The proof uses a test-owned fee account. No customer pending transaction was
replaced, and no frontend branch was merged.

## Compatibility and transport

Old build receipts without a quote remain supported. New authenticated backend
receipts retain their build quote and validate signed fees against that quote.
Browser activation submissions carry their quote into the durable setup record.
Kaspire validates before returning signed bytes. KasWare validates before pushTx.
Wallets exposing only atomic sign-and-broadcast use sign-only, then verified
submission through the existing backend or application RPC without another
signature request. Signed transaction bytes are never changed for repricing.
