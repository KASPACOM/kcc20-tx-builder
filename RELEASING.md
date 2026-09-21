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

## Later releases

1. Update the version with `npm version patch`, `minor`, or `major`.
2. Push the commit and its `v<version>` tag.
3. Publish a GitHub Release for that exact tag.
4. Confirm both registry jobs completed and that both registries contain the
   same version.

The release workflow rejects a GitHub Release whose tag does not exactly match
`v` plus the version in `package.json`.
