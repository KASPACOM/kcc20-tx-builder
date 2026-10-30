// @ts-nocheck
import { blake3 } from "@noble/hashes/blake3";
import { sha256 } from "@noble/hashes/sha256";
import { verifyKcomClaimProof, kcomClaimNullifier } from "./kcom-claim-policy.js";
import { bytesToHex, hexToBytes, requireHex32, selectFundingEntry, setVersionOneInputMassFields, utxoAmountSompi } from "./sale-common.js";
import { ADMIN_SIGNATURE_PLACEHOLDER } from "./kcom-claim-admin.js";

const FEE = 60000000n;
const COMMITMENT_KAS = 100000000n;
const encoder = new TextEncoder();
const domain = name => encoder.encode(`kcom.claim.${name}/v1\0`);
const digest = (name, ...parts) => bytesToHex(blake3(Buffer.concat([domain(name), ...parts])));
function le(value, width) {
  let n = BigInt(value);
  if (n < 0n || n >= 1n << BigInt(width * 8)) throw new Error("KCOM selection integer overflow");
  const out = Buffer.alloc(width);
  for (let i = 0; i < width; i++) { out[i] = Number(n & 255n); n >>= 8n; }
  return out;
}
function fold(leaf, index, siblings) {
  let hash = leaf, at = index;
  for (const sibling of siblings) {
    hash = at % 2 === 0 ? digest("used.node", hexToBytes(hash), hexToBytes(sibling))
      : digest("used.node", hexToBytes(sibling), hexToBytes(hash));
    at = Math.floor(at / 2);
  }
  return hash;
}
function witness(kw, codec, script, p, proof, route, signature) {
  const w = new kw.ScriptBuilder();
  w.addData(signature);
  w.addData(hexToBytes(proof.leaf.authority.identifier));
  w.addI64(BigInt(proof.leaf.index));
  w.addI64(BigInt(proof.leaf.baseEntitlementRaw));
  w.addI64(BigInt(p.tier));
  w.addData(new Uint8Array([p.beneficiary.scheme]));
  w.addData(hexToBytes(p.beneficiary.identifier));
  w.addData(Buffer.concat(proof.siblings.map(hexToBytes)));
  w.addData(hexToBytes(p.unusedProof));
  w.addI64(BigInt(proof.siblings.length));
  w.addI64(BigInt(route));
  codec.appendHiddenWitness(kw, w, "KCOMClaimShard", "select");
  w.addData(codec.dispatch("KCOMClaimShard", "select"));
  return kw.ScriptBuilder.fromScript(script).encodePayToScriptHashSignatureScript(w.drain());
}

