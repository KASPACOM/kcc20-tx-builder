import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { blake3 } from '@noble/hashes/blake3';
import * as kw from '../examples/vendor/kaspa/kaspa.js';
import { createKcc20PsktBuilderEngine, prepareKcc20FeeMarketGenesis,
  prepareKcc20FeeMarketAsk, prepareKcc20FeeMarketBid, templateParts } from '../dist/index.js';
kw.initSync({module: readFileSync(new URL('../examples/vendor/kaspa/kaspa_bg.wasm', import.meta.url))});
const names = { receipt:'KCC20FeeEscrowV1', root:'KCC20OrderbookFeeRootV1',
  holder:'KCC20OrderbookFeeHolderV1', ask:'KCC20OrderbookFeeAskV1', bid:'KCC20OrderbookFeeBidV1',
  ticket:'KCC20FeeTicket', wrapper:'KCC20WrapperFeeV1', argentWrapper:'KCC20WrapperFeeArgentV2' };
const artifacts = Object.fromEntries(Object.entries(names).map(([role,name])=>[role,
  JSON.parse(readFileSync(new URL(`../artifacts/${name}.placeholder.json`,import.meta.url)))]));
const artifactMap = Object.fromEntries(Object.entries(names).map(([role,name])=>[name+'.placeholder.json',artifacts[role]]));
const hex = b=>Buffer.from(b).toString('hex');
const network='testnet-10', tokenId='01'.repeat(32), marketId='02'.repeat(32);
const wallet = n=>{ const key=new kw.PrivateKey(n.toString(16).padStart(64,'0'));return {key,owner:key.toKeypair().xOnlyPublicKey.toString(),address:key.toAddress(network).toString()};};
const seller=wallet(3),buyer=wallet(4),matcher=wallet(5);
function payoutHash(a) {const spk=kw.payToAddressScript(a.address),script=Buffer.from(spk.script,'hex'),bytes=Buffer.alloc(11+script.length);bytes[0]=0xe3;bytes.writeUInt16LE(Number(spk.version),1);bytes.writeBigUInt64LE(BigInt(script.length),3);script.copy(bytes,11);return hex(blake3(bytes));}
function fixture({askAmount=2n,bidAmount=2n,bps=100,wrapperProfile='native',limit='500000000'}={}) {
  const policy={version:1,creatorFeeBps:bps,protocolAccountId:'04'.repeat(32),creatorAccountId:(bps?'05':'00').repeat(32),
    ...Object.fromEntries(['receipt','root','holder','ask','bid','ticket'].map(role=>{const p=templateParts(artifacts[role]);return [role+'Template',{hash:hex(p.hash),prefixLength:p.prefixLength,suffixLength:p.suffixLength}];}))};
  const common={tokenId,marketId,feeTicketId:'00'.repeat(32),priceScale:1n,policy,wrapperProfile,artifacts};
  const askPlan=prepareKcc20FeeMarketAsk({...common,owner:seller.owner,ownerScheme:0,payoutScriptHash:payoutHash(seller),holderAmount:askAmount,askAmount,askUnitPrice:300000000n});
  const bidPlan=prepareKcc20FeeMarketBid({...common,rootOwner:seller.owner,rootOwnerScheme:0,rootPayoutScriptHash:payoutHash(seller),buyer:buyer.owner,buyerScheme:0,buyerPayoutScriptHash:payoutHash(buyer),bidAmount,bidUnitPrice:400000000n});
  const entry=(script,amount,id,covenantId=marketId)=>({outpoint:{transactionId:id.repeat(32),index:0},amount,scriptPublicKey:kw.payToScriptHashScript(script.redeemScript),blockDaaScore:0n,isCoinbase:false,covenantId});
  const askEntry=entry(askPlan.ask,200000000n,'0a'),bidEntry=entry(bidPlan.bid,bidAmount*400000000n+100000000n,'0b');
  const funding={outpoint:{transactionId:'0c'.repeat(32),index:0},amount:10000000000n,scriptPublicKey:kw.payToAddressScript(matcher.address),blockDaaScore:0n,isCoinbase:false};
  const row=(e,state)=>({txidHex:e.outpoint.transactionId,vout:0,address:kw.addressFromScriptPublicKey(e.scriptPublicKey,network).toString(),amountSompiExact:e.amount.toString(),state});
  const ask=row(askEntry,askPlan.askState),bid=row(bidEntry,bidPlan.bidState);
  const request={schema:'kcc20-in-process-pskt-builder-input/v1',request:{builderKey:'kcc20orderbook.matcher-settle-crossed',network,owner:{walletAddress:matcher.address,kcc20Owner:matcher.owner},params:{canonicalTokenId:tokenId,wrappedMarketId:marketId,activeAskOrderUtxo:ask,activeBidOrderUtxo:bid,maxFeeSompi:limit}}};
  const submitted=[];
  const engine=createKcc20PsktBuilderEngine({wasm:kw,artifacts:artifactMap,allowBackendOnly:true,
    config:{KCC20_WRAPPER_OPERATOR_PRIVATE_KEY:'05'.padStart(64,'0')},
    rpcClientFactory:()=>({connect:async()=>{},disconnect:async()=>{},getUtxosByAddresses:async({addresses})=>({entries:addresses.includes(matcher.address)?[funding]:[askEntry,bidEntry]}),submitTransaction:async({transaction})=>{submitted.push(transaction);return {transactionId:'0d'.repeat(32)};}})});
  return {engine,request,submitted,askEntry,bidEntry,funding,ask,bid};
}
for (const [askAmount,bidAmount] of [[2n,2n],[3n,2n],[2n,3n]]) {
  for (const bps of [0,100,500]) test(`fee cross ${askAmount} asks / ${bidAmount} bids at ${bps} creator bps preserves payouts`,async()=>{
    const f=fixture({askAmount,bidAmount,bps});const b=await f.engine.build(f.request);
    assert.equal(f.submitted.length,1);
    if (process.env.FEE_CROSS_FIXTURE_DIR && bps === 100) {
      const raw=JSON.parse(b.psktTransactionJson);
      const tx={transaction_id:b.submittedTxidHex,inputs:raw.inputs.map((i,n)=>({previous_outpoint_hash:i.transactionId,previous_outpoint_index:String(i.index),previous_outpoint_amount:String([f.askEntry,f.bidEntry,f.funding][n].amount),previous_outpoint_script:[f.askEntry,f.bidEntry,f.funding][n].scriptPublicKey.script,signature_script:i.signatureScript})),outputs:raw.outputs.map((o,index)=>({index,amount:String(o.value),script_public_key:o.scriptPublicKey.slice(4),covenant_id:o.covenant?.covenantId,covenant_authorizing_input:o.covenant?.authorizingInput}))};
      for(const i of tx.inputs)i.previous_outpoint_amount=Number(i.previous_outpoint_amount);
      for(const o of tx.outputs)o.amount=Number(o.amount);
      writeFileSync(process.env.FEE_CROSS_FIXTURE_DIR+`/signed-cross-${askAmount}-${bidAmount}.json`,JSON.stringify({marketId,ask:f.ask.state,bid:f.bid.state,transaction:tx},null,2)+'\n');
    }

    const tx=JSON.parse(b.psktTransactionJson), m=b.metadata;
    assert.equal(m.protocolFeeSompi,'50000000');assert.equal(m.creatorFeeSompi,bps?'50000000':'0');
    assert.equal(tx.inputs.length,3);assert.equal(m.feeTicketApplied,false);
    assert.equal(BigInt(tx.outputs[m.sellerOutputIndex].value),600000000n+(askAmount===2n?f.askEntry.amount:0n));
    assert.equal(BigInt(tx.outputs[m.refundOutputIndex].value),200000000n);
    assert.equal(BigInt(tx.outputs[0].value),bidAmount===2n?100000000n:50000000n);
    assert.equal(BigInt(tx.outputs[m.feeOutputIndex].value),bps?100000000n:50000000n);
    assert.equal(m.askOutputIndex>=0,askAmount>2n);assert.equal(m.bidOutputIndex>=0,bidAmount>2n);
    if(m.askOutputIndex>=0)assert.equal(BigInt(tx.outputs[m.askOutputIndex].value),f.askEntry.amount);
    if(m.bidOutputIndex>=0){assert.equal(BigInt(tx.outputs[m.bidOutputIndex].value),500000000n);assert.equal(tx.outputs[m.bidOutputIndex].covenant.authorizingInput,1);}
    assert.equal(tx.outputs[m.feeOutputIndex].covenant.authorizingInput,0);
    const outputTotal=tx.outputs.reduce((s,o)=>s+BigInt(o.value),0n);
    assert.equal(f.askEntry.amount+f.bidEntry.amount+f.funding.amount-outputTotal,BigInt(m.networkFeeSompi));
    assert.equal(BigInt(m.matcherDebitSompi),BigInt(m.protocolFeeSompi)+BigInt(m.creatorFeeSompi)+BigInt(m.networkFeeSompi)+(bidAmount>2n?50000000n:0n));
    assert(tx.inputs[2].signatureScript.length>100);assert(BigInt(m.signedMass.compute)<=450000n);
  });
}
test('fee cross does not submit when matcher budget excludes creator or network costs',async()=>{
  const f=fixture({limit:'100000000'});await assert.rejects(()=>f.engine.build(f.request),e=>e.builderErrorCode==='MATCHER_FEE_EXCEEDS_MAX');assert.equal(f.submitted.length,0);
});
test('fee cross rejects tickets and policy disagreement before submission',async()=>{
  const f=fixture();f.request.request.params.activeFeeTicketUtxo={};await assert.rejects(()=>f.engine.build(f.request),/cannot use a FeeTicket/);delete f.request.request.params.activeFeeTicketUtxo;
  f.bid.state.feePolicy='00';await assert.rejects(()=>f.engine.build(f.request),/differ in feePolicy/);assert.equal(f.submitted.length,0);
});
test('fee cross rejects spent or changed node order principal',async()=>{
 const f=fixture();f.bidEntry.amount++;await assert.rejects(()=>f.engine.build(f.request),/differs from live node/);assert.equal(f.submitted.length,0);
});

