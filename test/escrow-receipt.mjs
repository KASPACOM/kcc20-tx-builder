import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2b";
import { verifyKcc20FeeReceiptForClaim } from "../dist/index.js";

const artifact = JSON.parse(readFileSync(new URL("../artifacts/KCC20FeeEscrowV1.placeholder.json", import.meta.url)));
const scriptHash = "6d7bffe991458166952a8c80c80f5583c37aec7fab7a6960e2a12ea346e02976";
const tokenId = "01".repeat(32);
const marketId = "02".repeat(32);
const policyId = "03".repeat(32);
const protocolAccountId = "04".repeat(32);
const creatorAccountId = "05".repeat(32);
const zero = "00".repeat(32);
const txid = "0a".repeat(32);
const state = {
  role: "0", token: tokenId, market: marketId, policy: policyId,
  protocol_account: protocolAccountId, creator_account: creatorAccountId,
  protocol_amount: "50000000", creator_amount: "50000000", owner: zero,
  owner_scheme: 0, guard_template: zero, guard_prefix: "0", guard_suffix: "0",
  action_hash: zero,
  self_template: "4f76258921097a2c778865573434179b4c37b0f6e1a87865bd09bd22f4dbb12e",
  self_prefix: "1", self_suffix: "24713", roleName: "receipt",
};
const indexed = {
  txidHex: txid, vout: 0, covenantIdHex: marketId, scriptHashHex: scriptHash,
  amountSompiExact: "100000000", status: "active", spentByTxidHex: null, state,
};
const live = {
  outpoint: { transactionId: txid, index: 0 }, amountSompi: 100000000n,
  covenantIdHex: marketId,
  scriptPublicKey: { version: 0, scriptHex: `aa20${scriptHash}87` },
};
const expected = { tokenId, marketId, policyId, protocolAccountId, creatorAccountId };

function verify(changes = {}) {
  return verifyKcc20FeeReceiptForClaim({ artifact, indexed, live, expected, ...changes });
}

function changedReceipt(changes) {
  const script = Uint8Array.from(artifact.contracts.KCC20FeeEscrowV1.compiled.bytecode);
  const stateValues = { ...state, ...changes };
  const fieldNames = artifact.contracts.KCC20FeeEscrowV1.runtime_state.fields.map(field => field.name);
  let cursor = 1;
  for (const name of fieldNames) {
    let length = script[cursor++];
    if (length === 0x4c) length = script[cursor++];
    if (Object.hasOwn(changes, name)) {
      if (length === 8) new DataView(script.buffer).setBigUint64(cursor, BigInt(stateValues[name]), true);
      else if (length === 32) script.set(Buffer.from(stateValues[name], "hex"), cursor);
      else throw new Error(`unsupported fixture field: ${name}`);
    }
    cursor += length;
  }
  const hash = Buffer.from(blake2b(script, { dkLen: 32 })).toString("hex");
  return {
    script,
    indexed: { ...indexed, state: stateValues, scriptHashHex: hash },
    live: { ...live, scriptPublicKey: { version: 0, scriptHex: `aa20${hash}87` } },
  };
}

test("pinned receipt reconstructs the exact live script and amounts", () => {
  const result = verify();
  assert.deepEqual(result.receipt, {
    outpoint: { transactionId: txid, index: 0 }, tokenId, marketId, policyId,
    protocolAccountId, creatorAccountId,
    valueSompi: 100000000n, protocolSompi: 50000000n, creatorSompi: 50000000n,
  });
  assert.deepEqual(result.redeemScript, Uint8Array.from(artifact.contracts.KCC20FeeEscrowV1.compiled.bytecode));
});

test("trade group receipt and one-sided claim replacement preserve exact script binding", () => {
  const trade = changedReceipt({ action_hash: "09".repeat(32) });
  assert.deepEqual(verify({ indexed: trade.indexed, live: trade.live }).redeemScript, trade.script);

  const replacement = changedReceipt({ protocol_amount: "100000000", creator_amount: "0" });
  const result = verify({ indexed: replacement.indexed, live: replacement.live });
  assert.deepEqual(result.redeemScript, replacement.script);
  assert.equal(result.receipt.protocolSompi, 100000000n);
  assert.equal(result.receipt.creatorSompi, 0n);
});

test("receipt authentication rejects mismatched lineage, live UTXO and script", () => {
  for (const changes of [
    { expected: { ...expected, marketId: "09".repeat(32) } },
    { indexed: { ...indexed, scriptHashHex: "09".repeat(32) } },
    { indexed: { ...indexed, covenantIdHex: "09".repeat(32) } },
    { indexed: { ...indexed, status: "spent" } },
    { indexed: { ...indexed, spentByTxidHex: "0b".repeat(32) } },
    { indexed: { ...indexed, amountSompiExact: "50000000" } },
    { live: { ...live, amountSompi: 50000000n } },
    { live: { ...live, outpoint: { ...live.outpoint, index: 1 } } },
    { live: { ...live, scriptPublicKey: { ...live.scriptPublicKey, version: 1 } } },
    { live: { ...live, scriptPublicKey: { ...live.scriptPublicKey, scriptHex: `aa20${"09".repeat(32)}87` } } },
  ]) assert.throws(() => verify(changes));
});

test("receipt authentication rejects altered entitlements and state anchors", () => {
  for (const changedState of [
    { creator_amount: "49999999" }, { protocol_amount: "49999999" },
    { creator_amount: "0", protocol_amount: "0" },
    { policy: "09".repeat(32) }, { owner: "09".repeat(32) },
    { self_template: "09".repeat(32) }, { self_suffix: "24714" },
    { action_hash: "09".repeat(32) },
  ]) assert.throws(() => verify({ indexed: { ...indexed, state: { ...state, ...changedState } } }));
});

test("receipt authentication rejects a modified artifact", () => {
  const changed = structuredClone(artifact);
  changed.contracts.KCC20FeeEscrowV1.compiled.bytecode[0] ^= 1;
  assert.throws(() => verify({ artifact: changed }));
});
