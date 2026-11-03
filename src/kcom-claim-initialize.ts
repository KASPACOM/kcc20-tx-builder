// @ts-nocheck
import { blake3 } from "@noble/hashes/blake3";
import { createKcomClaimTn10ProofPolicy, verifyKcomClaimManifest } from "./kcom-claim-policy.js";
import { ADMIN_SIGNATURE_PLACEHOLDER, checkedKcomAdminPair,
  finishKcomAdminIntent, kcomAdminWitness } from "./kcom-claim-admin.js";
import { bytesToHex, hexToBytes, requireHex32, selectFundingEntry,
  setVersionOneInputMassFields, utxoAmountSompi } from "./sale-common.js";

const FEE = 60000000n;
const VAULT_CELL = 100000000n;
const MAX_I64 = 9223372036854775807n;
const TOKEN_HASH = "5d6cacdf57c734536fcb8a9c833f0318671226727ec77c503a98fc5be59f9e29";
const FOOTER = "ea21b282cc3207940d86d8e790626db8998ce56b996c86df5d31718ebd037c5b";
const MAGIC = "6b636f6d2e636c61696d2e7465726d732f763200";
const encoder = new TextEncoder();
const digest = (name, ...parts) => blake3(Buffer.concat([
  encoder.encode(`kcom.claim.${name}/v1\0`), ...parts,
]));
function le(value, width) {
  let n = BigInt(value);
  if (n < 0n || n >= 1n << BigInt(width * 8)) throw new Error("Campaign initialization integer overflow");
  const out = Buffer.alloc(width);
  for (let i = 0; i < width; i++) { out[i] = Number(n & 255n); n >>= 8n; }
  return out;
}
function emptyRoot(kind, campaign, count) {
  let width = 1;
  while (width < count) width *= 2;
  let row = Array.from({ length: width }, (_, i) => digest(`${kind}.empty`, campaign, le(i, 4)));
  while (row.length > 1) {
    const next = [];
    for (let i = 0; i < row.length; i += 2)
      next.push(digest(`${kind}.node`, row[i], row[i + 1]));
    row = next;
  }
  return bytesToHex(row[0]);
}
function checkedTerms(p, codec, network) {
  const s = p.initState;
  if (!s || typeof p.termsHex !== "string" || !/^[0-9a-f]{554}$/.test(p.termsHex))
    throw new Error("Exact 277-byte frozen campaign terms required");
  const terms = Buffer.from(p.termsHex, "hex");
  const budget = BigInt(s.budget_raw), manifest = BigInt(s.manifest_total);
  const leafCount = BigInt(s.leaf_count), shardCount = BigInt(s.shard_count);
  const shardValue = BigInt(s.shard_value), opens = BigInt(s.opens_ms);
  const closes = BigInt(s.closes_ms), tge = BigInt(s.tge_ms);
  if (!(budget === 10000000000000000n ||
      (budget >= 10n && budget <= 20000n && budget % 10n === 0n)) ||
      manifest <= 0n || manifest > budget / 5n || leafCount <= 0n || leafCount > 1048576n ||
      budget / 5n - manifest >= leafCount || shardCount <= 0n || shardCount > 1048576n ||
      (shardCount & (shardCount - 1n)) !== 0n || shardValue <= 0n ||
      shardValue > 9223372036754775806n / shardCount ||
      opens < 500000000000n || opens > 9223372034262775807n ||
      closes !== opens + 2592000000n || tge <= closes || tge > 9000000000000000n)
    throw new Error("Campaign budget, shards or frozen dates are invalid");
  const campaign = requireHex32(s.campaign, "campaign id");
  const tokenId = requireHex32(s.token_id, "campaign token id");
  requireHex32(s.eligibility_root, "eligibility root");
  requireHex32(s.empty_used_root, "empty used root");
  requireHex32(s.empty_summaries_root, "empty summaries root");
  if (tokenId === "00".repeat(32) ||
      new Set([s.first, s.second, s.third].map((key, i) =>
        requireHex32(key, `administrator ${i + 1}`))).size !== 3)
    throw new Error("Campaign token and frozen administrators must be distinct and nonzero");
  const campaignBytes = hexToBytes(campaign);
  if (emptyRoot("used", campaignBytes, Number(leafCount)) !== s.empty_used_root ||
      emptyRoot("summary", campaignBytes, Number(shardCount)) !== s.empty_summaries_root)
    throw new Error("Campaign empty roots do not match its frozen dimensions");
  const expectedHash = requireHex32(p.expectedManifestContentHash, "trusted manifest hash");
  if (!p.eligibilityManifest) throw new Error("Reviewed eligibility manifest required");
  if (budget === 10000000000000000n)
    verifyKcomClaimManifest(p.eligibilityManifest, expectedHash);
  else
    createKcomClaimTn10ProofPolicy({ network, tokenId,
      campaignBudgetRaw: String(budget) }).verifyManifest(p.eligibilityManifest, expectedHash);
  const m = p.eligibilityManifest;
  if (m.campaignId !== campaign || m.tokenId !== tokenId ||
      m.root !== s.eligibility_root || BigInt(m.totalBaseEntitlementRaw) !== manifest ||
      m.leaves.length !== Number(leafCount))
    throw new Error("Reviewed eligibility manifest differs from frozen initializer");
  const hex = (start, end) => terms.subarray(start, end).toString("hex");
  if (hex(0, 20) !== MAGIC ||
      bytesToHex(blake3(terms)) !== s.terms_hash ||
      hex(20, 52) !== campaign || hex(52, 84) !== s.eligibility_root ||
      !terms.subarray(84, 92).equals(le(budget, 8)) ||
      !terms.subarray(92, 100).equals(le(manifest, 8)) ||
      hex(100, 132) !== tokenId || hex(164, 196) !== TOKEN_HASH ||
      terms.readUInt32LE(196) !== 1 || terms.readUInt32LE(200) !== 25264 ||
      !terms.subarray(204, 212).equals(le(tge, 8)) ||
      terms[212] > 4 || hex(213, 245) === "00".repeat(32) ||
      hex(245, 277) !== FOOTER)
    throw new Error("Campaign terms preimage differs from frozen initializer");
  const factoryState = { ...s, next_shard: "0", opened: false };
  const vaultState = {
    campaign, terms_hash: s.terms_hash, token_id: tokenId,
    tge_ms: String(tge), budget_raw: String(budget), extension: hex(132, 164),
    treasury_scheme: terms[212], treasury: hex(213, 245),
    first: s.first, second: s.second, third: s.third,
    funded: false, opened: false, settled: false, recovered: false,
    liability_raw: "0", activated_raw: "0",
  };
  codec.script("KCOMInitialize", s);
  codec.linkedScript("KCOMFactory", factoryState);
  codec.linkedScript("KCOMVault", vaultState);
  return { state: s, terms, factoryState, vaultState,
    shardCount, shardValue, campaign, tokenId, expectedHash };
}
function rpcClient(options, kw, req) {
  const config = { url: options.config?.KASPA_WRPC_URL ||
    "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh",
    encoding: kw.Encoding.Borsh, networkId: req.network };
  return options.rpcClientFactory?.(config) ?? new kw.RpcClient(config);
}