test('fee cross requires an explicit positive matcher budget', async()=>{
  for(const limit of [undefined,'0']) {const f=fixture();f.request.request.params.maxFeeSompi=limit;
    await assert.rejects(()=>f.engine.build(f.request),/maxFeeSompi/);assert.equal(f.submitted.length,0);}
});
test('fee cross rejects wrong live lineage, script and committed payout', async()=>{
  const lineage=fixture();lineage.bidEntry.covenantId='ff'.repeat(32);
  await assert.rejects(()=>lineage.engine.build(lineage.request),/covenant|market/i);assert.equal(lineage.submitted.length,0);
  const script=fixture();script.bidEntry.scriptPublicKey=kw.payToAddressScript(buyer.address);
  await assert.rejects(()=>script.engine.build(script.request),/differs from live node/);assert.equal(script.submitted.length,0);
  const payout=fixture();payout.ask.state.payout_script_hash='ff'.repeat(32);
  await assert.rejects(()=>payout.engine.build(payout.request),/payout differs/);assert.equal(payout.submitted.length,0);
});

test('fee cross accepts indexer annotations without treating them as runtime fields', async()=>{
  const f=fixture({askAmount:3n,bidAmount:2n});
  for(const order of [f.ask,f.bid]) Object.assign(order.state,{feePolicyVersion:1,creatorFeeBps:100,ownerScheme:0});
  const result=await f.engine.build(f.request);
  assert.equal(f.submitted.length,1);
  assert.equal(result.metadata.tokenAmount,'2');
  assert.equal(result.metadata.protocolFeeSompi,'50000000');
});

const argentCrosses=[];
for(const [askAmount,bidAmount] of [[2n,2n],[3n,2n],[2n,3n]])test(`Argent cross ${askAmount}/${bidAmount} keeps matcher funded protocol fee`,async()=>{
 const f=fixture({askAmount,bidAmount,bps:0,wrapperProfile:'argent'}),b=await f.engine.build(f.request);
 assert.equal(f.submitted.length,1);assert.equal(b.metadata.protocolFeeSompi,'50000000');assert.equal(b.metadata.creatorFeeSompi,'0');
 argentCrosses.push({name:`argent-cross-${askAmount}-${bidAmount}`,profileId:'argent-fee',count:2,covenantIds:[marketId,marketId,null],signedTransaction:JSON.parse(b.psktTransactionJson),built:{metadata:{covenantId:marketId}}});
 if(process.env.ARGENT_FEE_EVIDENCE){mkdirSync(process.env.ARGENT_FEE_EVIDENCE,{recursive:true});writeFileSync(process.env.ARGENT_FEE_EVIDENCE+'/argent-cross-transactions.json',JSON.stringify(argentCrosses,null,2));}
});
