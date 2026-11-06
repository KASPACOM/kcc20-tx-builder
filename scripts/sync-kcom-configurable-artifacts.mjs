import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const source = process.env.KCOM_CONTRACTS_DIR;
assert(source, 'KCOM_CONTRACTS_DIR required');
const root = new URL('../',import.meta.url);
const folder = resolve(source,'wallet-lab/vendor/kcom-configurable-v2');
const metadata = JSON.parse(readFileSync(resolve(folder,'build.json')));
assert.equal(metadata.compiler,'9a9f4b107116d0b259fae629f200fa3b663e7e9d');
const pins = {};
let linked;
for (const [sub,name] of [['vesting','KCOMVestingV2'],['graph','KCOMClaimGraphV2'],['initializer','KCOMClaimOpenV2']]) {
  const bytes = readFileSync(resolve(folder,sub,'artifact.json'));
  const a = JSON.parse(bytes);
  assert.equal(a.id,metadata[sub]);
  pins[sub] = {id:a.id,abiSha256:createHash('sha256').update(JSON.stringify(a.sil_abi)).digest('hex')};
  if (sub === 'graph') linked = Object.fromEntries(a.argent.template_plan.templates.filter(e => ['KCOMFactory','KCOMVault'].includes(e.actor)).map(e => [e.actor,Buffer.from(e.actor_type_handle.template.hash).toString('hex')]));
  writeFileSync(new URL(`artifacts/${name}.artifact.json`,root),bytes);
}
writeFileSync(new URL('src/kcom-configurable-pins.ts',root),`// Generated from the pinned Argent configurable-v2 artifact package.\nexport const KCOM_V2_PINS = ${JSON.stringify(pins,null,2)} as const;\nexport const KCOM_V2_LINKED_GENESIS_HASHES = ${JSON.stringify(linked,null,2)} as const;\n`);
