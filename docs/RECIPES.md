# Operation recipes

The [recipe registry](../examples/shared/recipes.ts) imports the package's existing
helpers with their original TypeScript signatures. These helpers describe an
operation; the shared `createBuilder` adapter constructs its transaction locally.
All examples target TN10. Supply current decoded state from your own indexer or
transaction decoder, plus current UTXOs from your own RPC connection.

## Run a helper and build its transaction

Save a JSON array containing the helper's arguments, in signature order, to
`arguments.json`. The CLI calls the selected helper and emits its operation:

```sh
cd examples
npm run --silent recipe -- deploy arguments.json > operation.json
KASPA_WRPC_URL=wss://your-tn10-node npm run --silent backend -- build operation.json > unsigned.json
```

For frontend applications, use the same typed registry directly:

```ts
import { recipes } from "./shared/recipes";
const operation = recipes.deploy(
  wallet,
  {
    ticker: "DEMO",
    tokenName: "Example token",
    decimals: 2,
    maxSupply: "1000",
    premintSupply: "1000",
    mintPolicy: "fixed",
    mintPricePerTokenSompi: "0",
  },
  { network: "testnet-10" },
);
const unsigned = await build(operation);
```

## Complete offline recipes

Every registry entry has a complete typed argument tuple in
[`recipe-fixtures.ts`](../examples/shared/recipe-fixtures.ts), including decoded
state and matching RPC entries derived from the packaged contract scripts.
Run any recipe without a wallet, node or private repository:

```sh
cd examples
npm run --silent recipe -- wrap --offline > unsigned-wrap.json
npm run --silent recipe -- wrap --arguments > wrap-arguments.json
npm run --silent recipe -- wrap wrap-arguments.json > wrap-operation.json
```

Replace `wrap` with `deploy`, `transfer`, `mint`, `publicMint`, `mintAvailability`,
`consolidate`, `reveal`, `deployMarket`, `unwrap`, `order`, `buyOrder`, `fill`,
`fillBid`, `sweep`, `sweepBids`, `cancel`, `cancelBid`, `consolidateWrapped`,
`deployFeeTicketRoot`, `updateFeeTicketRoot`, `createFeeTicket`, `burnFeeTicket`,
or `transferFeeTicket`. The frontend's **Offline recipe** selector runs the same
fixtures and always keeps signing and broadcasting disabled.

`order`, `fill`, `sweep`, and `cancel` demonstrate the ask side. The bid variants
exercise the opposite side. `mint` uses the authority owner; `publicMint` uses a
different owner against an active public minter. The availability recipe pauses
that minter. Sweep fee totals come from the package's per-leg fee helper, including
the minimum protocol fee.

All 24 recipes build real unsigned transactions with the bundled WASM. Tests
assemble signatures with public test-vector keys and compare browser/Node unsigned
transactions and signing instructions. Fixtures are independent snapshots, not a
chain simulator. They reuse synthetic funding and cannot be submitted. Replace
them with current decoded state and RPC entries for live use; see the
[live transfer adapter](LIVE_TRANSFER.md) for a complete retrieval example.

## Native tokens

| Recipe             | Existing helper                          | Inputs beyond the wallet                                                        |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------- |
| `deploy`           | `buildKcc20DeployTokenOperation`         | Draft supplies, decimals, mint policy, treasury and protocol fee configuration. |
| `transfer`         | `buildKcc20TransferTokenOperation`       | Token identity/decimals, display amount, recipient owner, current holder UTXOs. |
| `mint`             | `buildKcc20MintTokenOperation`           | Token mint policy, amount, active authority UTXOs, optional recipient.          |
| `mintAvailability` | `buildKcc20MintAvailabilityOperation`    | Token, active mint-authority state, requested enabled state.                    |
| `consolidate`      | `buildKcc20NativeConsolidationOperation` | Token, owner holder UTXOs, optional target amount.                              |
| `reveal`           | `buildKcc20VerifyTokenOperation`         | Token identity and a spendable holder/authority snapshot.                       |

