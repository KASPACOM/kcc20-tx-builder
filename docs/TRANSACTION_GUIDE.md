# Build transactions in your application

TX Builder constructs transactions locally in a browser or Node process. Your
application supplies WASM, the packaged contract artifacts, and chain data.
You do not need KaspaCom's backend to plan or build a transaction.

Start with the [runnable examples](../examples/README.md). Both applications use
[the same construction code](../examples/shared/build.ts) and build a deploy
followed by a transfer. Their offline transactions are identical across runtimes.

## Responsibilities

| Part | Responsibility |
| --- | --- |
| Operation helpers | Validate the requested action, select supplied covenant sources, convert display amounts, and describe intent. |
| Builder engine | Construct and serialize the funded unsigned transaction, attach covenant bindings, estimate fees, and return signing instructions. |
| Application | Initialize WASM, load artifacts, retrieve funding UTXOs and decoded covenant state, show transaction intent, and manage RPC lifetime. |
| Wallet or server signer | Confirm authorization and sign the required inputs, including covenant inputs. |
| Application and node | Submit the signed transaction, handle rejection, and track acceptance. |

A build is neither a signature nor proof of chain acceptance. Source snapshots
can become stale between construction and submission. On a spent-input failure,
refresh sources and rebuild; do not keep retrying the same transaction.

## Install and initialize

Use Node 22 for the examples. The package also supports its declared Node 20+
range. Install `@kaspacom/kcc20-tx-builder` from the public npm registry; no GitHub
Packages credentials are needed. Use the release version matching the examples.

The host initializes WASM once. See [Node initialization](../examples/backend/runtime.ts)
and [browser initialization](../examples/frontend/runtime.ts). Both use the
included ISC-licensed `kaspa-wasm` bundle, version `1.1.1-toc.1`, and call
`initWASM32Bindings({ validateClassNames: false })`. This allows bindings to work
when bundlers rename WASM classes. WASM remains host-owned; importing the package
does not initialize it or open a connection.

[COMPATIBILITY.json](COMPATIBILITY.json) pins binary/file checksums, contract
revision, compiler release, and artifact hashes. The runtime is included under
`examples/vendor/kaspa` in this repository and package, so neither example
fetches it from a private repository. The original runtime build's source commit
is not recorded in the supplied bundle. File integrity is verified; a reproducible
WASM source build is not claimed. The manifest also supplies an immutable public
`downloadBaseUrl`. Download `kaspa.js`, `kaspa_bg.wasm`, `kaspa.d.ts`, and
`LICENSE` from that base and verify each SHA-256 against `wasm.files` if you
host the runtime separately. Keep the license with redistributed files.

## Deploy a fixed-supply token

```ts
import { buildKcc20DeployTokenOperation } from '@kaspacom/kcc20-tx-builder/deploy-operation';

const operation = buildKcc20DeployTokenOperation(
  wallet, // { walletAddress: 'kaspatest:...', kcc20Owner: '<32-byte x-only public key>' }
  {
    ticker: 'DEMO', tokenName: 'Example token', decimals: 2,
    maxSupply: '1000', premintSupply: '1000',
    mintPolicy: 'fixed', mintPricePerTokenSompi: '0',
  },
  { network: 'testnet-10' },
);
const unsigned = await build(operation);
```

`build` comes from `createBuilder` in the shared example. That function creates
one existing `createKcc20PsktBuilderEngine`, verifies packaged artifact hashes,
and calls its `build` method. The complete adapter is executable code, not an
unspecified server request.

`engineInput(operation)` takes `operation.payload.signing.builderKey`, `params`,
`owner`, `network`, and source/signer requirements and assembles
`kcc20-in-process-pskt-builder-input/v1`. The separate shared-model input schema
is not interchangeable with this engine schema. The helper's
`missing-funded-pskt` status means construction is still required; historical
`backend-funded-pskt-builder` labels do not require a KaspaCom backend.
The local engine performs that construction.

The fixed-supply example creates 1,000 tokens with two decimals: 100,000 base
units. It locks KAS into the token output and returns KAS change to the funding
wallet. Use decimal strings, not floating-point multiplication, for token
amounts. KAS amounts and fees are integer sompi; 100,000,000 sompi is one KAS.
The library's protocol fee defaults still apply to relevant operations; inspect
the operation and resulting outputs before asking a wallet to sign.

