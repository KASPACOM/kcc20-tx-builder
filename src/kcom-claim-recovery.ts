// @ts-nocheck
import { buildKcc20ScriptForState, buildKcc20TransferSigScript,
  normalizeSilverScriptArtifact, ownerAuthorizationWitness, templateParts } from "./abi.js";
import { assertKcc20ArtifactScriptHash } from "./artifacts.js";
import { ADMIN_SIGNATURE_PLACEHOLDER, checkedKcomAdminPair,
  finishKcomAdminIntent, kcomAdminWitness } from "./kcom-claim-admin.js";
import { bytesToHex, hexToBytes, requireHex32, selectFundingEntry,
  setVersionOneInputMassFields, utxoAmountSompi } from "./sale-common.js";

const ZERO32 = "00".repeat(32);
const FEE = 60000000n;
const TOKEN_CELL = 100000000n;
const TOKEN_HASH = "5d6cacdf57c734536fcb8a9c833f0318671226727ec77c503a98fc5be59f9e29";

export async function buildKcomClaimRecovery({ options, kw, req, p, codec, graphId, address, canonicalArtifact }) {
  const state = p.vaultState;
  const budget = BigInt(state?.budget_raw ?? -1);
  const liability = BigInt(state?.liability_raw ?? -1);
  const activated = BigInt(state?.activated_raw ?? -1);
  if (!state?.funded || !state.opened || !state.settled || state.recovered ||
      budget <= 0n || budget > 10000000000000000n ||
      liability < 0n || liability >= budget || activated < 0n || activated > liability ||
      ![0, 1, 2, 3, 4].includes(Number(state.treasury_scheme)))
    throw new Error("Settled vault has no recoverable surplus");
  const { publicKeys, approvals } = checkedKcomAdminPair(p, state);
  const partial = activated < liability;
  const available = budget - activated, surplus = budget - liability;
  const remaining = liability - activated;
  const tokenId = requireHex32(state.token_id, "campaign token id");
  const extension = requireHex32(state.extension, "campaign token extension");
  requireHex32(state.treasury, "frozen treasury");
  const canonical = normalizeSilverScriptArtifact(canonicalArtifact);
  assertKcc20ArtifactScriptHash("KCC20.placeholder.json", canonical);
  const parts = templateParts(canonical);
  if (bytesToHex(parts.hash) !== TOKEN_HASH || parts.prefix.length !== 1 || parts.suffix.length !== 25264)
    throw new Error("Canonical token template does not match recovery covenant");
  const supplied = p.tokenState;
  if (!supplied || BigInt(supplied.amount) !== available ||
      requireHex32(supplied.owner, "token owner") !== graphId || supplied.ownerScheme !== 4 ||
      supplied.borrowScheme !== 0 || supplied.borrowGuard !== ZERO32 ||
      requireHex32(supplied.extensionCommitment, "token extension") !== extension)
    throw new Error("Vault reserve does not match unsettled beneficiary liability and surplus");
  const sourceTokenState = { amount: available, owner: hexToBytes(graphId), ownerScheme: 4,
    borrowScheme: 0, borrowGuard: hexToBytes(ZERO32), extensionCommitment: hexToBytes(extension) };
  const treasuryState = { ...sourceTokenState, amount: surplus,
    owner: hexToBytes(state.treasury), ownerScheme: Number(state.treasury_scheme) };
  const remainingState = { ...sourceTokenState, amount: remaining };
  const tokenStates = partial ? [treasuryState, remainingState] : [treasuryState];
  const vaultScript = codec.script("KCOMVault", state);
  const nextVaultScript = codec.script("KCOMVault", { ...state, recovered: true });
  const sourceTokenScript = buildKcc20ScriptForState(canonical, sourceTokenState);
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
    async function live(script, ref, id) {
      if (!ref || !Number.isSafeInteger(ref.index) || ref.index < 0)
        throw new Error("Recovery source outpoint required");
      requireHex32(ref.transactionId, "recovery source transaction");
      const addr = scriptAddress(script);
      const entry = (await rpc.getUtxosByAddresses([addr])).entries.find(e =>
        String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index);
      const sourceSpk = entry?.scriptPublicKey ?? entry?.entry?.scriptPublicKey ?? entry?.utxoEntry?.scriptPublicKey;
      if (!entry || refId(entry) !== id || !sourceSpk ||
          kw.addressFromScriptPublicKey(sourceSpk, req.network).toString() !== addr)
        throw new Error("KCOM_CLAIM_SOURCE_STALE: rebuild from current vault and token UTXOs");
      return entry;
    }
    const vault = await live(vaultScript, p.vault, graphId);
    const token = await live(sourceTokenScript, p.token, tokenId);
    if (p.vault.transactionId === p.token.transactionId && p.vault.index === p.token.index)
      throw new Error("Vault and token sources alias");
    const tokenNative = utxoAmountSompi(token);
    if (tokenNative < TOKEN_CELL) throw new Error("Token reserve lacks native KAS");
    const tokenValues = partial ? [TOKEN_CELL,
      tokenNative > 2n * TOKEN_CELL ? tokenNative - TOKEN_CELL : TOKEN_CELL] : [tokenNative];
    const topup = tokenValues.reduce((sum, value) => sum + value, 0n) - tokenNative;
    const funding = selectFundingEntry((await rpc.getUtxosByAddresses([address])).entries.filter(e =>
      !refId(e) && ![p.vault, p.token].some(ref =>
        String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index)),
      topup + FEE + 10000n);
    const sponsorSpk = kw.payToAddressScript(address);
    const outputs = [
      new kw.TransactionOutput(utxoAmountSompi(vault), spk(nextVaultScript),
        new kw.CovenantBinding(0, new kw.Hash(graphId))),
      ...tokenStates.map((tokenState, i) => new kw.TransactionOutput(tokenValues[i],
        spk(buildKcc20ScriptForState(canonical, tokenState)),
        new kw.CovenantBinding(1, new kw.Hash(tokenId)))),
      new kw.TransactionOutput(utxoAmountSompi(funding) - topup - FEE, sponsorSpk),
    ];
    const expectedOutputs = outputs.map(out => ({ value: out.value, script: out.scriptPublicKey.script,
      covenantId: String(out.covenant?.covenantId ?? "") }));
    const entries = [vault, token, funding], budgets = [120, 35, 10];
    const inputs = entries.map((e, i) => ({ previousOutpoint: e.outpoint, utxo: e,
      sequence: 0n, computeBudget: budgets[i], sigOpCount: 0 }));
    const entry = partial ? "recover_partial" : "recover_final";
    const appendExplicit = witness => {
      witness.addI64(1n); witness.addI64(1n);
      if (partial) witness.addI64(2n);
      witness.addData(parts.prefix); witness.addData(parts.suffix);
    };
    inputs[0].signatureScript = kcomAdminWitness(kw, codec, vaultScript, "KCOMVault", entry,
      publicKeys, [ADMIN_SIGNATURE_PLACEHOLDER, ADMIN_SIGNATURE_PLACEHOLDER], appendExplicit);
    inputs[1].signatureScript = kw.ScriptBuilder.fromScript(sourceTokenScript)
      .encodePayToScriptHashSignatureScript(buildKcc20TransferSigScript(kw, canonical, {
        nextStates: tokenStates, witness: ownerAuthorizationWitness(new Uint8Array()),
      }));
    let tx = new kw.Transaction({ version: 1, lockTime: 0n, inputs, outputs,
      subnetworkId: "00".repeat(20), gas: 0n, payload: "" });
    setVersionOneInputMassFields(tx, budgets[0]);
    tx.inputs[1].computeBudget = budgets[1]; tx.inputs[2].computeBudget = budgets[2];
    const protectedInputs = [0, 1].map(i => ({ signatureScript: tx.inputs[i].signatureScript,
      computeBudget: tx.inputs[i].computeBudget, sequence: tx.inputs[i].sequence }));
    if (options.transactionWithMinimumCalculatedFeeChange)
      tx = options.transactionWithMinimumCalculatedFeeChange(kw, tx, outputs.length - 1, req.network, req.builderKey);
    if (tx.version !== 1 || tx.lockTime !== 0n || tx.inputs.length !== 3 ||
        tx.outputs.length !== outputs.length ||
        protectedInputs.some((input, i) => tx.inputs[i].signatureScript !== input.signatureScript ||
          tx.inputs[i].computeBudget !== input.computeBudget || tx.inputs[i].sequence !== input.sequence) ||
        entries.some((e, i) => String(tx.inputs[i].previousOutpoint.transactionId) !== String(e.outpoint.transactionId) ||
          tx.inputs[i].previousOutpoint.index !== e.outpoint.index) ||
        tx.outputs.some((out, i) => out.scriptPublicKey.script !== expectedOutputs[i].script ||
          String(out.covenant?.covenantId ?? "") !== expectedOutputs[i].covenantId ||
          (i < outputs.length - 1 && out.value !== expectedOutputs[i].value)) ||
        tx.outputs.at(-1).value <= 10000n ||
        tx.outputs.at(-1).value > expectedOutputs.at(-1).value)
      throw new Error("KCOM recovery fee adjustment changed a custody output or source");
    const { adminSigning } = finishKcomAdminIntent({ kw, tx, params: p, codec,
      sourceScript: vaultScript, actor: "KCOMVault", entry, publicKeys, approvals, appendExplicit });
    return { schema: "kcc20-in-process-pskt-builder-output/v1",
      psktTransactionJson: tx.serializeToSafeJSON(),
      signInputs: approvals ? [{ index: 2, sighashType: 1 }] : [],
      submitTransactionSupported: !!approvals,
      metadata: { builderKey: req.builderKey, contract: "KCOMVault", network: req.network,
        graphId, tokenId, partial, surplusRaw: String(surplus), remainingLiabilityRaw: String(remaining),
        vaultOutpoint: `${p.vault.transactionId}:${p.vault.index}`,
        tokenOutpoint: `${p.token.transactionId}:${p.token.index}`,
        vaultOutputIndex: 0, treasuryOutputIndex: 1, remainingReserveOutputIndex: partial ? 2 : null,
        adminSigning, graphArtifactId: codec.graphArtifactId },
    };
  } finally { await rpc.disconnect(); }
}
