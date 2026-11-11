# Wallet integration on DEV testnet-10

Start with quantities and native sends. Use the existing public API for discovery
and the published TX builder for local construction. The wallet signs; no private
keys or seed phrases go to KaspaCom. Prices and trading screens are unnecessary.

Install and runtime pins: [public setup](PUBLIC_INTEGRATION.md).
Status and untested cases: [wallet checklist](WALLET_INTEGRATION_CHECKLIST.md).

## Existing public routes

Base: `https://dev-api-kcc20.kaspa.com`.
Use [public Swagger](https://dev-api-kcc20.kaspa.com/public-docs) and
[public schema](https://dev-api-kcc20.kaspa.com/public-docs-json).
`/docs` and `/docs-json` also contain website/admin endpoints.

| Need | Existing route |
| --- | --- |
| Backend availability | `GET /health` |
| Indexer freshness and suggested polling | `GET /trading/freshness` |
| Known token metadata | `GET /wallet-provider/tokens` |
| Wallet holdings | `GET /wallet-provider/owners/{owner}/balances` |
| Current decoded sources | `GET /trading/covenants/{covenantId}/utxos` |
| Optional open-order accounting | `GET /trading/owners/{owner}/orders` |
| Optional combined positions | `GET /trading/owners/{owner}/positions` |
| Backend-assisted native transfer | `POST /kcc20/build/tokens/{covenantId}/transfer` |
| Fragmentation preflight | `GET /kcc20/build/tokens/{covenantId}/consolidate/status` |
| Indexed transaction result | `GET /trading/tx/{txid}/settlement-status` |
| Optional activity | `GET /wallet-provider/owners/{owner}/tokens/{covenantId}/activity` |

`owner` accepts a 64-hex identifier or supported Kaspa P2PK address. These examples
use Schnorr P2PK testnet wallets. Other authority types require their specific
reviewed signer adapters; do not turn an arbitrary address into a Schnorr key.

## Display holdings

Directory and balance token rows already include `decimals` and
`tokenDisplayScale`. Queries already support `limit`, `offset`, `sortBy`,
`sortDirection`, `q`, `asset=all|native|wrapped`, `hasBalance`, `transferable`,
`wrappable`, `tradeable`, `covenantId`, `minNativeAmount`, `minWrappedAmount`,
`minTotalAmount` and `refresh`.

Quantity filters use base-unit integer strings. The backend transfer POST uses
display units; the local example accepts integer base units only. Sort fields are `canonicalCovenantId`, `ticker`, `name`, `nativeAmount`,
`wrappedAmount`, `totalAmount` and `lastChangeMs`; limit is 1–500. Offset pages
are not an atomic snapshot while a wallet is changing. Refresh after confirmed
operations; do not constantly bypass caches.

```sh
npm ci --prefix examples
npm --prefix examples run wallet -- '<kaspatest-address>'
```

[Shared reader](../examples/shared/wallet.ts) works in browser or Node. It formats
quantities without floating-point conversion. If decimals are missing, display
explicit base units and the covenant ID; do not guess precision or hide the row.
Metadata names/icons are display data, not proof of token authenticity.

Native and wrapped are representations, not different quantities to count twice.
Holder balances exclude ask/bid modes in the indexer. Open asks belong in a
separate `in orders` bucket; sum remaining token amounts from open asks only.
Do not subtract asks from holder balances again. Bids represent KAS commitments,
not tokens already owned. The positions endpoint's `totalBalance` excludes open
asks; its `openBidAmount` is requested tokens, not owned tokens or KAS value.
The positions service may omit order exposure on order-read failure. For an
accurate optional orders view, use the orders endpoint and preserve an error or
unknown state instead of showing zero on failure. Paginate all relevant orders.

Capability flags are discovery hints, not spending authorization. The existing
`capabilities.builders` lists backend registry operations; it is not a list of
all package operations or proof that a particular holder can use them. A balance
whose canonical token is unrecognized must not advertise native send or wrap.

## Native send

The [shared send adapter](../examples/shared/wallet-send.ts) calls the package's
native transfer helper. Provide the canonical ID,
wallet identity, recipient address/owner, integer base-unit quantity and current decoded
holder rows. Populate rows from the existing covenant UTXO read and normalize
with the package's `normalizeKcc20IndexedUtxos`; enrich the native covenant ID
from RPC. The builder rechecks current sources and authenticates their scripts.

```ts
const built = await buildSend(wasm, existingRpc, loadArtifact, {
  wallet: { walletAddress, kcc20Owner },
  covenantId, recipient: recipientAddress,
  quantityBaseUnits: '1250', holders: currentHolders, // 12.50 tokens at verified decimals=2
});
// Review quantity, recipient, input selection, change and KAS cost before signing.
const signed = await signSend(wasm, existingRpc, built, (json, signInputs) =>
  wallet.signPsktTransaction(json, { signInputs }));
```

[Browser adapter](../examples/frontend/wallet-adapter.ts) reuses the wallet's RPC.
[Node example](../examples/backend/send.ts) constructs without loading keys:

```sh
KASPA_WRPC_URL='wss://tn10-node.kaspa.com/testnet-10' \
  npm --prefix examples run wallet:send -- send-request.json
```

`send-request.json` has the same fields as the object above, with actual source
rows rather than placeholders. An amount spanning several holders can require
consolidation first. Confirm consolidation and reload inputs before sending.

For backend construction, use the existing transfer POST with `walletAddress`,
optional `ownerIdentifier`, `recipientOwner`, display `tokenAmount` and optional
`holderOutpoint`. It rejects extra fields. Inspect the returned signing payload;
do not treat `ready-to-sign` as execution. A local build has no backend build
receipt and uses wallet/node broadcast. Authenticated backend submit is covered
in the public API guide.

## Wrap and unwrap

Direct wrapped transfers are not advertised. Unwrap to yourself, confirm and
refresh, then send native tokens as a separate wallet-approved transaction.

[Wrap adapter](../examples/shared/wallet-wrap.ts) uses existing `kcc20fee.wrap`
and `kcc20fee.unwrap` builders with the native version-2 wrapper. It accepts an
`operation`, `wallet` and the package's existing `params`. Fetch the active market
from `/trading/tokens/{tokenId}/fee-market` and its fixed policy from
`/trading/fee-markets/{marketId}/policy`. Never substitute a different market's
policy or infer it from ticker, amounts or creator display settings.

Common parameters: `wrapperVersion: 2`, `marketId`, `contractCanonicalTokenId`,
`feeTicketId`, `priceScale`, base-unit `tokenAmount`, `feePolicy`, `policyId`, and
current `wrapperUtxo`. Every source needs its exact `amountSompiExact` from the
current node value, as well as its outpoint, address and decoded state. Wrap additionally needs `tokenUtxo`; unwrap needs
`wrappedUtxo` and `reserveUtxo`. The package verifies scripts and conservation.

```sh
KASPA_WRPC_URL='wss://tn10-node.kaspa.com/testnet-10' \
  npm --prefix examples run wallet:wrap -- wrap-request.json
```

The adapter passed a funded native-profile wrap and partial/full unwrap on TN10.
See the checklist for remaining discovery, review and publication gates.
Older/Argent wrappers need their supported version/profile adapter; this example
does not silently select one. General token burn is not exposed by the current
operation registry. Minting is conditional on the token policy and availability.
FeeTickets are coupons; their consumption is not a generic token-burn feature.

## Freshness and settlement

Use `/health` and `/trading/freshness` before declaring a wallet ready. Keep
previously displayed holdings clearly marked stale if reads fail. `generatedAtMs`
is response creation time; `lastChangeMs` describes a change, not full coverage.
Respect `suggestedPollMs`, stop polling on screen teardown, and coalesce concurrent
reads in the host. Activity is optional; refreshing balances is sufficient for
the first wallet integration.

The `broadcastSend` helper requires a durable host persistence callback before
submission and rechecks inputs after signing. It checks separate signed compute,
transient and storage mass against the example budgets. Before broadcast, save
the signed transaction ID. A timeout is ambiguous: query
that ID and chain acceptance instead of rebuilding or broadcasting again
implicitly. `indexed`/`decoded` establish read-model progress, not irreversible
finality. Revalidate spent inputs before signing and refresh balances after
acceptance and indexed settlement. Never auto-sign a replacement transaction.

## Optional minting and coupons

Public minting uses the existing token policy, not a universal wallet capability.
Read the current token policy and decoded mint-authority UTXOs. The authority must
have enough remaining supply and allow public minting. A deployment's original
availability flag is not proof that minting is still paused, active or available.
An exhausted or unavailable authority must not produce a signing request.

Use the same published builder and signing adapter as native sends:

```ts
import { buildKcc20MintTokenOperation } from '@kaspacom/kcc20-tx-builder/token-operation';
import { createBuilder } from './shared/build.ts';
import { signSend, broadcastSend } from './shared/wallet-send.ts';

const operation = buildKcc20MintTokenOperation(
  { walletAddress, kcc20Owner },
  {
    token: currentToken, // canonical ID, verified decimals and current mintPolicy
    activeUtxos: currentMintAuthorityUtxos,
    tokenAmount: '1', // display units, unlike the send adapter's base units
    publicRequest: true,
  },
  { network: 'testnet-10' },
);
const built = await createBuilder(wasm, existingRpc, loadArtifact)(operation);
// Review token quantity, treasury/protocol payments and network fee.
const signed = await signSend(wasm, existingRpc, built, signWithYourWallet);
await broadcastSend(wasm, existingRpc, signed, persistBeforeBroadcast);
```

The helper selects and authenticates the current mint authority. The browser host
supplies its wallet signer and durable transaction journal as in the send flow.
The authority owner can use a different authorized mint path; the funded public
proof uses a separate minter wallet and verifies `mintPath: "public"`.

The existing `POST /kcc20/build/tokens/{covenantId}/mint` is the backend-assisted
alternative in [public Swagger](https://dev-api-kcc20.kaspa.com/public-docs).
Mint fees follow the token's mint policy, separately from trading fees and escrow.
Do not hard-code the trading rate into a mint quote. Refresh after confirmation;
show source-unavailable or paused responses without repeatedly requesting signatures.

[Funded public-mint evidence](evidence/wallet-public-mint-tn10-20261112.json)
records two non-owner mints, pause/re-enable, final-supply consumption, direct
protocol/treasury payouts, node holder outputs, wallet balances and activity.
The deployment is indexed but initially unrevealed until its first spend; a
broadcast response alone is insufficient to display a usable mint authority.

FeeTicket administration and fee-waived trading are outside this wallet
integration. Do not label ticket consumption as ordinary token burning.
