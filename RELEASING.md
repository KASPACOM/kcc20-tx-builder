# Releasing

The package is published under the same version to both registries:

- npmjs (`https://registry.npmjs.org`) is the public distribution for general
  consumers and the backend.
- GitHub Packages (`https://npm.pkg.github.com`) supports KaspaCom projects
  whose `.npmrc` maps the entire `@kaspacom` scope to GitHub Packages.

Never publish different contents under the same version. npm package versions
are immutable, so update `package.json` before each release.

## Publishing setup

The package is already public on npmjs at `0.2.5`. GitHub Releases trigger
`.github/workflows/publish.yml`, which has independent npmjs and GitHub Packages
jobs. Both jobs install dependencies, run tests, and require the release tag to
match `v` plus the checked-out `package.json` version.

npmjs uses trusted OIDC publishing with provenance on Node 24. Its trusted
publisher identifies organization `KASPACOM`, repository `kcc20-tx-builder`,
and workflow `publish.yml`, with no GitHub environment configured. GitHub
Packages uses the workflow's short-lived `GITHUB_TOKEN` and `packages: write`.
Do not add long-lived npm tokens or publish from an unreviewed checkout.

## Prepare a release

1. Start from reviewed `main` and update the version in a release PR.
2. Run `npm ci`, `npm test`, and `npm pack --dry-run`.
3. Inspect the tarball for compiled ESM/CommonJS entry points, declarations,
   artifacts, documentation, and license. Check that no credentials or local
   wallet files are included.
4. Merge the release PR after CI and review pass.
5. Create the matching `v<version>` tag and GitHub Release from that commit.
6. Confirm both publish jobs succeed and inspect registry metadata and the
   package tarball before upgrading consumers.

Creating a GitHub Release publishes the package automatically. Prepare and
review the release first; do not create a release merely to test the workflow.

## Consumer upgrades

Install the exact released version using the registry used by your CI:

```sh
npm install --save-exact @kaspacom/kcc20-tx-builder@0.2.5 \
  --registry=https://registry.npmjs.org/ \
  --@kaspacom:registry=https://registry.npmjs.org/
```

Replace `0.2.5` with the reviewed version for a later upgrade. Commit both
`package.json` and `package-lock.json`. Keep frontend and backend on the same
exact package version. Remove any `file:../kcc20-tx-builder` resolution before
independent CI or deployment. Run package, backend, and frontend verification
against the registry package rather than a neighboring checkout.

## Live release gate

Before deploying either consumer, run one TN10 wallet smoke test with the
published package (not the local `file:` dependency):

1. Deploy and verify a token, then reload the page and confirm unfinished
   deploy recovery and backend settlement tracking still find it.
2. Mint, transfer, wrap, unwrap, and consolidate both native and wrapped
   holder UTXOs.
3. Create buy and sell orders; fill, sweep, and cancel both sides.
4. Deploy/update the FeeTicket root; create, use, transfer, and burn a ticket.
5. Confirm browser network traffic contains no KCC20 `/plan`, `/build`, or
   `/sources` requests and that all RPC-backed actions reuse one persistent
   Kaspa WebSocket connection.

Treat this as a release gate: unit tests prove deterministic construction and
adapter behavior, while this smoke test proves compatibility with the live
wallet, WASM, node, and indexer versions being deployed.

## Verify registry metadata

Projects may map the entire `@kaspacom` scope to GitHub Packages. Override that
mapping when checking public npm:

```sh
npm view @kaspacom/kcc20-tx-builder version dist-tags \
  --registry=https://registry.npmjs.org/ \
  --@kaspacom:registry=https://registry.npmjs.org/
```

A green publishing workflow confirms an upload, not consumer compatibility.
Inspect the installed tarball and complete the live release gate before
consumer deployment. Record any unverified operation families explicitly.
