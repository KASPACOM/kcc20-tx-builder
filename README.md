# KCC20 transaction builder

This package is the runtime-independent home for KCC20 covenant protocol and
PSKT construction logic. It is intended to be consumed by both the browser
frontend and the Node backend.

## Install

```sh
npm install --save-exact @kaspacom/kcc20-tx-builder@0.2.5 \
  --registry=https://registry.npmjs.org/ \
  --@kaspacom:registry=https://registry.npmjs.org/
```

The package provides ESM and CommonJS entry points and requires Node.js 20 or
newer for Node consumers.
Browser consumers must provide their already-loaded browser Kaspa WASM runtime;
Node consumers provide their Node Kaspa WASM runtime. Kaspa WASM is deliberately
not bundled or initialized by this package.

## Documentation

- [Integration guide](docs/INTEGRATION.md): amount calculations, engine setup,
  artifacts, source providers, signing boundaries, and error handling.
- [API guide](docs/API.md): public entry points and operation families.
- [Independent indexing](https://github.com/KASPACOM/kaspa-covenants/blob/develop/docs/INDEPENDENT_INDEXING.md): self-hosted data boundaries and lightweight-indexer release gates. The lightweight indexer is not yet a live data source.
- [Snapshot builders](docs/snapshot-start.md): signerless deployment, claims and verification; funded DEV rehearsal is still required.
- [Release guide](RELEASING.md): publishing and consumer verification.

Public npm installation does not require a GitHub token. The explicit scoped
registry flag overrides project settings that route `@kaspacom` to GitHub Packages.
The current public release is `0.2.5`; this branch prepares `0.3.0-snapshot.0` with expanded
documentation and the snapshot builders already merged into main. This remains a
prerelease candidate. Pin versions across wallet and server adapters.
See [the changelog](CHANGELOG.md) for the release candidate.

## Runtime boundary

The package deliberately does not import Kaspa WASM, Angular, NestJS, Node
filesystem APIs, or `process.env`. The application supplies a WASM runtime
through `KaspaWasmRuntime`.

The frontend and backend adapters pass their already-initialized, platform-
specific Kaspa WASM runtimes to the same shared builder implementation. The
package never loads or initializes either WASM build.

## Current status

The shared package contains the extracted user-operation engine, deterministic
amount/fee calculations, and action-specific UTXO selection. It supports
deploy, verify, mint, mint availability, transfer, native/wrapped
consolidation, wrap, unwrap, wrapper-market deploy, create/fill/sweep/cancel
orders, FeeTicket root/create/burn/transfer/update operations, and the
deterministic matcher/operator transaction builders. Matcher/operator
invocation, authorization, scheduling, and key custody remain backend-only;
hosts must explicitly enable those builders with `allowBackendOnly`.

The package ships the KCC20 contract artifacts under `artifacts/`, but the
engine still accepts supplied artifacts and UTXO/RPC access and never reads
files, environment variables, or WASM assets itself. Browser and backend hosts
decide how to load package artifacts for their runtime. The host can
configure the exported engine with its already-loaded runtime:

```ts
import { createKcc20PsktBuilderEngine } from "@kaspacom/kcc20-tx-builder";

createKcc20PsktBuilderEngine({
  wasm: loadedKaspa,
  artifacts: {},
  artifactProvider: (key) =>
    fetch(`/kcc20-artifacts/${encodeURIComponent(key)}`).then((response) => {
      if (!response.ok) throw new Error(`Cannot load artifact ${key}`);
      return response.json();
    }),
  sourceProvider: {
    getUtxosByAddresses: (request) =>
      applicationRpcConnection.getUtxosByAddresses(request),
  },
});
```

The artifact and source providers are host policies. Private operator keys
must never be embedded in this package; a trusted backend may inject one at
runtime for an explicitly authorized operator build.

When `sourceProvider` is present, its connection lifecycle belongs entirely to
the host: the builder does not construct, connect, or disconnect an RPC client.
This allows a browser application to reuse one reconnecting websocket across
wallet actions while a backend can use its own pool. `rpcClientFactory` remains
available as a compatibility fallback for hosts that do not provide sources.

## Design rules

- Keep protocol calculations deterministic and side-effect free.
- Pass UTXO/source data into the builder; do not perform RPC in the core.
- Keep generic indexer/RPC source fetching, authentication, receipts,
  broadcasting, and job orchestration in application adapters. Keep
  action-specific source selection in this package.
- Pin contract artifact hashes in the build context.
- Treat client-built PSKTs as untrusted until backend validation succeeds.

## Contract artifacts

The placeholder contract artifacts are exported as package subpaths. For
example:

```ts
import kcc20Artifact from "@kaspacom/kcc20-tx-builder/artifacts/KCC20.placeholder.json";
```

The published, hash-pinned set contains `KCC20`, `KCC20Wrapper`,
`KCC20Orderbook`, `KCC20FeeTicket`, and `KCC20Vesting`. Consumers should not
vendor separate copies of these files.

How JSON modules are loaded depends on the consuming runtime and bundler. A
host may instead copy the artifacts to its public assets and supply an
`artifactProvider`.

## Security boundary

Building a PSKT in a browser does not make it trusted. Applications should
validate submitted transaction intent, ownership, protocol invariants, and
resulting chain state independently. Never pass operator private keys or other
backend secrets into this package in a browser.

## License

Apache-2.0

## Runnable transaction examples

Start with the [frontend and backend examples](examples/README.md), then read
the [transaction construction guide](docs/TRANSACTION_GUIDE.md) and
[operation recipes](docs/RECIPES.md). Both applications construct transactions
locally using packaged artifacts and host-supplied chain data.

For independently retrieved holder state, see the [live transfer walkthrough](docs/LIVE_TRANSFER.md); all supported user operation families have [runnable offline recipes](docs/RECIPES.md).
