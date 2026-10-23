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
import { buildKcomClaimActivation } from "./kcom-claim-activation.js";
import { buildKcomClaimSeal } from "./kcom-claim-seal.js";
import { buildKcomClaimFinishSettlement } from "./kcom-claim-finish-settlement.js";
import { buildKcomClaimCollect } from "./kcom-claim-collect.js";
import { buildKcomClaimOpen } from "./kcom-claim-open.js";
import { buildKcomClaimClose } from "./kcom-claim-close.js";
import { buildKcomClaimSelect } from "./kcom-claim-select.js";
import { buildKcomClaimSettle } from "./kcom-claim-settle.js";
import {
  hexToBytes,
  requireHex32,
  selectFundingEntry,
  setVersionOneInputMassFields,
  utxoAmountSompi,
} from "./sale-common.js";

export const KCOM_CLAIM_BUILDER_KEYS = ["kcom-claim.fund-vault", "kcom-claim.open", "kcom-claim.create-shard", "kcom-claim.finish-initialization", "kcom-claim.select", "kcom-claim.close", "kcom-claim.collect", "kcom-claim.settle", "kcom-claim.finish-settlement", "kcom-claim.seal", "kcom-claim.activate"] as const;
const ZERO32 = "00".repeat(32);
const FEE = 60000000n;

async function buildFactoryStep({ options, kw, req, p, codec, graphId, address }) {
  const s = p.factoryState;
  if (!s?.opened) throw new Error("Campaign factory is not open");
  const finishing = req.builderKey === "kcom-claim.finish-initialization";
  const nextShard = BigInt(s.next_shard);
  const shardCount = BigInt(s.shard_count);
  const shardValue = BigInt(s.shard_value);
  if (finishing && (nextShard !== shardCount || shardCount <= 0n))
    throw new Error("Factory has not created every claim shard");
  if (!finishing && (nextShard < 0n || nextShard >= shardCount || shardValue <= 0n))
    throw new Error("No claim shard remains to create");
  const factoryScript = codec.script("KCOMFactory", s);
  const nextFactoryScript = finishing ? null : codec.script("KCOMFactory", { ...s, next_shard: String(nextShard + 1n) });
  const shardState = {
    campaign: s.campaign, terms_hash: s.terms_hash, token_id: s.token_id,
    budget_raw: s.budget_raw, manifest_total: s.manifest_total,
    eligibility_root: s.eligibility_root, used_root: s.empty_used_root,
    leaf_count: s.leaf_count, selected_count: "0", all_weight: "0",
    boosted_weight: "0", long_weight: "0", shard: s.next_shard,
    shard_count: s.shard_count, first: s.first, second: s.second, third: s.third,
    opens_ms: s.opens_ms, closes_ms: s.closes_ms, tge_ms: s.tge_ms, closed: false,
  };
  const shardScript = finishing ? null : codec.script("KCOMClaimShard", shardState);
  const collectorState = {
    campaign: s.campaign, terms_hash: s.terms_hash, token_id: s.token_id,
    budget_raw: s.budget_raw, manifest_total: s.manifest_total,
    eligibility_root: s.eligibility_root, summaries_root: s.empty_summaries_root,
    leaf_count: s.leaf_count, shard_count: s.shard_count, next_shard: "0",
    selected_count: "0", all_weight: "0", boosted_weight: "0", long_weight: "0",
    first: s.first, second: s.second, third: s.third,
    opens_ms: s.opens_ms, closes_ms: s.closes_ms, tge_ms: s.tge_ms,
    collection_complete: false, settled_count: "0", liability_raw: "0", settlement_complete: false,
  };
  const collectorScript = finishing ? codec.script("KCOMSettlement", collectorState) : null;
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
  await rpc.connect();
  try {
    const ref = p.factory;
    if (!ref || !Number.isSafeInteger(ref.index) || ref.index < 0)
      throw new Error("Factory source outpoint required");
    requireHex32(ref.transactionId, "factory source transaction");
    const factory = (await query(scriptAddress(factoryScript))).find(e =>
      String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index);
    const sourceScript = factory?.scriptPublicKey ?? factory?.entry?.scriptPublicKey ?? factory?.utxoEntry?.scriptPublicKey;
    if (!factory || refId(factory) !== graphId || !sourceScript ||
      kw.addressFromScriptPublicKey(sourceScript, req.network).toString() !== scriptAddress(factoryScript))
      throw new Error("KCOM_CLAIM_SOURCE_STALE: rebuild from current factory UTXO");
    const factoryValue = utxoAmountSompi(factory);
    if (!finishing && factoryValue <= shardValue)
      throw new Error("Factory has insufficient native KAS for another shard");
    const funding = selectFundingEntry((await query(address)).filter(e =>
      !refId(e) && !(String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index)), FEE + 10000n);
    const outputs = finishing ? [
      new kw.TransactionOutput(factoryValue, kw.payToScriptHashScript(collectorScript), new kw.CovenantBinding(0, new kw.Hash(graphId))),
      new kw.TransactionOutput(utxoAmountSompi(funding) - FEE, kw.payToAddressScript(address)),
    ] : [
      new kw.TransactionOutput(factoryValue - shardValue, kw.payToScriptHashScript(nextFactoryScript), new kw.CovenantBinding(0, new kw.Hash(graphId))),
      new kw.TransactionOutput(shardValue, kw.payToScriptHashScript(shardScript), new kw.CovenantBinding(0, new kw.Hash(graphId))),
      new kw.TransactionOutput(utxoAmountSompi(funding) - FEE, kw.payToAddressScript(address)),
    ];
    const budget = finishing ? 40 : 30;
    const changeIndex = finishing ? 1 : 2;
    const inputs = [factory, funding].map((e, i) => ({
      previousOutpoint: e.outpoint, utxo: e, sequence: 0n,
      computeBudget: i === 0 ? budget : 10, sigOpCount: 0,
    }));
    const witness = new kw.ScriptBuilder();
    codec.appendHiddenWitness(kw, witness, "KCOMFactory", finishing ? "finish_initialization" : "create_shard");
    witness.addData(codec.dispatch("KCOMFactory", finishing ? "finish_initialization" : "create_shard"));
    inputs[0].signatureScript = kw.ScriptBuilder.fromScript(factoryScript).encodePayToScriptHashSignatureScript(witness.drain());
    let tx = new kw.Transaction({
      version: 1, lockTime: 0n, inputs, outputs,
      subnetworkId: "00".repeat(20), gas: 0n, payload: "",
    });
    setVersionOneInputMassFields(tx, budget);
    tx.inputs[1].computeBudget = 10;
    if (options.transactionWithMinimumCalculatedFeeChange)
      tx = options.transactionWithMinimumCalculatedFeeChange(kw, tx, changeIndex, req.network, req.builderKey);
    if (tx.outputs.length !== outputs.length ||
      tx.outputs[0].scriptPublicKey.script !== kw.payToScriptHashScript(finishing ? collectorScript : nextFactoryScript).script ||
      String(tx.outputs[0].covenant?.covenantId) !== graphId ||
      tx.outputs[0].value !== (finishing ? factoryValue : factoryValue - shardValue) ||
      (!finishing && (tx.outputs[1].scriptPublicKey.script !== kw.payToScriptHashScript(shardScript).script ||
        String(tx.outputs[1].covenant?.covenantId) !== graphId || tx.outputs[1].value !== shardValue)) ||
      tx.outputs[changeIndex].scriptPublicKey.script !== kw.payToAddressScript(address).script ||
      tx.outputs[changeIndex].covenant || tx.outputs[changeIndex].value <= 10000n ||
      tx.outputs[changeIndex].value >= utxoAmountSompi(funding))
      throw new Error("KCOM claim fee adjustment changed a factory output");
    return {
      schema: "kcc20-in-process-pskt-builder-output/v1",
      psktTransactionJson: tx.serializeToSafeJSON(),
      signInputs: [{ index: 1, sighashType: 1 }],
      submitTransactionSupported: true,
      metadata: {
        builderKey: req.builderKey, contract: "KCOMFactory", network: req.network,
        graphId, shard: finishing ? null : String(nextShard), factoryOutpoint: `${ref.transactionId}:${ref.index}`,
        factoryOutputIndex: finishing ? null : 0, shardOutputIndex: finishing ? null : 1,
        collectorOutputIndex: finishing ? 0 : null,
        graphArtifactId: codec.graphArtifactId, openingArtifactId: codec.openingArtifactId,
      },
    };
  } finally {
    await rpc.disconnect();
  }
}

