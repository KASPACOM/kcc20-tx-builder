# Transfer using your own indexer and RPC

The browser and Node examples use the same
[`liveTransferOperation`](../examples/shared/live-transfer.ts) adapter. It retrieves
decoded holder state from an endpoint you configure, confirms the output through
RPC, and passes the validated holder to the existing transfer helper. No KaspaCom
application backend is involved.

## Decoded-state endpoint

Serve an HTTP GET endpoint returning:

```ts
import type { Kcc20IndexedCovenantUtxo } from "@kaspacom/kcc20-tx-builder/action-source-resolver";
type HolderResponse = {
  network: "testnet-10";
  utxos: Kcc20IndexedCovenantUtxo[];
};
```

Map your indexer's transaction ID, output index, KAS amount, native covenant ID,
address and decoded state to this shape. An application alias must not replace
the native covenant ID. Amounts must be decimal strings. This adapter supports
unborrowed native holders owned by a Schnorr public key. It rejects duplicate
outpoints and malformed rows. Paginate in your indexer adapter if a response
would exceed 1,000 rows.

A complete deterministic response can be generated without a backend:

```sh
cd examples
npm run --silent recipe -- transfer --arguments > transfer-arguments.json
node --input-type=module -e 'import fs from "node:fs"; const a=JSON.parse(fs.readFileSync("transfer-arguments.json")); console.log(JSON.stringify({network:"testnet-10",utxos:a[1].activeUtxos},null,2))' > holder-response.json
```

This includes actual address strings, outpoints, base-unit amounts, native IDs,
owner identifiers, extension commitments and borrow fields. All outpoints are
synthetic. They demonstrate the schema and are rejected by a live node.

For real use, fill these fields from your indexer's decoded current outputs.
RPC alone does not provide token amount, owner scheme or extension commitment.
The adapter rebuilds the holder script from decoded state and the packaged
artifact, verifies its address, then checks the RPC outpoint, script, KAS amount
and native covenant ID. A fabricated or stale snapshot cannot bypass those
comparisons. The selected RPC remains a trusted source of chain data.

## Transfer configuration

Save `transfer.json` in `examples`. Replace the marked values with your own
TN10 account and verified token metadata:

```json
{
  "network": "testnet-10",
  "stateUrl": "https://your-indexer.example/holders",
  "wallet": {
    "walletAddress": "kaspatest:YOUR_ADDRESS",
    "kcc20Owner": "YOUR_64_HEX_OWNER"
  },
  "covenantId": "YOUR_64_HEX_NATIVE_COVENANT_ID",
  "decimals": 2,
  "recipientOwner": "RECIPIENT_64_HEX_OWNER",
  "tokenAmount": "12.50"
}
```

TypeScript applications can import `LiveTransferConfig` from the shared adapter.
`decimals` comes from verified token metadata. It determines the requested base
units; it cannot be inferred from a holder amount. The recipient is an x-only
public key. The adapter checks that the sender address belongs to the supplied
owner key. This example requires one holder large enough for the transfer and
separate KAS funding. Use the consolidation recipe for fragmented balances.

## Backend

```sh
cd examples
KASPA_WRPC_URL=wss://your-tn10-node npm run --silent backend -- transfer transfer.json > unsigned.json
```

The CLI checks the connected node's network, retrieves and validates the holder,
builds locally, writes the unsigned transaction and signing instructions, and
closes RPC. A server handler can call the same adapter with a process-owned
connection. Apply authorization before any server signing. Do not accept arbitrary
state URLs from unauthenticated callers: configure or allowlist indexer endpoints
in your own server to avoid turning it into an HTTP proxy.

## Frontend

Start the Vite example, enter the RPC URL, paste the same configuration JSON into
the text area, and click **Build transfer from indexer**. The state endpoint must
allow your application's origin through CORS. HTTPS applications need HTTPS state
URLs and WSS RPC. Review the complete unsigned transaction before the separate
**Sign** and **Broadcast** actions.

The same function can be imported directly:

```ts
const operation = await liveTransferOperation(wasm, rpc, loadArtifact, config);
const unsigned = await createBuilder(wasm, rpc, loadArtifact)(operation);
```

The network check belongs to the host connection setup, as shown in both runnable
apps. An input can be spent after validation: on a node rejection, refresh state
and rebuild. If submission times out, check the transaction ID and spent inputs
before retrying. These examples do not claim live wallet or node acceptance.
