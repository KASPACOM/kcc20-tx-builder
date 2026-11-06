// Synchronize independent Argent execution receipts, never builder-generated expected outputs.
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
const root = new URL('../',import.meta.url);
const read = url => JSON.parse(readFileSync(url));
const receipt = process.env.KCOM_CAMPAIGN_RECEIPT;
const fixtures = process.env.KCOM_CAMPAIGN_FIXTURES;
assert(receipt && fixtures,'KCOM_CAMPAIGN_RECEIPT and KCOM_CAMPAIGN_FIXTURES required');
const y = read(receipt).scenarios['tn10-proof-mixed'];
const f = read(fixtures).scenarios['tn10-proof-mixed'];
let x = read(new URL('test/fixtures/kcom-claim-script-vectors.json',root));
x = JSON.parse(JSON.stringify(x).replaceAll(x.graphId,y.campaignCovenantId).replaceAll(x.termsHash,f.termsHash));
x.termsHex = f.termsPreimageHex;
const acts = y.graph.filter(row => row.operation.startsWith('activate-'));
for (const [name,row] of [['firstActivation',acts[0]],['lastActivation',acts.at(-1)]]) {
  for (const key of ['inputs','outputs','allocationRaw','sourceTransactionId','sourceEntitlementTransactionId']) x[name][key] = row[key];
  x[name].positionId = row.positionCovenantId;
}
x.outputs.initialize.outputs = y.graph.find(row => row.operation === 'initialize').outputs.map(o=>o.scriptPublicKeyHex);
writeFileSync(new URL('test/fixtures/kcom-configurable-script-vectors.json',root),JSON.stringify(x,null,2)+'\n');
writeFileSync(new URL('test/fixtures/kcom-configurable-initialization-vector.json',root),JSON.stringify({leaves:f.leaves,termsPreimageHex:f.termsPreimageHex},null,2)+'\n');
