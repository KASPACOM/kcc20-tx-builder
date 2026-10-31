import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blake3 } from "@noble/hashes/blake3";
import * as kw from "../examples/vendor/kaspa/kaspa.js";
import {
  buildKcc20ScriptForState, createKcc20PsktBuilderEngine,
  prepareKcc20FeeMarketGenesis, prepareKcc20FeeMarketWrappedHolder, templateParts,
} from "../dist/index.js";

kw.initSync({ module: readFileSync(new URL("../examples/vendor/kaspa/kaspa_bg.wasm", import.meta.url)) });
const names = {
  receipt: "KCC20FeeEscrowV1", root: "KCC20OrderbookFeeRootV1",
  holder: "KCC20OrderbookFeeHolderV1", ask: "KCC20OrderbookFeeAskV1",
  bid: "KCC20OrderbookFeeBidV1", ticket: "KCC20FeeTicket",
  wrapper: "KCC20WrapperFeeV1", argentWrapper: "KCC20WrapperFeeArgentV1",
};
const artifacts = Object.fromEntries(Object.entries(names).map(([role, name]) => [
  role, JSON.parse(readFileSync(new URL(`../artifacts/${name}.placeholder.json`, import.meta.url))),
]));
const artifactMap = Object.fromEntries(Object.entries(names).map(([role, name]) => [
  `${name}.placeholder.json`, artifacts[role],
]));
const native = JSON.parse(readFileSync(new URL("../artifacts/KCC20.placeholder.json", import.meta.url)));
const argent = JSON.parse(readFileSync(new URL("../artifacts/ArgentKCC20.reference.json", import.meta.url)));
const hex = bytes => Buffer.from(bytes).toString("hex");
const tuple = role => {
  const parts = templateParts(artifacts[role]);
  return { hash: hex(parts.hash), prefixLength: parts.prefixLength, suffixLength: parts.suffixLength };
};
const policy = {
  version: 1, creatorFeeBps: 0,
  protocolAccountId: "04".repeat(32), creatorAccountId: "00".repeat(32),
  ...Object.fromEntries(["receipt", "root", "holder", "ask", "bid", "ticket"]
    .map(role => [`${role}Template`, tuple(role)])),
};
const tokenId = "01".repeat(32);
const marketId = "02".repeat(32);
const key = new kw.PrivateKey("03".padStart(64, "0"));
const owner = key.toKeypair().xOnlyPublicKey.toString();
const wallet = key.toAddress("testnet-10").toString();

function fixture(amount = 10n, wrap = 5n) {
  const tokenState = {
    amount, owner: Buffer.from(owner, "hex"), ownerScheme: 0,
    borrowScheme: 0, borrowGuard: new Uint8Array(32),
    extensionCommitment: new Uint8Array(32),
  };
  const tokenScript = buildKcc20ScriptForState(native, tokenState);
  const tokenSpk = kw.payToScriptHashScript(tokenScript);
  const tokenAddress = kw.addressFromScriptPublicKey(tokenSpk, "testnet-10").toString();
  const payoutSpk = kw.payToAddressScript(wallet);
  const payoutScript = Buffer.from(String(payoutSpk.script), "hex");
  const payoutSerialized = Buffer.alloc(11 + payoutScript.length);
  payoutSerialized[0] = 0xe3;
  payoutSerialized.writeUInt16LE(Number(payoutSpk.version), 1);
  payoutSerialized.writeBigUInt64LE(BigInt(payoutScript.length), 3);
  payoutScript.copy(payoutSerialized, 11);
  const holder = prepareKcc20FeeMarketWrappedHolder({
    tokenId, marketId, feeTicketId: "00".repeat(32), priceScale: 1n,
    policy, wrapperProfile: "native", artifacts, recipientOwner: owner,
    recipientOwnerScheme: 0, recipientPayoutScriptHash: hex(blake3(payoutSerialized)),
    tokenAmount: wrap,
  });
  const wrapperSpk = kw.payToScriptHashScript(holder.wrapper.redeemScript);
  const wrapperAddress = kw.addressFromScriptPublicKey(wrapperSpk, "testnet-10").toString();
  const tokenEntry = {
    outpoint: { transactionId: "0a".repeat(32), index: 0 }, amount: 50000000n,
    scriptPublicKey: tokenSpk, blockDaaScore: 0n, isCoinbase: false, covenantId: tokenId,
  };
  const wrapperEntry = {
    outpoint: { transactionId: "0b".repeat(32), index: 0 }, amount: 50000000n,
    scriptPublicKey: wrapperSpk, blockDaaScore: 0n, isCoinbase: false, covenantId: marketId,
  };
  const fundingEntry = {
    outpoint: { transactionId: "0c".repeat(32), index: 0 }, amount: 500000000n,
    scriptPublicKey: kw.payToAddressScript(wallet), blockDaaScore: 0n, isCoinbase: false,
  };
  const genesis = prepareKcc20FeeMarketGenesis({ tokenId,
    feeTicketId: "00".repeat(32), priceScale: 1n, policy,
    wrapperProfile: "native", artifacts });
  const source = {
    txidHex: tokenEntry.outpoint.transactionId, vout: 0, address: tokenAddress,
    amountSompiExact: "50000000",
    state: { stateAmount: amount.toString(), owner, ownerScheme: 0,
      borrowScheme: 0, borrowGuard: "00".repeat(32),
      extensionCommitment: "00".repeat(32) },
  };
  const wrapperUtxo = { txidHex: wrapperEntry.outpoint.transactionId,
    vout: 0, address: wrapperAddress, amountSompiExact: "50000000" };
  const request = { schema: "kcc20-in-process-pskt-builder-input/v1",
    request: { builderKey: "kcc20fee.wrap", network: "testnet-10",
      owner: { walletAddress: wallet, kcc20Owner: owner },
      params: { marketId, contractCanonicalTokenId: tokenId,
        feeTicketId: "00".repeat(32), priceScale: "1", tokenAmount: wrap.toString(),
        feePolicy: policy, policyId: genesis.policyId, tokenUtxo: source, wrapperUtxo } } };
  const engine = createKcc20PsktBuilderEngine({ wasm: kw,
    artifacts: { ...artifactMap, "KCC20.placeholder.json": native,
      "ArgentKCC20.reference.json": argent },
    rpcClientFactory: () => ({ connect: async () => {}, disconnect: async () => {},
      getUtxosByAddresses: async ({ addresses }) => ({ entries:
        addresses.includes(tokenAddress) ? [tokenEntry, wrapperEntry]
          : [fundingEntry] }) }) });
  return { engine, request, tokenEntry, wrapperEntry, fundingEntry,
    tokenSpk, holder, source, wrapperUtxo };
}

