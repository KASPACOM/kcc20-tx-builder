// @ts-nocheck
import { blake3 } from "@noble/hashes/blake3";
import { concatBytes } from "./abi.js";
import { bytesToHex, hexToBytes, requireHex32, selectFundingEntry, setVersionOneInputMassFields, utxoAmountSompi } from "./sale-common.js";

const FEE = 60000000n;
const encoder = new TextEncoder();
const domain = name => encoder.encode(`kcom.claim.summary.${name}/v1\0`);
function fixedLe(value, width) {
  let n = BigInt(value);
  if (n < 0n || n >= 1n << BigInt(width * 8)) throw new Error("KCOM summary integer overflow");
  const bytes = new Uint8Array(width);
  for (let i = 0; i < width; i++) { bytes[i] = Number(n & 255n); n >>= 8n; }
  return bytes;
}
function digest(name, ...parts) { return blake3(concatBytes(domain(name), ...parts)); }
function fold(leaf, index, proof, depth) {
  let value = leaf, at = index;
  for (let i = 0; i < depth; i++) {
    const sibling = proof.slice(i * 32, (i + 1) * 32);
    value = at % 2 === 0 ? digest("node", value, sibling) : digest("node", sibling, value);
    at = Math.floor(at / 2);
  }
  return bytesToHex(value);
}

