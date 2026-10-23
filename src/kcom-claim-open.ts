// @ts-nocheck
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, requireHex32, selectFundingEntry, setVersionOneInputMassFields, utxoAmountSompi } from "./sale-common.js";

const FEE = 60000000n;
const PLACEHOLDER_SIGNATURE = Uint8Array.from([...new Uint8Array(64), 1]);

export async function buildKcomClaimOpen({ options, kw, req, p, codec, graphId, address }) {
  const factoryState = p.factoryState, vaultState = p.vaultState;
  if (!factoryState || !vaultState || factoryState.opened || BigInt(factoryState.next_shard) !== 0n ||
      !vaultState.funded || vaultState.opened || vaultState.settled || vaultState.recovered ||
      BigInt(vaultState.liability_raw) !== 0n || BigInt(vaultState.activated_raw) !== 0n)
    throw new Error("Factory and funded vault are not ready to open");
  for (const key of ["campaign", "terms_hash", "token_id", "budget_raw", "first", "second", "third", "tge_ms"])
    if (String(factoryState[key]) !== String(vaultState[key]))
      throw new Error(`Factory ${key} differs from funded vault`);
  const authorities = [factoryState.first, factoryState.second, factoryState.third]
    .map((value, i) => requireHex32(value, `administrator ${i + 1}`));
  if (new Set(authorities).size !== 3) throw new Error("Frozen administrators are not distinct");
  const publicKeys = p.adminPublicKeys;
  if (!Array.isArray(publicKeys) || publicKeys.length !== 2 ||
      publicKeys.some(key => typeof key !== "string" || !authorities.includes(key)) ||
      publicKeys[0] === publicKeys[1])
    throw new Error("Two distinct frozen administrator public keys required");
  const approvals = p.adminApprovals;
  if (approvals !== undefined && (!Array.isArray(approvals) || approvals.length !== 2 ||
      approvals.some((approval, i) => approval?.publicKey !== publicKeys[i] ||
        typeof approval.signature !== "string" || !/^[0-9a-f]{128}01$/.test(approval.signature))))
    throw new Error("Two ordered SIGHASH_ALL administrator signatures required");
  const factoryScript = codec.script("KCOMFactory", factoryState);
  const vaultScript = codec.script("KCOMVault", vaultState);
  const nextFactoryScript = codec.script("KCOMFactory", { ...factoryState, opened: true });
  const nextVaultScript = codec.script("KCOMVault", { ...vaultState, opened: true });
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
        throw new Error("KCOM_CLAIM_SOURCE_STALE: rebuild from current factory and vault UTXOs");
      return entry;
    }
    const factory = await live(factoryScript, p.factory);
    const vault = await live(vaultScript, p.vault);
    if (p.factory.transactionId === p.vault.transactionId && p.factory.index === p.vault.index)
      throw new Error("Factory and vault sources alias");
    const funding = selectFundingEntry((await rpc.getUtxosByAddresses([address])).entries.filter(e =>
      !refId(e) && ![p.factory, p.vault].some(ref =>
        String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index)), FEE + 10000n);
    const nextFactorySpk = spk(nextFactoryScript), nextVaultSpk = spk(nextVaultScript);
    const sponsorSpk = kw.payToAddressScript(address);
    const factorySpkHex = nextFactorySpk.script, vaultSpkHex = nextVaultSpk.script;
    const sponsorSpkHex = sponsorSpk.script;
    const factoryValue = utxoAmountSompi(factory), vaultValue = utxoAmountSompi(vault);
    const change = utxoAmountSompi(funding) - FEE;
    const outputs = [
      new kw.TransactionOutput(factoryValue, nextFactorySpk, new kw.CovenantBinding(0, new kw.Hash(graphId))),
      new kw.TransactionOutput(vaultValue, nextVaultSpk, new kw.CovenantBinding(0, new kw.Hash(graphId))),
      new kw.TransactionOutput(change, sponsorSpk),
    ];
    const entries = [factory, vault, funding];
    const budgets = [70, 15, 10];
    const inputs = entries.map((e, i) => ({
      previousOutpoint: e.outpoint, utxo: e, sequence: 0n,
      computeBudget: budgets[i], sigOpCount: 0,
    }));
    function factoryWitness(signatures) {
      const witness = new kw.ScriptBuilder();
      for (let i = 0; i < 2; i++) {
        witness.addData(signatures[i]);
        witness.addData(hexToBytes(publicKeys[i]));
      }
      codec.appendHiddenWitness(kw, witness, "KCOMFactory", "open");
      witness.addData(codec.dispatch("KCOMFactory", "open"));
      return kw.ScriptBuilder.fromScript(factoryScript)
        .encodePayToScriptHashSignatureScript(witness.drain());
    }
    inputs[0].signatureScript = factoryWitness([PLACEHOLDER_SIGNATURE, PLACEHOLDER_SIGNATURE]);
    const delegate = new kw.ScriptBuilder();
    codec.appendHiddenWitness(kw, delegate, "KCOMVault", "open");
    delegate.addData(codec.dispatch("KCOMVault", "open"));
    inputs[1].signatureScript = kw.ScriptBuilder.fromScript(vaultScript)
      .encodePayToScriptHashSignatureScript(delegate.drain());
    let tx = new kw.Transaction({
      version: 1, lockTime: 0n, inputs, outputs,
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
      tx = options.transactionWithMinimumCalculatedFeeChange(kw, tx, 2, req.network, req.builderKey);
    if (tx.version !== 1 || tx.lockTime !== 0n || tx.inputs.length !== 3 || tx.outputs.length !== 3 ||
        protectedInputs.some((input, i) => tx.inputs[i].signatureScript !== input.signatureScript ||
          tx.inputs[i].computeBudget !== input.computeBudget || tx.inputs[i].sequence !== input.sequence) ||
        entries.some((e, i) => String(tx.inputs[i].previousOutpoint.transactionId) !== String(e.outpoint.transactionId) ||
          tx.inputs[i].previousOutpoint.index !== e.outpoint.index) ||
        tx.outputs[0].value !== factoryValue || tx.outputs[0].scriptPublicKey.script !== factorySpkHex ||
        String(tx.outputs[0].covenant?.covenantId) !== graphId ||
        tx.outputs[1].value !== vaultValue || tx.outputs[1].scriptPublicKey.script !== vaultSpkHex ||
        String(tx.outputs[1].covenant?.covenantId) !== graphId ||
        tx.outputs[2].covenant || tx.outputs[2].scriptPublicKey.script !== sponsorSpkHex ||
        tx.outputs[2].value <= 10000n || tx.outputs[2].value > change)
      throw new Error("KCOM open fee adjustment changed a custody output or source");
    const signingCommitment = bytesToHex(sha256(new TextEncoder().encode(tx.serializeToSafeJSON())));
    if (approvals) {
      if (p.expectedSigningCommitment !== signingCommitment)
        throw new Error("KCOM_OPEN_SIGNING_INTENT_STALE: rebuild and collect fresh administrator signatures");
      tx.inputs[0].signatureScript = factoryWitness(approvals.map(approval => hexToBytes(approval.signature)));
    }
    return {
      schema: "kcc20-in-process-pskt-builder-output/v1",
      psktTransactionJson: tx.serializeToSafeJSON(),
      signInputs: approvals ? [{ index: 2, sighashType: 1 }] : [],
      submitTransactionSupported: !!approvals,
      metadata: {
        builderKey: req.builderKey, contract: "KCOMFactory", network: req.network,
        graphId, tokenId: factoryState.token_id,
        factoryOutpoint: `${p.factory.transactionId}:${p.factory.index}`,
        vaultOutpoint: `${p.vault.transactionId}:${p.vault.index}`,
        factoryOutputIndex: 0, vaultOutputIndex: 1,
        adminSigning: { inputIndex: 0, sighashType: 1, publicKeys,
          signingCommitment, status: approvals ? "collected" : "awaiting-two-signatures" },
        graphArtifactId: codec.graphArtifactId,
      },
    };
  } finally {
    await rpc.disconnect();
  }
}
