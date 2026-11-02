import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blake3 } from "@noble/hashes/blake3";
import * as kw from "../examples/vendor/kaspa/kaspa.js";
import {
  buildKcc20FeeMarketRoleScript, createKcc20PsktBuilderEngine,
  prepareKcc20FeeMarketGenesis, prepareKcc20FeeMarketWrappedHolder,
  saleCommon, templateParts,
  isKcc20BuilderKey,
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
const ownerKey = new kw.PrivateKey("03".padStart(64, "0"));
const owner = ownerKey.toKeypair().xOnlyPublicKey.toString();
const wallet = ownerKey.toAddress("testnet-10").toString();
const sellerSpk = kw.payToAddressScript(wallet);
const sellerScript = Buffer.from(String(sellerSpk.script), "hex");
const payoutBytes = Buffer.alloc(11 + sellerScript.length);
payoutBytes[0] = 0xe3;
payoutBytes.writeUInt16LE(Number(sellerSpk.version), 1);
payoutBytes.writeBigUInt64LE(BigInt(sellerScript.length), 3);
sellerScript.copy(payoutBytes, 11);
const payoutHash = hex(blake3(payoutBytes));
const base = { tokenId, feeTicketId: "00".repeat(32), priceScale: 1n,
  policy, wrapperProfile: "native", artifacts, marketId };
const policyId = prepareKcc20FeeMarketGenesis(base).policyId;

function fixture(count, { partialFirst = false, holderExtra = 0, useTicket = false,
  creatorFeeBps = 0, bidPriceSompi = 100_000_000n } = {}) {
  const ticketRoot = useTicket ? "05".repeat(32) : "00".repeat(32);
  const marketPolicy = creatorFeeBps > 0
    ? { ...policy, creatorFeeBps, creatorAccountId: "07".repeat(32) } : policy;
  const marketBase = { ...base, feeTicketId: ticketRoot, policy: marketPolicy };
  const marketPolicyId = prepareKcc20FeeMarketGenesis(marketBase).policyId;
  const holder = prepareKcc20FeeMarketWrappedHolder({ ...marketBase,
    recipientOwner: owner, recipientOwnerScheme: 0,
    recipientPayoutScriptHash: payoutHash, tokenAmount: BigInt(count + holderExtra) });
  const holderSpk = kw.payToScriptHashScript(holder.holder.redeemScript);
  const holderAddress = kw.addressFromScriptPublicKey(holderSpk, "testnet-10").toString();
  const holderEntry = {
    outpoint: { transactionId: "10".repeat(32), index: 0 }, amount: 50_000_000n,
    scriptPublicKey: holderSpk, blockDaaScore: 0n, isCoinbase: false,
    covenantId: marketId,
  };
  const bids = Array.from({ length: count }, (_, slot) => {
    const bidAmount = partialFirst && slot === 0 ? 2 : 1;
    const bidSompi = BigInt(bidAmount) * bidPriceSompi + 200_000_000n;
    const buyer = new kw.PrivateKey((slot + 4).toString(16).padStart(64, "0"))
      .toKeypair().xOnlyPublicKey.toString();
    const state = { ...holder.holderState, owner: buyer, owner_scheme: 0,
      amount: String(bidAmount), mode: "3", unitPrice: bidPriceSompi.toString(),
      payout_script_hash: payoutHash };
    const script = buildKcc20FeeMarketRoleScript({ artifact: artifacts.bid,
      role: "bid", state });
    const spk = kw.payToScriptHashScript(script.redeemScript);
    const address = kw.addressFromScriptPublicKey(spk, "testnet-10").toString();
    return { bidUtxo: { txidHex: (slot + 20).toString(16).padStart(2, "0").repeat(32),
      vout: 0, address, amountSompiExact: bidSompi.toString(), state },
      entry: { outpoint: { transactionId: (slot + 20).toString(16).padStart(2, "0").repeat(32), index: 0 },
        amount: bidSompi, scriptPublicKey: spk, blockDaaScore: 0n,
        isCoinbase: false, covenantId: marketId }, fillAmount: "1" };
  });
  const fundingEntry = { outpoint: { transactionId: "ee".repeat(32), index: 0 },
    amount: 10_000_000_000n, scriptPublicKey: sellerSpk, blockDaaScore: 0n,
    isCoinbase: false };
  const byAddress = new Map([[holderAddress, [holderEntry]], [wallet, [fundingEntry]]]);
  for (const bid of bids) byAddress.set(bid.bidUtxo.address, [bid.entry]);
  const ticket = useTicket ? (() => {
    const utilityTokenId = "06".repeat(32);
    const script = saleCommon.buildKcc20FeeTicketScriptForState(artifacts.ticket.script, {
      ownerIdentifier: Buffer.from(owner, "hex"), ownerScheme: 0, mode: 2,
      utilityTokenId: Buffer.from(utilityTokenId, "hex"), denomination: 1n,
    });
    const spk = kw.payToScriptHashScript(script);
    const address = kw.addressFromScriptPublicKey(spk, "testnet-10").toString();
    const entry = { outpoint: { transactionId: "aa".repeat(32), index: 0 },
      amount: 100_000_000n, scriptPublicKey: spk, blockDaaScore: 0n,
      isCoinbase: false, covenantId: ticketRoot };
    byAddress.set(address, [entry]);
    return { entry, utxo: { txidHex: entry.outpoint.transactionId, vout: 0,
      address, amountSompiExact: "100000000",
      state: { stateOwner: owner, ownerScheme: 0, stateMode: 2,
        utilityTokenId, denomination: "1" } } };
  })() : null;
  const engine = createKcc20PsktBuilderEngine({ wasm: kw, artifacts: artifactMap,
    rpcClientFactory: () => ({ connect: async () => {}, disconnect: async () => {},
      getUtxosByAddresses: async ({ addresses }) => ({
        entries: addresses.flatMap(address => byAddress.get(address) || []),
      }),
    }),
  });
  const request = { schema: "kcc20-in-process-pskt-builder-input/v1", request: {
    builderKey: "kcc20fee.sell-into-bids", network: "testnet-10",
    owner: { walletAddress: wallet, kcc20Owner: owner },
    params: { marketId, contractCanonicalTokenId: tokenId,
      feeTicketId: ticketRoot, priceScale: "1", feePolicy: marketPolicy,
      policyId: marketPolicyId,
      holderUtxo: { txidHex: holderEntry.outpoint.transactionId, vout: 0,
        address: holderAddress, amountSompiExact: "50000000", state: holder.holderState },
      bids: bids.map(({ bidUtxo, fillAmount }) => ({ bidUtxo, fillAmount })),
      ...(ticket ? { feeTicketUtxo: ticket.utxo } : {}),
    },
  } };
  return { engine, request, holderEntry, bids, fundingEntry, ticket };
}

function signBuilt(built, f) {
  const tx = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  for (const script of built.scripts) {
    const args = new kw.ScriptBuilder();
    let sig = Buffer.from(kw.createInputSignature(tx, script.inputIndex,
      ownerKey, kw.SighashType.All), "hex");
    if (sig.length === 66 && sig[0] === 0x41) sig = sig.subarray(1);
    if (script.signatureScript.mode === "signature-first-args") args.addData(sig);
    for (const arg of script.signatureScript.args) {
      if (arg.type === "signature") args.addData(sig);
      else if (arg.type === "i64") args.addI64(BigInt(arg.value));
      else if (arg.type === "data") args.addData(Buffer.from(arg.hex, "hex"));
      else throw new Error(`unsupported seller witness argument ${arg.type}`);
    }
    tx.inputs[script.inputIndex].signatureScript = kw.ScriptBuilder.fromScript(
      Buffer.from(script.scriptHex, "hex"), { flags: { covenantsEnabled: true } },
    ).encodePayToScriptHashSignatureScript(args.drain());
  }
  const fundingIndex = built.signInputs[0].index;
  tx.inputs[fundingIndex].signatureScript = kw.createInputSignature(
    tx, fundingIndex, ownerKey, kw.SighashType.All);
  return tx;
}

for (const count of [3, 10]) {
  test(`fee-market ${count}-bid seller sweep signs one receipt and returns deposits`, async () => {
    const f = fixture(count);
    assert.equal(isKcc20BuilderKey(f.request.request.builderKey), true);
    const built = await f.engine.build(f.request);
    assert.equal(built.metadata.fillCount, count);
    assert.equal(built.metadata.protocolFeeSompi, String(count * 50_000_000));
    assert.equal(built.metadata.creatorFeeSompi, "0");
    assert.equal(built.metadata.sellerRefundIndex, count * 2 + 1);
    const tx = signBuilt(built, f);
    const mass = f.engine.protocol.calculateToccataV1NonContextualMass(tx,
      `fee-market ${count}-bid seller sweep`);
    const storage = f.engine.protocol.calculateToccataStorageMass(tx,
      `fee-market ${count}-bid seller sweep`);
    assert(mass.computeMass <= 450_000n, `compute ${mass.computeMass}`);
    assert(mass.transientMass <= 900_000n, `transient ${mass.transientMass}`);
    assert(storage <= 450_000n, `storage ${storage}`);
    const paidFee = f.holderEntry.amount + f.fundingEntry.amount +
      f.bids.reduce((sum, bid) => sum + bid.entry.amount, 0n) -
      tx.outputs.reduce((sum, output) => sum + BigInt(output.value), 0n);
    const requiredFee = (mass.transactionMass > storage ? mass.transactionMass : storage) * 100n;
    assert(paidFee >= requiredFee, `paid ${paidFee} required ${requiredFee}`);
  });
}

test("seller sweep accepts indexed policy summaries without treating them as script state", async () => {
  const f = fixture(3, { creatorFeeBps: 100, bidPriceSompi: 300_000_000n });
  for (const bid of f.bids) {
    bid.bidUtxo.state.creatorFeeBps = 100;
    bid.bidUtxo.state.feePolicyVersion = 1;
  }
  const built = await f.engine.build(f.request);
  assert.equal(built.metadata.fillCount, 3);
  assert.equal(built.metadata.creatorFeeSompi, "150000000");
  f.bids[0].bidUtxo.state.creatorFeeBps = 0;
  await assert.rejects(f.engine.build(f.request), /indexed policy summary differs/);
});

test("seller sweep rejects a changed live bid lineage", async () => {
  const f = fixture(3);
  f.bids[0].entry.covenantId = "ff".repeat(32);
  await assert.rejects(f.engine.build(f.request), /covenant/i);
});

for (const count of [3, 10]) {
test(`one burned ticket waives every protocol fee in a ${count}-bid sale`, async () => {
  const f = fixture(count, { useTicket: true });
  const built = await f.engine.build(f.request);
  assert.equal(built.metadata.protocolFeeSompi, "0");
  assert.equal(built.metadata.creatorFeeSompi, "0");
  assert.equal(built.metadata.receiptOutputIndex, -1);
  assert.equal(built.metadata.ticketInputIndex, count + 1);
  assert.equal(built.metadata.ticketRefundIndex, count * 2 + 1);
  assert.equal(built.scripts.length, 2);
  const tx = signBuilt(built, f);
  assert.equal(BigInt(tx.outputs[count * 2 + 1].value), f.ticket.entry.amount);
  const mass = f.engine.protocol.calculateToccataV1NonContextualMass(tx, "ticket seller sweep");
  const storage = f.engine.protocol.calculateToccataStorageMass(tx, "ticket seller sweep");
  assert(mass.computeMass <= 450_000n);
  assert(mass.transientMass <= 900_000n);
  assert(storage <= 450_000n);
  f.ticket.entry.covenantId = "ff".repeat(32);
  await assert.rejects(f.engine.build(f.request), /covenant/i);
});
}

test("partial bid and seller remainder keep both locked deposits", async () => {
  const f = fixture(3, { partialFirst: true, holderExtra: 1 });
  const built = await f.engine.build(f.request);
  assert.equal(built.metadata.sellerChangeIndex, 7);
  assert.equal(built.metadata.sellerRefundIndex, -1);
  const tx = signBuilt(built, f);
  assert.equal(BigInt(tx.outputs[1].value), 300_000_000n);
  assert.equal(BigInt(tx.outputs[7].value), 50_000_000n);
  const mass = f.engine.protocol.calculateToccataV1NonContextualMass(tx, "partial seller sweep");
  const storage = f.engine.protocol.calculateToccataStorageMass(tx, "partial seller sweep");
  assert(mass.computeMass <= 450_000n);
  assert(mass.transientMass <= 900_000n);
  assert(storage <= 450_000n);
});

test("creator fees survive a grouped ticket waiver", async () => {
  const f = fixture(3, { useTicket: true, creatorFeeBps: 500,
    bidPriceSompi: 10_000_000_000n });
  const built = await f.engine.build(f.request);
  assert.equal(built.metadata.protocolFeeSompi, "0");
  assert.equal(built.metadata.creatorFeeSompi, "1500000000");
  assert.equal(built.metadata.receiptOutputIndex, 6);
  assert.equal(built.metadata.ticketRefundIndex, 8);
  const tx = signBuilt(built, f);
  assert.equal(BigInt(tx.outputs[6].value), 1_500_000_000n);
  const mass = f.engine.protocol.calculateToccataV1NonContextualMass(tx, "creator ticket sweep");
  assert(mass.computeMass <= 450_000n);
  assert(mass.transientMass <= 900_000n);
  assert(f.engine.protocol.calculateToccataStorageMass(tx, "creator ticket sweep") <= 450_000n);
});
