import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blake3 } from "@noble/hashes/blake3";
import * as kw from "../examples/vendor/kaspa/kaspa.js";
import {
  buildKcc20ScriptForState, createKcc20PsktBuilderEngine,
  prepareKcc20FeeMarketGenesis, prepareKcc20FeeMarketBinding,
  prepareKcc20FeeMarketWrappedHolder, prepareKcc20FeeMarketAsk,
  prepareKcc20FeeMarketBid, buildKcc20FeeEscrowScript, templateParts,
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

function unwrapFixture(unwrapAmount = 10n) {
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
    tokenAmount: 10n,
  });
  const reserveState = { amount: 10n,
    owner: Buffer.from(holder.wrapper.scriptHash, "hex"), ownerScheme: 3,
    borrowScheme: 0, borrowGuard: new Uint8Array(32),
    extensionCommitment: new Uint8Array(32) };
  const reserveScript = buildKcc20ScriptForState(native, reserveState);
  const reserveSpk = kw.payToScriptHashScript(reserveScript);
  const reserveAddress = kw.addressFromScriptPublicKey(reserveSpk, "testnet-10").toString();
  const holderSpk = kw.payToScriptHashScript(holder.holder.redeemScript);
  const holderAddress = kw.addressFromScriptPublicKey(holderSpk, "testnet-10").toString();
  const wrapperSpk = kw.payToScriptHashScript(holder.wrapper.redeemScript);
  const wrapperAddress = kw.addressFromScriptPublicKey(wrapperSpk, "testnet-10").toString();
  const wrappedEntry = { outpoint: { transactionId: "0a".repeat(32), index: 0 },
    amount: 50000000n, scriptPublicKey: holderSpk, blockDaaScore: 0n,
    isCoinbase: false, covenantId: marketId };
  const reserveEntry = { outpoint: { transactionId: "0b".repeat(32), index: 0 },
    amount: 50000000n, scriptPublicKey: reserveSpk, blockDaaScore: 0n,
    isCoinbase: false, covenantId: tokenId };
  const wrapperEntry = { outpoint: { transactionId: "0c".repeat(32), index: 0 },
    amount: 50000000n, scriptPublicKey: wrapperSpk, blockDaaScore: 0n,
    isCoinbase: false, covenantId: marketId };
  const fundingEntry = { outpoint: { transactionId: "0d".repeat(32), index: 0 },
    amount: 500000000n, scriptPublicKey: payoutSpk, blockDaaScore: 0n,
    isCoinbase: false };
  const wrappedUtxo = { txidHex: wrappedEntry.outpoint.transactionId, vout: 0,
    address: holderAddress, amountSompiExact: "50000000", state: holder.holderState };
  const reserveUtxo = { txidHex: reserveEntry.outpoint.transactionId, vout: 0,
    address: reserveAddress, amountSompiExact: "50000000", state: {
      stateAmount: "10", owner: holder.wrapper.scriptHash, ownerScheme: 3,
      borrowScheme: 0, borrowGuard: "00".repeat(32),
      extensionCommitment: "00".repeat(32) } };
  const wrapperUtxo = { txidHex: wrapperEntry.outpoint.transactionId, vout: 0,
    address: wrapperAddress, amountSompiExact: "50000000" };
  const genesis = prepareKcc20FeeMarketGenesis({ tokenId,
    feeTicketId: "00".repeat(32), priceScale: 1n, policy,
    wrapperProfile: "native", artifacts });
  const request = { schema: "kcc20-in-process-pskt-builder-input/v1",
    request: { builderKey: "kcc20fee.unwrap", network: "testnet-10",
      owner: { walletAddress: wallet, kcc20Owner: owner },
      params: { marketId, contractCanonicalTokenId: tokenId,
        feeTicketId: "00".repeat(32), priceScale: "1", tokenAmount: unwrapAmount.toString(),
        feePolicy: policy, policyId: genesis.policyId,
        wrappedUtxo, reserveUtxo, wrapperUtxo } } };
  const engine = createKcc20PsktBuilderEngine({ wasm: kw,
    artifacts: { ...artifactMap, "KCC20.placeholder.json": native,
      "ArgentKCC20.reference.json": argent },
    rpcClientFactory: () => ({ connect: async () => {}, disconnect: async () => {},
      getUtxosByAddresses: async ({ addresses }) => ({ entries:
        addresses.includes(wallet) ? [fundingEntry]
          : [wrappedEntry, reserveEntry, wrapperEntry] }) }) });
  return { engine, request, wrappedEntry, reserveEntry, wrapperEntry, fundingEntry,
    holder, wrappedUtxo, reserveUtxo };
}

