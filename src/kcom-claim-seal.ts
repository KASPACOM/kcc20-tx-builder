// @ts-nocheck
import { requireHex32, selectFundingEntry, setVersionOneInputMassFields, utxoAmountSompi } from "./sale-common.js";

const FEE = 60000000n;

export async function buildKcomClaimSeal({ options, kw, req, p, codec, graphId, address }) {
  const vaultState = p.vaultState, collectorState = p.collectorState;
  if (!vaultState?.funded || !vaultState.opened || vaultState.settled || vaultState.recovered ||
      BigInt(vaultState.liability_raw) !== 0n || BigInt(vaultState.activated_raw) !== 0n)
    throw new Error("Campaign vault cannot seal liabilities");
  const liability = BigInt(collectorState?.liability_raw ?? -1);
  const budget = BigInt(vaultState.budget_raw);
  if (!collectorState?.collection_complete || !collectorState.settlement_complete ||
      BigInt(collectorState.next_shard) !== BigInt(collectorState.shard_count) ||
      BigInt(collectorState.settled_count) !== BigInt(collectorState.selected_count) ||
      liability < 0n || liability > budget ||
      collectorState.campaign !== vaultState.campaign ||
      collectorState.terms_hash !== vaultState.terms_hash ||
      collectorState.token_id !== vaultState.token_id ||
      String(collectorState.tge_ms) !== String(vaultState.tge_ms) ||
      String(collectorState.budget_raw) !== String(vaultState.budget_raw) ||
      collectorState.first !== vaultState.first ||
      collectorState.second !== vaultState.second ||
      collectorState.third !== vaultState.third)
    throw new Error("Settlement collector is incomplete or differs from vault terms");
  requireHex32(vaultState.token_id, "campaign token id");
  const vaultScript = codec.script("KCOMVault", vaultState);
  const collectorScript = codec.script("KCOMSettlement", collectorState);
  const nextVaultScript = codec.script("KCOMVault", {
    ...vaultState, settled: true, recovered: false,
    liability_raw: String(liability), activated_raw: "0",
  });
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
  const query = async addr => (await rpc.getUtxosByAddresses([addr])).entries;
  async function live(script, ref) {
    if (!ref || !Number.isSafeInteger(ref.index) || ref.index < 0)
      throw new Error("Source outpoint required");
    requireHex32(ref.transactionId, "source transaction");
    const entry = (await query(scriptAddress(script))).find(e =>
      String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index);
    const sourceScript = entry?.scriptPublicKey ?? entry?.entry?.scriptPublicKey ?? entry?.utxoEntry?.scriptPublicKey;
    if (!entry || refId(entry) !== graphId || !sourceScript ||
        kw.addressFromScriptPublicKey(sourceScript, req.network).toString() !== scriptAddress(script))
      throw new Error("KCOM_CLAIM_SOURCE_STALE: rebuild from current vault and collector UTXOs");
    return entry;
  }
  await rpc.connect();
  try {
    const vault = await live(vaultScript, p.vault);
    const collector = await live(collectorScript, p.collector);
    const funding = selectFundingEntry((await query(address)).filter(e =>
      !refId(e) && ![p.vault, p.collector].some(ref =>
        String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index)), FEE + 10000n);
    const sealedValue = utxoAmountSompi(vault) + utxoAmountSompi(collector);
    const sponsorChange = utxoAmountSompi(funding) - FEE;
    const sealedSpk = spk(nextVaultScript).script;
    const sponsorSpk = kw.payToAddressScript(address).script;
    const outputs = [
      new kw.TransactionOutput(sealedValue, spk(nextVaultScript), new kw.CovenantBinding(0, new kw.Hash(graphId))),
      new kw.TransactionOutput(sponsorChange, kw.payToAddressScript(address)),
    ];
    const budgets = [40, 25, 10];
    const inputs = [vault, collector, funding].map((entry, i) => ({
      previousOutpoint: entry.outpoint, utxo: entry, sequence: 0n,
      computeBudget: budgets[i], sigOpCount: 0,
    }));
    for (const [i, script, actor] of [[0, vaultScript, "KCOMVault"], [1, collectorScript, "KCOMSettlement"]]) {
      const witness = new kw.ScriptBuilder();
      witness.addData(codec.dispatch(actor, "seal"));
      inputs[i].signatureScript = kw.ScriptBuilder.fromScript(script).encodePayToScriptHashSignatureScript(witness.drain());
    }
    let tx = new kw.Transaction({
      version: 1, lockTime: 0n, inputs, outputs,
      subnetworkId: "00".repeat(20), gas: 0n, payload: "",
    });
    setVersionOneInputMassFields(tx, budgets[0]);
    tx.inputs[1].computeBudget = budgets[1];
    tx.inputs[2].computeBudget = budgets[2];
    if (options.transactionWithMinimumCalculatedFeeChange)
      tx = options.transactionWithMinimumCalculatedFeeChange(kw, tx, 1, req.network, req.builderKey);
    if (tx.inputs.length !== 3 || tx.outputs.length !== 2 ||
        String(tx.outputs[0].covenant?.covenantId) !== graphId ||
        tx.outputs[0].scriptPublicKey.script !== sealedSpk ||
        tx.outputs[0].value !== sealedValue ||
        tx.outputs[1].covenant ||
        tx.outputs[1].scriptPublicKey.script !== sponsorSpk ||
        tx.outputs[1].value <= 10000n || tx.outputs[1].value > sponsorChange ||
        [vault, collector, funding].some((entry, i) =>
          String(tx.inputs[i].previousOutpoint.transactionId) !== String(entry.outpoint.transactionId) ||
          tx.inputs[i].previousOutpoint.index !== entry.outpoint.index))
      throw new Error("KCOM seal fee adjustment changed a custody output or source");
    return {
      schema: "kcc20-in-process-pskt-builder-output/v1",
      psktTransactionJson: tx.serializeToSafeJSON(),
      signInputs: [{ index: 2, sighashType: 1 }],
      submitTransactionSupported: true,
      metadata: {
        builderKey: req.builderKey, contract: "KCOMVault", network: req.network,
        graphId, tokenId: vaultState.token_id, liabilityRaw: String(liability),
        vaultOutpoint: `${p.vault.transactionId}:${p.vault.index}`,
        collectorOutpoint: `${p.collector.transactionId}:${p.collector.index}`,
        vaultOutputIndex: 0, graphArtifactId: codec.graphArtifactId,
      },
    };
  } finally {
    await rpc.disconnect();
  }
}
