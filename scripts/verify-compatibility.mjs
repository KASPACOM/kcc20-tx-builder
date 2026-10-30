import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('docs/COMPATIBILITY.json', root)));
const packageMetadata = JSON.parse(await readFile(new URL('package.json', root)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const SHA256 = /^[0-9a-f]{64}$/;
assert.equal(manifest.packageVersion, packageMetadata.version, 'Compatibility package version is stale');
assert.match(manifest.contractsCommit, /^[0-9a-f]{40}$/, 'Reviewed contracts commit is not pinned');
assert.doesNotMatch(manifest.contractsSourceStatus, /unreviewed/i, 'Contract source is still marked unreviewed');
for (const [name, expected] of Object.entries(manifest.wasm.files)) {
  assert.equal(hash(await readFile(new URL(`examples/vendor/kaspa/${name}`, root))), expected, `WASM file changed: ${name}`);
}
for (const [name, expected] of Object.entries(manifest.artifacts)) {
  const file = await readFile(new URL(`artifacts/${name}`, root));
  const artifact = JSON.parse(file);
  assert.equal(hash(file), expected.fileSha256, `Artifact file changed: ${name}`);
  assert.equal(hash(Buffer.from(artifact.script)), expected.scriptSha256, `Artifact script changed: ${name}`);
  assert.match(expected.sourceSha256, SHA256, `Artifact source is not committed: ${name}`);
  assert.match(expected.constructorArgsSha256, SHA256, `Artifact constructor is not committed: ${name}`);
  assert.equal(hash(JSON.stringify(artifact.abi)), expected.abiSha256, `Artifact ABI changed: ${name}`);
  assert.equal(artifact.generation?.silverscript_tag, manifest.compiler.tag, `Compiler tag changed: ${name}`);
  assert.equal(artifact.generation?.silverscript_commit, manifest.compiler.commit, `Compiler commit changed: ${name}`);
  assert.equal(artifact.generation?.silverscript_tree, manifest.compiler.tree, `Compiler tree changed: ${name}`);
  assert.equal(artifact.generation?.compiler_build, expected.compilerBuild, `Compiler build changed: ${name}`);
}
console.log('WASM, contract provenance, and packaged artifacts match the compatibility manifest.');