```ts
const mint = recipes.mint(
  wallet,
  {
    token,
    tokenAmount: "10.00",
    activeUtxos: minterUtxos,
  },
  { network: "testnet-10" },
);
const unsignedMint = await build(mint);
```

`token` must include its actual decimals and mint policy. Controlled minting
requires the authority owner. A public mint can be paused. Mint-authority state
includes extension data that a holder snapshot does not contain. Public mint
amount limits and paid-mint minimums are validated by the helper.

## Wrappers and orderbook

| Recipe               | Existing helper                              | Required state                                                                          |
| -------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `deployMarket`       | `buildKcc20WrapperMarketDeployOperation`     | Token identity, market configuration and fee-ticket identity if used.                   |
| `wrap`               | `buildKcc20WrapTokenOperationFromSnapshot`   | Native holder, wrapper candidates, native covenant IDs, token decimals and amount.      |
| `unwrap`             | `buildKcc20UnwrapTokenOperationFromSnapshot` | Wrapped holder, wrapper reserve, market identity and amount.                            |
| `order`              | `buildKcc20OrderOperation`                   | Trading context and buy/sell draft; buy uses a market root, sell uses a wrapped holder. |
| `fill`               | `buildKcc20FillOperation`                    | Trading context, selected bid/ask, fill amount, funding/holder sources.                 |
| `sweep`              | `buildKcc20SweepOperation`                   | Trading context, ordered bid/ask legs and sufficient buyer/seller sources.              |
| `cancel`             | `buildKcc20CancelOperation`                  | Owner's bid/ask and matching market context.                                            |
| `consolidateWrapped` | `buildKcc20WrappedConsolidationOperation`    | Matching wrapped-holder sources and market context.                                     |

```ts
const order = recipes.order(
  wallet,
  tradingContext,
  {
    wrappedMarketId: tradingContext.wrapper.marketId,
    side: "buy",
    tokenAmount: "10.00",
    unitPriceSompi: "100000000",
  },
  { network: "testnet-10" },
);
const unsignedOrder = await build(order);
```

The context contains token decimals, the wrapper identity and its buildability,
current wrapped UTXOs, and optional fee-ticket UTXOs. Preserve the distinction
between native token identity, wrapper identity, and market identity. Use helper
parameter types rather than constructing a request from UI labels. The bid/ask
side controls which builder runs and which sources it consumes. Fees, locked
KAS deposits, price scale, partial-fill change, and token change must be shown
before signing. Never reuse a quote after its input order has changed.

## Fee tickets

| Recipe                | Existing helper                     | Required state                                                           |
| --------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| `deployFeeTicketRoot` | `buildFeeTicketRootDeployOperation` | Utility token ID, denomination, discount and optional supported markets. |
| `updateFeeTicketRoot` | `buildFeeTicketRootUpdateOperation` | Root configuration, current root UTXOs and new denomination.             |
| `createFeeTicket`     | `buildFeeTicketCreateOperation`     | Root configuration, root UTXOs, utility holders and quantity.            |
| `burnFeeTicket`       | `buildFeeTicketBurnOperation`       | Owner tickets and root configuration.                                    |
| `transferFeeTicket`   | `buildFeeTicketTransferOperation`   | Owner tickets, recipient and root configuration.                         |

```ts
const root = recipes.deployFeeTicketRoot(
  wallet,
  {
    utilityTokenId,
    utilityTokenAmount: "100",
    discountBps: 2500,
  },
  { network: "testnet-10" },
);
const unsignedRoot = await build(root);
```

`utilityTokenAmount` is an integer denomination in base units. Batch creation
requires a matching artifact and root capability; use the engine's existing
`resolveFeeTicketBatchCreateCapability` rather than assuming every root supports
multiple tickets. Creating tickets burns the selected utility amount.

## Backend-only matcher

`kcc20orderbook.matcher-settle-crossed` is intentionally excluded from the public
example registry. The engine accepts it only with `allowBackendOnly: true`.
Use a separate server instance, validated crossed-order snapshots, and explicit
operator configuration. Never enable it in the frontend, expose operator
credentials through a client configuration object, or forward all of `process.env`
to the engine. Public minting, transfer, and user order actions do not require
this matcher or KaspaCom's backend.