test("fee-market full unwrap returns the exact holder deposit and native reserve", async () => {
  const f = unwrapFixture();
  const built = await f.engine.build(f.request);
  const json = JSON.parse(built.psktTransactionJson);
  assert.deepEqual(built.signInputs, [{ index: 3, sighashType: 1 }]);
  assert.equal(built.metadata.refundIndex, 1);
  assert.equal(built.metadata.reserveChangeIndex, -1);
  assert.equal(built.metadata.wrappedChangeIndex, -1);
  assert.equal(json.outputs[0].covenant.covenantId, tokenId);
  assert.equal(BigInt(json.outputs[0].value), f.reserveEntry.amount);
  assert.equal(json.outputs[1].covenant, null);
  assert.equal(BigInt(json.outputs[1].value), f.wrappedEntry.amount);
  assert.equal(json.outputs[2].covenant.covenantId, marketId);
  assert.equal(BigInt(json.outputs[2].value), f.wrapperEntry.amount);
  const signed = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  const script = built.scripts[0];
  let signature = Buffer.from(kw.createInputSignature(signed, 0, key, kw.SighashType.All), "hex");
  if (signature.length === 66 && signature[0] === 0x41) signature = signature.subarray(1);
  const args = new kw.ScriptBuilder({ flags: { covenantsEnabled: true } });
  for (const arg of script.signatureScript.args) {
    if (arg.type === "data") args.addData(Buffer.from(arg.hex, "hex"));
    else if (arg.type === "i64") args.addI64(BigInt(arg.value));
    else if (arg.type === "signature") args.addData(signature);
    else throw new Error(`unsupported holder argument ${arg.type}`);
  }
  signed.inputs[0].signatureScript = kw.ScriptBuilder.fromScript(
    Buffer.from(script.scriptHex, "hex"), { flags: { covenantsEnabled: true } },
  ).encodePayToScriptHashSignatureScript(args.drain());
  signed.inputs[3].signatureScript = kw.createInputSignature(signed, 3, key, kw.SighashType.All);
  const { transactionMass } = f.engine.protocol.calculateToccataV1NonContextualMass(signed, "fee-market unwrap");
  const storageMass = f.engine.protocol.calculateToccataStorageMass(signed, "fee-market unwrap");
  assert(transactionMass <= 450000n);
  assert(storageMass <= 450000n);
  const paidFee = f.wrappedEntry.amount + f.reserveEntry.amount +
    f.wrapperEntry.amount + f.fundingEntry.amount -
    json.outputs.reduce((sum, output) => sum + BigInt(output.value), 0n);
  assert(paidFee >= (transactionMass > storageMass ? transactionMass : storageMass) * 100n);
});

test("fee-market partial unwrap preserves both reserve and wrapped holder deposits", async () => {
  const f = unwrapFixture(5n);
  const built = await f.engine.build(f.request);
  const json = JSON.parse(built.psktTransactionJson);
  assert.equal(built.metadata.reserveChangeIndex, 1);
  assert.equal(built.metadata.wrappedChangeIndex, 2);
  assert.equal(built.metadata.refundIndex, -1);
  assert.equal(BigInt(json.outputs[1].value), f.reserveEntry.amount);
  assert.equal(BigInt(json.outputs[2].value), f.wrappedEntry.amount);
  assert.equal(json.outputs[1].covenant.covenantId, tokenId);
  assert.equal(json.outputs[2].covenant.covenantId, marketId);
});

test("fee-market unwrap rejects a reserve from a different wrapper", async () => {
  const f = unwrapFixture();
  f.reserveUtxo.state.owner = "ff".repeat(32);
  await assert.rejects(f.engine.build(f.request),
    /different wrapper script|reserve address|does not match a bundled token profile/);
});

test("fee-market ask creation signs the exact order and holder change", async () => {
  const f = unwrapFixture();
  f.request.request.builderKey = "kcc20fee.create-ask";
  f.request.request.params = { ...f.request.request.params,
    holderUtxo: f.wrappedUtxo, askAmount: "5", askUnitPriceSompi: "100000000" };
  const built = await f.engine.build(f.request);
  const json = JSON.parse(built.psktTransactionJson);
  assert.deepEqual(built.signInputs, [{ index: 1, sighashType: 1 }]);
  assert.equal(built.metadata.holderChangeIndex, 1);
  assert.equal(built.metadata.grossSompi, "500000000");
  assert.equal(BigInt(json.outputs[0].value), f.wrappedEntry.amount);
  assert.equal(BigInt(json.outputs[1].value), 50000000n);
  assert.equal(json.outputs[0].covenant.authorizingInput, 0);
  assert.equal(json.outputs[1].covenant.authorizingInput, 0);
  const signed = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  const script = built.scripts[0];
  let signature = Buffer.from(kw.createInputSignature(signed, 0, key, kw.SighashType.All), "hex");
  if (signature.length === 66 && signature[0] === 0x41) signature = signature.subarray(1);
  const args = new kw.ScriptBuilder({ flags: { covenantsEnabled: true } });
  for (const arg of script.signatureScript.args) {
    if (arg.type === "data") args.addData(Buffer.from(arg.hex, "hex"));
    else if (arg.type === "i64") args.addI64(BigInt(arg.value));
    else if (arg.type === "signature") args.addData(signature);
    else throw new Error(`unsupported ask argument ${arg.type}`);
  }
  signed.inputs[0].signatureScript = kw.ScriptBuilder.fromScript(
    Buffer.from(script.scriptHex, "hex"), { flags: { covenantsEnabled: true } },
  ).encodePayToScriptHashSignatureScript(args.drain());
  signed.inputs[1].signatureScript = kw.createInputSignature(signed, 1, key, kw.SighashType.All);
  const non = f.engine.protocol.calculateToccataV1NonContextualMass(signed, "fee-market ask");
  const storage = f.engine.protocol.calculateToccataStorageMass(signed, "fee-market ask");
  assert(non.transactionMass <= 450000n);
  assert(storage <= 450000n);
  const fee = f.wrappedEntry.amount + f.fundingEntry.amount -
    json.outputs.reduce((sum, output) => sum + BigInt(output.value), 0n);
  assert(fee >= (non.transactionMass > storage ? non.transactionMass : storage) * 100n);
});

