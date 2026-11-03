// @ts-nocheck
import { blake3 } from "@noble/hashes/blake3";
import { kcomClaimNullifier } from "./kcom-claim-policy.js";
import { bytesToHex, hexToBytes, requireHex32, selectFundingEntry, setVersionOneInputMassFields, utxoAmountSompi } from "./sale-common.js";

const FEE = 60000000n;
const encoder = new TextEncoder();
const digest = (name, ...parts) => bytesToHex(blake3(Buffer.concat([
  encoder.encode(`kcom.claim.${name}/v1\0`), ...parts,
])));
function le(value, width) {
  let n = BigInt(value);
  if (n < 0n || n >= 1n << BigInt(width * 8)) throw new Error("KCOM settlement integer overflow");
  const out = Buffer.alloc(width);
  for (let i = 0; i < width; i++) { out[i] = Number(n & 255n); n >>= 8n; }
  return out;
}
function fold(name, leaf, index, proof, depth) {
  let value = leaf, at = index;
  for (let i = 0; i < depth; i++) {
    const sibling = proof.slice(i * 32, (i + 1) * 32);
    value = at % 2 === 0 ? digest(name, hexToBytes(value), sibling)
      : digest(name, sibling, hexToBytes(value));
    at = Math.floor(at / 2);
  }
  return value;
}
const decimal = value => String(BigInt(value));

