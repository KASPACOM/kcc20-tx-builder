import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blake3 } from '@noble/hashes/blake3';
import { buildKcc20InitialFeeRecipient, planKcc20FeeRecipientApproval } from '../dist/index.js';

const artifact = JSON.parse(readFileSync(new URL('../artifacts/KCC20FeeRecipientV1.placeholder.json', import.meta.url)));
const owner = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';
const id = n => n.toString(16).padStart(2, '0').repeat(32);
function fixture() {
  const initial = buildKcc20InitialFeeRecipient({ artifact, tokenId:id(1), marketId:id(2), policyId:id(3),
    ownerSchnorrPublicKey:owner, principalSompi:50000000n });
  const indexed = { txidHex:id(10), vout:2, covenantIdHex:id(4), scriptHashHex:initial.scriptHash,
    amountSompiExact:'50000000', status:'active', state:{ ...initial.state, roleName:'recipient' } };
  const live = { outpoint:{transactionId:id(10),index:2},amountSompi:50000000n,covenantIdHex:id(4),scriptPublicKey:initial.scriptPublicKey };
  const account = {outpoint:{transactionId:id(11),index:3},covenantId:id(5),principalSompi:50000000n,
    state:{...initial.state, role:'1', owner:id(4),owner_scheme:4,guard_template:initial.recipientTemplate.hash,
      guard_prefix:String(initial.recipientTemplate.prefixLength),guard_suffix:String(initial.recipientTemplate.suffixLength)}};
  const nextAccount = {...account.state,action_hash:id(9)};
  return {artifact,indexed,live,account,nextAccount,signingOwner:owner,action:1};
}

test('recipient approval commits to the exact account outpoint, claim and continuation', () => {
  const f=fixture(), p=planKcc20FeeRecipientApproval(f);
  const i64=n=>{const b=Buffer.alloc(8);b.writeBigInt64LE(BigInt(n));return b};
  const expected=blake3(Buffer.concat([Buffer.from('a1','hex'),Buffer.from(id(11),'hex'),i64(3),i64(1),
    Buffer.from(id(9)+id(4)+'04'+f.account.state.guard_template,'hex'),
    i64(f.account.state.guard_prefix),i64(f.account.state.guard_suffix)]));
  assert.equal(p.nextState.action_hash,Buffer.from(expected).toString('hex'));
  assert.equal(p.principalSompi,50000000n);
  assert.equal(p.nextState.owner,owner);
  assert.notEqual(p.currentRedeemScript.toString(),p.successorRedeemScript.toString());
  const changed=fixture();changed.nextAccount.action_hash=id(8);
  assert.notEqual(planKcc20FeeRecipientApproval(changed).nextState.action_hash,p.nextState.action_hash);
});

test('recipient hints cannot change wallet authority, account identity, live script or principal', () => {
  for(const change of [
    f=>f.signingOwner=id(7), f=>f.live.covenantIdHex=id(7), f=>f.live.amountSompi=49999999n,
    f=>f.indexed.state.market=id(7), f=>f.indexed.state.owner=id(7), f=>f.indexed.status='spent',
    f=>f.live.outpoint.index++,f=>f.live.scriptPublicKey.scriptHex='51',
    f=>f.account.state.guard_template=id(7), f=>f.account.state.owner_scheme=0,
    f=>f.nextAccount.owner=id(7), f=>f.nextAccount.action_hash=id(0),
    f=>f.nextAccount.market=id(7), f=>f.action=3,
  ]) {const f=fixture();change(f);assert.throws(()=>planKcc20FeeRecipientApproval(f));}
});

test('recipient artifact and initial identity are pinned',()=>{
  const input={artifact,tokenId:id(1),marketId:id(2),policyId:id(3),ownerSchnorrPublicKey:owner,principalSompi:50000000n};
  for(const changed of [{marketId:id(0)},{principalSompi:0n},{ownerSchnorrPublicKey:id(255)},
    {artifact:{...artifact,untrusted:true}}]) assert.throws(()=>buildKcc20InitialFeeRecipient({...input,...changed}));
});