test("fee-market ask rejects a holder from another policy", async () => {
  const f = unwrapFixture();
  f.request.request.builderKey = "kcc20fee.create-ask";
  f.request.request.params = { ...f.request.request.params,
    holderUtxo: f.wrappedUtxo, askAmount: "5", askUnitPriceSompi: "100000000" };
  f.wrappedUtxo.state.feePolicy = "ff".repeat(361);
  await assert.rejects(f.engine.build(f.request), /holder state differs from fixed policy/);
});

test("fee-market final ask retains one market output and refunds no holder deposit", async () => {
  const f = unwrapFixture();
  f.request.request.builderKey = "kcc20fee.create-ask";
  f.request.request.params = { ...f.request.request.params,
    holderUtxo: f.wrappedUtxo, askAmount: "10", askUnitPriceSompi: "100000000" };
  const built = await f.engine.build(f.request);
  const json = JSON.parse(built.psktTransactionJson);
  assert.equal(built.metadata.holderChangeIndex, -1);
  assert.equal(json.outputs.filter(output => output.covenant?.covenantId === marketId).length, 1);
  assert.equal(BigInt(json.outputs[0].value), f.wrappedEntry.amount);
});

test("fee-market ask rejects gross above the signed contract range", async () => {
  const f = unwrapFixture();
  f.request.request.builderKey = "kcc20fee.create-ask";
  f.request.request.params = { ...f.request.request.params,
    holderUtxo: f.wrappedUtxo, askAmount: "10",
    askUnitPriceSompi: "9223372036854775807" };
  await assert.rejects(f.engine.build(f.request), /gross exceeds contract range/);
});

test("fee-market cancel ask signs the exact holder restoration and deposit", async () => {
  const f = unwrapFixture();
  const plan = prepareKcc20FeeMarketAsk({ tokenId, marketId,
    feeTicketId: "00".repeat(32), priceScale: 1n, policy,
    wrapperProfile: "native", artifacts, owner, ownerScheme: 0,
    payoutScriptHash: f.holder.holderState.payout_script_hash,
    holderAmount: 10n, askAmount: 10n, askUnitPrice: 100000000n });
  const askSpk = kw.payToScriptHashScript(plan.ask.redeemScript);
  const askAddress = kw.addressFromScriptPublicKey(askSpk, "testnet-10").toString();
  f.wrappedEntry.scriptPublicKey = askSpk;
  f.wrappedUtxo.address = askAddress;
  f.wrappedUtxo.state = plan.askState;
  f.request.request.builderKey = "kcc20fee.cancel-ask";
  f.request.request.params = { ...f.request.request.params, askUtxo: f.wrappedUtxo };
  const built = await f.engine.build(f.request);
  const json = JSON.parse(built.psktTransactionJson);
  assert.deepEqual(built.signInputs, [{ index: 1, sighashType: 1 }]);
  assert.equal(BigInt(json.outputs[0].value), f.wrappedEntry.amount);
  assert.equal(json.outputs[0].covenant.authorizingInput, 0);
  assert.equal(String(json.outputs[0].scriptPublicKey).slice(-70),
    plan.holder.holder.scriptPublicKey.scriptHex);
  const signed = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  const script = built.scripts[0];
  let signature = Buffer.from(kw.createInputSignature(signed, 0, key, kw.SighashType.All), "hex");
  if (signature.length === 66 && signature[0] === 0x41) signature = signature.subarray(1);
  const args = new kw.ScriptBuilder({ flags: { covenantsEnabled: true } });
  for (const arg of script.signatureScript.args) {
    if (arg.type === "data") args.addData(Buffer.from(arg.hex, "hex"));
    else if (arg.type === "i64") args.addI64(BigInt(arg.value));
    else if (arg.type === "signature") args.addData(signature);
    else throw new Error(`unsupported cancel argument ${arg.type}`);
  }
  signed.inputs[0].signatureScript = kw.ScriptBuilder.fromScript(
    Buffer.from(script.scriptHex, "hex"), { flags: { covenantsEnabled: true } },
  ).encodePayToScriptHashSignatureScript(args.drain());
  signed.inputs[1].signatureScript = kw.createInputSignature(signed, 1, key, kw.SighashType.All);
  const non = f.engine.protocol.calculateToccataV1NonContextualMass(signed, "fee-market cancel ask");
  const storage = f.engine.protocol.calculateToccataStorageMass(signed, "fee-market cancel ask");
  assert(non.transactionMass <= 450000n);
  assert(storage <= 450000n);
});

