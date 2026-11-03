import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { verifyArgentArtifacts } from '../scripts/verify-argent-artifacts.mjs';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('docs/COMPATIBILITY.json', root)));

test('all three production Argent artifacts have checked provenance', async () => {
  await verifyArgentArtifacts(root, manifest);
  assert.equal(createHash('sha256').update(await readFile(new URL('artifacts/KCOMVesting.artifact.json', root))).digest('hex'),
    '096a5b5c76f0be3b0b4289028a245f9f52873cbf070e3fccbbb211860726314d');
});

test('missing coverage and altered compiler, source, ABI, bytecode or constructor pins fail', async () => {
  for (const mutate of [
    p => delete p.artifacts['KCOMVesting.artifact.json'],
    p => p.compiler.commit = '0'.repeat(40),
    p => p.sources[Object.keys(p.sources)[0]].sha256 = '0'.repeat(64),
    p => p.artifacts['KCOMVesting.artifact.json'].abiSha256 = '0'.repeat(64),
    p => p.artifacts['KCOMVesting.artifact.json'].contracts.KCOMVesting.scriptSha256 = '0'.repeat(64),
    p => p.artifacts['KCOMVesting.artifact.json'].contracts.KCOMVesting.runtimeStateSha256 = '0'.repeat(64),
  ]) {
    const changed = structuredClone(manifest);
    mutate(changed.argent);
    await assert.rejects(verifyArgentArtifacts(root, changed));
  }
});