export async function buildKcomClaimSelect({ options, kw, req, p, codec, graphId, address }) {
  const state = p.shardState, proof = p.eligibilityProof;
  const count = BigInt(state?.shard_count ?? -1), shard = BigInt(state?.shard ?? -1);
  const opens = BigInt(state?.opens_ms ?? -1), closes = BigInt(state?.closes_ms ?? -1);
  const selected = BigInt(state?.selected_count ?? -1), leaves = Number(state?.leaf_count);
  const manifest = BigInt(state?.manifest_total ?? -1), budget = BigInt(state?.budget_raw ?? -1);
  const all = BigInt(state?.all_weight ?? -1), boosted = BigInt(state?.boosted_weight ?? -1);
  const long = BigInt(state?.long_weight ?? -1);
  if (!state || state.closed || count < 1n || count > 1048576n || (count & (count - 1n)) !== 0n ||
      shard < 0n || shard >= count || !Number.isSafeInteger(leaves) || leaves < 1 || leaves > 1048576 ||
      selected < 0n || selected >= BigInt(leaves) ||
      !(budget === 10000000000000000n || (budget >= 10n && budget <= 20000n && budget % 10n === 0n)) ||
      manifest < 1n || manifest > budget / 5n || all < 0n || all > manifest ||
      boosted < 0n || boosted > all || long < 0n || long > boosted ||
      opens < 500000000000n || closes !== opens + 2592000000n ||
      closes > 9223372034262775806n || ![1, 2, 3].includes(p.tier) ||
      !Number.isInteger(p.beneficiary?.scheme) || p.beneficiary.scheme < 0 || p.beneficiary.scheme > 4)
    throw new Error("Claim shard and selection terms are invalid");
  requireHex32(state.campaign, "campaign id"); requireHex32(state.token_id, "campaign token id");
  requireHex32(p.beneficiary.identifier, "beneficiary identifier");
  if (!proof || proof.leaf?.authority?.scheme !== 0 || proof.leaf.authority.identifier !== p.authorityPublicKey)
    throw new Error("Only the original eligible native Schnorr authority can select");
  verifyKcomClaimProof({ proof, campaignId: state.campaign,
    root: state.eligibility_root, leafCount: leaves });
  const index = proof.leaf.index, weight = BigInt(proof.leaf.baseEntitlementRaw);
  if (weight > 2000000000000000n || all + weight > manifest)
    throw new Error("Selection weight exceeds frozen manifest bounds");
  const depth = proof.siblings.length;
  if (typeof p.unusedProof !== "string" ||
      !new RegExp(`^[0-9a-f]{${depth * 64}}$`).test(p.unusedProof))
    throw new Error("Unused-slot proof length or encoding invalid");
  const unused = Array.from({ length: depth }, (_, i) => p.unusedProof.slice(i * 64, (i + 1) * 64));
  const campaign = hexToBytes(state.campaign), leafIndex = le(index, 4);
  if (fold(digest("used.empty", campaign, leafIndex), index, unused) !== state.used_root)
    throw new Error("Eligibility slot has already been selected or its source is stale");
  const identity = kcomClaimNullifier(state.campaign, proof.leaf.authority);
  const route = Buffer.from(identity, "hex").readUInt32LE(0);
  if (BigInt(route) % count !== shard) throw new Error("Eligible authority routes to another shard");
  const selection = digest("selection", campaign, hexToBytes(state.eligibility_root),
    hexToBytes(identity), new Uint8Array([p.tier, p.beneficiary.scheme]), hexToBytes(p.beneficiary.identifier));
  const usedRoot = fold(digest("used.leaf", campaign, leafIndex, hexToBytes(selection)), index, unused);
  const nextState = { ...state, used_root: usedRoot,
    selected_count: String(selected + 1n), all_weight: String(all + weight),
    boosted_weight: String(boosted + (p.tier >= 2 ? weight : 0n)),
    long_weight: String(long + (p.tier === 3 ? weight : 0n)) };
  const commitmentState = {
    campaign: state.campaign, terms_hash: state.terms_hash, token_id: state.token_id,
    tge_ms: state.tge_ms, budget_raw: state.budget_raw, manifest_total: state.manifest_total,
    eligibility_root: state.eligibility_root, leaf_count: state.leaf_count,
    index: String(index), original_authority: proof.leaf.authority.identifier,
    identity, weight: String(weight), tier: String(p.tier),
    beneficiary_scheme: p.beneficiary.scheme, beneficiary: p.beneficiary.identifier,
    shard: state.shard, shard_count: state.shard_count,
  };
  const script = codec.script("KCOMClaimShard", state);
  const nextSpk = kw.payToScriptHashScript(codec.script("KCOMClaimShard", nextState));
  const commitmentSpk = kw.payToScriptHashScript(codec.script("KCOMClaimCommitment", commitmentState));
  const sourceAddress = kw.addressFromScriptPublicKey(kw.payToScriptHashScript(script), req.network).toString();
  const rpc = options.rpcClientFactory?.({
    url: options.config?.KASPA_WRPC_URL || "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh",
    encoding: kw.Encoding.Borsh, networkId: req.network,
  }) ?? new kw.RpcClient({
    url: options.config?.KASPA_WRPC_URL || "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh",
    encoding: kw.Encoding.Borsh, networkId: req.network,
  });
  const refId = entry => String(entry.entry?.covenantId ?? entry.covenantId ?? "");
  await rpc.connect();
  try {
    const ref = p.shard;
    if (!ref || !Number.isSafeInteger(ref.index) || ref.index < 0)
      throw new Error("Claim shard source outpoint required");
    requireHex32(ref.transactionId, "claim shard source transaction");
    const source = (await rpc.getUtxosByAddresses([sourceAddress])).entries.find(e =>
      String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index);
    const sourceSpk = source?.scriptPublicKey ?? source?.entry?.scriptPublicKey ?? source?.utxoEntry?.scriptPublicKey;
    if (!source || refId(source) !== graphId || !sourceSpk ||
        kw.addressFromScriptPublicKey(sourceSpk, req.network).toString() !== sourceAddress)
      throw new Error("KCOM_CLAIM_SOURCE_STALE: rebuild from current claim shard UTXO");
    const funding = selectFundingEntry((await rpc.getUtxosByAddresses([address])).entries.filter(e =>
      !refId(e) && !(String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index)),
      FEE + COMMITMENT_KAS + 10000n);
    const sponsorSpk = kw.payToAddressScript(address), value = utxoAmountSompi(source);
    const change = utxoAmountSompi(funding) - FEE - COMMITMENT_KAS;
    const outputs = [
      new kw.TransactionOutput(value, nextSpk, new kw.CovenantBinding(0, new kw.Hash(graphId))),
      new kw.TransactionOutput(COMMITMENT_KAS, commitmentSpk, new kw.CovenantBinding(0, new kw.Hash(graphId))),
      new kw.TransactionOutput(change, sponsorSpk),
    ];
    const inputs = [source, funding].map((e, i) => ({
      previousOutpoint: e.outpoint, utxo: e, sequence: 0n,
      computeBudget: i === 0 ? 40 : 10, sigOpCount: 0,
    }));
    inputs[0].signatureScript = witness(kw, codec, script, p, proof, route, ADMIN_SIGNATURE_PLACEHOLDER);
    let tx = new kw.Transaction({ version: 1, lockTime: opens + 1n, inputs, outputs,
      subnetworkId: "00".repeat(20), gas: 0n, payload: "" });
    setVersionOneInputMassFields(tx, 40); tx.inputs[1].computeBudget = 10;
    const sourceWitness = tx.inputs[0].signatureScript;
    if (options.transactionWithMinimumCalculatedFeeChange)
      tx = options.transactionWithMinimumCalculatedFeeChange(kw, tx, 2, req.network, req.builderKey);
    if (tx.version !== 1 || tx.lockTime !== opens + 1n || tx.inputs.length !== 2 || tx.outputs.length !== 3 ||
        tx.inputs[0].signatureScript !== sourceWitness || tx.inputs[0].computeBudget !== 40 ||
        tx.inputs[0].sequence !== 0n ||
        String(tx.inputs[0].previousOutpoint.transactionId) !== ref.transactionId ||
        tx.inputs[0].previousOutpoint.index !== ref.index ||
        String(tx.inputs[1].previousOutpoint.transactionId) !== String(funding.outpoint.transactionId) ||
        tx.inputs[1].previousOutpoint.index !== funding.outpoint.index ||
        String(tx.outputs[0].covenant?.covenantId) !== graphId ||
        tx.outputs[0].scriptPublicKey.script !== nextSpk.script || tx.outputs[0].value !== value ||
        String(tx.outputs[1].covenant?.covenantId) !== graphId ||
        tx.outputs[1].scriptPublicKey.script !== commitmentSpk.script ||
        tx.outputs[1].value !== COMMITMENT_KAS || tx.outputs[2].covenant ||
        tx.outputs[2].scriptPublicKey.script !== sponsorSpk.script ||
        tx.outputs[2].value <= 10000n || tx.outputs[2].value > change)
      throw new Error("KCOM selection fee adjustment changed a claim output or source");
    const signingCommitment = bytesToHex(sha256(encoder.encode(tx.serializeToSafeJSON())));
    const signature = p.authorityApproval?.signature;
    if (signature !== undefined) {
      if (p.authorityApproval.publicKey !== p.authorityPublicKey ||
          typeof signature !== "string" || !/^[0-9a-f]{128}01$/.test(signature))
        throw new Error("Original authority SIGHASH_ALL signature required");
      if (p.expectedSigningCommitment !== signingCommitment)
        throw new Error("KCOM_CLAIM_SIGNING_INTENT_STALE: rebuild and obtain a fresh claim signature");
      tx.inputs[0].signatureScript = witness(kw, codec, script, p, proof, route, hexToBytes(signature));
    }
    return {
      schema: "kcc20-in-process-pskt-builder-output/v1",
      psktTransactionJson: tx.serializeToSafeJSON(),
      signInputs: signature === undefined ? [] : [{ index: 1, sighashType: 1 }],
      submitTransactionSupported: signature !== undefined,
      metadata: { builderKey: req.builderKey, contract: "KCOMClaimShard", network: req.network,
        graphId, tokenId: state.token_id, shard: String(shard), leafIndex: String(index),
        selectionDigest: selection, identity, shardOutpoint: `${ref.transactionId}:${ref.index}`,
        nextShardOutputIndex: 0, commitmentOutputIndex: 1,
        authoritySigning: { inputIndex: 0, sighashType: 1, publicKey: p.authorityPublicKey,
          signingCommitment, status: signature === undefined ? "awaiting-original-authority" : "collected" },
        graphArtifactId: codec.graphArtifactId },
    };
  } finally { await rpc.disconnect(); }
}