function bidFixture() {
  const base = unwrapFixture();
  const binding = prepareKcc20FeeMarketBinding({ tokenId, marketId,
    feeTicketId: "00".repeat(32), priceScale: 1n, policy,
    wrapperProfile: "native", artifacts, rootOwner: owner,
    rootOwnerScheme: 0,
    rootPayoutScriptHash: base.holder.holderState.payout_script_hash });
  const rootSpk = kw.payToScriptHashScript(binding.root.redeemScript);
  const rootAddress = kw.addressFromScriptPublicKey(rootSpk, "testnet-10").toString();
  const rootEntry = { outpoint: { transactionId: "0e".repeat(32), index: 0 },
    amount: 50000000n, scriptPublicKey: rootSpk, blockDaaScore: 0n,
    isCoinbase: false, covenantId: marketId };
  const fundingEntry = { outpoint: { transactionId: "0f".repeat(32), index: 0 },
    amount: 3000000000n, scriptPublicKey: kw.payToAddressScript(wallet),
    blockDaaScore: 0n, isCoinbase: false };
  const rootUtxo = { txidHex: rootEntry.outpoint.transactionId,
    vout: 0, address: rootAddress, amountSompiExact: "50000000",
    state: binding.rootState };
  const request = { schema: "kcc20-in-process-pskt-builder-input/v1",
    request: { builderKey: "kcc20fee.create-bid", network: "testnet-10",
      owner: { walletAddress: wallet, kcc20Owner: owner },
      params: { marketId, contractCanonicalTokenId: tokenId,
        feeTicketId: "00".repeat(32), priceScale: "1",
        bidAmount: "5", bidUnitPriceSompi: "100000000",
        feePolicy: policy, policyId: binding.genesis.policyId, rootUtxo } } };
  const engine = createKcc20PsktBuilderEngine({ wasm: kw,
    artifacts: { ...artifactMap, "KCC20.placeholder.json": native,
      "ArgentKCC20.reference.json": argent },
    rpcClientFactory: () => ({ connect: async () => {}, disconnect: async () => {},
      getUtxosByAddresses: async ({ addresses }) => ({ entries:
        addresses.includes(wallet) ? [fundingEntry] : [rootEntry] }) }) });
  return { engine, request, rootEntry, fundingEntry, rootUtxo, binding };
}

test("fee-market bid creation signs exact 2 KAS deposit and preserves root", async () => {
  const f = bidFixture();
  const built = await f.engine.build(f.request);
  const json = JSON.parse(built.psktTransactionJson);
  assert.deepEqual(built.signInputs, [{ index: 1, sighashType: 1 }]);
  assert.equal(built.metadata.grossSompi, "500000000");
  assert.equal(built.metadata.bidDepositSompi, "200000000");
  assert.equal(BigInt(json.outputs[0].value), 700000000n);
  assert.equal(BigInt(json.outputs[1].value), f.rootEntry.amount);
  assert.equal(json.outputs[0].covenant.authorizingInput, 0);
  assert.equal(json.outputs[1].covenant.authorizingInput, 0);
  assert.equal(String(json.outputs[1].scriptPublicKey).slice(-70),
    f.binding.root.scriptPublicKey.scriptHex);
  const signed = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  signed.inputs[1].signatureScript = kw.createInputSignature(signed, 1, key, kw.SighashType.All);
  const non = f.engine.protocol.calculateToccataV1NonContextualMass(signed, "fee-market create bid");
  const storage = f.engine.protocol.calculateToccataStorageMass(signed, "fee-market create bid");
  assert(non.transactionMass <= 450000n);
  assert(storage <= 450000n);
});

test("fee-market bid rejects a root with changed policy", async () => {
  const f = bidFixture();
  f.rootUtxo.state.feePolicy = "ff".repeat(361);
  await assert.rejects(f.engine.build(f.request), /root feePolicy differs from fixed policy/);
});

