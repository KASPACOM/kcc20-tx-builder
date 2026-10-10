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

`test:examples` packs the current candidate and installs that tarball into the
examples extracted from that tarball before testing; it also installs the same candidate into the checkout. This matters before 0.3.0-snapshot.0 is published: the lockfile's
registry bootstrap dependency is 0.2.5, which predates the browser compatibility
fix. Do not skip the candidate installation when testing a checkout.

After publication, users can copy `examples` from the package or repository,
run `npm ci` inside it, then install the matching release explicitly:

```sh
npm install --no-save --package-lock=false @kaspacom/kcc20-tx-builder@0.3.0-snapshot.0 \
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
