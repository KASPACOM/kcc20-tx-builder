import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('docs/COMPATIBILITY.json', root)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [name, expected] of Object.entries(manifest.wasm.files)) {
  assert.equal(hash(await readFile(new URL(`examples/vendor/kaspa/${name}`, root))), expected, `WASM file changed: ${name}`);
}
for (const [name, expected] of Object.entries(manifest.artifacts)) {
  const file = await readFile(new URL(`artifacts/${name}`, root));
  assert.equal(hash(file), expected.fileSha256, `Artifact file changed: ${name}`);
  assert.equal(hash(Buffer.from(JSON.parse(file).script)), expected.scriptSha256, `Artifact script changed: ${name}`);
}
console.log('WASM and packaged artifact checksums match the compatibility manifest.');