test("fee-market cancel bid refunds gross and the full 2 KAS deposit", async () => {
  const f = bidFixture();
  const plan = prepareKcc20FeeMarketBid({ tokenId, marketId,
    feeTicketId: "00".repeat(32), priceScale: 1n, policy,
    wrapperProfile: "native", artifacts, rootOwner: owner,
    rootOwnerScheme: 0,
    rootPayoutScriptHash: f.binding.rootState.payout_script_hash,
    buyer: owner, buyerScheme: 0,
    buyerPayoutScriptHash: f.binding.rootState.payout_script_hash,
    bidAmount: 5n, bidUnitPrice: 100000000n });
  const bidSpk = kw.payToScriptHashScript(plan.bid.redeemScript);
  const bidAddress = kw.addressFromScriptPublicKey(bidSpk, "testnet-10").toString();
  f.rootEntry.amount = 700000000n;
  f.rootEntry.scriptPublicKey = bidSpk;
  f.rootUtxo.address = bidAddress;
  f.rootUtxo.amountSompiExact = "700000000";
  f.rootUtxo.state = plan.bidState;
  f.request.request.builderKey = "kcc20fee.cancel-bid";
  f.request.request.params = { ...f.request.request.params, bidUtxo: f.rootUtxo };
  const built = await f.engine.build(f.request);
  const json = JSON.parse(built.psktTransactionJson);
  assert.deepEqual(built.signInputs, [{ index: 1, sighashType: 1 }]);
  assert.equal(json.outputs[0].covenant, null);
  assert.equal(BigInt(json.outputs[0].value), 700000000n);
  const signed = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  const script = built.scripts[0];
  let signature = Buffer.from(kw.createInputSignature(signed, 0, key, kw.SighashType.All), "hex");
  if (signature.length === 66 && signature[0] === 0x41) signature = signature.subarray(1);
  const args = new kw.ScriptBuilder({ flags: { covenantsEnabled: true } });
  for (const arg of script.signatureScript.args) {
    if (arg.type === "data") args.addData(Buffer.from(arg.hex, "hex"));
    else if (arg.type === "i64") args.addI64(BigInt(arg.value));
    else if (arg.type === "signature") args.addData(signature);
    else throw new Error(`unsupported bid cancel argument ${arg.type}`);
  }
  signed.inputs[0].signatureScript = kw.ScriptBuilder.fromScript(
    Buffer.from(script.scriptHex, "hex"), { flags: { covenantsEnabled: true } },
  ).encodePayToScriptHashSignatureScript(args.drain());
  signed.inputs[1].signatureScript = kw.createInputSignature(signed, 1, key, kw.SighashType.All);
  const non = f.engine.protocol.calculateToccataV1NonContextualMass(signed, "fee-market cancel bid");
  const storage = f.engine.protocol.calculateToccataStorageMass(signed, "fee-market cancel bid");
  assert(non.transactionMass <= 450000n);
  assert(storage <= 450000n);
});

function buyAskFixture(fillAmount = 5n) {
  const sellerKey = new kw.PrivateKey("04".padStart(64, "0"));
  const seller = sellerKey.toKeypair().xOnlyPublicKey.toString();
  const sellerWallet = sellerKey.toAddress("testnet-10").toString();
  const sellerSpk = kw.payToAddressScript(sellerWallet);
  const sellerScript = Buffer.from(String(sellerSpk.script), "hex");
  const payoutBytes = Buffer.alloc(11 + sellerScript.length);
  payoutBytes[0] = 0xe3;
  payoutBytes.writeUInt16LE(Number(sellerSpk.version), 1);
  payoutBytes.writeBigUInt64LE(BigInt(sellerScript.length), 3);
  sellerScript.copy(payoutBytes, 11);
  const sellerPayoutHash = hex(blake3(payoutBytes));
  const plan = prepareKcc20FeeMarketAsk({ tokenId, marketId,
    feeTicketId: "00".repeat(32), priceScale: 1n, policy,
    wrapperProfile: "native", artifacts, owner: seller,
    ownerScheme: 0, payoutScriptHash: sellerPayoutHash,
    holderAmount: 5n, askAmount: 5n, askUnitPrice: 100000000n });
  const askSpk = kw.payToScriptHashScript(plan.ask.redeemScript);
  const askAddress = kw.addressFromScriptPublicKey(askSpk, "testnet-10").toString();
  const askEntry = { outpoint: { transactionId: "1a".repeat(32), index: 0 },
    amount: 50000000n, scriptPublicKey: askSpk, blockDaaScore: 0n,
    isCoinbase: false, covenantId: marketId };
  const fundingEntry = { outpoint: { transactionId: "1b".repeat(32), index: 0 },
    amount: 3000000000n, scriptPublicKey: kw.payToAddressScript(wallet),
    blockDaaScore: 0n, isCoinbase: false };
  const askUtxo = { txidHex: askEntry.outpoint.transactionId, vout: 0,
    address: askAddress, amountSompiExact: "50000000",
    state: { ...plan.askState, feePolicyVersion: 1, creatorFeeBps: 0 } };
  const genesis = prepareKcc20FeeMarketGenesis({ tokenId,
    feeTicketId: "00".repeat(32), priceScale: 1n, policy,
    wrapperProfile: "native", artifacts });
  const request = { schema: "kcc20-in-process-pskt-builder-input/v1",
    request: { builderKey: "kcc20fee.buy-ask", network: "testnet-10",
      owner: { walletAddress: wallet, kcc20Owner: owner },
      params: { marketId, contractCanonicalTokenId: tokenId,
        feeTicketId: "00".repeat(32), priceScale: "1",
        fillAmount: fillAmount.toString(), feePolicy: policy,
        policyId: genesis.policyId, askUtxo } } };
  const engine = createKcc20PsktBuilderEngine({ wasm: kw,
    artifacts: { ...artifactMap, "KCC20.placeholder.json": native,
      "ArgentKCC20.reference.json": argent },
    rpcClientFactory: () => ({ connect: async () => {}, disconnect: async () => {},
      getUtxosByAddresses: async ({ addresses }) => ({ entries:
        addresses.includes(wallet) ? [fundingEntry] : [askEntry] }) }) });
  return { engine, request, askEntry, fundingEntry, askUtxo, plan, sellerWallet };
}