export async function buildKcomClaimCollect({ options, kw, req, p, codec, graphId, address }) {
  const collectorState = p.collectorState, shardState = p.closedShardState;
  const shardCount = BigInt(collectorState?.shard_count ?? -1);
  const index = BigInt(collectorState?.next_shard ?? -1);
  const depth = Number(p.depth);
  const proofHex = p.unusedProof ?? "";
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > 20 ||
      shardCount !== 1n << BigInt(depth) || index < 0n || index >= shardCount ||
      typeof proofHex !== "string" || !new RegExp(`^[0-9a-f]{${depth * 64}}$`).test(proofHex) ||
      !shardState?.closed || collectorState.collection_complete || collectorState.settlement_complete ||
      BigInt(collectorState.settled_count) !== 0n || BigInt(collectorState.liability_raw) !== 0n ||
      BigInt(shardState.shard) !== index || BigInt(shardState.shard_count) !== shardCount)
    throw new Error("Collector and closed shard are not ready for collection");
  for (const key of ["campaign", "terms_hash", "token_id", "budget_raw", "manifest_total",
    "eligibility_root", "leaf_count", "first", "second", "third", "opens_ms", "closes_ms", "tge_ms"])
    if (String(collectorState[key]) !== String(shardState[key]))
      throw new Error(`Closed shard ${key} differs from collector`);
  requireHex32(collectorState.token_id, "campaign token id");
  const selected = BigInt(collectorState.selected_count) + BigInt(shardState.selected_count);
  const all = BigInt(collectorState.all_weight) + BigInt(shardState.all_weight);
  const boosted = BigInt(collectorState.boosted_weight) + BigInt(shardState.boosted_weight);
  const long = BigInt(collectorState.long_weight) + BigInt(shardState.long_weight);
  if (selected > BigInt(collectorState.leaf_count) || all > BigInt(collectorState.manifest_total) ||
      long > boosted || boosted > all)
    throw new Error("Closed shard participation exceeds campaign bounds");
  const closeTime = BigInt(collectorState.closes_ms);
  if (closeTime !== BigInt(collectorState.opens_ms) + 2592000000n ||
      closeTime < 500000000000n || closeTime > 9223372034262775805n)
    throw new Error("Invalid frozen campaign close time");
  const campaign = hexToBytes(requireHex32(collectorState.campaign, "campaign id"));
  const shardIndex = fixedLe(index, 4);
  const proof = hexToBytes(proofHex);
  const empty = digest("empty", campaign, shardIndex);
  if (fold(empty, Number(index), proof, depth) !== collectorState.summaries_root)
    throw new Error("Closed shard does not own the next empty summary slot");
  const summary = digest("leaf", campaign, shardIndex,
    hexToBytes(requireHex32(shardState.used_root, "closed shard used root")),
    fixedLe(shardState.selected_count, 8), fixedLe(shardState.all_weight, 8),
    fixedLe(shardState.boosted_weight, 8), fixedLe(shardState.long_weight, 8));
  const nextState = {
    ...collectorState, summaries_root: fold(summary, Number(index), proof, depth),
    next_shard: String(index + 1n), selected_count: String(selected), all_weight: String(all),
    boosted_weight: String(boosted), long_weight: String(long),
    collection_complete: index + 1n === shardCount,
  };
  const collectorScript = codec.script("KCOMSettlement", collectorState);
  const shardScript = codec.script("KCOMClaimShard", shardState);
  const nextScript = codec.script("KCOMSettlement", nextState);
  const rpc = options.rpcClientFactory?.({
    url: options.config?.KASPA_WRPC_URL || "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh",
    encoding: kw.Encoding.Borsh, networkId: req.network,
  }) ?? new kw.RpcClient({
    url: options.config?.KASPA_WRPC_URL || "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh",
    encoding: kw.Encoding.Borsh, networkId: req.network,
  });
  const spk = script => kw.payToScriptHashScript(script);
  const scriptAddress = script => kw.addressFromScriptPublicKey(spk(script), req.network).toString();
  const refId = entry => String(entry.entry?.covenantId ?? entry.covenantId ?? "");
  await rpc.connect();
  try {
    async function live(script, ref) {
      if (!ref || !Number.isSafeInteger(ref.index) || ref.index < 0)
        throw new Error("Campaign source outpoint required");
      requireHex32(ref.transactionId, "campaign source transaction");
      const entry = (await rpc.getUtxosByAddresses([scriptAddress(script)])).entries.find(e =>
        String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index);
      const sourceSpk = entry?.scriptPublicKey ?? entry?.entry?.scriptPublicKey ?? entry?.utxoEntry?.scriptPublicKey;
      if (!entry || refId(entry) !== graphId || !sourceSpk ||
          kw.addressFromScriptPublicKey(sourceSpk, req.network).toString() !== scriptAddress(script))
        throw new Error("KCOM_CLAIM_SOURCE_STALE: rebuild from current collector and shard UTXOs");
      return entry;
    }
    const collector = await live(collectorScript, p.collector);
    const shard = await live(shardScript, p.closedShard);
    if (p.collector.transactionId === p.closedShard.transactionId && p.collector.index === p.closedShard.index)
      throw new Error("Collector and shard sources alias");
    const funding = selectFundingEntry((await rpc.getUtxosByAddresses([address])).entries.filter(e =>
      !refId(e) && ![p.collector, p.closedShard].some(ref =>
        String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index)), FEE + 10000n);
    const value = utxoAmountSompi(collector) + utxoAmountSompi(shard);
    const change = utxoAmountSompi(funding) - FEE;
    const nextSpk = spk(nextScript), sponsorSpk = kw.payToAddressScript(address);
    const nextScriptHex = nextSpk.script, sponsorScriptHex = sponsorSpk.script;
    const outputs = [
      new kw.TransactionOutput(value, nextSpk, new kw.CovenantBinding(0, new kw.Hash(graphId))),
      new kw.TransactionOutput(change, sponsorSpk),
    ];
    const entries = [collector, shard, funding];
    const budgets = [45, 30, 10];
    const inputs = entries.map((e, i) => ({
      previousOutpoint: e.outpoint, utxo: e, sequence: 0n,
      computeBudget: budgets[i], sigOpCount: 0,
    }));
    const leaderWitness = new kw.ScriptBuilder();
    leaderWitness.addData(proof); leaderWitness.addI64(BigInt(depth));
    codec.appendHiddenWitness(kw, leaderWitness, "KCOMSettlement", "collect");
    leaderWitness.addData(codec.dispatch("KCOMSettlement", "collect"));
    inputs[0].signatureScript = kw.ScriptBuilder.fromScript(collectorScript)
      .encodePayToScriptHashSignatureScript(leaderWitness.drain());
    const shardWitness = new kw.ScriptBuilder();
    codec.appendHiddenWitness(kw, shardWitness, "KCOMClaimShard", "collect");
    shardWitness.addData(codec.dispatch("KCOMClaimShard", "collect"));
    inputs[1].signatureScript = kw.ScriptBuilder.fromScript(shardScript)
      .encodePayToScriptHashSignatureScript(shardWitness.drain());
    let tx = new kw.Transaction({
      version: 1, lockTime: closeTime + 2n, inputs, outputs,
      subnetworkId: "00".repeat(20), gas: 0n, payload: "",
    });
    setVersionOneInputMassFields(tx, budgets[0]);
    tx.inputs[1].computeBudget = budgets[1]; tx.inputs[2].computeBudget = budgets[2];
    const protectedInputs = [0, 1].map(i => ({
      signatureScript: tx.inputs[i].signatureScript,
      computeBudget: tx.inputs[i].computeBudget,
      sequence: tx.inputs[i].sequence,
    }));
    if (options.transactionWithMinimumCalculatedFeeChange)
      tx = options.transactionWithMinimumCalculatedFeeChange(kw, tx, 1, req.network, req.builderKey);
    if (tx.version !== 1 || tx.lockTime !== closeTime + 2n ||
        tx.inputs.length !== 3 || tx.outputs.length !== 2 ||
        protectedInputs.some((input, i) =>
          tx.inputs[i].signatureScript !== input.signatureScript ||
          tx.inputs[i].computeBudget !== input.computeBudget ||
          tx.inputs[i].sequence !== input.sequence) ||
        entries.some((e, i) => String(tx.inputs[i].previousOutpoint.transactionId) !== String(e.outpoint.transactionId) ||
          tx.inputs[i].previousOutpoint.index !== e.outpoint.index) ||
        String(tx.outputs[0].covenant?.covenantId) !== graphId ||
        tx.outputs[0].scriptPublicKey.script !== nextScriptHex || tx.outputs[0].value !== value ||
        tx.outputs[1].covenant || tx.outputs[1].scriptPublicKey.script !== sponsorScriptHex ||
        tx.outputs[1].value <= 10000n || tx.outputs[1].value > change)
      throw new Error("KCOM collection fee adjustment changed a custody output or source");
    return {
      schema: "kcc20-in-process-pskt-builder-output/v1",
      psktTransactionJson: tx.serializeToSafeJSON(),
      signInputs: [{ index: 2, sighashType: 1 }], submitTransactionSupported: true,
      metadata: {
        builderKey: req.builderKey, contract: "KCOMSettlement", network: req.network,
        graphId, tokenId: collectorState.token_id, shard: String(index),
        collectorOutpoint: `${p.collector.transactionId}:${p.collector.index}`,
        shardOutpoint: `${p.closedShard.transactionId}:${p.closedShard.index}`,
        collectorOutputIndex: 0, graphArtifactId: codec.graphArtifactId,
      },
    };
  } finally {
    await rpc.disconnect();
  }
}
