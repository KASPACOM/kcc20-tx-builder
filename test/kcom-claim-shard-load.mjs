import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { blake3 } from '@noble/hashes/blake3';
import { loadPinnedKaspaWasm } from './load-kaspa-wasm.mjs';
import { buildKcomClaimManifest, createKcomClaimProof, kcomClaimNullifier,
  createKcomClaimPsktBuilder, kcomClaimCodec } from '../dist/index.js';

const kw = await loadPinnedKaspaWasm(process.env.SNAPSHOT_TEST_WASM);
const artifact = name => JSON.parse(readFileSync(new URL(`../artifacts/${name}`, import.meta.url)));
const graph = artifact('KCOMClaimGraph.artifact.json');
const opening = artifact('KCOMClaimOpen.artifact.json');
const vector = JSON.parse(readFileSync(new URL('./fixtures/kcom-claim-script-vectors.json', import.meta.url)));
const selection = JSON.parse(readFileSync(new URL('./fixtures/kcom-claim-selection-vector.json', import.meta.url)));
const hex = n => BigInt(n).toString(16).padStart(64, '0');
const le32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const digest = (name, ...parts) => Buffer.from(blake3(Buffer.concat([
  Buffer.from(`kcom.claim.${name}/v1\0`), ...parts]))).toString('hex');
const campaign = hex(71), tokenId = vector.tokenId, budget = 10_000_000_000_000_000n;
const authorityKey = new kw.PrivateKey('04'.repeat(32));
const authorityId = String(authorityKey.toPublicKey().toXOnlyPublicKey());

function emptyUsedProof(leafCount, index) {
  let level = Array.from({ length: leafCount }, (_, at) =>
    digest('used.empty', Buffer.from(campaign, 'hex'), le32(at)));
  const siblings = [];
  for (let at = index; level.length > 1; at = Math.floor(at / 2)) {
    siblings.push(level[at ^ 1]);
    level = Array.from({ length: level.length / 2 }, (_, i) =>
      digest('used.node', Buffer.from(level[i * 2], 'hex'), Buffer.from(level[i * 2 + 1], 'hex')));
  }
  return { root: level[0], proof: siblings.join('') };
}

function manifestFor(count) {
  assert((count & (count - 1)) === 0 && count >= 2);
  const perLeaf = budget / 5n / BigInt(count);
  const entitlements = Array.from({ length: count }, (_, i) => ({
    authority: { scheme: 0, identifier: hex(i + 1000) },
    baseEntitlementRaw: String(perLeaf),
  }));
  entitlements[0].authority.identifier = authorityId;
  const input = { campaignId: campaign, tokenId,
    provenance: { materializationHash: hex(10), membershipSnapshotHash: hex(11),
      integrityManifestHash: hex(12), sourceManifestHashes: [hex(13)], cutoffMs: '1794700800000' },
    entitlements };
  const started = performance.now();
  const manifest = buildKcomClaimManifest(input);
  const index = manifest.leaves.findIndex(x => x.authority.identifier === authorityId);
  assert(index >= 0);
  return { manifest, proof: createKcomClaimProof(manifest, index), index,
    generatedMs: Math.round(performance.now() - started) };
}

