# Frontend and backend transaction examples

These examples build KCC20 transactions inside the application, without
KaspaCom backend build, plan, or source endpoints. They share TypeScript
construction code and include their WASM runtime and license.

## Run from the package repository

```sh
npm ci
npm run build
npm ci --prefix examples --registry=https://registry.npmjs.org/ --@kaspacom:registry=https://registry.npmjs.org/
npm exec --prefix examples -- playwright install --with-deps --only-shell chromium
npm run test:examples
npm --prefix examples run backend -- offline
npm --prefix examples run frontend
```

`test:examples` packs the current candidate and installs it into the examples
before testing. The checked-in examples pin the published `0.8.3-fee.6`
prerelease; candidate testing intentionally replaces that dependency temporarily.

Synthetic offline examples use the same digest-authenticated bundled profile as
live builders. They do not broadcast transactions.

After publication, users can copy `examples` from the package or repository,
run `npm ci` inside it, then install the matching release explicitly:

```sh
npm install --no-save --package-lock=false @kaspacom/kcc20-tx-builder@0.8.3-fee.6 \
  --registry=https://registry.npmjs.org/ --@kaspacom:registry=https://registry.npmjs.org/
npm run backend -- offline
npm run frontend
```

Node 22 is the reference runtime. The browser demo opens on the Vite localhost
URL. Click **Build offline deploy and transfer**. No wallet, RPC, credentials,
or private repository is needed. The synthetic addresses are public test vectors:
do not fund them.

## Build against your TN10 node

Construct an operation with the helpers in `shared/build.ts` or use the
[operation recipes](../docs/RECIPES.md). Save the result to `examples/operation.json` when running the command below
from the repository root. npm runs this CLI with `examples` as its working directory.

```sh
KASPA_WRPC_URL=wss://your-tn10-node npm --prefix examples run backend -- build operation.json
```

The CLI writes the full unsigned builder result. It never signs or broadcasts.
For a frontend deploy, click **Prepare deploy from KasWare account** to
construct the operation locally from your connected TN10 account, then review
the demo token parameters. For other operations, paste the helper-generated
operation JSON. Enter your RPC URL in the browser form. Inspect the output, then optionally sign with KasWare and broadcast
with the separate button. Use a TN10-compatible node and wallet. Your RPC endpoint
must permit browser WebSocket access; HTTPS pages need a secure `wss://` endpoint.

Read the [transaction guide](../docs/TRANSACTION_GUIDE.md) for source snapshots,
decimals, fees, covenant script signing, and failure handling. Offline tests do
not establish that the selected node or wallet supports the current TN10 rules.

## Files to copy into your application

- `shared/build.ts`: helpers, operation-to-engine adapter, source injection, inspection.
- `backend/runtime.ts` or `frontend/runtime.ts`: initialize WASM and load package artifacts.
- `shared/signing.ts`: covenant script assembly after wallet signing.
- `shared/recipes.ts`: typed entry points for the other operation families.

`shared/fixture.ts` is offline test data. Replace it with your RPC provider and
own indexer/decoded snapshots for live builds. Keep one host-owned connection
and close it when the host shuts down.

## Complete operation recipes and live transfer

The browser **Offline recipe** selector and `npm run recipe -- <name> --offline`
construct all 24 documented scenarios. `--arguments` prints their complete typed
helper arguments as JSON. See [recipes](../docs/RECIPES.md).

To retrieve real holder state independently, follow the
[live transfer guide](../docs/LIVE_TRANSFER.md). Node supports
`npm run backend -- transfer transfer.json`; the browser accepts the same config
through **Build transfer from indexer**. Both verify decoded state against RPC.

## Fee-protocol starting point

Run `npm run fee-quote` for a local fee calculation. The generic order/wrap
recipes above target the older helper family, not `kcc20fee.*` markets. See the
[public integration guide](../docs/PUBLIC_INTEGRATION.md) before choosing a
market version; a complete live fee-market trading CLI remains a follow-up.


## New fee-market lifecycle

The [lifecycle cookbook](../docs/PUBLIC_LIFECYCLE.md) documents the new
`fee-request`, `deploy-request` and `lifecycle` commands. Construction is local;
broadcast requires an explicit signer and spend cap. See the
[checklist](../docs/PUBLIC_INTEGRATION_CHECKLIST.md) for per-flow proof status and
the [wallet-provider guide](../docs/PUBLIC_WALLET_PROVIDER.md) for balance/transfer
integrations. These commands do not use the legacy order recipes above.

## Release archive

Release `0.8.3-fee.7` contains these examples. Their lockfile installs the
unchanged `0.8.3-fee.6` engine; the release changes example wiring and docs.
Extract the public archive and install the example dependencies:

```sh
npm pack @kaspacom/kcc20-tx-builder@0.8.3-fee.7 --ignore-scripts --registry=https://registry.npmjs.org/
tar -xzf kaspacom-kcc20-tx-builder-0.8.3-fee.7.tgz
cd package/examples
npm ci --registry=https://registry.npmjs.org/ --@kaspacom:registry=https://registry.npmjs.org/
npm test
```

Live lifecycle builds fetch a fresh priority quote from the connected TN10 node.
Fee-estimate failure stops construction. Wallet signing validates the quoted fee
against the complete signed transaction. Inspection remains the default;
broadcast still requires explicit `--submit`, a signer and a debit cap.
