import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { blake3 } from '@noble/hashes/blake3';
import { createKcomClaimPsktBuilder, createKcomClaimTn10ProofPolicy,
  kcomClaimCodec, kcomVestingCodec } from '../dist/index.js';
import { loadPinnedKaspaWasm } from './load-kaspa-wasm.mjs';

const artifact = name => JSON.parse(readFileSync(new URL(`../artifacts/${name}`, import.meta.url)));
const graph = artifact('KCOMClaimGraph.artifact.json');
const opening = artifact('KCOMClaimOpen.artifact.json');
const vesting = artifact('KCOMVesting.artifact.json');
const vector = JSON.parse(readFileSync(new URL('./fixtures/kcom-claim-script-vectors.json', import.meta.url)));
const scenario = JSON.parse(readFileSync(new URL('./fixtures/kcom-claim-initialization-vector.json', import.meta.url)));

test('fast TN10 artifacts are separate from the production graph and vesting', () => {
  assert.equal(graph.id, '988b773c14ff9e48ca1f92ed0b5d2bd2ce18976785c7442af44c2b8723607433');
  assert.equal(opening.id, '2201127f5998a97f2a21f167af0d536b9a292f326f11d5fb0a501ce9bcdf4016');
  assert.equal(vesting.id, '52fdb903011d5f87e67470b6fbb745bb98998834ab5fb4ad1895b0619bfffe16');
  assert.equal(kcomClaimCodec({ graph, opening }).openingArtifactId, opening.id);
  assert.equal(kcomVestingCodec(vesting).artifactId, vesting.id);
});

test('fast Long availability starts at minute ten and closes after minute forty-five', () => {
  const tge = 1_800_000_000_000n;
  const state = { token_id: '11'.repeat(32), beneficiary: '22'.repeat(32), beneficiary_scheme: 0,
    extension: '33'.repeat(32), total: '360', released: '0', tier: '3', tge_ms: String(tge),
    token_prefix_len: '1', token_suffix_len: '25264', token_template_hash: '44'.repeat(32) };
  const codec = kcomVestingCodec(vesting);
  assert.equal(codec.availability(state, tge + 9n * 60_000n).releasable, 0n);
  assert.equal(codec.availability(state, tge + 10n * 60_000n).releasable, 10n);
  assert.equal(codec.availability(state, tge + 45n * 60_000n).releasable, 360n);
});

test('the fast builder constructs a signed-source initializer for its own artifact', async () => {
  const kw = await loadPinnedKaspaWasm(process.env.SNAPSHOT_TEST_WASM);
  const termsHex = scenario.termsPreimageHex.slice(0, -64) + vesting.id;
  const initState = { ...vector.factoryState,
    closes_ms: String(BigInt(vector.factoryState.opens_ms) + 3_600_000n),
    terms_hash: Buffer.from(blake3(Buffer.from(termsHex, 'hex'))).toString('hex') };
  delete initState.next_shard;
  delete initState.opened;
  const policy = createKcomClaimTn10ProofPolicy({ network: 'testnet-10',
    tokenId: vector.tokenId, campaignBudgetRaw: vector.budgetRaw });
  const manifest = policy.buildManifest({ campaignId: vector.campaign, tokenId: vector.tokenId,
    provenance: { materializationHash: '11'.repeat(32), membershipSnapshotHash: '22'.repeat(32),
      integrityManifestHash: '33'.repeat(32), sourceManifestHashes: ['44'.repeat(32)],
      cutoffMs: '1794700800000' }, entitlements: scenario.leaves.map(x => ({
        authority: x.authority, baseEntitlementRaw: x.baseEntitlementRaw })) });
  assert.equal(manifest.root, initState.eligibility_root);
  const pair = kw.Keypair.random(), address = pair.toAddress('testnet-10').toString();
  const funding = { outpoint: { transactionId: 'd1'.repeat(32), index: 0 }, amount: 2_000_000_000n,
    scriptPublicKey: kw.payToAddressScript(address), covenantId: null,
    entry: { covenantId: null }, blockDaaScore: 1n, isCoinbase: false };
  const rpc = { connect: async () => {}, disconnect: async () => {},
    getUtxosByAddresses: async () => ({ entries: [funding] }) };
  const builder = createKcomClaimPsktBuilder({ wasm: kw, artifacts: {
    'KCOMClaimGraph.artifact.json': graph, 'KCOMClaimOpen.artifact.json': opening },
    rpcClientFactory: () => rpc });
  const result = await builder({ schema: 'kcc20-in-process-pskt-builder-input/v1', request: {
    builderKey: 'kcom-claim.deploy-initializer', network: 'testnet-10',
    owner: { walletAddress: address }, params: { initState, termsHex,
      eligibilityManifest: manifest, expectedManifestContentHash: manifest.contentHash,
      initializerValueSompi: '600000000' } } });
  assert.equal(result.submitTransactionSupported, true);
  const tx = kw.Transaction.deserializeFromSafeJSON(result.psktTransactionJson);
  assert.equal(tx.outputs[0].scriptPublicKey.script,
    kw.payToScriptHashScript(kcomClaimCodec({ graph, opening }).script('KCOMInitialize', initState)).script);
  assert.equal(tx.outputs[0].value, 600_000_000n);
});
