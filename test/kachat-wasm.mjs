import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as kw from '../examples/vendor/kaspa/kaspa.js';
import { buildKaChatPayload, kaChatSigningMessage, buildKaChatSelfSend, createKcc20PsktBuilderEngine } from '../dist/index.js';
kw.initSync({module:await readFile(new URL('../examples/vendor/kaspa/kaspa_bg.wasm',import.meta.url))});
// Public deterministic test key. Used only with synthetic outpoints, never broadcast.
const key=new kw.PrivateKey('03'.padStart(64,'0'));
const address=key.toAddress('testnet-10').toString();
const engine=createKcc20PsktBuilderEngine({wasm:kw,artifacts:{},config:{KASPA_NETWORK:'testnet-10'}});
const measure=transaction=>({...engine.protocol.calculateToccataV1NonContextualMass(transaction,'KaChat test'),storageMass:engine.protocol.calculateToccataStorageMass(transaction,'KaChat test')});
const entry={outpoint:{transactionId:'aa'.repeat(32),index:0},amount:100000000n,scriptPublicKey:kw.payToAddressScript(address),blockDaaScore:0n,isCoinbase:false};
const action={kind:'post',text:'Public comments 😀'};
const signature=kw.signMessage({message:kaChatSigningMessage(action),privateKey:key});
const payload=buildKaChatPayload(action,key.toPublicKey().toString(),signature,kw);
const options={network:'testnet-10',observedNetwork:'testnet-10',walletAddress:address,payload,entry,feeRate:400,maxFeeSompi:5000000n,runtime:kw,measure};
test('genuine SDK signatures verify and reject changed text or author',()=>{
  assert.throws(()=>buildKaChatPayload({...action,text:'forged'},key.toPublicKey().toString(),signature,kw));
  const other=new kw.PrivateKey('04'.padStart(64,'0'));
  assert.throws(()=>buildKaChatPayload(action,other.toPublicKey().toString(),signature,kw));
});
test('signed version-1 self-send preserves principal and budgets the complete witness',()=>{
  const {transaction,feeSompi,mass}=buildKaChatSelfSend(options);
  assert.equal(transaction.inputs[0].signatureScript,'');
  transaction.inputs[0].signatureScript=kw.createInputSignature(transaction,0,key,kw.SighashType.All);
  assert.equal(transaction.version,1);
  assert.equal(transaction.inputs[0].sigOpCount,0);
  assert.equal(transaction.inputs[0].computeBudget,30);
  assert.equal(transaction.outputs.length,1);
  assert.equal(transaction.outputs[0].scriptPublicKey.script,entry.scriptPublicKey.script);
  assert.equal(transaction.outputs[0].value+feeSompi,entry.amount);
  assert.deepEqual(measure(transaction),mass);
  assert(feeSompi<=options.maxFeeSompi);
});
test('reject wrong networks, token inputs, foreign funding and unaffordable fees',()=>{
  for(const override of [
    {observedNetwork:'testnet-12'},
    {entry:{...entry,covenantId:'bb'.repeat(32)}},
    {entry:{...entry,isCoinbase:true}},
    {entry:{...entry,scriptPublicKey:{script:'bad',version:0}}},
    {maxFeeSompi:1n}, {feeRate:NaN}, {feeRate:Infinity},
    {measure:()=>({computeMass:450001n,transientMass:1n,storageMass:1n})},
  ]) assert.throws(()=>buildKaChatSelfSend({...options,...override}));
});
