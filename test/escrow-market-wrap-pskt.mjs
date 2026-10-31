import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blake3 } from "@noble/hashes/blake3";
import * as kw from "../examples/vendor/kaspa/kaspa.js";
import {
  buildKcc20ScriptForState, createKcc20PsktBuilderEngine,
  prepareKcc20FeeMarketGenesis, prepareKcc20FeeMarketWrappedHolder,
  prepareKcc20FeeMarketAsk, templateParts,
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
