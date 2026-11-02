import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as kw from '../examples/vendor/kaspa/kaspa.js';
import { buildKcc20InitialFeeRecipient, buildKcc20InitialFeeAccount, buildKcc20FeeEscrowScript,
  createKcc20PsktBuilderEngine } from '../dist/index.js';
kw.initSync({module:readFileSync(new URL('../examples/vendor/kaspa/kaspa_bg.wasm',import.meta.url))});
const names=['KCC20FeeEscrowV1','KCC20FeeRecipientV1','KCC20OrderbookFeeRootV1','KCC20OrderbookFeeHolderV1',
  'KCC20OrderbookFeeAskV1','KCC20OrderbookFeeBidV1','KCC20FeeTicket','KCC20WrapperFeeV1','KCC20WrapperFeeArgentV1'];
const artifacts=Object.fromEntries(names.map(n=>[n+'.placeholder.json',JSON.parse(readFileSync(new URL('../artifacts/'+n+'.placeholder.json',import.meta.url)))]));
const escrow=artifacts['KCC20FeeEscrowV1.placeholder.json'],recipient=artifacts['KCC20FeeRecipientV1.placeholder.json'];
const id=n=>n.toString(16).padStart(2,'0').repeat(32),zero=id(0),tokenId=id(1),marketId=id(2),policyId=id(3);
const protocolAccountId=id(4),creatorAccountId=id(5),recipientId=id(6);
const key=new kw.PrivateKey('03'.padStart(64,'0')),owner=key.toKeypair().xOnlyPublicKey.toString(),wallet=key.toAddress('testnet-10').toString();
const evidence=[];
function fixture(count=1,party='creator',other=true){
  const r=buildKcc20InitialFeeRecipient({artifact:recipient,tokenId,marketId,policyId,ownerSchnorrPublicKey:owner,principalSompi:70000000n});
  const a=buildKcc20InitialFeeAccount({artifact:escrow,tokenId,ownerSchnorrPublicKey:owner,principalSompi:60000000n});
  const state={...a.state,market:marketId,policy:policyId,owner:recipientId,owner_scheme:4,
    guard_template:r.recipientTemplate.hash,guard_prefix:String(r.recipientTemplate.prefixLength),guard_suffix:String(r.recipientTemplate.suffixLength)};
  const account=buildKcc20FeeEscrowScript(escrow,state);
  const receiptState={...a.state,role:'0',market:marketId,policy:policyId,owner:zero,
    protocol_account:protocolAccountId,creator_account:creatorAccountId,
    protocol_amount:party==='protocol'||other?'50000000':'0',creator_amount:party==='creator'||other?'50000000':'0'};
  const receipt=buildKcc20FeeEscrowScript(escrow,receiptState);
  const covenantEntries=[];
  const hint=(script,s,cid,txid,amount,roleName)=>{
    const spk=kw.payToScriptHashScript(script.redeemScript);
    covenantEntries.push({outpoint:{transactionId:txid,index:0},amount,scriptPublicKey:spk,blockDaaScore:0n,isCoinbase:false,covenantId:cid});
    return {address:kw.addressFromScriptPublicKey(spk,'testnet-10').toString(),txidHex:txid,vout:0,covenantIdHex:cid,
      scriptHashHex:script.scriptHash,amountSompiExact:String(amount),status:'active',state:{...s,roleName}};
  };
  const receipts=Array.from({length:count},(_,i)=>hint(receipt,receiptState,marketId,id(10+i),other?100000000n:50000000n,'receipt'));
  const indexedAccount=hint(account,state,party==='protocol'?protocolAccountId:creatorAccountId,id(20),60000000n,'account');
  const indexedRecipient=hint(r,r.state,recipientId,id(21),70000000n,'recipient');
  const funding={outpoint:{transactionId:id(22),index:0},amount:1000000000n,scriptPublicKey:kw.payToAddressScript(wallet),blockDaaScore:0n,isCoinbase:false};
  const request={schema:'kcc20-in-process-pskt-builder-input/v1',request:{builderKey:'kcc20fee.claim',network:'testnet-10',owner:{walletAddress:wallet,kcc20Owner:owner},
    params:{contractCanonicalTokenId:tokenId,marketId,policyId,protocolAccountId,creatorAccountId,party,receipts,account:indexedAccount,recipient:indexedRecipient}}};
  const engine=createKcc20PsktBuilderEngine({wasm:kw,artifacts,rpcClientFactory:()=>({connect:async()=>{},disconnect:async()=>{},
    getUtxosByAddresses:async({addresses})=>({entries:addresses.includes(wallet)?[funding]:covenantEntries})})});
  return {request,engine,covenantEntries,funding};
}
function sign(built, mutate = () => {}){
  const tx=kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  mutate(tx);
  for(const hint of built.scripts){
    let sig=kw.createInputSignature(tx,hint.inputIndex,key,kw.SighashType.All);
    if(sig.length===132&&sig.startsWith('41'))sig=sig.slice(2);
    const b=new kw.ScriptBuilder({flags:{covenantsEnabled:true}});
    for(const arg of hint.signatureScript.args){
      if(arg.type==='i64')b.addI64(BigInt(arg.value));
      else if(arg.type==='byte')b.addData(Uint8Array.of(arg.value));
      else if(arg.type==='signature')b.addData(Buffer.from(sig,'hex'));
      else if(arg.type==='data')b.addData(Buffer.from(arg.hex,'hex'));
      else throw Error(arg.type);
    }
    tx.inputs[hint.inputIndex].signatureScript=kw.ScriptBuilder.fromScript(Buffer.from(hint.scriptHex,'hex'),{flags:{covenantsEnabled:true}}).encodePayToScriptHashSignatureScript(b.drain());
  }
  for(const input of built.signInputs)tx.inputs[input.index].signatureScript=kw.createInputSignature(tx,input.index,key,kw.SighashType.All);
  return tx;
}
for(const count of [1,2,3,4,5])for(const party of ['protocol','creator'])for(const other of [true,false]){
  test(`signed recipient claim ${party}, ${count} receipts, retained=${other}`,async()=>{
    const f=fixture(count,party,other),built=await f.engine.build(f.request),tx=sign(built),json=JSON.parse(tx.serializeToSafeJSON());
    assert.equal(built.metadata.claimSompi,String(count*50000000));
    assert.equal(json.outputs[1].value,'60000000');
    assert.equal(json.outputs[built.metadata.recipientOutputIndex].value,'70000000');
    assert.equal(json.outputs[built.metadata.recipientOutputIndex].covenant.authorizingInput,count+1);
    assert.equal(built.scripts.length,1);assert.equal(built.scripts[0].inputIndex,count+1);
    assert.equal(built.metadata.remainderSompi,String(other?count*50000000:0));
    const mass=f.engine.protocol.calculateToccataV1NonContextualMass(tx,'delegated claim');
    const storage=f.engine.protocol.calculateToccataStorageMass(tx,'delegated claim');
    assert(mass.computeMass<=450000n);assert(mass.transientMass<=900000n);assert(storage<=450000n);
    const inputTotal=f.covenantEntries.reduce((s,e)=>s+e.amount,f.funding.amount),outputTotal=json.outputs.reduce((s,o)=>s+BigInt(o.value),0n);
    assert(inputTotal-outputTotal>=mass.transactionMass*100n);
    const e={name:`recipient-${party}-${count}-${other}`,profileId:'fee-recipient',count:count+2,
      covenantIds:f.covenantEntries.map(e=>e.covenantId).concat([null]),signedTransaction:json,built:{metadata:{covenantId:marketId}}};
    evidence.push(e);
    if(count===1&&other){
      const bad=structuredClone(e);bad.name+='-diverted-remainder';bad.expectFailure=true;
      const diverted=sign(built,t=>{t.outputs[2].scriptPublicKey=kw.payToAddressScript(wallet)});
      bad.signedTransaction=JSON.parse(diverted.serializeToSafeJSON());
      // Fresh signatures stay valid. Only the receipt covenant must reject.
      bad.expectedFailureInputs=[0];evidence.push(bad);
    }
    if(process.env.RECIPIENT_EVIDENCE){mkdirSync(process.env.RECIPIENT_EVIDENCE,{recursive:true});writeFileSync(process.env.RECIPIENT_EVIDENCE+'/recipient-transactions.json',JSON.stringify(evidence,null,2));}
  });
}
test('recipient creation returns a live-verifiable genesis hint without changing account creation',async()=>{
  const f=fixture();f.request.request.builderKey='kcc20fee.create-recipient';f.request.request.params={tokenId,marketId,policyId,principalSompi:'70000000'};
  const b=await f.engine.build(f.request),tx=sign(b),j=JSON.parse(tx.serializeToSafeJSON());
  assert.equal(b.metadata.contract,'KCC20FeeRecipientV1');assert.equal(b.metadata.recipientGenesisHint.state.role,'2');
  assert.equal(b.metadata.recipientGenesisHint.state.market,marketId);assert.equal(j.outputs[0].value,'70000000');
  assert.equal(b.metadata.accountGenesisHint,undefined);assert.equal(b.metadata.recipientGenesisHint.covenantIdHex,j.outputs[0].covenant.covenantId);
});
test('delegated claims reject changed recipient node inputs before signing',async()=>{
  for(const change of [f=>f.covenantEntries.at(-1).amount++,f=>f.covenantEntries.at(-1).covenantId=id(30),
    f=>f.covenantEntries.at(-1).scriptPublicKey=kw.payToAddressScript(wallet),f=>f.request.request.params.recipient.state.owner=id(30)]){
    const f=fixture();change(f);await assert.rejects(()=>f.engine.build(f.request));
  }
});

