# Published package contents review, 2026-11-10

Both the GitHub repository and npm package are public. No visibility change or
new npm release was needed for this review.

Inspected archive: `@kaspacom/kcc20-tx-builder@0.8.3-fee.3`, downloaded from the
public npm registry without install scripts. It contains 625 files.
SHA-256: `e2fa4130c35f2fb53e445d93df220da4e7b4a26682f3a7ca111e157a34f383f9`.

The scan found no private-key PEM blocks, AWS access-key patterns, GitHub/npm
access-token patterns, credential-bearing connection URLs, `.env` files,
`.npmrc`, `id_rsa` or `wallet.json`. Source review confirmed the core accepts
host-supplied runtime/providers rather than loading operator configuration.
Examples intentionally include public deterministic test fixtures and host-side
RPC/runtime wiring. Do not fund test-vector wallets.

This supports the statement "no live credentials were identified in the
reviewed package." It does not establish that arbitrary strings are not secrets,
audit every binary byte or Git history, or certify future releases. Inspect the
actual release tarball again when publishing a changed package. Package version
and artifact pins should remain explicit in consumer lockfiles.
