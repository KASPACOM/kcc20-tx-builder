// @ts-nocheck
import {
  buildKcc20ScriptForState,
  buildKcc20TransferSigScript,
  normalizeSilverScriptArtifact,
  ownerAuthorizationWitness,
  templateParts,
} from "./abi.js";
import { assertKcc20ArtifactScriptHash } from "./artifacts.js";
import { kcomVestingCodec } from "./kcom-vesting.js";
import {
  bytesToHex,
  hexToBytes,
  requireHex32,
  selectFundingEntry,
  setVersionOneInputMassFields,
  utxoAmountSompi,
} from "./sale-common.js";

const ZERO32 = "00".repeat(32);
const FEE = 60000000n;
const TOKEN_CELL = 100000000n;
const TOKEN_HASH = "5d6cacdf57c734536fcb8a9c833f0318671226727ec77c503a98fc5be59f9e29";

export async function buildKcomClaimActivation({ options, kw, req, p, codec, graphId, address, canonicalArtifact, vestingArtifact }) {
  const vaultState = p.vaultState, entitlementState = p.entitlementState;
  if (!vaultState?.funded || !vaultState.opened || !vaultState.settled)
    throw new Error("Campaign vault is not settled");
  const liability = BigInt(vaultState.liability_raw);
  const activated = BigInt(vaultState.activated_raw);
  const budget = BigInt(vaultState.budget_raw);
  const total = BigInt(entitlementState?.total ?? 0);
  const tokenId = requireHex32(vaultState.token_id, "campaign token id");
  if (budget <= 0n || liability <= 0n || liability > budget || activated < 0n || activated >= liability ||
      total <= 0n || total > liability - activated ||
      entitlementState.campaign !== vaultState.campaign ||
      entitlementState.terms_hash !== vaultState.terms_hash ||
      entitlementState.token_id !== tokenId ||
      String(entitlementState.tge_ms) !== String(vaultState.tge_ms) ||
      String(entitlementState.budget_raw) !== String(vaultState.budget_raw) ||
      ![1, 2, 3].includes(Number(entitlementState.tier)) ||
      ![0, 1, 2, 3, 4].includes(Number(entitlementState.beneficiary_scheme)))
    throw new Error("Entitlement does not match settled vault liability");
  const available = vaultState.recovered ? liability - activated : budget - activated;
  const final = total === available && total === liability - activated;
  if (!final && total >= available)
    throw new Error("Entitlement exceeds vault token reserve");

  const canonical = normalizeSilverScriptArtifact(canonicalArtifact);
  assertKcc20ArtifactScriptHash("KCC20.placeholder.json", canonical);
  const parts = templateParts(canonical);
  if (bytesToHex(parts.hash) !== TOKEN_HASH || parts.prefix.length !== 1 || parts.suffix.length !== 25264)
    throw new Error("Canonical token template does not match activation covenant");
  const vesting = kcomVestingCodec(vestingArtifact);
  const positionState = {
    token_id: tokenId, beneficiary: entitlementState.beneficiary,
    beneficiary_scheme: entitlementState.beneficiary_scheme,
    extension: vaultState.extension, total: String(total), released: "0",
    tier: String(entitlementState.tier), tge_ms: String(vaultState.tge_ms),
    token_prefix_len: "1", token_suffix_len: "25264", token_template_hash: TOKEN_HASH,
  };
  const positionScript = vesting.script(positionState);
  const vaultScript = codec.script("KCOMVault", vaultState);
  const entitlementScript = codec.script("KCOMEntitlement", entitlementState);
  const nextVaultScript = codec.script("KCOMVault", { ...vaultState, activated_raw: String(activated + total) });
  const sourceTokenState = {
    amount: available, owner: hexToBytes(graphId), ownerScheme: 4,
    borrowScheme: 0, borrowGuard: hexToBytes(ZERO32),
    extensionCommitment: hexToBytes(requireHex32(vaultState.extension, "token extension")),
  };
  const supplied = p.tokenState;
  if (!supplied || BigInt(supplied.amount) !== available ||
      requireHex32(supplied.owner, "token owner") !== graphId || supplied.ownerScheme !== 4 ||
      supplied.borrowScheme !== 0 || supplied.borrowGuard !== ZERO32 ||
      requireHex32(supplied.extensionCommitment, "token extension") !== vaultState.extension)
    throw new Error("Vault token reserve does not match settled liability");
  const sourceTokenScript = buildKcc20ScriptForState(canonical, sourceTokenState);
  const rpc = options.rpcClientFactory?.({
    url: options.config?.KASPA_WRPC_URL || "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh",
    encoding: kw.Encoding.Borsh, networkId: req.network,
  }) ?? new kw.RpcClient({
    url: options.config?.KASPA_WRPC_URL || "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh",
    encoding: kw.Encoding.Borsh, networkId: req.network,
  });
  const spk = (script) => kw.payToScriptHashScript(script);
  const scriptAddress = (script) => kw.addressFromScriptPublicKey(spk(script), req.network).toString();
  const refId = (entry) => String(entry.entry?.covenantId ?? entry.covenantId ?? "");
  const query = async (addr) => (await rpc.getUtxosByAddresses([addr])).entries;
  async function live(script, ref, id) {
    if (!ref || !Number.isSafeInteger(ref.index) || ref.index < 0)
      throw new Error("Source outpoint required");
    requireHex32(ref.transactionId, "source transaction");
    const entry = (await query(scriptAddress(script))).find(e =>
      String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index);
    const sourceScript = entry?.scriptPublicKey ?? entry?.entry?.scriptPublicKey ?? entry?.utxoEntry?.scriptPublicKey;
    if (!entry || refId(entry) !== id || !sourceScript ||
        kw.addressFromScriptPublicKey(sourceScript, req.network).toString() !== scriptAddress(script))
      throw new Error("KCOM_CLAIM_SOURCE_STALE: rebuild from current accepted UTXOs");
    return entry;
  }
  await rpc.connect();
  try {
    const vault = await live(vaultScript, p.vault, graphId);
    const entitlement = await live(entitlementScript, p.entitlement, graphId);
    const token = await live(sourceTokenScript, p.token, tokenId);
    const nativeToken = utxoAmountSompi(token);
    if (nativeToken < TOKEN_CELL) throw new Error("Token reserve lacks native KAS");
    const positionOutput = new kw.TransactionOutput(utxoAmountSompi(entitlement), spk(positionScript));
    const positionId = kw.covenantId(vault.outpoint, [{ index: 1, output: positionOutput }]).toString();
    const positionTokenState = { ...sourceTokenState, amount: total, owner: hexToBytes(positionId) };
    const remainingTokenState = { ...sourceTokenState, amount: available - total };
    const tokenStates = final ? [positionTokenState] : [positionTokenState, remainingTokenState];
    const tokenValues = final ? [nativeToken] : [TOKEN_CELL, nativeToken > 2n * TOKEN_CELL ? nativeToken - TOKEN_CELL : TOKEN_CELL];
    const topup = tokenValues.reduce((a, b) => a + b, 0n) - nativeToken;
    const refs = [p.vault, p.entitlement, p.token];
    const funding = selectFundingEntry((await query(address)).filter(e =>
      !refId(e) && !refs.some(ref =>
        String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index)), topup + FEE + 10000n);
    const outputs = [
      new kw.TransactionOutput(utxoAmountSompi(vault), spk(nextVaultScript), new kw.CovenantBinding(0, new kw.Hash(graphId))),
      positionOutput,
      ...tokenStates.map((state, i) => new kw.TransactionOutput(
        tokenValues[i], spk(buildKcc20ScriptForState(canonical, state)),
        new kw.CovenantBinding(2, new kw.Hash(tokenId)))),
      new kw.TransactionOutput(utxoAmountSompi(funding) - topup - FEE, kw.payToAddressScript(address)),
    ];
    // Preserve primitives before the fee callback; WASM output wrappers may share mutable backing state.
    const expectedOutputs = outputs.map(out => ({ value: out.value, script: out.scriptPublicKey.script }));
    const budgets = final ? [70, 15, 25, 10] : [100, 15, 35, 10];
    const inputs = [vault, entitlement, token, funding].map((entry, i) => ({
      previousOutpoint: entry.outpoint, utxo: entry, sequence: 0n,
      computeBudget: budgets[i], sigOpCount: 0,
    }));
    const vaultWitness = new kw.ScriptBuilder();
    vaultWitness.addI64(2n); vaultWitness.addI64(2n);
    if (!final) vaultWitness.addI64(3n);
    vaultWitness.addData(parts.prefix); vaultWitness.addData(parts.suffix);
    codec.appendHiddenWitness(kw, vaultWitness, "KCOMVault", final ? "activate_final" : "activate_partial", {
      externalTemplates: { "KCOMClaimVesting::KCOMVesting": templateParts(vestingArtifact.sil_abi) },
      spawnOutputIndex: 1,
    });
    vaultWitness.addData(codec.dispatch("KCOMVault", final ? "activate_final" : "activate_partial"));
    inputs[0].signatureScript = kw.ScriptBuilder.fromScript(vaultScript).encodePayToScriptHashSignatureScript(vaultWitness.drain());
    const entitlementWitness = new kw.ScriptBuilder();
    codec.appendHiddenWitness(kw, entitlementWitness, "KCOMEntitlement", final ? "activate_final" : "activate_partial");
    entitlementWitness.addData(codec.dispatch("KCOMEntitlement", final ? "activate_final" : "activate_partial"));
    inputs[1].signatureScript = kw.ScriptBuilder.fromScript(entitlementScript).encodePayToScriptHashSignatureScript(entitlementWitness.drain());
    inputs[2].signatureScript = kw.ScriptBuilder.fromScript(sourceTokenScript).encodePayToScriptHashSignatureScript(
      buildKcc20TransferSigScript(kw, canonical, {
        nextStates: tokenStates, witness: ownerAuthorizationWitness(new Uint8Array()),
      }));
    let tx = new kw.Transaction({
      version: 1, lockTime: 0n, inputs, outputs,
      subnetworkId: "00".repeat(20), gas: 0n, payload: "",
    });
    setVersionOneInputMassFields(tx, budgets[0]);
    for (let i = 1; i < budgets.length; i++) tx.inputs[i].computeBudget = budgets[i];
    tx.populateGenesisCovenants([new kw.GenesisCovenantGroup(0, [1])]);
    tx.finalize();
    if (options.transactionWithMinimumCalculatedFeeChange)
      tx = options.transactionWithMinimumCalculatedFeeChange(kw, tx, outputs.length - 1, req.network, req.builderKey);
    const expectedIds = [graphId, positionId, ...tokenStates.map(() => tokenId), ""];
    if (tx.outputs.length !== outputs.length || String(tx.outputs[1].covenant?.covenantId) !== positionId ||
        tx.outputs.some((out, i) =>
          (out.value !== expectedOutputs[i].value && i !== outputs.length - 1) ||
          out.scriptPublicKey.script !== expectedOutputs[i].script ||
          String(out.covenant?.covenantId ?? "") !== expectedIds[i]) ||
        tx.outputs.at(-1).value <= 10000n || tx.outputs.at(-1).value > expectedOutputs.at(-1).value ||
        tx.inputs.length !== 4 ||
        [vault, entitlement, token, funding].some((entry, i) =>
          String(tx.inputs[i].previousOutpoint.transactionId) !== String(entry.outpoint.transactionId) ||
          tx.inputs[i].previousOutpoint.index !== entry.outpoint.index))
      throw new Error("KCOM activation fee adjustment changed a custody output or source");
    return {
      schema: "kcc20-in-process-pskt-builder-output/v1",
      psktTransactionJson: tx.serializeToSafeJSON(),
      signInputs: [{ index: 3, sighashType: 1 }],
      submitTransactionSupported: true,
      metadata: {
        builderKey: req.builderKey, contract: "KCOMVault", network: req.network,
        graphId, tokenId, positionId, positionState,
        allocationRaw: String(total), final,
        vaultOutpoint: `${p.vault.transactionId}:${p.vault.index}`,
        entitlementOutpoint: `${p.entitlement.transactionId}:${p.entitlement.index}`,
        tokenOutpoint: `${p.token.transactionId}:${p.token.index}`,
        vaultOutputIndex: 0, positionOutputIndex: 1, positionReserveOutputIndex: 2,
        vaultReserveOutputIndex: final ? null : 3,
        graphArtifactId: codec.graphArtifactId, vestingArtifactId: vesting.artifactId,
      },
    };
  } finally {
    await rpc.disconnect();
  }
}