test('recipient can rotate account back to a wallet while preserving both principals',async()=>{
  const f=fixture(),p=f.request.request.params;
  f.request.request.builderKey='kcc20fee.rotate-account';
  f.request.request.params={contractCanonicalTokenId:tokenId,marketId,policyId,accountId:creatorAccountId,
    account:p.account,recipient:p.recipient,newOwner:owner,newOwnerScheme:0};
  const built=await f.engine.build(f.request),tx=sign(built),j=JSON.parse(tx.serializeToSafeJSON());
  assert.equal(j.inputs.length,3);assert.equal(j.outputs[0].value,'60000000');assert.equal(j.outputs[1].value,'70000000');
  assert.equal(built.metadata.newOwnerScheme,0);assert.equal(built.scripts[0].inputIndex,1);
  assert.equal(built.signInputs[0].index,2);assert.equal(j.outputs[1].covenant.authorizingInput,1);
  const mass=f.engine.protocol.calculateToccataV1NonContextualMass(tx,'recipient rotation');
  assert(mass.computeMass<=450000n);assert(mass.transientMass<=900000n);
  assert(f.engine.protocol.calculateToccataStorageMass(tx,'recipient rotation')<=450000n);
  evidence.push({name:'recipient-rotation-back',profileId:'fee-recipient',count:2,
    covenantIds:[creatorAccountId,recipientId,null],signedTransaction:j,built:{metadata:{covenantId:creatorAccountId}}});
  if(process.env.RECIPIENT_EVIDENCE)writeFileSync(process.env.RECIPIENT_EVIDENCE+'/recipient-transactions.json',JSON.stringify(evidence,null,2));
});
