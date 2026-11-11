# Public operation support

Reviewed against builder `0.8.3-fee.3` and backend `80ebab60`.
Source tracing is not a funded acceptance result. See the
[delivery checklist](PUBLIC_INTEGRATION_CHECKLIST.md) for proof status.

Use the new fee-market keys below for new markets. Native token operations
still use `kcc20.*`; a native token and its wrapped market are different lineages.
Exact supported artifact hashes come from the package's authenticated registry.
Do not infer compatibility from a ticker or a similarly named contract.

`/kcc20/build/tokens/{tokenId}` is abbreviated `BUILD` below. Public route
presence does not mean the route can construct a new fee-market transaction.
Local builder keys identify package APIs, not runnable example scripts. This
checkout does not ship a public fee-market lifecycle runner or browser adapter.

| Operation | Local builder key | Inputs/data needed | Public backend construction |
| --- | --- | --- | --- |
| Token deployment | `kcc20.deploy-token` | Deployment draft, wallet identity, funding | `/kcc20/build/deploy`; token deployment only, not fee-market setup |
| Mint | `kcc20.mint` | Current minter, authenticated mint policy and amount, funding | `BUILD/mint`; public mint eligibility enforced |
| Transfer | `kcc20.transfer` | Native holders, recipient, amount | `BUILD/transfer`; profile-dependent |
| Native consolidation | `kcc20.consolidate-holders` | Compatible native holders | `BUILD/consolidate`; native mode only for this guide |
| Create fee account | `kcc20fee.create-account` | Token ID, account owner, principal, funding | No public route; local builder |
| Bind fee account | `kcc20fee.bind-account` | Accepted account genesis hint, account/market/policy IDs | No public route; local builder |
| Market genesis | `kcc20fee.deploy-market-genesis` | Token evidence, accounts, policy, ticket root, price scale | No public route; local builder |
| Activate market | `kcc20fee.bind-market` | Accepted wrapper genesis, creator evidence/consent where required | No public route; local builder |
| Wrap | `kcc20fee.wrap` | Live token holder and wrapper, bound policy, amount | `BUILD/wrap` selects this key for fee markets; browser-only registry entry, not verified server PSKT support |
| Unwrap | `kcc20fee.unwrap` | Wrapped holder, matching native reserve and wrapper | Existing `BUILD/unwrap` planner uses legacy wrapper key; use local builder |
| Merge wrapped holders | `kcc20fee.merge-holders` | Compatible holder list, policy | Existing wrapped consolidation planner uses legacy key; use local builder |
| Create ask | `kcc20fee.create-ask` | Holder, ask amount and unit price | Existing `BUILD/orders` planner uses legacy keys; use local builder |
| Create bid | `kcc20fee.create-bid` | Market root, bid amount and unit price, KAS funding | Same limitation |
| Cancel ask/bid | `kcc20fee.cancel-ask`, `kcc20fee.cancel-bid` | Owner's current order and funding | Existing `BUILD/orders/cancel` planner uses legacy keys; use local builder |
| Buy one ask | `kcc20fee.buy-ask` | Ask, fill amount, seller payout, optional ticket | Existing `BUILD/orders/fill` planner uses legacy keys; use local builder |
| Buy two asks | `kcc20fee.buy-two-asks` | Ordered ask/fill records, optional ticket | Existing `BUILD/orders/sweep` planner uses legacy keys; use local builder |
| Sell into bids | `kcc20fee.sell-into-bids` | Seller holder, ordered bid/fill records, optional ticket | Same limitation; required 3-/10-bid shapes use this key |
| Create coupons | `fee-ticket.create-from-utility-burn` | Enabled root, utility-token holder, quantity | No public management route; local builder |
| Transfer coupons | `fee-ticket.transfer` | Owned ticket UTXOs, recipient, root identity | No public management route; local builder |
| Burn coupons | `fee-ticket.burn` | Owned ticket UTXOs and root | Standalone burn is separate from automatic trading consumption |
| Claim fees | `kcc20fee.claim` | Party, current account, 1–5 compatible receipts | No public claim build route; local builder |
| Rotate account | `kcc20fee.rotate-account` | Current account authority and new authority | No public route; local builder |
| Recipient example | `kcc20fee.create-recipient` then claim/rotate | Supported recipient state, current account | No public route; local builder |

## Read sources and authority

Use public Swagger for the current response schema:

- `/tokens/{tokenId}/page-data`, `/tokens/{tokenId}/wrappers`: identity and wrapper discovery.
- `/trading/tokens/{tokenId}/orderbook` and `/quote`: market data and quote guidance.
- `/trading/tokens/{tokenId}/fee-market`: fee-market discovery.
- `/trading/fee-markets/{marketId}/policy`, `/accounts`, `/receipts`: fee state.
- `/rewards/fee-ticket-root`: configured coupon root, not ownership inventory.

Paginate receipt and source reads. Public market/account responses and retained
genesis/continuation hints provide decoded state; the builder checks actual
outpoints against the node. A quote is not a spending authorization. Never use
a backend cookie or an admin endpoint to fill a missing public API capability.

Account creation starts with a Schnorr wallet. For later claims/rotation, consult
[FEE_ACCOUNT_AUTHORITIES.md](FEE_ACCOUNT_AUTHORITIES.md) for schemes 0–4 and
[fee-recipient-wallet.md](fee-recipient-wallet.md) for the supported recipient.
The example host must advertise its actual Schnorr/ECDSA capabilities; arbitrary
P2SH/covenant authorities require their reviewed adapters.

## Source trace

Backend public controller delegates to `TokenActionBuildService`. Its order,
fill, sweep, cancellation, consolidation and unwrap planning still emits legacy
keys. Fee wrapping emits `kcc20fee.wrap`, but the wallet-operation registry marks
fee keys as browser builders. These are not interchangeable server capabilities.
This release documents the limitations instead of adding public write endpoints.

Crossed ask/bid matching uses `kcc20orderbook.matcher-settle-crossed`, a backend-only
builder. It is not exposed by a shipped public example runner and never uses a coupon.
Root deployment/denomination changes are operator actions, separate from creating
and spending user coupons.
