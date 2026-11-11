# Public integration: start here

Use the TX builder to construct transactions in your own application. Your wallet
keeps signing authority. KaspaCom's public backend is optional for discovery,
market data, consolidation guidance and transaction planning.

This guide targets DEV testnet-10. It does not enable mainnet or create markets.

Track delivery and live proof in the [checklist](PUBLIC_INTEGRATION_CHECKLIST.md).
See the [operation matrix](PUBLIC_OPERATION_MATRIX.md) before selecting a backend build route.

Wallet providers that only need balances and transfers can start with the
[wallet-provider guide](PUBLIC_WALLET_PROVIDER.md). Full fee-market examples are
described in the [lifecycle cookbook](PUBLIC_LIFECYCLE.md).

## Choose a path

| Responsibility | TX builder first (recommended) | Backend-assisted |
| --- | --- | --- |
| Discover tokens, markets and orders | Public API or your own compatible indexer | Public API |
| Fetch current funding and covenant UTXOs | Your connected node and decoded source provider | Backend build service |
| Construct unsigned transaction | Pinned package in browser or Node | `POST /kcc20/build/*` |
| Review and sign | Your wallet | Your wallet |
| Broadcast | Your node/wallet | Your node/wallet, or authenticated `/kcc20/submit` for that backend's build receipt |
| Confirm result | Chain acceptance plus indexed settlement | Same |

You can mix public API reads with local transaction construction. A locally built
transaction has no backend build receipt: do not send it to `/kcc20/submit` as if
it came from an authenticated backend build. Keep wallet private keys out of
HTTP requests and application logs.

## Install an exact version

```sh
npm install --save-exact @kaspacom/kcc20-tx-builder@0.8.3-fee.5 \
  --registry=https://registry.npmjs.org/ \
  --@kaspacom:registry=https://registry.npmjs.org/
```

This fee-protocol version is a prerelease on the `next` tag. At the review on
2026-11-10, `latest` was `0.7.0`. Do not use an unversioned install or a floating
tag for a deployment. The repository and npm package are public; no GitHub or
npm token is required to install. Commit the lockfile. Node >=20 is required;
Node 22 is the reference runtime for the examples.

Use the matching package artifacts and a compatible initialized Kaspa WASM
runtime. The core builder does not initialize WASM or own an RPC connection.
[Compatibility pins](COMPATIBILITY.json) identify the example runtime and artifacts.

## First runnable examples

From this repository:

```sh
npm ci
npm run build
npm ci --prefix examples --registry=https://registry.npmjs.org/ --@kaspacom:registry=https://registry.npmjs.org/
npm --prefix examples run backend -- offline
npm --prefix examples run fee-quote
npm --prefix examples run frontend
```

The offline CLI builds unsigned deploy and transfer transactions from synthetic
UTXOs. The browser demo runs the same construction path. Neither offline mode
nor the fee quote broadcasts. Demo keys and addresses are public test vectors;
never fund them. See [example setup](../examples/README.md).

`fee-quote` uses the package directly for a 100 KAS fill with a 1% creator fee:
1 KAS protocol fee and 1 KAS creator fee. It excludes network fees and refundable
deposits. A quote's waiver flag is not authorization to use a coupon; the signed
builder must validate and consume the eligible FeeTicket.

## Construct a transaction locally

The working adapters are [shared/build.ts](../examples/shared/build.ts),
[Node runtime](../examples/backend/runtime.ts), and
[browser runtime](../examples/frontend/runtime.ts). Copy the host adapter, not
private server configuration. Keep one initialized builder and RPC connection.

1. Select the actual market version and authenticated token profile. Native token
   IDs, wrapper-market IDs, fee-policy IDs and fee-account IDs are different.
2. Read decoded state, then revalidate outpoints, scripts, ownership and values
   against fresh node UTXOs. Indexer JSON alone is not spend authority.
3. Build the operation with the matching package helper and call `engine.build`.
   Inspect `psktTransactionJson`, `signInputs`, covenant script hints and metadata.
4. Have the wallet sign the indicated inputs. Use the [example signing adapter](../examples/shared/signing.ts) to
   assemble covenant witnesses; signing funding inputs alone is not sufficient.
5. Check the complete signed transaction's fees and separate mass limits against
   the pinned node, then broadcast with your wallet/node. Rebuild from fresh inputs
   after conflicts; do not retry a stale signed transaction with changed fields.
6. Track the txid through acceptance and indexed settlement, then refresh balances.
   An HTTP 200 or a broadcast txid does not establish final canonical acceptance.

For a live source-backed transaction, start with the existing
[live transfer example](LIVE_TRANSFER.md). It describes the source-provider
contract without requiring KaspaCom's build endpoint.

### New fee markets versus older recipes

The generic `recipes.ts` order/wrap recipes use the older orderbook helper family.
They are not interchangeable with `kcc20fee.*` builders. Do not select a builder
from the token ticker or apply an older recipe to a fee-market UTXO.

For fee markets, discover the active market with
`GET /trading/tokens/{tokenId}/fee-market`, then read its policy, accounts and
receipts using the routes in public Swagger. The package includes versioned
settlement, claim and account builders; see [fee primitives](escrow-fees.md),
[account authorities](FEE_ACCOUNT_AUTHORITIES.md), and
[recipient adapter](fee-recipient-wallet.md).

A complete copy-and-run fee-market trading/claim CLI with live source adapters
is still a documentation/example gap. Existing contract/builder tests are not
that public integration journey. Do not describe the 24 older recipes as proof
of all new fee-market flows. Keep unsupported profile/operation combinations
explicit and fail closed.

## Backend-assisted route

Use [public Swagger](https://dev-api-kcc20.kaspa.com/public-docs) and
[public OpenAPI JSON](https://dev-api-kcc20.kaspa.com/public-docs-json).
The full `/docs` includes internal/admin and website-session endpoints and is
not the third-party contract.

For the HTTP planning/signing/submission sequence, follow the
[public trading guide](https://dev-api-kcc20.kaspa.com/agent-guide.md).
Anonymous reads/builds do not grant submit authorization. Backend submission
requires wallet-signed API authentication and the matching authenticated build
receipt. Do not transplant website cookies or use `/wallet-operations/submissions`
as a public API integration shortcut.

## Package contents and custody

The package contains protocol code, public contract artifacts and example host
adapters. Private keys, seed phrases, service credentials and operator settings
belong in the integrating host or wallet, never in the package. Public recipient
addresses and deterministic offline test vectors are not secret credentials.

The [package review](PACKAGE_CONTENT_REVIEW.md) records the exact published
archive inspected and the checks performed. It is a scoped review, not a promise
that every future release is free of secrets.

## Follow-up backlog

- Extract complete new fee-market build/sign/broadcast/claim examples with tested
  live source adapters and record funded testnet transaction evidence.
- Verify public HTTP build support by market version, not merely route presence.
- Review the lightweight index server separately. It is not required for this
  first integration guide and is not presented here as a released dependency.