async function measureSelection(count) {
  const { manifest, proof, index, generatedMs } = manifestFor(count);
  const used = emptyUsedProof(count, index);
  const route = Buffer.from(kcomClaimNullifier(campaign, proof.leaf.authority), 'hex').readUInt32LE(0) % 4;
  const state = { ...selection.step.before, campaign, token_id: tokenId,
    budget_raw: String(budget), manifest_total: manifest.totalBaseEntitlementRaw,
    eligibility_root: manifest.root, used_root: used.root, leaf_count: String(count),
    selected_count: '0', all_weight: '0', boosted_weight: '0', long_weight: '0',
    shard: String(route), shard_count: '4', first: vector.factoryState.first,
    second: vector.factoryState.second, third: vector.factoryState.third,
    opens_ms: vector.factoryState.opens_ms, closes_ms: vector.factoryState.closes_ms,
    tge_ms: vector.factoryState.tge_ms, closed: false };
  const codec = kcomClaimCodec({ graph, opening });
  const pair = kw.Keypair.random(), sponsorKey = new kw.PrivateKey(pair.privateKey);
  const sponsorAddress = pair.toAddress('testnet-10').toString();
  const shard = { outpoint: { transactionId: hex(81), index: 0 }, amount: 100_000_000n,
    scriptPublicKey: kw.payToScriptHashScript(codec.script('KCOMClaimShard', state)),
    covenantId: vector.graphId, entry: { covenantId: vector.graphId },
    blockDaaScore: 1n, isCoinbase: false };
  const sponsor = { outpoint: { transactionId: hex(82), index: 0 }, amount: 10_000_000_000n,
    scriptPublicKey: kw.payToAddressScript(sponsorAddress), covenantId: null,
    entry: { covenantId: null }, blockDaaScore: 1n, isCoinbase: false };
  const shardAddress = kw.addressFromScriptPublicKey(shard.scriptPublicKey, 'testnet-10').toString();
  const rpc = { connect: async () => {}, disconnect: async () => {},
    getUtxosByAddresses: async ([address]) => ({ entries: address === shardAddress ? [shard] :
      address === sponsorAddress ? [sponsor] : [] }) };
  const builder = createKcomClaimPsktBuilder({ wasm: kw, artifacts: {
    'KCOMClaimGraph.artifact.json': graph, 'KCOMClaimOpen.artifact.json': opening },
    rpcClientFactory: () => rpc });
  const params = { graphId: vector.graphId, shardState: state, shard: shard.outpoint,
    eligibilityProof: proof, authorityPublicKey: authorityId, tier: 3,
    beneficiary: { scheme: 0, identifier: authorityId }, unusedProof: used.proof };
  const request = extra => ({ schema: 'kcc20-in-process-pskt-builder-input/v1',
    request: { builderKey: 'kcom-claim.select', network: 'testnet-10',
      owner: { walletAddress: sponsorAddress }, params: { ...params, ...extra } } });
  const prepared = await builder(request({}));
  assert.equal(prepared.submitTransactionSupported, false);
  const unsigned = kw.Transaction.deserializeFromSafeJSON(prepared.psktTransactionJson);
  const signature = Buffer.from(String(kw.createInputSignature(unsigned, 0, authorityKey, kw.SighashType.All)), 'hex');
  assert.equal(signature[0], 65);
  const approval = { publicKey: authorityId, signature: signature.subarray(1).toString('hex') };
  const finalized = await builder(request({ authorityApproval: approval,
    expectedSigningCommitment: prepared.metadata.authoritySigning.signingCommitment }));
  assert.equal(finalized.submitTransactionSupported, true);
  const signed = kw.Transaction.deserializeFromSafeJSON(finalized.psktTransactionJson);
  signed.inputs[1].signatureScript = kw.createInputSignature(signed, 1, sponsorKey, kw.SighashType.All);
  const transactionMass = kw.calculateTransactionMass('testnet-10', signed);
  const maximumMass = kw.maximumStandardTransactionMass();
  assert(transactionMass <= maximumMass, `${count}-leaf selection exceeds standard mass`);
  return { count, proofDepth: proof.siblings.length, proofBytes: 32 * proof.siblings.length,
    generatedMs, transactionMass: String(transactionMass), maximumMass: String(maximumMass),
    shardSignatureScriptBytes: signed.inputs[0].signatureScript.length / 2,
    sponsorSignatureScriptBytes: signed.inputs[1].signatureScript.length / 2 };
}

const rows = [];
for (const count of [1024, 4096, 65536]) rows.push(await measureSelection(count));
assert(rows[1].proofDepth > rows[0].proofDepth);
assert(rows[2].proofDepth > rows[1].proofDepth);
function shardDistribution(wallets, shards) {
  const counts = Array(shards).fill(0);
  for (let i = 0; i < wallets; i++) {
    const authority = { scheme: 0, identifier: hex(i + 1000) };
    const route = Buffer.from(kcomClaimNullifier(campaign, authority), 'hex').readUInt32LE(0) % shards;
    counts[route]++;
  }
  return { wallets, shards, minPerShard: Math.min(...counts), maxPerShard: Math.max(...counts),
    meanPerShard: wallets / shards, emptyShards: counts.filter(x => x === 0).length,
    lockedShardKasSompiAtOneKasEach: String(BigInt(shards) * 100_000_000n) };
}
const distribution = [4, 16, 64, 256].map(shards => shardDistribution(4096, shards));
console.log(JSON.stringify({ schema: 'kcom-shard-load-local/v1', network: 'testnet-10',
  scope: 'signed synthetic first-selection transactions plus deterministic route distribution; no TN10 contention measurement',
  builderRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  rows, distribution }, null, 2));