export function createKcomClaimPsktBuilder(options) {
  const kw = options.wasm;
  const load = async (key) => options.artifacts?.[key] ?? (await options.artifactProvider?.(key));
  return async (input) => {
    if (input.schema !== "kcc20-in-process-pskt-builder-input/v1")
      throw new Error("Invalid builder input schema");
    const req = input.request ?? {}, p = req.params ?? {};
    if (req.network !== "testnet-10") throw new Error("KCOM claim builders are TN10-only");
    if (!KCOM_CLAIM_BUILDER_KEYS.includes(req.builderKey)) throw new Error("Unsupported KCOM claim operation");
    const address = req.owner?.walletAddress;
    if (typeof address !== "string" || !address.startsWith("kaspatest:"))
      throw new Error("TN10 funding wallet required");
    const graphId = requireHex32(p.graphId, "graph covenant id");
    const codec = kcomClaimCodec({
      graph: await load("KCOMClaimGraph.artifact.json"),
      opening: await load("KCOMClaimOpen.artifact.json"),
    });
    if (req.builderKey === "kcom-claim.activate")
      return buildKcomClaimActivation({ options, kw, req, p, codec, graphId, address, canonicalArtifact: await load("KCC20.placeholder.json"), vestingArtifact: await load("KCOMVesting.artifact.json") });
    if (req.builderKey === "kcom-claim.seal")
      return buildKcomClaimSeal({ options, kw, req, p, codec, graphId, address });
    if (req.builderKey === "kcom-claim.finish-settlement")
      return buildKcomClaimFinishSettlement({ options, kw, req, p, codec, graphId, address });
    if (req.builderKey === "kcom-claim.collect")
      return buildKcomClaimCollect({ options, kw, req, p, codec, graphId, address });
    if (req.builderKey === "kcom-claim.open")
      return buildKcomClaimOpen({ options, kw, req, p, codec, graphId, address });
    if (req.builderKey === "kcom-claim.close")
      return buildKcomClaimClose({ options, kw, req, p, codec, graphId, address });
    if (req.builderKey === "kcom-claim.select")
      return buildKcomClaimSelect({ options, kw, req, p, codec, graphId, address });
    if (req.builderKey === "kcom-claim.settle")
      return buildKcomClaimSettle({ options, kw, req, p, codec, graphId, address });
    if (req.builderKey === "kcom-claim.create-shard" || req.builderKey === "kcom-claim.finish-initialization")
      return buildFactoryStep({ options, kw, req, p, codec, graphId, address });
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
        tx.outputs[1].value !== utxoAmountSompi(reserve) ||
        tx.outputs[2].scriptPublicKey.script !== kw.payToAddressScript(address).script ||
        tx.outputs[2].covenant || tx.outputs[2].value <= 10000n ||
        tx.outputs[2].value >= utxoAmountSompi(funding))
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
