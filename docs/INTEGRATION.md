# Integrating the TX Builder

This guide describes the API shipped in `@kaspacom/kcc20-tx-builder@0.2.5`.
The host application supplies wallet identity, network configuration, contract
artifacts, chain data, and an initialized Kaspa WASM runtime. The package
constructs operations and transaction JSON. The host signs, validates,
broadcasts, and tracks the result.

## Install from the public registry

```sh
npm install --save-exact @kaspacom/kcc20-tx-builder@0.2.5 \
  --registry=https://registry.npmjs.org/ \
  --@kaspacom:registry=https://registry.npmjs.org/
```

The scoped registry option matters when a project or user `.npmrc` maps
`@kaspacom` to GitHub Packages. Public npm installation does not require a
GitHub token. Commit your lockfile and pin the same package version across
browser and server adapters.

Node consumers need Node.js 20 or newer. Browser consumers need a bundler
that supports ESM and their platform's Kaspa WASM build. ESM and CommonJS
exports are available:

```js
import { KCC20_PSKT_BUILDER_INPUT_SCHEMA } from '@kaspacom/kcc20-tx-builder';
```

```js
const { KCC20_PSKT_BUILDER_INPUT_SCHEMA } = require('@kaspacom/kcc20-tx-builder');
```

## Start with amount calculations

This example runs without a wallet, RPC connection, or WASM runtime:

```js
import {
  parseKcc20DisplayAmountToBaseUnits,
  formatKcc20BaseUnitsForDisplay,
  calculateKcc20OrderTotalSompi,
} from '@kaspacom/kcc20-tx-builder';

const baseUnits = parseKcc20DisplayAmountToBaseUnits('1.25', 8, 'amount');
console.log(baseUnits); // '125000000'
console.log(formatKcc20BaseUnitsForDisplay(baseUnits, 8)); // '1.25'

const order = calculateKcc20OrderTotalSompi('1.25', '100000000', 8);
console.log(order?.totalSompi); // '125000000'
```

Use decimal strings for token amounts and sompi values. Use `bigint` for
arithmetic. A token's display decimals are separate from the KAS unit scale;
read them from its verified metadata. The helpers accept token decimals from
0 through 8. Check `roundedDown` and `roundedTokenAmountBaseUnits` when quoting
orders because some prices require rounding to an exact sompi amount.

## Configure a persistent engine

The following adapter is TypeScript. Its parameters are dependencies supplied
by your application, not objects exported by the package:

```ts
import {
  createKcc20PsktBuilderEngine,
  type KaspaWasmRuntime,
  type Kcc20PsktBuilderInput,
} from '@kaspacom/kcc20-tx-builder';

export function createWalletBuilder(
  loadedKaspa: KaspaWasmRuntime,
  applicationRpcConnection: {
    getUtxosByAddresses(request: { addresses: string[] }): Promise<unknown>;
  },
  artifactProvider: (key: string) => Promise<unknown>,
) {
  const engine = createKcc20PsktBuilderEngine({
    wasm: loadedKaspa,
    artifacts: {},
    artifactProvider,
    config: { KASPA_NETWORK: 'testnet-10' },
    sourceProvider: {
      getUtxosByAddresses: (request) =>
        applicationRpcConnection.getUtxosByAddresses(request),
    },
  });

  return (preparedInput: Kcc20PsktBuilderInput) => engine.build(preparedInput);
}
```

Initialize WASM before calling this adapter. Select and connect your RPC
endpoint in the host. The builder does not connect or disconnect a supplied
`sourceProvider`. Reuse a persistent engine to retain its artifact cache.
Supply fresh indexed covenant state and wallet funding sources for each build.

For a browser, serve the package's JSON artifacts through your asset pipeline:

```ts
export async function artifactProvider(key: string): Promise<unknown> {
  const response = await fetch(`/kcc20-artifacts/${encodeURIComponent(key)}`);
  if (!response.ok) throw new Error(`Cannot load artifact ${key}: ${response.status}`);
  return response.json();
}
```

