# KCC20 transaction builder

This package is the runtime-independent home for KCC20 covenant protocol and
PSKT construction logic. It is intended to be consumed by both the browser
frontend and the Node backend.

## Install

```sh
npm install @kaspacom/kcc20-tx-builder
```

The package is ESM-only and requires Node.js 20 or newer for Node consumers.
Browser consumers must provide their already-loaded browser Kaspa WASM runtime;
Node consumers provide their Node Kaspa WASM runtime. Kaspa WASM is deliberately
not bundled or initialized by this package.

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
orders, and FeeTicket root/create/burn/transfer/update operations. Matcher
settlement and operator-only flows remain backend-only.

The package ships the KCC20 contract artifacts under `artifacts/`, but the
engine still accepts supplied artifacts and UTXO/RPC access and never reads
files, environment variables, or WASM assets itself. Browser and backend hosts
decide how to load package artifacts for their runtime. The frontend host can
configure the bridge with its already-loaded runtime:

```ts
clientBuilder.configure({
  wasm: loadedKaspa,
  artifactProvider: (key) =>
    fetch(`/kcc20-artifacts/${key}`).then((response) => response.json()),
  sourceProvider: {
    getUtxosByAddresses: (request) =>
      applicationRpcConnection.getUtxosByAddresses(request),
  },
});
```

The artifact and source providers are host policies. Private operator keys and
matcher settlement logic must not enter this package.

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
import kcc20Artifact from
  "@kaspacom/kcc20-tx-builder/artifacts/KCC20.placeholder.json";
```

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
