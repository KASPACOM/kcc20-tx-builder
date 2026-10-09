# Changelog

## 0.2.6 (unreleased)

- Add integration and API guides, including amount examples, host-supplied WASM,
  artifact loading, source transport, request schemas, signing, and errors.
- Include guides, release instructions, and security reporting in the npm tarball.
- Replace the README's host-specific bridge example with the exported engine API.
- Document public npm registry overrides and replace obsolete first-release steps.

Artifact contents are unchanged from `0.2.5`. The engine RPC adapter now supports frozen WASM exports from browser bundlers.

### Public integration examples

- Add runnable browser and Node deploy/transfer examples with WASM and offline fixtures.
- Fix the engine RPC adapter for frozen WASM module exports produced by bundlers.
- Verify packed-package browser/Node parity without external network requests.
