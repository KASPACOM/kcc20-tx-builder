// @ts-nocheck
import { requireHex32, selectFundingEntry, setVersionOneInputMassFields, utxoAmountSompi } from "./sale-common.js";

const FEE = 60000000n;

export async function buildKcomClaimFinishSettlement({ options, kw, req, p, codec, graphId, address }) {
  const state = p.collectorState;
  const count = BigInt(state?.selected_count ?? -1);
  const budget = BigInt(state?.budget_raw ?? -1);
  const liability = BigInt(state?.liability_raw ?? -1);
  if (!state?.collection_complete || state.settlement_complete ||
      BigInt(state.next_shard) !== BigInt(state.shard_count) ||
      BigInt(state.settled_count) !== count || count < 0 ||
      count > BigInt(state.leaf_count) || liability < 0 || liability > budget ||
      !(budget === 10000000000000000n ||
        (budget >= 10n && budget <= 20000n && budget % 10n === 0n)))
    throw new Error("Settlement collector is not ready to finalize");
  requireHex32(state.token_id, "campaign token id");
  const sourceScript = codec.script("KCOMSettlement", state);
  const nextScript = codec.script("KCOMSettlement", { ...state, settlement_complete: true });
  const rpc = options.rpcClientFactory?.({
    url: options.config?.KASPA_WRPC_URL || "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh",
    encoding: kw.Encoding.Borsh, networkId: req.network,
  }) ?? new kw.RpcClient({
    url: options.config?.KASPA_WRPC_URL || "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh",
    encoding: kw.Encoding.Borsh, networkId: req.network,
  });
  const scriptAddress = kw.addressFromScriptPublicKey(kw.payToScriptHashScript(sourceScript), req.network).toString();
  const refId = entry => String(entry.entry?.covenantId ?? entry.covenantId ?? "");
  await rpc.connect();
  try {
    const entries = (await rpc.getUtxosByAddresses([scriptAddress])).entries;
    const ref = p.collector;
    if (!ref || !Number.isSafeInteger(ref.index) || ref.index < 0)
      throw new Error("Settlement collector source required");
    requireHex32(ref.transactionId, "collector source transaction");
    const collector = entries.find(e =>
      String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index);
    const spk = collector?.scriptPublicKey ?? collector?.entry?.scriptPublicKey ?? collector?.utxoEntry?.scriptPublicKey;
    if (!collector || refId(collector) !== graphId || !spk ||
        kw.addressFromScriptPublicKey(spk, req.network).toString() !== scriptAddress)
      throw new Error("KCOM_CLAIM_SOURCE_STALE: rebuild from current collector UTXO");
    const funding = selectFundingEntry((await rpc.getUtxosByAddresses([address])).entries.filter(e =>
      !refId(e) && !(String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index)),
      FEE + 10000n);
    const nextSpk = kw.payToScriptHashScript(nextScript);
    const sponsorSpk = kw.payToAddressScript(address);
    const value = utxoAmountSompi(collector);
    const change = utxoAmountSompi(funding) - FEE;
    const outputs = [
      new kw.TransactionOutput(value, nextSpk, new kw.CovenantBinding(0, new kw.Hash(graphId))),
      new kw.TransactionOutput(change, sponsorSpk),
    ];
    const inputs = [collector, funding].map((e, i) => ({
      previousOutpoint: e.outpoint, utxo: e, sequence: 0n,
      computeBudget: i === 0 ? 40 : 10, sigOpCount: 0,
    }));
    const witness = new kw.ScriptBuilder();
    codec.appendHiddenWitness(kw, witness, "KCOMSettlement", "finish_settlement");
    witness.addData(codec.dispatch("KCOMSettlement", "finish_settlement"));
    inputs[0].signatureScript = kw.ScriptBuilder.fromScript(sourceScript)
      .encodePayToScriptHashSignatureScript(witness.drain());
    let tx = new kw.Transaction({
      version: 1, lockTime: 0n, inputs, outputs,
      subnetworkId: "00".repeat(20), gas: 0n, payload: "",
    });
    setVersionOneInputMassFields(tx, 40);
    tx.inputs[1].computeBudget = 10;
    if (options.transactionWithMinimumCalculatedFeeChange)
      tx = options.transactionWithMinimumCalculatedFeeChange(kw, tx, 1, req.network, req.builderKey);
    if (tx.inputs.length !== 2 || tx.outputs.length !== 2 ||
        String(tx.inputs[0].previousOutpoint.transactionId) !== ref.transactionId ||
        tx.inputs[0].previousOutpoint.index !== ref.index ||
        String(tx.inputs[1].previousOutpoint.transactionId) !== String(funding.outpoint.transactionId) ||
        tx.inputs[1].previousOutpoint.index !== funding.outpoint.index ||
        String(tx.outputs[0].covenant?.covenantId) !== graphId ||
        tx.outputs[0].scriptPublicKey.script !== nextSpk.script || tx.outputs[0].value !== value ||
        tx.outputs[1].covenant || tx.outputs[1].scriptPublicKey.script !== sponsorSpk.script ||
        tx.outputs[1].value <= 10000n || tx.outputs[1].value > change)
      throw new Error("KCOM settlement fee adjustment changed a custody output or source");
    return {
      schema: "kcc20-in-process-pskt-builder-output/v1",
      psktTransactionJson: tx.serializeToSafeJSON(),
      signInputs: [{ index: 1, sighashType: 1 }],
      submitTransactionSupported: true,
      metadata: {
        builderKey: req.builderKey, contract: "KCOMSettlement", network: req.network,
        graphId, tokenId: state.token_id, liabilityRaw: String(liability),
        collectorOutpoint: `${ref.transactionId}:${ref.index}`, collectorOutputIndex: 0,
        graphArtifactId: codec.graphArtifactId,
      },
    };
  } finally {
    await rpc.disconnect();
  }
}