Copy the installed package's `artifacts/*.json` files to that asset directory
as part of the host build. A server can load those same files once using its
own filesystem adapter and pass the resulting objects through `artifacts`.
Filesystem access belongs in the host, outside this package.

`rpcClientFactory` is an alternative for hosts that need the builder to create
an RPC client. Prefer `sourceProvider` when the application already owns a
connection. Configure network and RPC explicitly rather than relying on the
engine's TN10 defaults.

## Prepare the input

The engine accepts the in-process envelope:

```ts
import {
  KCC20_PSKT_BUILDER_INPUT_SCHEMA,
  type Kcc20PsktBuilderInput,
} from '@kaspacom/kcc20-tx-builder';

export function toBuilderInput(
  preparedRequest: Record<string, unknown>,
): Kcc20PsktBuilderInput {
  return {
    schema: KCC20_PSKT_BUILDER_INPUT_SCHEMA,
    builder: {},
    request: preparedRequest,
  };
}
```

`request.builderKey` selects the operation. The remaining request fields are
operation-specific: wallet owner and address, network, params, and decoded
covenant sources. This envelope adapter does not prepare or validate them.
Use the operation helpers listed in [the API guide](API.md) to construct intent,
then let your host resolve the required sources and assemble the engine request.
There is no universal funded request that works for every operation.

Operation helpers such as `buildKcc20TransferTokenOperation` return a wallet
operation envelope with an initially missing funded PSKT. That object is not
directly an engine input. The host must convert its intent and sources into
`request`, build the PSKT, and attach the funded result to its signing flow.

Do not confuse `KCC20_PSKT_BUILDER_INPUT_SCHEMA` with
`KCC20_BUILDER_INPUT_SCHEMA` from `models.ts`. The latter describes the separate
shared source/context model. Passing that model directly to `engine.build`
fails its schema check.

## Consume the result

The engine returns an operation-specific record with
`schema: 'kcc20-in-process-pskt-builder-output/v1'`, `psktTransactionJson`,
`signInputs`, and, where needed, covenant `scripts` and `metadata`.
`psktTransactionJson` is JSON text, not an already signed transaction.
The return type is `Record<string, unknown>`; narrow and validate the fields
your wallet adapter consumes.

1. Present the intended action, amounts, recipients, and fees to the user.
2. Build using fresh sources and check the resulting inputs and outputs.
3. Use the wallet's PSKT signing interface with the returned signing instructions.
4. Independently validate the signed transaction and authorization in your trusted host.
5. Broadcast through your host and reconcile confirmation or reorg state through your indexer.

The package does not provide wallet discovery, signing UI, authentication,
broadcast orchestration, or confirmation tracking. Browser-built transaction
JSON remains untrusted input at a backend boundary.

## Artifacts and privileged builders

The package pins script hashes for five shipped artifacts. The engine validates
artifacts against those hashes; mixing independently compiled artifacts with
this package version can fail the build. Upgrade artifacts and builder together.
JSON subpath loading depends on the host's module loader, so the asset-provider
approach avoids imposing a JSON import syntax on consumers.

`allowBackendOnly` defaults to disabled. The matcher builder
`kcc20orderbook.matcher-settle-crossed` requires an engine explicitly configured
with `allowBackendOnly: true` in a trusted server. That flag does not authorize
a caller. Keep matcher scheduling, authorization, and any private keys in the
server host. `buildKcc20Pskt` does not expose this opt-in; configure an engine
for privileged work.

## Handle errors

Some helpers throw `Kcc20BuilderError`, exposing `code` and string-valued
`details`. Other helpers and the engine throw ordinary `Error` instances;
do not assume every failure has a structured code. Handle both:

```ts
import { Kcc20BuilderError } from '@kaspacom/kcc20-tx-builder';

export function describeBuildFailure(error: unknown): string {
  if (error instanceof Kcc20BuilderError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Transaction construction failed';
}
```

Refresh sources after spent or stale UTXO failures. An artifact mismatch needs
a package/artifact compatibility check. A missing WASM capability needs a
compatible runtime. Do not retry signing or broadcast automatically after an
ambiguous submission; reconcile its transaction ID in your host first.