test("fee-market buyer fills an ask with one authenticated fee receipt", async () => {
  const f = buyAskFixture();
  const built = await f.engine.build(f.request);
  const json = JSON.parse(built.psktTransactionJson);
  assert.deepEqual(built.signInputs, [{ index: 1, sighashType: 1 }]);
  assert.equal(built.metadata.protocolFeeSompi, "50000000");
  assert.equal(built.metadata.creatorFeeSompi, "0");
  assert.equal(built.metadata.askContinuationOutputIndex, -1);
  assert.equal(BigInt(json.outputs[0].value), 50000000n);
  assert.equal(BigInt(json.outputs[1].value), 550000000n);
  assert.equal(BigInt(json.outputs[2].value), 50000000n);
  assert.equal(json.outputs[0].covenant.covenantId, marketId);
  assert.equal(json.outputs[2].covenant.covenantId, marketId);
  const signed = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  signed.inputs[1].signatureScript = kw.createInputSignature(signed, 1, key, kw.SighashType.All);
  const non = f.engine.protocol.calculateToccataV1NonContextualMass(signed, "fee-market buy ask");
  const storage = f.engine.protocol.calculateToccataStorageMass(signed, "fee-market buy ask");
  assert(non.transactionMass <= 450000n);
  assert(storage <= 450000n);
});

test("fee-market partial buy preserves the seller's remaining ask deposit", async () => {
  const f = buyAskFixture(2n);
  const built = await f.engine.build(f.request);
  const json = JSON.parse(built.psktTransactionJson);
  assert.equal(built.metadata.askContinuationOutputIndex, 1);
  assert.equal(built.metadata.sellerOutputIndex, 2);
  assert.equal(built.metadata.receiptOutputIndex, 3);
  assert.equal(BigInt(json.outputs[1].value), f.askEntry.amount);
  assert.equal(BigInt(json.outputs[2].value), 200000000n);
  assert.equal(BigInt(json.outputs[3].value), 50000000n);
});

test("fee-market buy rejects an ask from a different fixed policy", async () => {
  const f = buyAskFixture();
  f.askUtxo.state.feePolicy = "ff".repeat(361);
  await assert.rejects(f.engine.build(f.request), /fixed market policy/);
});

test("fee-market buy honors a covenant-owned ask's committed payout", async () => {
  const f = buyAskFixture();
  const seller = "aa".repeat(32);
  const plan = prepareKcc20FeeMarketAsk({ tokenId, marketId,
    feeTicketId: "00".repeat(32), priceScale: 1n, policy,
    wrapperProfile: "native", artifacts, owner: seller,
    ownerScheme: 3,
    payoutScriptHash: f.plan.askState.payout_script_hash,
    holderAmount: 5n, askAmount: 5n, askUnitPrice: 100000000n });
  const spk = kw.payToScriptHashScript(plan.ask.redeemScript);
  f.askEntry.scriptPublicKey = spk;
  f.askUtxo.address = kw.addressFromScriptPublicKey(spk, "testnet-10").toString();
  f.askUtxo.state = { ...plan.askState, feePolicyVersion: 1, creatorFeeBps: 0 };
  f.request.request.params.sellerPayoutAddress = f.sellerWallet;
  const built = await f.engine.build(f.request);
  const json = JSON.parse(built.psktTransactionJson);
  assert.equal(BigInt(json.outputs[built.metadata.sellerOutputIndex].value), 550000000n);
});

