// @ts-nocheck
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, requireHex32 } from "./sale-common.js";

export const ADMIN_SIGNATURE_PLACEHOLDER = Uint8Array.from([...new Uint8Array(64), 1]);

export function checkedKcomAdminPair(params, state) {
  const authorities = [state.first, state.second, state.third]
    .map((value, i) => requireHex32(value, `administrator ${i + 1}`));
  if (new Set(authorities).size !== 3) throw new Error("Frozen administrators are not distinct");
  const publicKeys = params.adminPublicKeys;
  if (!Array.isArray(publicKeys) || publicKeys.length !== 2 ||
      publicKeys.some(key => typeof key !== "string" || !authorities.includes(key)) ||
      publicKeys[0] === publicKeys[1])
    throw new Error("Two distinct frozen administrator public keys required");
  const approvals = params.adminApprovals;
  if (approvals !== undefined && (!Array.isArray(approvals) || approvals.length !== 2 ||
      approvals.some((approval, i) => approval?.publicKey !== publicKeys[i] ||
        typeof approval.signature !== "string" || !/^[0-9a-f]{128}01$/.test(approval.signature))))
    throw new Error("Two ordered SIGHASH_ALL administrator signatures required");
  return { publicKeys, approvals };
}

export function kcomAdminWitness(kw, codec, sourceScript, actor, entry, publicKeys, signatures) {
  const witness = new kw.ScriptBuilder();
  for (let i = 0; i < 2; i++) {
    witness.addData(signatures[i]);
    witness.addData(hexToBytes(publicKeys[i]));
  }
  codec.appendHiddenWitness(kw, witness, actor, entry);
  witness.addData(codec.dispatch(actor, entry));
  return kw.ScriptBuilder.fromScript(sourceScript)
    .encodePayToScriptHashSignatureScript(witness.drain());
}

export function finishKcomAdminIntent({ kw, tx, params, codec, sourceScript, actor, entry, publicKeys, approvals }) {
  const signingCommitment = bytesToHex(sha256(new TextEncoder().encode(tx.serializeToSafeJSON())));
  if (approvals) {
    if (params.expectedSigningCommitment !== signingCommitment)
      throw new Error("KCOM_ADMIN_SIGNING_INTENT_STALE: rebuild and collect fresh administrator signatures");
    tx.inputs[0].signatureScript = kcomAdminWitness(kw, codec, sourceScript, actor, entry,
      publicKeys, approvals.map(approval => hexToBytes(approval.signature)));
  }
  return {
    signingCommitment,
    adminSigning: { inputIndex: 0, sighashType: 1, publicKeys,
      signingCommitment, status: approvals ? "collected" : "awaiting-two-signatures" },
  };
}
