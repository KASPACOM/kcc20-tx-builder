import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as kw from '../examples/vendor/kaspa/kaspa.js';
import { BUNDLED_TOKEN_PROFILES, authenticateTokenArtifact, buildKcc20ScriptForState, requireTokenCapability, tokenPublicKeyHash, planTokenOwnerWitness, ownerNativeHolderUtxos } from '../dist/index.js';
kw.initSync({ module: readFileSync(new URL('../examples/vendor/kaspa/kaspa_bg.wasm', import.meta.url)) });
const profile = BUNDLED_TOKEN_PROFILES.profiles.find(p => p.id === 'kaspacom-kcc20-september2026-holder-v1');
assert(profile);
const artifact = authenticateTokenArtifact(profile, JSON.parse(readFileSync(new URL('../artifacts/' + profile.artifactKey, import.meta.url))));
// Captured DEV PACK2 genesis holder: f92c09074bf94d71172534bd3a3d868d86adb80d88365d4900ef8f1ac694f17e:10.
const state = {
  amount: 10000000000000n,
  owner: Buffer.from('51fb56d74326e9f92d4866907994cb6442791f71f2a1a2fee0d408f1cdfa28d1','hex'),
  ownerScheme: 0, borrowScheme: 0, borrowGuard: new Uint8Array(32),
  extensionCommitment: Buffer.from('8db2c2e8f6e6b702a7e4a1344fa1383d9d31cb340a90d6b037ea36d934e1b19a','hex'),
};
assert.equal(kw.addressFromScriptPublicKey(kw.payToScriptHashScript(buildKcc20ScriptForState(artifact, state)), 'testnet-10').toString(), 'kaspatest:pq0fctdr3s07mq49pft6gdg3kv0042csa928td6c5rwzj6trcvr72qup4nl8l');
requireTokenCapability(profile, 'transfer');
for (const operation of ['mint','burn','borrow','wrap','unwrap','trade']) assert.throws(() => requireTokenCapability(profile, operation), /does not support/);
console.log('PACK2 archived holder script matches captured DEV output; only transfers enabled');

const { blake3 } = await import('@noble/hashes/blake3');
const hashKey = new Uint8Array(32); hashKey.set(new TextEncoder().encode('PublicKeyHash'));
const publicKey = new Uint8Array(32).fill(7);
const owner = '494c1139020c5eb8c60691c12471d36a5bdf90d368d3f0f310e13d82dc321c15';
assert.equal(Buffer.from(blake3(publicKey, { key: hashKey })).toString('hex'), owner);
assert.equal(Buffer.from(tokenPublicKeyHash(publicKey, profile.standardRevision)).toString('hex'), owner);
assert.notEqual(Buffer.from(tokenPublicKeyHash(publicKey)).toString('hex'), owner);
assert.doesNotThrow(() => planTokenOwnerWitness({ profile, owner, ownerScheme: 1, publicKey: Buffer.from(publicKey).toString('hex'), capabilities: { schnorr: true, ecdsa: false }, role: 'leader' }));
assert.throws(() => planTokenOwnerWitness({ profile, owner: Buffer.from(tokenPublicKeyHash(publicKey)).toString('hex'), ownerScheme: 1, publicKey: Buffer.from(publicKey).toString('hex'), capabilities: { schnorr: true, ecdsa: false }, role: 'leader' }), /does not own/);

const candidate = { txidHex: '11'.repeat(32), vout: 0, state: { amount: '10', owner, ownerScheme: 1 } };
assert.equal(ownerNativeHolderUtxos([candidate], Buffer.from(publicKey).toString('hex'), profile.standardRevision).length, 1);
assert.equal(ownerNativeHolderUtxos([candidate], Buffer.from(publicKey).toString('hex')).length, 0);