export async function buildKcomClaimSettle({ options, kw, req, p, codec, graphId, address }) {
  const state = p.collectorState, claim = p.commitmentState, summary = p.closedShardSummary;
  if (!state || !claim || !summary) throw new Error("Collector, commitment and closed-shard summary required");
  const count = BigInt(state.shard_count), nextShard = BigInt(state.next_shard);
  const selected = BigInt(state.selected_count), settled = BigInt(state.settled_count);
  const leaves = BigInt(state.leaf_count), budget = BigInt(state.budget_raw);
  const manifest = BigInt(state.manifest_total), all = BigInt(state.all_weight);
  const boosted = BigInt(state.boosted_weight), long = BigInt(state.long_weight);
  const liability = BigInt(state.liability_raw), closeTime = BigInt(state.closes_ms);
  const claimIndex = BigInt(claim.index), claimWeight = BigInt(claim.weight), tier = Number(claim.tier);
  const summarySelected = BigInt(summary.selected_count), summaryAll = BigInt(summary.all_weight);
  const summaryBoosted = BigInt(summary.boosted_weight), summaryLong = BigInt(summary.long_weight);
  if (!state.collection_complete || state.settlement_complete || count < 1n || count > 1048576n ||
      (count & (count - 1n)) !== 0n || nextShard !== count || leaves < 1n || leaves > 1048576n ||
      selected <= 0n || selected > leaves || settled < 0n || settled >= selected ||
      !(budget === 10000000000000000n || (budget >= 10n && budget <= 20000n && budget % 10n === 0n)) ||
      manifest <= 0n || manifest > budget / 5n || all <= 0n || all > manifest ||
      boosted < 0n || boosted > all || long < 0n || long > boosted ||
      liability < 0n || liability > budget ||
      claimIndex < 0n || claimIndex >= leaves || claimWeight <= 0n || claimWeight > all ||
      ![1, 2, 3].includes(tier) ||
      ![0, 1, 2, 3, 4].includes(Number(claim.beneficiary_scheme)) ||
      BigInt(claim.shard_count) !== count ||
      BigInt(claim.shard) < 0n || BigInt(claim.shard) >= count ||
      BigInt(summary.shard) !== BigInt(claim.shard) ||
      summarySelected <= 0n || summarySelected > selected ||
      summaryAll < claimWeight || summaryAll > all ||
      summaryBoosted < 0n || summaryBoosted > summaryAll ||
      summaryLong < 0n || summaryLong > summaryBoosted ||
      closeTime !== BigInt(state.opens_ms) + 2592000000n ||
      closeTime < 500000000000n || closeTime > 9223372034262775805n)
    throw new Error("Collector and selected commitment are not ready for settlement");
  for (const key of ["campaign", "terms_hash", "token_id", "budget_raw", "manifest_total",
    "eligibility_root", "leaf_count", "tge_ms", "shard_count"])
    if (String(claim[key]) !== String(state[key])) throw new Error(`Commitment ${key} differs from collector`);
  for (const key of ["campaign", "eligibility_root", "token_id", "budget_raw", "manifest_total",
    "terms_hash", "leaf_count", "tge_ms", "shard_count"])
    if (String(summary[key]) !== String(state[key])) throw new Error(`Closed shard ${key} differs from collector`);
  requireHex32(state.token_id, "campaign token id");
  requireHex32(claim.identity, "claim identity");
  requireHex32(claim.original_authority, "original authority");
  if (kcomClaimNullifier(state.campaign,
    { scheme: 0, identifier: claim.original_authority }) !== claim.identity)
    throw new Error("Commitment identity differs from original eligible authority");
  requireHex32(claim.beneficiary, "beneficiary");
  requireHex32(summary.used_root, "closed shard used root");
  const summaryDepth = Number(p.summaryDepth), usedDepth = Number(p.usedDepth);
  let requiredSummaryDepth = 0, width = 1n;
  while (width < count) { requiredSummaryDepth++; width *= 2n; }
  let requiredUsedDepth = 0; width = 1n;
  while (width < leaves) { requiredUsedDepth++; width *= 2n; }
  if (summaryDepth !== requiredSummaryDepth || usedDepth !== requiredUsedDepth ||
      typeof p.summaryProof !== "string" ||
      !new RegExp(`^[0-9a-f]{${summaryDepth * 64}}$`).test(p.summaryProof) ||
      typeof p.usedProof !== "string" ||
      !new RegExp(`^[0-9a-f]{${usedDepth * 64}}$`).test(p.usedProof))
    throw new Error("Settlement proof depth or encoding invalid");
  const campaign = hexToBytes(state.campaign), summaryProof = hexToBytes(p.summaryProof);
  const usedProof = hexToBytes(p.usedProof);
  const summaryLeaf = digest("summary.leaf", campaign, le(claim.shard, 4),
    hexToBytes(summary.used_root), le(summarySelected, 8), le(summaryAll, 8),
    le(summaryBoosted, 8), le(summaryLong, 8));
  if (fold("summary.node", summaryLeaf, Number(claim.shard), summaryProof, summaryDepth) !== state.summaries_root)
    throw new Error("Closed shard summary does not open the collected root");
  const selection = digest("selection", campaign, hexToBytes(state.eligibility_root),
    hexToBytes(claim.identity), new Uint8Array([tier, Number(claim.beneficiary_scheme)]),
    hexToBytes(claim.beneficiary));
  const usedLeaf = digest("used.leaf", campaign, le(claimIndex, 4), hexToBytes(selection));
  if (fold("used.node", usedLeaf, Number(claimIndex), usedProof, usedDepth) !== summary.used_root)
    throw new Error("Selected claim does not open its final used root");
  const ratio = (pool, denominator) => {
    if (denominator <= 0n || denominator > 2000000000000000n || claimWeight > denominator)
      throw new Error("Invalid settlement denominator");
    return pool * claimWeight / denominator;
  };
  let total = claimWeight;
  if (tier >= 2) total += ratio((budget / 10n) * 3n, boosted);
  if (tier === 3) total += ratio(budget / 2n, long) + ratio(manifest - all, long);
  if (total <= 0n || total > budget || liability > budget - total)
    throw new Error("Settlement allocation exceeds campaign budget");
  const nextState = { ...state, settled_count: decimal(settled + 1n),
    liability_raw: decimal(liability + total) };
  const entitlementState = {
    campaign: state.campaign, terms_hash: state.terms_hash, token_id: state.token_id,
    tge_ms: state.tge_ms, budget_raw: state.budget_raw, manifest_total: state.manifest_total,
    eligibility_root: state.eligibility_root, index: claim.index,
    original_authority: claim.original_authority, beneficiary: claim.beneficiary,
    beneficiary_scheme: claim.beneficiary_scheme, tier: claim.tier, total: decimal(total),
  };
  const collectorScript = codec.script("KCOMSettlement", state);
  const commitmentScript = codec.script("KCOMClaimCommitment", claim);
  const collectorSpk = kw.payToScriptHashScript(codec.script("KCOMSettlement", nextState));
  const entitlementSpk = kw.payToScriptHashScript(codec.script("KCOMEntitlement", entitlementState));
  const rpc = options.rpcClientFactory?.({
    url: options.config?.KASPA_WRPC_URL || "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh",
    encoding: kw.Encoding.Borsh, networkId: req.network,
  }) ?? new kw.RpcClient({
    url: options.config?.KASPA_WRPC_URL || "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh",
    encoding: kw.Encoding.Borsh, networkId: req.network,
  });
  const scriptAddress = script => kw.addressFromScriptPublicKey(kw.payToScriptHashScript(script), req.network).toString();
  const refId = entry => String(entry.entry?.covenantId ?? entry.covenantId ?? "");
  await rpc.connect();
  try {
    async function live(script, ref) {
      if (!ref || !Number.isSafeInteger(ref.index) || ref.index < 0)
        throw new Error("Settlement source outpoint required");
      requireHex32(ref.transactionId, "settlement source transaction");
      const addr = scriptAddress(script);
      const entry = (await rpc.getUtxosByAddresses([addr])).entries.find(e =>
        String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index);
      const sourceSpk = entry?.scriptPublicKey ?? entry?.entry?.scriptPublicKey ?? entry?.utxoEntry?.scriptPublicKey;
      if (!entry || refId(entry) !== graphId || !sourceSpk ||
          kw.addressFromScriptPublicKey(sourceSpk, req.network).toString() !== addr)
        throw new Error("KCOM_CLAIM_SOURCE_STALE: rebuild from current collector and commitment UTXOs");
      return entry;
    }
    const collector = await live(collectorScript, p.collector);
    const commitment = await live(commitmentScript, p.commitment);
    if (p.collector.transactionId === p.commitment.transactionId && p.collector.index === p.commitment.index)
      throw new Error("Collector and commitment sources alias");
    const funding = selectFundingEntry((await rpc.getUtxosByAddresses([address])).entries.filter(e =>
      !refId(e) && ![p.collector, p.commitment].some(ref =>
        String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index)),
      FEE + 10000n);
    const sponsorSpk = kw.payToAddressScript(address);
    const collectorValue = utxoAmountSompi(collector), commitmentValue = utxoAmountSompi(commitment);
    const change = utxoAmountSompi(funding) - FEE;
    const outputs = [
      new kw.TransactionOutput(collectorValue, collectorSpk, new kw.CovenantBinding(0, new kw.Hash(graphId))),
      new kw.TransactionOutput(commitmentValue, entitlementSpk, new kw.CovenantBinding(0, new kw.Hash(graphId))),
      new kw.TransactionOutput(change, sponsorSpk),
    ];
    const entries = [collector, commitment, funding], budgets = [40, 30, 10];
    const inputs = entries.map((e, i) => ({ previousOutpoint: e.outpoint, utxo: e,
      sequence: 0n, computeBudget: budgets[i], sigOpCount: 0 }));
    const leader = new kw.ScriptBuilder();
    leader.addData(hexToBytes(summary.used_root));
    leader.addI64(summarySelected); leader.addI64(summaryAll);
    leader.addI64(summaryBoosted); leader.addI64(summaryLong);
    leader.addData(summaryProof); leader.addI64(BigInt(summaryDepth));
    leader.addData(usedProof); leader.addI64(BigInt(usedDepth));
    codec.appendHiddenWitness(kw, leader, "KCOMSettlement", "settle");
    leader.addData(codec.dispatch("KCOMSettlement", "settle"));
    inputs[0].signatureScript = kw.ScriptBuilder.fromScript(collectorScript)
      .encodePayToScriptHashSignatureScript(leader.drain());
    const delegate = new kw.ScriptBuilder();
    codec.appendHiddenWitness(kw, delegate, "KCOMClaimCommitment", "settle");
    delegate.addData(codec.dispatch("KCOMClaimCommitment", "settle"));
    inputs[1].signatureScript = kw.ScriptBuilder.fromScript(commitmentScript)
      .encodePayToScriptHashSignatureScript(delegate.drain());
    let tx = new kw.Transaction({ version: 1, lockTime: closeTime + 2n, inputs, outputs,
      subnetworkId: "00".repeat(20), gas: 0n, payload: "" });
    setVersionOneInputMassFields(tx, budgets[0]);
    tx.inputs[1].computeBudget = budgets[1]; tx.inputs[2].computeBudget = budgets[2];
    const protectedInputs = [0, 1].map(i => ({ signatureScript: tx.inputs[i].signatureScript,
      computeBudget: tx.inputs[i].computeBudget, sequence: tx.inputs[i].sequence }));
    if (options.transactionWithMinimumCalculatedFeeChange)
      tx = options.transactionWithMinimumCalculatedFeeChange(kw, tx, 2, req.network, req.builderKey);
    if (tx.version !== 1 || tx.lockTime !== closeTime + 2n || tx.inputs.length !== 3 ||
        tx.outputs.length !== 3 || protectedInputs.some((input, i) =>
          tx.inputs[i].signatureScript !== input.signatureScript ||
          tx.inputs[i].computeBudget !== input.computeBudget || tx.inputs[i].sequence !== input.sequence) ||
        entries.some((e, i) => String(tx.inputs[i].previousOutpoint.transactionId) !== String(e.outpoint.transactionId) ||
          tx.inputs[i].previousOutpoint.index !== e.outpoint.index) ||
        String(tx.outputs[0].covenant?.covenantId) !== graphId ||
        tx.outputs[0].scriptPublicKey.script !== collectorSpk.script || tx.outputs[0].value !== collectorValue ||
        String(tx.outputs[1].covenant?.covenantId) !== graphId ||
        tx.outputs[1].scriptPublicKey.script !== entitlementSpk.script || tx.outputs[1].value !== commitmentValue ||
        tx.outputs[2].covenant || tx.outputs[2].scriptPublicKey.script !== sponsorSpk.script ||
        tx.outputs[2].value <= 10000n || tx.outputs[2].value > change)
      throw new Error("KCOM settlement fee adjustment changed an entitlement or source");
    return { schema: "kcc20-in-process-pskt-builder-output/v1",
      psktTransactionJson: tx.serializeToSafeJSON(), signInputs: [{ index: 2, sighashType: 1 }],
      submitTransactionSupported: true,
      metadata: { builderKey: req.builderKey, contract: "KCOMSettlement", network: req.network,
        graphId, tokenId: state.token_id, leafIndex: String(claimIndex), tier: String(tier),
        allocationRaw: String(total), collectorOutpoint: `${p.collector.transactionId}:${p.collector.index}`,
        commitmentOutpoint: `${p.commitment.transactionId}:${p.commitment.index}`,
        collectorOutputIndex: 0, entitlementOutputIndex: 1, graphArtifactId: codec.graphArtifactId },
    };
  } finally { await rpc.disconnect(); }
}