export async function buildKcomClaimDeployInitializer({ options, kw, req, p, codec, address }) {
  const checked = checkedTerms(p, codec, req.network);
  const value = BigInt(p.initializerValueSompi ?? -1);
  if (value <= checked.shardValue * checked.shardCount + VAULT_CELL || value > MAX_I64)
    throw new Error("Initializer native KAS does not fund all frozen shards and vault");
  const script = codec.script("KCOMInitialize", checked.state), rpc = rpcClient(options, kw, req);
  await rpc.connect();
  try {
    const refId = entry => String(entry.entry?.covenantId ?? entry.covenantId ?? "");
    const funding = selectFundingEntry((await rpc.getUtxosByAddresses([address])).entries.filter(e => !refId(e)),
      value + FEE + 10000n);
    const initializerSpk = kw.payToScriptHashScript(script), sponsorSpk = kw.payToAddressScript(address);
    const outputs = [new kw.TransactionOutput(value, initializerSpk),
      new kw.TransactionOutput(utxoAmountSompi(funding) - value - FEE, sponsorSpk)];
    let tx = new kw.Transaction({ version: 1, lockTime: 0n,
      inputs: [{ previousOutpoint: funding.outpoint, utxo: funding, sequence: 0n,
        computeBudget: 100, sigOpCount: 0 }], outputs,
      subnetworkId: "00".repeat(20), gas: 0n, payload: "" });
    setVersionOneInputMassFields(tx, 100);
    tx.populateGenesisCovenants([new kw.GenesisCovenantGroup(0, [0])]);
    tx.finalize();
    const initializerId = String(tx.outputs[0].covenant?.covenantId ?? "");
    requireHex32(initializerId, "derived initializer id");
    if (options.transactionWithMinimumCalculatedFeeChange)
      tx = options.transactionWithMinimumCalculatedFeeChange(kw, tx, 1, req.network, req.builderKey);
    if (tx.version !== 1 || tx.lockTime !== 0n || tx.inputs.length !== 1 || tx.outputs.length !== 2 ||
        String(tx.inputs[0].previousOutpoint.transactionId) !== String(funding.outpoint.transactionId) ||
        tx.inputs[0].previousOutpoint.index !== funding.outpoint.index ||
        String(tx.outputs[0].covenant?.covenantId) !== initializerId ||
        tx.outputs[0].scriptPublicKey.script !== initializerSpk.script ||
        tx.outputs[0].value !== value || tx.outputs[1].covenant ||
        tx.outputs[1].scriptPublicKey.script !== sponsorSpk.script ||
        tx.outputs[1].value <= 10000n ||
        tx.outputs[1].value > utxoAmountSompi(funding) - value - FEE)
      throw new Error("KCOM initializer fee adjustment changed a custody output or source");
    return { schema: "kcc20-in-process-pskt-builder-output/v1",
      psktTransactionJson: tx.serializeToSafeJSON(),
      signInputs: [{ index: 0, sighashType: 1 }], submitTransactionSupported: true,
      metadata: { builderKey: req.builderKey, contract: "KCOMInitialize", network: req.network,
        initializerId, initializerOutputIndex: 0, campaign: checked.campaign,
        tokenId: checked.tokenId, termsHash: checked.state.terms_hash,
        manifestContentHash: checked.expectedHash, openingArtifactId: codec.openingArtifactId },
    };
  } finally { await rpc.disconnect(); }
}