test("fee-market partial wrap signs exact reserve, holder and wrapper outputs", async () => {
  const f = fixture();
  const built = await f.engine.build(f.request);
  const json = JSON.parse(built.psktTransactionJson);
  assert.deepEqual(built.signInputs, [{ index: 2, sighashType: 1 }]);
  assert.equal(json.inputs[0].computeBudget, 100);
  assert.equal(json.inputs[1].computeBudget, 300);
  assert.equal(json.outputs[0].covenant.covenantId, tokenId);
  assert.equal(json.outputs[1].covenant.covenantId, marketId);
  assert.equal(json.outputs[2].covenant.covenantId, marketId);
  assert.equal(json.outputs[0].covenant.authorizingInput, 0);
  assert.equal(json.outputs[1].covenant.authorizingInput, 1);
  assert.equal(json.outputs[2].covenant.authorizingInput, 1);
  assert.equal(String(json.outputs[1].scriptPublicKey).slice(-70), f.holder.holder.scriptPublicKey.scriptHex);
  assert.equal(String(json.outputs[2].scriptPublicKey).slice(-70), f.holder.wrapper.scriptPublicKey.scriptHex);
  assert.equal(json.outputs[3].covenant.covenantId, tokenId);
  assert.equal(BigInt(json.outputs[3].value), f.tokenEntry.amount);
  const signed = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  const script = built.scripts[0];
  let signature = Buffer.from(kw.createInputSignature(signed, 0, key, kw.SighashType.All), "hex");
  if (signature.length === 66 && signature[0] === 0x41) signature = signature.subarray(1);
  const args = new kw.ScriptBuilder({ flags: { covenantsEnabled: true } });
  for (const arg of script.signatureScript.args) {
    if (arg.type === "data") args.addData(Buffer.from(arg.hex, "hex"));
    else if (arg.type === "i64") args.addI64(BigInt(arg.value));
    else if (arg.type === "byte") args.addData(Uint8Array.of(arg.value));
    else if (arg.type === "signature") args.addData(Buffer.concat([
      Buffer.from(arg.prefixHex ?? "", "hex"), signature]));
    else throw new Error(`unsupported token argument ${arg.type}`);
  }
  signed.inputs[0].signatureScript = kw.ScriptBuilder.fromScript(
    Buffer.from(script.scriptHex, "hex"), { flags: { covenantsEnabled: true } },
  ).encodePayToScriptHashSignatureScript(args.drain());
  signed.inputs[2].signatureScript = kw.createInputSignature(signed, 2, key, kw.SighashType.All);
  const { transactionMass } = f.engine.protocol.calculateToccataV1NonContextualMass(signed, "fee-market wrap");
  const storageMass = f.engine.protocol.calculateToccataStorageMass(signed, "fee-market wrap");
  assert(transactionMass <= 450000n);
  assert(storageMass <= 450000n);
  const paidFee = f.tokenEntry.amount + f.wrapperEntry.amount + f.fundingEntry.amount -
    json.outputs.reduce((sum, output) => sum + BigInt(output.value), 0n);
  assert(paidFee >= (transactionMass > storageMass ? transactionMass : storageMass) * 100n);
});

test("fee-market wrap rejects wrong live wrapper lineage", async () => {
  const f = fixture();
  f.wrapperEntry.covenantId = "ff".repeat(32);
  await assert.rejects(f.engine.build(f.request), /covenant/i);
});

test("fee-market final wrap has no native holder change output", async () => {
  const f = fixture(5n, 5n);
  const built = await f.engine.build(f.request);
  assert.equal(built.metadata.tokenChangeOutputIndex, -1);
  const json = JSON.parse(built.psktTransactionJson);
  assert.equal(json.outputs[3].covenant, null);
});
