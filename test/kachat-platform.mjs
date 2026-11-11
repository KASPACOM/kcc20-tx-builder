import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as kw from '../examples/vendor/kaspa/kaspa.js';
import { decodeKaChatPayload,buildKaChatPayload,kaChatSigningMessage,buildKaChatSelfSend,validateKaChatSignedTransaction } from '../dist/kachat.js';
import { createKcc20PsktBuilderEngine } from '../dist/engine.js';
kw.initSync({module:await readFile(new URL('../examples/vendor/kaspa/kaspa_bg.wasm',import.meta.url))});
const key=new kw.PrivateKey('03'.padStart(64,'0')),address=key.toAddress('testnet-10').toString();
const engine=createKcc20PsktBuilderEngine({wasm:kw,artifacts:{},config:{KASPA_NETWORK:'testnet-10'}});
const measure=tx=>({...engine.protocol.calculateToccataV1NonContextualMass(tx,'KaChat'),storageMass:engine.protocol.calculateToccataStorageMass(tx,'KaChat')});
const action={kind:'reply',postId:'a'.repeat(64),text:'Browser flow שלום 😀'};
const payload=buildKaChatPayload(action,key.toPublicKey().toString(),kw.signMessage({message:kaChatSigningMessage(action),privateKey:key}),kw);
function build(){return buildKaChatSelfSend({network:'testnet-10',observedNetwork:'testnet-10',walletAddress:address,payload,
 entry:{outpoint:{transactionId:'b'.repeat(64),index:0},amount:100000000n,scriptPublicKey:kw.payToAddressScript(address),isCoinbase:false,blockDaaScore:0n},feeRate:100,maxFeeSompi:5000000n,runtime:kw,measure}).transaction;}
test('authenticated UTF-8 decoder accepts every action and rejects forged or oversized payloads',()=>{
 for(const a of [action,{kind:'post',text:'Root'},{kind:'vote',postId:action.postId,authorPublicKey:key.toPublicKey().toString(),vote:'upvote'},{kind:'vote',postId:action.postId,authorPublicKey:key.toPublicKey().toString(),vote:'unvote'}]){
 const bytes=buildKaChatPayload(a,key.toPublicKey().toString(),kw.signMessage({message:kaChatSigningMessage(a),privateKey:key}),kw);assert.deepEqual(decodeKaChatPayload(bytes,kw).action,a);
 const bad=new Uint8Array(bytes);bad[40]^=1;assert.throws(()=>decodeKaChatPayload(bad,kw));}
 assert.throws(()=>decodeKaChatPayload(new Uint8Array(4097),kw));
});
test('wallet adds a valid witness without changing immutable fields',()=>{const original=build(),signed=kw.Transaction.deserializeFromSafeJSON(original.serializeToSafeJSON());signed.inputs[0].signatureScript=kw.createInputSignature(signed,0,key,kw.SighashType.All);assert(validateKaChatSignedTransaction(original,signed,measure).computeMass>0n);});
test('wallet diversion, changed payload and missing signature fail before broadcast',()=>{const original=build();for(const change of [t=>t.outputs[0].value-=1n,t=>t.payload='00',t=>t.inputs[0].signatureScript='']){const signed=kw.Transaction.deserializeFromSafeJSON(original.serializeToSafeJSON());signed.inputs[0].signatureScript=kw.createInputSignature(signed,0,key,kw.SighashType.All);change(signed);assert.throws(()=>validateKaChatSignedTransaction(original,signed,measure));}});