function claimFixture(party = "protocol", count = 1) {
  const escrow = artifacts.receipt;
  const parts = templateParts(escrow);
  const common = { token: tokenId, market: marketId,
    policy: "03".repeat(32), owner_scheme: 0,
    guard_template: "00".repeat(32), guard_prefix: "0", guard_suffix: "0",
    self_template: hex(parts.hash),
    self_prefix: String(parts.prefixLength), self_suffix: String(parts.suffixLength) };
  const receiptState = { ...common, role: "0",
    protocol_account: "04".repeat(32), creator_account: "05".repeat(32),
    protocol_amount: "50000000", creator_amount: "50000000",
    owner: "00".repeat(32), action_hash: "06".repeat(32), roleName: "receipt" };
  const accountId = party === "protocol" ? "04".repeat(32) : "05".repeat(32);
  const accountState = { ...common, role: "1",
    protocol_account: "00".repeat(32), creator_account: "00".repeat(32),
    protocol_amount: "0", creator_amount: "0", owner,
    action_hash: "00".repeat(32), roleName: "account" };
  const receiptScript = buildKcc20FeeEscrowScript(escrow, receiptState);
  const accountScript = buildKcc20FeeEscrowScript(escrow, accountState);
  const receiptSpk = kw.payToScriptHashScript(receiptScript.redeemScript);
  const accountSpk = kw.payToScriptHashScript(accountScript.redeemScript);
  const receiptAddress = kw.addressFromScriptPublicKey(receiptSpk, "testnet-10").toString();
  const accountAddress = kw.addressFromScriptPublicKey(accountSpk, "testnet-10").toString();
  const receiptEntries = Array.from({ length: count }, (_, index) => ({
    outpoint: { transactionId: (0x4a + index).toString(16).repeat(32), index: 0 },
    amount: 100000000n, scriptPublicKey: receiptSpk, blockDaaScore: 0n,
    isCoinbase: false, covenantId: marketId }));
  const accountEntry = { outpoint: { transactionId: "2b".repeat(32), index: 0 },
    amount: 500000000n, scriptPublicKey: accountSpk, blockDaaScore: 0n,
    isCoinbase: false, covenantId: accountId };
  const fundingEntry = { outpoint: { transactionId: "2c".repeat(32), index: 0 },
    amount: 500000000n, scriptPublicKey: kw.payToAddressScript(wallet),
    blockDaaScore: 0n, isCoinbase: false };
  const receipts = receiptEntries.map(entry => ({
    txidHex: entry.outpoint.transactionId, vout: 0,
    covenantIdHex: marketId, address: receiptAddress,
    scriptHashHex: receiptScript.scriptHash,
    amountSompiExact: "100000000", status: "active", spentByTxidHex: null,
    state: receiptState }));
  const account = { txidHex: accountEntry.outpoint.transactionId, vout: 0,
    covenantIdHex: accountId, address: accountAddress,
    scriptHashHex: accountScript.scriptHash,
    amountSompiExact: "500000000", status: "active", spentByTxidHex: null,
    state: accountState };
  const request = { schema: "kcc20-in-process-pskt-builder-input/v1",
    request: { builderKey: "kcc20fee.claim", network: "testnet-10",
      owner: { walletAddress: wallet, kcc20Owner: owner },
      params: { party, marketId, contractCanonicalTokenId: tokenId,
        policyId: "03".repeat(32), protocolAccountId: "04".repeat(32),
        creatorAccountId: "05".repeat(32), receipts, account } } };
  const engine = createKcc20PsktBuilderEngine({ wasm: kw,
    artifacts: { ...artifactMap, "KCC20.placeholder.json": native,
      "ArgentKCC20.reference.json": argent },
    rpcClientFactory: () => ({ connect: async () => {}, disconnect: async () => {},
      getUtxosByAddresses: async ({ addresses }) => ({ entries:
        addresses.includes(wallet) ? [fundingEntry]
          : [...receiptEntries, accountEntry] }) }) });
  return { engine, request, receiptEntry: receiptEntries[0], receiptEntries,
    accountEntry, fundingEntry, receipt: receipts[0], receipts, account };
}

