// @ts-nocheck
import { ADMIN_SIGNATURE_PLACEHOLDER, checkedKcomAdminPair, finishKcomAdminIntent, kcomAdminWitness } from "./kcom-claim-admin.js";
import { requireHex32, selectFundingEntry, setVersionOneInputMassFields, utxoAmountSompi } from "./sale-common.js";

const FEE = 60000000n;

export async function buildKcomClaimClose({ options, kw, req, p, codec, graphId, address }) {
  const state = p.shardState;
  const shardCount = BigInt(state?.shard_count ?? -1);
  const shard = BigInt(state?.shard ?? -1);
  const leaves = BigInt(state?.leaf_count ?? -1);
  const selected = BigInt(state?.selected_count ?? -1);
  const all = BigInt(state?.all_weight ?? -1);
  const boosted = BigInt(state?.boosted_weight ?? -1);
  const long = BigInt(state?.long_weight ?? -1);
  const budget = BigInt(state?.budget_raw ?? -1);
  const manifest = BigInt(state?.manifest_total ?? -1);
  const opens = BigInt(state?.opens_ms ?? -1);
  const closes = BigInt(state?.closes_ms ?? -1);
  if (!state || state.closed || shardCount < 1n || shardCount > 1048576n ||
      (shardCount & (shardCount - 1n)) !== 0n || shard < 0n || shard >= shardCount ||
      leaves < 1n || leaves > 1048576n || selected < 0n || selected > leaves ||
      !(budget === 10000000000000000n ||
        (budget >= 10n && budget <= 20000n && budget % 10n === 0n)) ||
      manifest <= 0n || manifest > budget / 5n ||
      all < 0n || all > manifest || boosted < 0n || boosted > all ||
      long < 0n || long > boosted || opens < 500000000000n ||
      closes !== opens + 2592000000n || closes > 9223372034262775806n)
    throw new Error("Claim shard is not ready for frozen-window close");
  requireHex32(state.token_id, "campaign token id");
  const { publicKeys, approvals } = checkedKcomAdminPair(p, state);
  const sourceScript = codec.script("KCOMClaimShard", state);
  const nextScript = codec.script("KCOMClaimShard", { ...state, closed: true });
  const rpc = options.rpcClientFactory?.({
    url: options.config?.KASPA_WRPC_URL || "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh",
    encoding: kw.Encoding.Borsh, networkId: req.network,
  }) ?? new kw.RpcClient({
    url: options.config?.KASPA_WRPC_URL || "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh",
    encoding: kw.Encoding.Borsh, networkId: req.network,
  });
  const sourceAddress = kw.addressFromScriptPublicKey(kw.payToScriptHashScript(sourceScript), req.network).toString();
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
      FEE + 10000n);
    const nextSpk = kw.payToScriptHashScript(nextScript), sponsorSpk = kw.payToAddressScript(address);
    const nextSpkHex = nextSpk.script, sponsorSpkHex = sponsorSpk.script;
    const value = utxoAmountSompi(source), change = utxoAmountSompi(funding) - FEE;
    const outputs = [
      new kw.TransactionOutput(value, nextSpk, new kw.CovenantBinding(0, new kw.Hash(graphId))),
      new kw.TransactionOutput(change, sponsorSpk),
    ];
    const inputs = [source, funding].map((e, i) => ({
      previousOutpoint: e.outpoint, utxo: e, sequence: 0n,
      computeBudget: i === 0 ? 50 : 10, sigOpCount: 0,
    }));
    inputs[0].signatureScript = kcomAdminWitness(kw, codec, sourceScript, "KCOMClaimShard", "close",
      publicKeys, [ADMIN_SIGNATURE_PLACEHOLDER, ADMIN_SIGNATURE_PLACEHOLDER]);
    let tx = new kw.Transaction({
      version: 1, lockTime: closes + 1n, inputs, outputs,
      subnetworkId: "00".repeat(20), gas: 0n, payload: "",
    });
    setVersionOneInputMassFields(tx, 50);
    tx.inputs[1].computeBudget = 10;
    const sourceWitness = tx.inputs[0].signatureScript;
    if (options.transactionWithMinimumCalculatedFeeChange)
      tx = options.transactionWithMinimumCalculatedFeeChange(kw, tx, 1, req.network, req.builderKey);
    if (tx.version !== 1 || tx.lockTime !== closes + 1n || tx.inputs.length !== 2 || tx.outputs.length !== 2 ||
        tx.inputs[0].signatureScript !== sourceWitness || tx.inputs[0].computeBudget !== 50 ||
        tx.inputs[0].sequence !== 0n ||
        String(tx.inputs[0].previousOutpoint.transactionId) !== ref.transactionId ||
        tx.inputs[0].previousOutpoint.index !== ref.index ||
        String(tx.inputs[1].previousOutpoint.transactionId) !== String(funding.outpoint.transactionId) ||
        tx.inputs[1].previousOutpoint.index !== funding.outpoint.index ||
        String(tx.outputs[0].covenant?.covenantId) !== graphId ||
        tx.outputs[0].scriptPublicKey.script !== nextSpkHex || tx.outputs[0].value !== value ||
        tx.outputs[1].covenant || tx.outputs[1].scriptPublicKey.script !== sponsorSpkHex ||
        tx.outputs[1].value <= 10000n || tx.outputs[1].value > change)
      throw new Error("KCOM close fee adjustment changed a custody output or source");
    const { adminSigning } = finishKcomAdminIntent({ kw, tx, params: p, codec,
      sourceScript, actor: "KCOMClaimShard", entry: "close", publicKeys, approvals });
    return {
      schema: "kcc20-in-process-pskt-builder-output/v1",
      psktTransactionJson: tx.serializeToSafeJSON(),
      signInputs: approvals ? [{ index: 1, sighashType: 1 }] : [],
      submitTransactionSupported: !!approvals,
      metadata: {
        builderKey: req.builderKey, contract: "KCOMClaimShard", network: req.network,
        graphId, tokenId: state.token_id, shard: String(shard), closesMs: String(closes),
        shardOutpoint: `${ref.transactionId}:${ref.index}`, closedOutputIndex: 0,
        adminSigning, graphArtifactId: codec.graphArtifactId,
      },
    };
  } finally {
    await rpc.disconnect();
  }
}
