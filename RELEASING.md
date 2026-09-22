# Releasing

The package is published under the same version to both registries:

- npmjs (`https://registry.npmjs.org`) is the public distribution for general
  consumers and the backend.
- GitHub Packages (`https://npm.pkg.github.com`) supports KaspaCom projects
  whose `.npmrc` maps the entire `@kaspacom` scope to GitHub Packages.

Never publish different contents under the same version. npm package versions
are immutable, so update `package.json` before each release.

## First release

The first npmjs release must be published manually. This creates the npm
package so its trusted publisher can be configured afterward.

```sh
npm ci
npm test
npm pack --dry-run
npm login --registry=https://registry.npmjs.org/
npm publish --access public \
  --registry=https://registry.npmjs.org/ \
  --@kaspacom:registry=https://registry.npmjs.org/
npm publish \
  --registry=https://npm.pkg.github.com/ \
  --@kaspacom:registry=https://npm.pkg.github.com/
```

Publishing requires permission to the `@kaspacom` organization on npmjs. The
GitHub Packages publication requires a GitHub token with `write:packages`.
Do not commit either token or a user-level `.npmrc`.

After the npmjs publication, configure its trusted publisher for:

- Organization/user: `KASPACOM`
- Repository: `kcc20-tx-builder`
- Workflow: `publish.yml`

Also grant this repository's Actions workflow permission to publish the GitHub
package. The workflow uses GitHub's short-lived `GITHUB_TOKEN`; it does not
need a long-lived package token.

## Consumer cutover

The frontend and backend use `file:../kcc20-tx-builder` while developing the
first release locally. That path is not valid when either consumer is cloned
or deployed independently. After version `0.1.0` is visible on npmjs, run this
in both consumer repositories and commit both `package.json` and
`package-lock.json`:

```sh
npm install --save-exact @kaspacom/kcc20-tx-builder@0.1.0
```

Keep both consumers pinned to the same exact package version. Verify that
neither lockfile contains a `file:../kcc20-tx-builder` resolution, then rerun
the package tests, backend tests/build, and frontend tests/production build.
Do not merge a consumer dependency cutover before that exact version is
available from the registry used by its CI environment.

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

## Later releases

1. Update the version with `npm version patch`, `minor`, or `major`.
2. Push the commit and its `v<version>` tag.
3. Publish a GitHub Release for that exact tag.
4. Confirm both registry jobs completed and that both registries contain the
   same version.
5. Upgrade frontend and backend to the same exact version and rerun their full
   verification suites before deployment.

The release workflow rejects a GitHub Release whose tag does not exactly match
`v` plus the version in `package.json`.