export async function buildKcomClaimInitialize({ options, kw, req, p, codec, address }) {
  const checked = checkedTerms(p, codec, req.network);
  const initializerId = requireHex32(p.initializerId, "accepted initializer id");
  const { publicKeys, approvals } = checkedKcomAdminPair(p, checked.state);
  const script = codec.script("KCOMInitialize", checked.state);
  const factorySpk = kw.payToScriptHashScript(codec.linkedScript("KCOMFactory", checked.factoryState));
  const vaultSpk = kw.payToScriptHashScript(codec.linkedScript("KCOMVault", checked.vaultState));
  const addr = kw.addressFromScriptPublicKey(kw.payToScriptHashScript(script), req.network).toString();
  const rpc = rpcClient(options, kw, req);
  const refId = entry => String(entry.entry?.covenantId ?? entry.covenantId ?? "");
  await rpc.connect();
  try {
    const ref = p.initializer;
    if (!ref || !Number.isSafeInteger(ref.index) || ref.index < 0)
      throw new Error("Accepted initializer source outpoint required");
    requireHex32(ref.transactionId, "initializer source transaction");
    const source = (await rpc.getUtxosByAddresses([addr])).entries.find(e =>
      String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index);
    const sourceSpk = source?.scriptPublicKey ?? source?.entry?.scriptPublicKey ?? source?.utxoEntry?.scriptPublicKey;
    if (!source || refId(source) !== initializerId || !sourceSpk ||
        kw.addressFromScriptPublicKey(sourceSpk, req.network).toString() !== addr)
      throw new Error("KCOM_CLAIM_SOURCE_STALE: rebuild from accepted initializer UTXO");
    const value = utxoAmountSompi(source);
    if (value <= checked.shardValue * checked.shardCount + VAULT_CELL || value > MAX_I64)
      throw new Error("Initializer native KAS does not fund all frozen shards and vault");
    const funding = selectFundingEntry((await rpc.getUtxosByAddresses([address])).entries.filter(e =>
      !refId(e) && !(String(e.outpoint.transactionId) === ref.transactionId && e.outpoint.index === ref.index)),
      FEE + 10000n);
    const sponsorSpk = kw.payToAddressScript(address);
    const outputs = [new kw.TransactionOutput(value - VAULT_CELL, factorySpk),
      new kw.TransactionOutput(VAULT_CELL, vaultSpk),
      new kw.TransactionOutput(utxoAmountSompi(funding) - FEE, sponsorSpk)];
    const hiddenOptions = { externalTemplates: {
      "KCOMEntitlementGraph::KCOMFactory": codec.linkedTemplateParts("KCOMFactory"),
      "KCOMEntitlementGraph::KCOMVault": codec.linkedTemplateParts("KCOMVault"),
    }, spawnOutputIndices: { factory: 0, vault: 1 } };
    const appendExplicit = witness => witness.addData(checked.terms);
    const inputs = [source, funding].map((entry, i) => ({
      previousOutpoint: entry.outpoint, utxo: entry, sequence: 0n,
      computeBudget: i === 0 ? 60 : 10, sigOpCount: 0,
    }));
    inputs[0].signatureScript = kcomAdminWitness(kw, codec, script, "KCOMInitialize", "initialize",
      publicKeys, [ADMIN_SIGNATURE_PLACEHOLDER, ADMIN_SIGNATURE_PLACEHOLDER], appendExplicit, hiddenOptions);
    let tx = new kw.Transaction({ version: 1, lockTime: 0n, inputs, outputs,
      subnetworkId: "00".repeat(20), gas: 0n, payload: "" });
    setVersionOneInputMassFields(tx, 60); tx.inputs[1].computeBudget = 10;
    tx.populateGenesisCovenants([new kw.GenesisCovenantGroup(0, [0, 1])]);
    tx.finalize();
    const graphId = String(tx.outputs[0].covenant?.covenantId ?? "");
    requireHex32(graphId, "derived campaign graph id");
    const sourceWitness = tx.inputs[0].signatureScript;
    if (options.transactionWithMinimumCalculatedFeeChange)
      tx = options.transactionWithMinimumCalculatedFeeChange(kw, tx, 2, req.network, req.builderKey);
    if (tx.version !== 1 || tx.lockTime !== 0n || tx.inputs.length !== 2 || tx.outputs.length !== 3 ||
        tx.inputs[0].signatureScript !== sourceWitness || tx.inputs[0].computeBudget !== 60 ||
        tx.inputs[0].sequence !== 0n ||
        String(tx.inputs[0].previousOutpoint.transactionId) !== ref.transactionId ||
        tx.inputs[0].previousOutpoint.index !== ref.index ||
        String(tx.inputs[1].previousOutpoint.transactionId) !== String(funding.outpoint.transactionId) ||
        tx.inputs[1].previousOutpoint.index !== funding.outpoint.index ||
        String(tx.outputs[0].covenant?.covenantId) !== graphId ||
        tx.outputs[0].scriptPublicKey.script !== factorySpk.script ||
        tx.outputs[0].value !== value - VAULT_CELL ||
        String(tx.outputs[1].covenant?.covenantId) !== graphId ||
        tx.outputs[1].scriptPublicKey.script !== vaultSpk.script ||
        tx.outputs[1].value !== VAULT_CELL ||
        tx.outputs[2].covenant || tx.outputs[2].scriptPublicKey.script !== sponsorSpk.script ||
        tx.outputs[2].value <= 10000n || tx.outputs[2].value > utxoAmountSompi(funding) - FEE)
      throw new Error("KCOM initialization fee adjustment changed a campaign output or source");
    const { adminSigning } = finishKcomAdminIntent({ kw, tx, params: p, codec,
      sourceScript: script, actor: "KCOMInitialize", entry: "initialize", publicKeys,
      approvals, appendExplicit, hiddenOptions });
    return { schema: "kcc20-in-process-pskt-builder-output/v1",
      psktTransactionJson: tx.serializeToSafeJSON(),
      signInputs: approvals ? [{ index: 1, sighashType: 1 }] : [],
      submitTransactionSupported: !!approvals,
      metadata: { builderKey: req.builderKey, contract: "KCOMInitialize", network: req.network,
        initializerId, graphId, campaign: checked.campaign, tokenId: checked.tokenId,
        manifestContentHash: checked.expectedHash,
        initializerOutpoint: `${ref.transactionId}:${ref.index}`,
        factoryOutputIndex: 0, vaultOutputIndex: 1,
        adminSigning, graphArtifactId: codec.graphArtifactId,
        openingArtifactId: codec.openingArtifactId },
    };
  } finally { await rpc.disconnect(); }
}
