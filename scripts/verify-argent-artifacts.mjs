import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const required = ['KCOMClaimGraph.artifact.json', 'KCOMClaimOpen.artifact.json', 'KCOMVesting.artifact.json'];

export async function verifyArgentArtifacts(root, manifest) {
  const pin = manifest.argent;
  assert.ok(pin, 'KCOM Argent provenance missing');
  assert.deepEqual(Object.keys(pin.artifacts).sort(), required, 'KCOM artifact coverage differs');
  assert.match(pin.contractsCommit, /^[0-9a-f]{40}$/);
  assert.equal(pin.compiler.commit, '9a9f4b107116d0b259fae629f200fa3b663e7e9d', 'Argent compiler pin changed');
  const lockBytes = await readFile(new URL(pin.toolchainPath, root));
  assert.equal(hash(lockBytes), pin.toolchainSha256, 'Argent toolchain changed');
  assert.deepEqual(JSON.parse(lockBytes).argent, pin.compiler, 'Argent compiler provenance differs');
  for (const [module, source] of Object.entries(pin.sources)) {
    assert.equal(hash(await readFile(new URL(source.path, root))), source.sha256, `Argent source changed: ${module}`);
  }
  for (const [name, expected] of Object.entries(pin.artifacts)) {
    const bytes = await readFile(new URL(`artifacts/${name}`, root));
    const artifact = JSON.parse(bytes);
    assert.equal(hash(bytes), expected.fileSha256, `Argent artifact changed: ${name}`);
    assert.equal(artifact.id, expected.artifactId);
    assert.equal(hash(JSON.stringify(artifact.sil_abi)), expected.abiSha256, `Argent ABI changed: ${name}`);
    assert.deepEqual(artifact.generator, expected.generator);
    assert.equal(artifact.sil_abi.compiler_version, expected.compilerVersion);
    assert.equal(artifact.root, expected.root);
    assert.deepEqual(artifact.modules, expected.modules);
    assert.deepEqual(artifact.dependencies, expected.dependencies);
    assert.ok(artifact.modules.includes(artifact.root));
    for (const module of artifact.modules) assert.ok(pin.sources[module], `Unpinned Argent module: ${module}`);
    assert.deepEqual(Object.keys(artifact.sil_abi.contracts).sort(), Object.keys(expected.contracts).sort());
    for (const [actor, contract] of Object.entries(artifact.sil_abi.contracts)) {
      const checked = expected.contracts[actor];
      assert.equal(hash(Buffer.from(contract.compiled.bytecode)), checked.scriptSha256, `Argent script changed: ${actor}`);
      assert.equal(hash(JSON.stringify(contract.runtime_state)), checked.runtimeStateSha256, `Argent constructor schema changed: ${actor}`);
      assert.equal(checked.constructorMode, 'runtime-state');
      assert.equal(Buffer.from(contract.compiled.template_hash).toString('hex'), checked.templateHash);
    }
  }
}
