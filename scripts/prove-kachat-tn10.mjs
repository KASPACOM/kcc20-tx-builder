// Explicit opt-in funded proof. Never prints keys. Saves signed bytes before submission.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { buildKaChatPayload, kaChatSigningMessage, buildKaChatSelfSend } from '../dist/kachat.js';
import { createKcc20PsktBuilderEngine } from '../dist/engine.js';

const { KACHAT_PROOF_WALLET, KACHAT_PROOF_WASM, KACHAT_PROOF_RPC, KACHAT_PROOF_OUTPUT } = process.env;
assert(KACHAT_PROOF_WALLET && KACHAT_PROOF_WASM && KACHAT_PROOF_RPC && KACHAT_PROOF_OUTPUT,
  'Set KACHAT_PROOF_WALLET, KACHAT_PROOF_WASM, KACHAT_PROOF_RPC and KACHAT_PROOF_OUTPUT');
assert(process.argv.includes('--submit'), 'Explicit --submit required');
const kw = createRequire(import.meta.url)(KACHAT_PROOF_WASM);
const key = new kw.PrivateKey(JSON.parse(fs.readFileSync(KACHAT_PROOF_WALLET)).privateKey);
const address = key.toAddress('testnet-10').toString();
const pubkey = key.toPublicKey().toString();
const rpc = new kw.RpcClient({url:KACHAT_PROOF_RPC,networkId:'testnet-10',encoding:kw.Encoding.Borsh});
const engine = createKcc20PsktBuilderEngine({wasm:kw,artifacts:{},config:{KASPA_NETWORK:'testnet-10'}});
const bounded = async work => {
  let timer;
  try { return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('RPC timeout')),20000);})]); }
  finally { clearTimeout(timer); }
};
const save = (file, data) => {
  const tmp=file+'.tmp';
  const fd=fs.openSync(tmp,'w',0o600);
  try { fs.writeFileSync(fd,JSON.stringify(data,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n'); fs.fsyncSync(fd); }
  finally {fs.closeSync(fd);}
  fs.renameSync(tmp,file);
};
fs.mkdirSync(KACHAT_PROOF_OUTPUT,{recursive:true,mode:0o700});
try {
  await bounded(rpc.connect());
  assert.equal((await bounded(rpc.getBlockDagInfo())).network,'testnet-10');
  assert((await bounded(rpc.getInfo())).isSynced,'node not synced');
  const ownScript=kw.payToAddressScript(address).script;
  const reserved = new Set();
  if (process.env.KACHAT_PROOF_RESERVED_JOURNAL) {
    const saved = JSON.parse(fs.readFileSync(process.env.KACHAT_PROOF_RESERVED_JOURNAL));
    for(const i of kw.Transaction.deserializeFromSafeJSON(saved.signedJson).inputs)
      reserved.add(`${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`);
  }
  const outcomes=[];
  for(const name of ['root','comment','reply','like','unlike']) {
    const file=path.join(KACHAT_PROOF_OUTPUT,`${name}.json`);
    let record=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
    if(record?.phase==='accepted'){outcomes.push(record); continue;}
    if(!record){
      const action=name==='root'?{kind:'post',text:'KaspaCom DEV TN10 integration proof. Test discussion, not a production token thread.'}:
        name==='comment'?{kind:'reply',postId:outcomes[0].txid,text:'Testing on-chain token comments: שלום 😀'}:
        name==='reply'?{kind:'reply',postId:outcomes[1].txid,text:'Testing a reply to the comment.'}:
        {kind:'vote',postId:outcomes[1].txid,authorPublicKey:pubkey,vote:name==='like'?'upvote':'unvote'};
      const signature=kw.signMessage({message:kaChatSigningMessage(action),privateKey:key});
      const payload=buildKaChatPayload(action,pubkey,signature,kw);
      const {entries}=await bounded(rpc.getUtxosByAddresses({addresses:[address]}));
      const safe=entries.filter(e=>!reserved.has(`${e.outpoint.transactionId}:${e.outpoint.index}`)&&!e.isCoinbase&&!e.covenantId&&e.scriptPublicKey.script===ownScript&&e.amount>21000000n)
        .sort((a,b)=>a.amount<b.amount?-1:1);
      assert(safe.length,'No eligible ordinary funding UTXO');
      const quote=await bounded(rpc.getFeeEstimate());
      const built=buildKaChatSelfSend({network:'testnet-10',observedNetwork:'testnet-10',walletAddress:address,payload,
        entry:safe[0],runtime:kw,feeRate:Math.max(100,quote.estimate.priorityBucket.feerate),maxFeeSompi:5000000n,
        measure:tx=>({...engine.protocol.calculateToccataV1NonContextualMass(tx,'KaChat'),storageMass:engine.protocol.calculateToccataStorageMass(tx,'KaChat')})});
      const tx=built.transaction;
      tx.inputs.forEach((input,i)=>{
        assert.equal(input.utxo.scriptPublicKey.script,ownScript);
        input.signatureScript=kw.createInputSignature(tx,i,key,kw.SighashType.All);
      });
      assert(tx.outputs.every(o=>!o.covenant&&o.scriptPublicKey.script===ownScript));
      const fee=tx.inputs.reduce((n,i)=>n+i.utxo.amount,0n)-tx.outputs.reduce((n,o)=>n+o.value,0n);
      assert(fee>=0n&&fee<=5000000n,'Proof fee cap is 0.05 KAS per action');
      const mass=engine.protocol.calculateToccataV1NonContextualMass(tx,'KaChat');
      const storage=engine.protocol.calculateToccataStorageMass(tx,'KaChat');
      assert(mass.computeMass<=450000n&&mass.transientMass<=900000n&&storage<=450000n,'signed mass budget exceeded');
      tx.finalize();
      record={name,phase:'prepared',txid:tx.id.toString(),signedJson:tx.serializeToSafeJSON(),action,feeSompi:fee,mass:{...mass,storage},address};
      save(file,record);
    }
    const tx=kw.Transaction.deserializeFromSafeJSON(record.signedJson);
    tx.finalize(); assert.equal(tx.id.toString(),record.txid);
    const accepted=async()=>{
      const {entries}=await bounded(rpc.getUtxosByAddresses({addresses:[address]}));
      return entries.some(e=>e.outpoint.transactionId===record.txid);
    };
    if(record.phase==='prepared'){
      if(!await accepted()){
        // Save ambiguity BEFORE sending. A crash must not silently rebuild a replacement.
        record.phase='broadcast-unknown';save(file,record);
        assert.equal((await bounded(rpc.submitTransaction({transaction:tx,allowOrphan:false}))).transactionId,record.txid);
      }
    }
    for(let attempt=0;attempt<20&&!await accepted();attempt++) await new Promise(resolve=>setTimeout(resolve,1000));
    assert(await accepted(),`Acceptance unconfirmed for ${record.txid}; reconcile saved transaction before retrying`);
    record.phase='accepted';save(file,record);outcomes.push(record);
    console.log(JSON.stringify({name,txid:record.txid,phase:record.phase,feeSompi:String(record.feeSompi),mass:record.mass},(_,v)=>typeof v==='bigint'?v.toString():v));
  }
} finally { await bounded(rpc.disconnect()); }