test("fee-market protocol claim preserves creator share and account principal", async () => {
  const f = claimFixture();
  const built = await f.engine.build(f.request);
  const json = JSON.parse(built.psktTransactionJson);
  assert.deepEqual(built.signInputs, [{ index: 2, sighashType: 1 }]);
  assert.equal(built.metadata.claimSompi, "50000000");
  assert.equal(built.metadata.remainderSompi, "50000000");
  assert.equal(BigInt(json.outputs[0].value), 50000000n);
  assert.equal(BigInt(json.outputs[1].value), f.accountEntry.amount);
  assert.equal(BigInt(json.outputs[2].value), 50000000n);
  assert.equal(json.outputs[1].covenant.covenantId, "04".repeat(32));
  assert.equal(json.outputs[2].covenant.covenantId, marketId);
  const signed = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  const script = built.scripts[0];
  let signature = Buffer.from(kw.createInputSignature(signed, 1, key, kw.SighashType.All), "hex");
  if (signature.length === 66 && signature[0] === 0x41) signature = signature.subarray(1);
  const args = new kw.ScriptBuilder({ flags: { covenantsEnabled: true } });
  for (const arg of script.signatureScript.args) {
    if (arg.type === "data") args.addData(Buffer.from(arg.hex, "hex"));
    else if (arg.type === "i64") args.addI64(BigInt(arg.value));
    else if (arg.type === "byte") args.addData(Uint8Array.of(arg.value));
    else if (arg.type === "signature") args.addData(signature);
    else throw new Error(`unsupported claim argument ${arg.type}`);
  }
  signed.inputs[1].signatureScript = kw.ScriptBuilder.fromScript(
    Buffer.from(script.scriptHex, "hex"), { flags: { covenantsEnabled: true } },
  ).encodePayToScriptHashSignatureScript(args.drain());
  signed.inputs[2].signatureScript = kw.createInputSignature(signed, 2, key, kw.SighashType.All);
  const non = f.engine.protocol.calculateToccataV1NonContextualMass(signed, "fee-market claim");
  const storage = f.engine.protocol.calculateToccataStorageMass(signed, "fee-market claim");
  assert(non.transactionMass <= 450000n);
  assert(storage <= 450000n);
});

test("fee-market creator claim preserves protocol share", async () => {
  const f = claimFixture("creator");
  const built = await f.engine.build(f.request);
  assert.equal(built.metadata.claimSompi, "50000000");
  assert.equal(built.metadata.remainderSompi, "50000000");
  assert.equal(built.metadata.accountId, "05".repeat(32));
});

test("fee-market claims one through five receipts without spending principal", async () => {
  for (const count of [1, 2, 3, 4, 5]) {
    const f = claimFixture("protocol", count);
    const built = await f.engine.build(f.request);
    const json = JSON.parse(built.psktTransactionJson);
    assert.equal(built.metadata.receiptCount, count);
    assert.equal(built.metadata.claimSompi, String(count * 50000000));
    assert.equal(built.metadata.remainderSompi, String(count * 50000000));
    assert.equal(BigInt(json.outputs[1].value), f.accountEntry.amount);
    assert.deepEqual(built.signInputs, [{ index: count + 1, sighashType: 1 }]);
  }
});

test("fee-market account rotation preserves principal and changes only its authority", async () => {
  for (const next of [
    { newOwnerScheme: 0, newOwner: "aa".repeat(32) },
    { newOwnerScheme: 1, newOwner: hex(blake3(Buffer.from(owner, "hex"))),
      newOwnerPublicKey: owner },
    { newOwnerScheme: 2,
      newOwner: hex(blake3(Buffer.from(key.toKeypair().publicKey, "hex"))),
      newOwnerPublicKey: key.toKeypair().publicKey },
    { newOwnerScheme: 3,
      newOwner: String(kw.payToScriptHashScript(Uint8Array.of(0x51)).script).slice(4, 68),
      newOwnerP2shRedeemScriptHex: "51",
      newGuardTemplate: "bb".repeat(32) },
    { newOwnerScheme: 4, newOwner: "aa".repeat(32),
      newGuardTemplate: "bb".repeat(32), newGuardPrefix: "1", newGuardSuffix: "2" },
  ]) {
    const f = claimFixture();
    f.request.request.builderKey = "kcc20fee.rotate-account";
    f.request.request.params = { account: f.account,
      marketId, contractCanonicalTokenId: tokenId,
      policyId: "03".repeat(32), accountId: "04".repeat(32), ...next };
    const built = await f.engine.build(f.request);
    const json = JSON.parse(built.psktTransactionJson);
    assert.equal(built.metadata.newOwnerScheme, next.newOwnerScheme);
    assert.equal(BigInt(json.outputs[0].value), f.accountEntry.amount);
    assert.equal(json.outputs[0].covenant.covenantId, "04".repeat(32));
    assert.deepEqual(built.signInputs, [{ index: 1, sighashType: 1 }]);
  }
});

test("fee-market rotation rejects a mismatched new key or P2SH program", async () => {
  for (const next of [
    { newOwnerScheme: 1, newOwner: "aa".repeat(32), newOwnerPublicKey: owner },
    { newOwnerScheme: 2, newOwner: "aa".repeat(32),
      newOwnerPublicKey: key.toKeypair().publicKey },
    { newOwnerScheme: 3, newOwner: "aa".repeat(32),
      newOwnerP2shRedeemScriptHex: "51", newGuardTemplate: "bb".repeat(32) },
  ]) {
    const f = claimFixture();
    f.request.request.builderKey = "kcc20fee.rotate-account";
    f.request.request.params = { account: f.account,
      marketId, contractCanonicalTokenId: tokenId,
      policyId: "03".repeat(32), accountId: "04".repeat(32), ...next };
    await assert.rejects(f.engine.build(f.request), /does not match/);
  }
});
