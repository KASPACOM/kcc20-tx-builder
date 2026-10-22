// @ts-nocheck
import {
  buildKcc20ScriptForState,
  buildKcc20TransferSigScript,
  normalizeSilverScriptArtifact,
  ownerAuthorizationWitness,
  templateParts,
} from "./abi.js";
import { assertKcc20ArtifactScriptHash } from "./artifacts.js";
import { kcomClaimCodec } from "./kcom-claim-codec.js";
import {
  hexToBytes,
  requireHex32,
  selectFundingEntry,
  setVersionOneInputMassFields,
  utxoAmountSompi,
} from "./sale-common.js";

export const KCOM_CLAIM_BUILDER_KEYS = ["kcom-claim.fund-vault"] as const;
const ZERO32 = "00".repeat(32);
const FEE = 60000000n;

export function createKcomClaimPsktBuilder(options) {
  const kw = options.wasm;
  const load = async (key) => options.artifacts?.[key] ?? (await options.artifactProvider?.(key));
  return async (input) => {
    if (input.schema !== "kcc20-in-process-pskt-builder-input/v1")
      throw new Error("Invalid builder input schema");
    const req = input.request ?? {}, p = req.params ?? {};
    if (req.network !== "testnet-10") throw new Error("KCOM claim builders are TN10-only");
    if (req.builderKey !== "kcom-claim.fund-vault") throw new Error("Unsupported KCOM claim operation");
    const address = req.owner?.walletAddress;
    if (typeof address !== "string" || !address.startsWith("kaspatest:"))
      throw new Error("TN10 funding wallet required");
    const graphId = requireHex32(p.graphId, "graph covenant id");
    const codec = kcomClaimCodec({
      graph: await load("KCOMClaimGraph.artifact.json"),
      opening: await load("KCOMClaimOpen.artifact.json"),
    });
    const canonical = normalizeSilverScriptArtifact(await load("KCC20.placeholder.json"));
    assertKcc20ArtifactScriptHash("KCC20.placeholder.json", canonical);
    const parts = templateParts(canonical);
    const s = p.vaultState;
    const budget = BigInt(s?.budget_raw ?? "-1");
    if (budget <= 0n || budget > 10000000000000000n || s.funded || s.opened || s.settled || s.recovered ||
      BigInt(s.liability_raw) !== 0n || BigInt(s.activated_raw) !== 0n)
      throw new Error("Vault is not awaiting complete funding");
    const tokenId = requireHex32(s.token_id, "campaign token id");
    const tokenState = p.tokenState;
    if (!tokenState || BigInt(tokenState.amount) !== budget || tokenState.ownerScheme !== 4 ||
      requireHex32(tokenState.owner, "token reserve owner") !== graphId ||
      tokenState.borrowScheme !== 0 || tokenState.borrowGuard !== ZERO32 ||
      requireHex32(tokenState.extensionCommitment, "token extension") !== s.extension)
      throw new Error("Canonical campaign token source is not graph owned");
    const next = { ...s, funded: true };
    const vaultScript = codec.script("KCOMVault", s);
    const nextVaultScript = codec.script("KCOMVault", next);
    const token = {
      amount: budget,
      owner: hexToBytes(graphId), ownerScheme: 4,
      borrowScheme: 0, borrowGuard: hexToBytes(ZERO32),
      extensionCommitment: hexToBytes(s.extension),
    };
    const tokenScript = buildKcc20ScriptForState(canonical, token);
    const rpc = options.rpcClientFactory?.({
      url: options.config?.KASPA_WRPC_URL || "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh",
      encoding: kw.Encoding.Borsh, networkId: req.network,
    }) ?? new kw.RpcClient({
      url: options.config?.KASPA_WRPC_URL || "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh",
      encoding: kw.Encoding.Borsh, networkId: req.network,
    });
    const scriptAddress = (script) => kw.addressFromScriptPublicKey(kw.payToScriptHashScript(script), req.network).toString();
    const refId = (entry) => String(entry.entry?.covenantId ?? entry.covenantId ?? "");
    const query = async (addr) => (await rpc.getUtxosByAddresses([addr])).entries;
    async function live(script, ref, id) {
      if (!ref || !Number.isSafeInteger(ref.index) || ref.index < 0)
        throw new Error("Source outpoint required");
      requireHex32(ref.transactionId, "source transaction");
      const entry = (await query(scriptAddress(script))).find(e =>
        String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index);
      if (!entry || refId(entry) !== id)
        throw new Error("KCOM_CLAIM_SOURCE_STALE: rebuild from current covenant UTXO");
      const sourceScript = entry.scriptPublicKey ?? entry.entry?.scriptPublicKey ?? entry.utxoEntry?.scriptPublicKey;
      if (!sourceScript || kw.addressFromScriptPublicKey(sourceScript, req.network).toString() !== scriptAddress(script))
        throw new Error("KCOM_CLAIM_SOURCE_STALE: source script differs from reconstructed state");
      return entry;
    }
    await rpc.connect();
    try {
      const vault = await live(vaultScript, p.vault, graphId);
      const reserve = await live(tokenScript, p.token, tokenId);
      const funding = selectFundingEntry((await query(address)).filter(e =>
        !refId(e) && ![p.vault, p.token].some(ref =>
          String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index)), FEE + 10000n);
      const tokenInput = {
        ...token,
        borrowGuard: hexToBytes(ZERO32),
      };
      const outputs = [
        new kw.TransactionOutput(utxoAmountSompi(vault), kw.payToScriptHashScript(nextVaultScript), new kw.CovenantBinding(0, new kw.Hash(graphId))),
        new kw.TransactionOutput(utxoAmountSompi(reserve), kw.payToScriptHashScript(tokenScript), new kw.CovenantBinding(1, new kw.Hash(tokenId))),
        new kw.TransactionOutput(utxoAmountSompi(funding) - FEE, kw.payToAddressScript(address)),
      ];
      const inputs = [vault, reserve, funding].map((e, i) => ({
        previousOutpoint: e.outpoint, utxo: e, sequence: 0n,
        computeBudget: [60, 20, 10][i], sigOpCount: 0,
      }));
      const v = new kw.ScriptBuilder();
      v.addI64(1n); v.addI64(1n); v.addData(parts.prefix); v.addData(parts.suffix);
      v.addData(codec.dispatch("KCOMVault", "fund"));
      inputs[0].signatureScript = kw.ScriptBuilder.fromScript(vaultScript).encodePayToScriptHashSignatureScript(v.drain());
      inputs[1].signatureScript = kw.ScriptBuilder.fromScript(tokenScript).encodePayToScriptHashSignatureScript(
        buildKcc20TransferSigScript(kw, canonical, { nextStates: [tokenInput], witness: ownerAuthorizationWitness(new Uint8Array()) }));
      let tx = new kw.Transaction({
        version: 1, lockTime: 0n, inputs, outputs,
        subnetworkId: "00".repeat(20), gas: 0n, payload: "",
      });
      setVersionOneInputMassFields(tx, 60);
      tx.inputs[1].computeBudget = 20;
      tx.inputs[2].computeBudget = 10;
      if (options.transactionWithMinimumCalculatedFeeChange)
        tx = options.transactionWithMinimumCalculatedFeeChange(kw, tx, 2, req.network, req.builderKey);
      if (tx.outputs.length !== 3 ||
        tx.outputs[0].scriptPublicKey.script !== kw.payToScriptHashScript(nextVaultScript).script ||
        String(tx.outputs[0].covenant?.covenantId) !== graphId ||
        tx.outputs[0].value !== utxoAmountSompi(vault) ||
        tx.outputs[1].scriptPublicKey.script !== kw.payToScriptHashScript(tokenScript).script ||
        String(tx.outputs[1].covenant?.covenantId) !== tokenId ||
        tx.outputs[1].value !== utxoAmountSompi(reserve))
        throw new Error("KCOM claim fee adjustment changed a custody output");
      return {
        schema: "kcc20-in-process-pskt-builder-output/v1",
        psktTransactionJson: tx.serializeToSafeJSON(),
        signInputs: [{ index: 2, sighashType: 1 }],
        submitTransactionSupported: true,
        metadata: {
          builderKey: req.builderKey, contract: "KCOMVault", network: req.network,
          graphId, tokenId, budgetRaw: String(budget),
          vaultOutpoint: `${p.vault.transactionId}:${p.vault.index}`,
          tokenOutpoint: `${p.token.transactionId}:${p.token.index}`,
          vaultOutputIndex: 0, reserveOutputIndex: 1,
          graphArtifactId: codec.graphArtifactId, openingArtifactId: codec.openingArtifactId,
        },
      };
    } finally {
      await rpc.disconnect();
    }
  };
}
