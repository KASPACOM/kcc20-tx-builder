# Wallet provider: balances and native transfers

A wallet that displays tokens and transfers native holdings needs a smaller API
surface than a trading application. It can use public reads with the local TX
builder or request an unsigned transfer from the backend.

Base URL: `https://dev-api-kcc20.kaspa.com` (DEV TN10).
Use [public Swagger](https://dev-api-kcc20.kaspa.com/public-docs) and
[public OpenAPI](https://dev-api-kcc20.kaspa.com/public-docs-json).
The full `/docs` and `/docs-json` also include private app/operator interfaces.

| Step | Public route | Meaning |
| --- | --- | --- |
| API availability | `GET /health` | Backend dependencies, not proof of current balances |
| Indexing freshness | `GET /trading/freshness` | Freshness and suggested polling interval |
| Directory | `GET /wallet-provider/tokens` | Metadata with optional nullable decimals/display scale |
| Holdings | `GET /wallet-provider/owners/{owner}/balances` | Native and wrapped holdings grouped by canonical token |
| HTTP transfer construction | `POST /kcc20/build/tokens/{covenantId}/transfer` | Optional backend-assisted unsigned transfer |
| Settlement | `GET /trading/tx/{txid}/settlement-status` | Indexed settlement progress after broadcast |

## Metadata and amount units

As of 2026-11-10, the public schema includes `decimals` and
`tokenDisplayScale`. These can be null or absent when metadata is unavailable.
Do not assume 8 decimals. Preserve raw integer strings and withhold a formatted
transfer quote until the token's scale is known. Treat display metadata and its
verification status separately from authenticated token identity.

Balances and `minNativeAmount`, `minWrappedAmount`, `minTotalAmount` filters use
base units. The backend transfer request's `tokenAmount` uses display units.
Use integer/decimal-string conversion; JavaScript floating-point arithmetic must
not round token balances or transfer amounts.

## Filter holdings

The current API already supports the following query fields:

```text
limit, offset, sortBy, sortDirection, q, covenantId, asset,
hasBalance, transferable, wrappable, tradeable,
minNativeAmount, minWrappedAmount, minTotalAmount, refresh
```

Use the enums and limits from public OpenAPI. Follow pagination until `total` is
covered. `owner` accepts a supported Kaspa P2PK address or 64-hex owner identifier.
A typical first page is:

```sh
curl --fail-with-body --get \
  "https://dev-api-kcc20.kaspa.com/wallet-provider/owners/$OWNER/balances" \
  --data-urlencode 'limit=100' --data-urlencode 'offset=0' \
  --data-urlencode 'sortBy=lastChangeMs' --data-urlencode 'sortDirection=desc' \
  --data-urlencode 'hasBalance=true' --data-urlencode 'refresh=false'
```

Do not use `refresh=true` on every poll. Respect cache/freshness metadata and
retry guidance. A refresh bypasses an API cache; it does not make a lagging
indexer current. Surface incomplete coverage rather than presenting it as a
verified final balance. Read capability fields instead of assuming wrapped tokens
are transferable just because native tokens are.

## Transfer

For local construction use `buildKcc20TransferTokenOperation` and the
[live source example](LIVE_TRANSFER.md), then sign and broadcast through the
wallet/node. Revalidate live input scripts, values, lineage and ownership.
This repository does not ship a `transfer-request` script; use the documented
package API or backend request directly.

For backend assistance:

```sh
curl --fail-with-body -X POST \
  "https://dev-api-kcc20.kaspa.com/kcc20/build/tokens/$TOKEN_ID/transfer" \
  -H 'Content-Type: application/json' --data-binary @transfer.json
```

```json
{
  "walletAddress": "kaspatest:YOUR_SIGNING_WALLET",
  "recipientOwner": "kaspatest:RECIPIENT",
  "tokenAmount": "10.5"
}
```

Optional fields include `ownerIdentifier` and `holderOutpoint`; extra fields are
rejected. `covenantId` identifies the native token, not a wrapped market. Validate
that the response contains a ready signing payload and its unsigned transaction;
a request ID or descriptive operation envelope alone is not enough to sign.
Inspect outputs, fees and all required signing inputs before requesting approval.

Anonymous builds do not grant authenticated API submission rights. Broadcast a
local/anonymous build with the wallet/node. `/kcc20/submit` requires wallet API
authentication and a matching authenticated backend build receipt. Never send a
wallet private key, seed phrase or website cookie.

After broadcast, check acceptance and settlement separately. If inputs have been
spent, refresh and rebuild. A request timeout can occur after broadcast: check the
recorded transaction ID before retrying. Check freshness and refresh balances
after settlement; do not credit tokens from a successful HTTP response alone.