## Transfer from a decoded holder snapshot

```ts
import { buildKcc20TransferTokenOperation } from '@kaspacom/kcc20-tx-builder/token-operation';

const operation = buildKcc20TransferTokenOperation(wallet, {
  token: { covenantId: holder.covenantId, decimals: 2 },
  activeUtxos: [holder],
  recipientOwner, // 32-byte x-only public key, not an address string
  tokenAmount: '12.50',
}, { network: 'testnet-10' });
const unsigned = await build(operation);
```

See [fixture.ts](../examples/shared/fixture.ts) for a complete holder snapshot:
transaction ID, output index, address, KAS amount, native covenant ID, owner,
token amount, extension commitment, and borrow state. The offline fixture derives
that snapshot from its deploy result. Its outpoints are synthetic and must never
be used as live funding.

Use the [live transfer adapter and walkthrough](LIVE_TRANSFER.md) to retrieve and validate a complete holder snapshot.
For live use, retrieve decoded state from your own indexer or decode the prior
transaction and reveal script. RPC UTXOs alone do not contain every contract
state field. Supply that state to the helper, then let the engine's source
provider retrieve current RPC entries by address. Preserve the native covenant
ID from RPC; an application's token identifier or script hash is not always the
native covenant ID. The engine rebuilds the holder script and checks its address.

The example transfers 1,250 base units, retains 98,750 as token change, and
uses a separate KAS funding input. A fragmented token balance may require
consolidation first. Funding selection can require one sufficiently large KAS
UTXO even when the wallet's total balance is sufficient.

## Inspect, sign, submit

The engine returns `psktTransactionJson`, `signInputs`, optional `scripts`,
`metadata`, and `submitTransactionSupported`. Inspect the full transaction,
recipients, token change, covenant IDs, KAS change, and fee before signing.
`inspect` computes the fee from input amounts minus output values.

[The signing adapter](../examples/shared/signing.ts) includes the covenant input
indexes from `scripts` as well as ordinary `signInputs`. After KasWare signs,
it inserts the signature into the ordered ABI arguments and wraps the redeem
script. Omitting this step produces a signed funding input but an invalid
covenant spend. Preserve every builder-provided sighash and script template. The adapter preserves
prebuilt witnesses on inputs the wallet does not sign, checks returned signature
encoding and sighash bytes, and rejects changes to transaction intent. These
checks do not replace cryptographic verification or node consensus validation.
When using the WASM signer directly, map wire sighash `1` to `wasm.SighashType.All`;
the WASM enum's numeric value is `0`, not the wire byte.

The frontend checks the wallet account and TN10 network, then offers separate
Sign and Broadcast actions. It submits through the selected RPC node. The backend
example returns an unsigned transaction for an application or wallet to sign;
it does not load private keys. The offline suite verifies construction and
script assembly, not a wallet extension's current behavior or live acceptance.

For server integrations, call the same shared `createBuilder` function from your
handler with a process-owned RPC connection. Validate the caller's request and
apply your own authorization before signing. Return the builder result as JSON;
never forward your environment or signing credentials to a browser.

## Failure handling

| Failure | Application action |
| --- | --- |
| Insufficient KAS or no single funding UTXO | Refresh funding and obtain an adequate input; inspect the required output deposits and fee. |
| No holder large enough | Check ownership and decimals; consolidate if the balance is fragmented. |
| Active holder not found | Refresh decoded state and RPC UTXOs; the input may have been spent. |
| Rebuilt script address mismatch | Check decoded state and artifact version; do not substitute another address. |
| Artifact hash mismatch | Use the artifacts shipped with this package version. |
| Wrong network or missing WASM capability | Correct host configuration before building. |
| Wallet rejection | Keep the transaction unsigned and report cancellation. |
| Node rejection or uncertain submission | Query acceptance and spent inputs before rebuilding or retrying. |

Errors include both plain `Error` messages and structured builder errors. Do not
assume every error has a `code`. Add transport timeouts appropriate to your host,
and close failed connections. Browser applications should reuse one RPC
connection rather than reconnecting for each build.
