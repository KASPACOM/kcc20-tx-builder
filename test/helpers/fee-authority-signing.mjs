// Offline fixture signer only. Never loads a wallet or connects to a node.
import assert from 'node:assert/strict';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
const raw = h => Buffer.from(h, 'hex');
const le = (n, size) => { const b = Buffer.alloc(size); let v = BigInt(n);
  for (let i = 0; i < size; i++) { b[i] = Number(v & 255n); v >>= 8n; } return b; };
export function feeSigningHash(kw, tx, index, ecdsa = false) {
  const t = JSON.parse(tx.serializeToSafeJSON());
  assert.equal(t.version, 1); assert.equal(t.payload, '');
  const hash = (chunks, E = false) => {
    const h = new (E ? kw.TransactionSigningHashECDSA : kw.TransactionSigningHash)();
    try { for (const c of chunks) h.update(c); return raw(h.finalize()); } finally { h.free(); }
  };
  const spk = s => { const b = raw(s); return [b.subarray(0, 2), le(b.length - 2, 8), b.subarray(2)]; };
  const i = t.inputs[index];
  const h = hash([le(t.version, 2),
    hash(t.inputs.flatMap(i => [raw(i.transactionId), le(i.index, 4)])),
    hash(t.inputs.map(i => le(i.sequence, 8))), raw(i.transactionId), le(i.index, 4),
    ...spk(i.utxo.scriptPublicKey), le(i.utxo.amount, 8), le(i.sequence, 8),
    hash(t.outputs.flatMap(o => [le(o.value, 8), ...spk(o.scriptPublicKey),
      ...(!o.covenant ? [le(0, 1)] : [le(1, 1), le(o.covenant.authorizingInput, 2), raw(o.covenant.covenantId)])])),
    le(t.lockTime, 8), raw(t.subnetworkId), le(t.gas, 8), Buffer.alloc(32), le(1, 1)]);
  return ecdsa ? hash([h], true) : h;
}
export function signFeeAuthorityBuild(kw, built, key, mutate = () => {}, mutateWitness = () => {}) {
  const tx = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  mutate(tx);
  for (const hint of built.scripts) {
    const digest = feeSigningHash(kw, tx, hint.inputIndex, hint.signatureAlgorithm === 'ecdsa');
    let sig;
    if (hint.signatureAlgorithm === 'ecdsa') {
      sig = Buffer.concat([secp256k1.sign(digest, key.toString(), { lowS: true }).toCompactRawBytes(), Buffer.from([1])]);
      assert(secp256k1.verify(sig.subarray(0, 64), digest, raw(key.toKeypair().publicKey)));
    } else {
      sig = raw(kw.createInputSignature(tx, hint.inputIndex, key, kw.SighashType.All));
      if (sig.length === 66) sig = sig.subarray(1);
      // Independently check the serializer against the pinned WASM signer.
      assert(schnorr.verify(sig.subarray(0, 64), digest, raw(key.toKeypair().xOnlyPublicKey.toString())));
    }
    assert.equal(sig.length, 65);
    const b = new kw.ScriptBuilder({ flags: { covenantsEnabled: true } });
    for (const arg of hint.signatureScript.args) {
      if (arg.type === 'signature') b.addData(mutateWitness(Buffer.concat([raw(arg.prefixHex ?? ''), sig]), hint) ?? Buffer.concat([raw(arg.prefixHex ?? ''), sig]));
      else if (arg.type === 'data') b.addData(raw(arg.hex));
      else if (arg.type === 'i64') b.addI64(BigInt(arg.value));
      else if (arg.type === 'byte') b.addData(Uint8Array.of(arg.value));
      else throw Error('unexpected signature template');
    }
    tx.inputs[hint.inputIndex].signatureScript = kw.ScriptBuilder.fromScript(raw(hint.scriptHex), { flags: { covenantsEnabled: true } }).encodePayToScriptHashSignatureScript(b.drain());
  }
  for (const i of built.signInputs) tx.inputs[i.index].signatureScript = kw.createInputSignature(tx, i.index, key, kw.SighashType.All);
  return tx;
}
