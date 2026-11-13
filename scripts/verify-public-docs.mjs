import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const root = new URL('../', import.meta.url).pathname;
const names = ['PUBLIC_INTEGRATION', 'PUBLIC_INTEGRATION_CHECKLIST', 'PUBLIC_LIFECYCLE', 'PUBLIC_OPERATION_MATRIX', 'PUBLIC_WALLET_PROVIDER', 'PUBLIC_BACKEND_SUBMISSION'];
for (const name of names) {
  const file = resolve(root, `docs/${name}.md`);
  const body = await readFile(file, 'utf8');
  for (const [, link] of body.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^(https?:|#)/.test(link)) continue;
    await access(resolve(dirname(file), link.split('#')[0]));
  }
}
const { KCC20_BUILDER_KEYS } = await import('../dist/operations.js');
const matrix = await readFile(resolve(root, 'docs/PUBLIC_OPERATION_MATRIX.md'), 'utf8');
for (const [, key] of matrix.matchAll(/`((?:kcc20fee|kcc20|fee-ticket)\.[a-z-]+)`/g))
  assert(KCC20_BUILDER_KEYS.includes(key), `Undeclared builder ${key}`);
const pkg = JSON.parse(await readFile(resolve(root, 'examples/package.json'), 'utf8'));
const lock = JSON.parse(await readFile(resolve(root, 'examples/package-lock.json'), 'utf8'));
assert.equal(pkg.dependencies['@kaspacom/kcc20-tx-builder'], lock.packages[''].dependencies['@kaspacom/kcc20-tx-builder']);
assert(!/[~^*]/.test(pkg.dependencies['@kaspacom/kcc20-tx-builder']), 'Example version must be exact');
console.log('Verified public doc links, builder keys and exact example dependency');
