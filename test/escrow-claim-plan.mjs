import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2b";
import { planKcc20FeeClaimTransition, verifyKcc20FeeAccountForClaim } from "../dist/index.js";

const zero = "00".repeat(32);
const tokenId = "01".repeat(32);
const marketId = "02".repeat(32);
const policyId = "03".repeat(32);
const protocolAccountId = "04".repeat(32);
const creatorAccountId = "05".repeat(32);
const receipt = {
  outpoint: { transactionId: "0a".repeat(32), index: 0 },
  tokenId, marketId, policyId, protocolAccountId, creatorAccountId,
  valueSompi: 100000000n, protocolSompi: 50000000n, creatorSompi: 50000000n,
};
const state = {
  role: "1", token: tokenId, market: marketId, policy: policyId,
  protocol_account: zero, creator_account: zero,
  protocol_amount: "0", creator_amount: "0",
  owner: "07".repeat(32), owner_scheme: 0,
  guard_template: zero, guard_prefix: "0", guard_suffix: "0",
  action_hash: zero,
  self_template: "4f76258921097a2c778865573434179b4c37b0f6e1a87865bd09bd22f4dbb12e",
  self_prefix: "1", self_suffix: "24713",
};
const protocolAccount = {
  outpoint: { transactionId: "0b".repeat(32), index: 0 },
  covenantId: protocolAccountId, principalSompi: 500000000n, state,
};
const creatorAccount = {
  ...protocolAccount,
  outpoint: { transactionId: "0c".repeat(32), index: 0 },
  covenantId: creatorAccountId,
};
const payoutScriptPublicKey = Uint8Array.of(0, 0, 0x51);
const escrowTemplate = { hash: state.self_template, prefixLength: 1, suffixLength: 24713 };
const artifact = JSON.parse(readFileSync(new URL("../artifacts/KCC20FeeEscrowV1.placeholder.json", import.meta.url)));

function accountProof(changes = {}) {
  const candidate = { ...state, ...changes, roleName: "account" };
  const script = Uint8Array.from(artifact.contracts.KCC20FeeEscrowV1.compiled.bytecode);
  const fields = artifact.contracts.KCC20FeeEscrowV1.runtime_state.fields;
  let cursor = 1;
  for (const { name } of fields) {
    let length = script[cursor++];
    if (length === 0x4c) length = script[cursor++];
    if (length === 8) new DataView(script.buffer).setBigUint64(cursor, BigInt(candidate[name]), true);
    else if (length === 32) script.set(Buffer.from(candidate[name], "hex"), cursor);
    else if (length === 1) script[cursor] = candidate[name];
    else throw new Error(`unexpected escrow field ${name}`);
    cursor += length;
  }
  const hash = Buffer.from(blake2b(script, { dkLen: 32 })).toString("hex");
  return {
    indexed: {
      txidHex: protocolAccount.outpoint.transactionId, vout: 0,
      covenantIdHex: protocolAccountId, scriptHashHex: hash,
      amountSompiExact: protocolAccount.principalSompi.toString(),
      status: "active", spentByTxidHex: null, state: candidate,
    },
    live: {
      outpoint: protocolAccount.outpoint, amountSompi: protocolAccount.principalSompi,
      covenantIdHex: protocolAccountId,
      scriptPublicKey: { version: 0, scriptHex: `aa20${hash}87` },
    },
  };
}

test("pinned live account proof binds the principal, owner and exact escrow script", () => {
  const proof = accountProof();
  const verified = verifyKcc20FeeAccountForClaim({
    artifact, ...proof, expected: { tokenId, marketId, policyId, accountId: protocolAccountId },
  });
  assert.equal(verified.account.principalSompi, 500000000n);
  assert.equal(verified.account.state.owner, state.owner);
  assert.deepEqual(verified.escrowTemplate, escrowTemplate);
  const plan = planKcc20FeeClaimTransition({
    receipts: [receipt], party: "protocol", account: verified.account,
    escrowTemplate: verified.escrowTemplate, payoutScriptPublicKey,
  });
  assert.equal(plan.claimSompi, 50000000n);
  for (const changed of [
    { indexed: { ...proof.indexed, amountSompiExact: "499999999" } },
    { live: { ...proof.live, amountSompi: 499999999n } },
    { indexed: { ...proof.indexed, covenantIdHex: creatorAccountId } },
    { indexed: { ...proof.indexed, state: { ...proof.indexed.state, owner: "09".repeat(32) } } },
    { indexed: { ...proof.indexed, status: "spent" } },
    { live: { ...proof.live, scriptPublicKey: { version: 0, scriptHex: `aa20${zero}87` } } },
  ]) assert.throws(() => verifyKcc20FeeAccountForClaim({
    artifact, ...proof, ...changed,
    expected: { tokenId, marketId, policyId, accountId: protocolAccountId },
  }));
});

test("account proof accepts all five authority shapes and rejects invalid guards", () => {
  const expected = { tokenId, marketId, policyId, accountId: protocolAccountId };
  for (const changes of [
    {},
    { owner_scheme: 1 },
    { owner_scheme: 2 },
    { owner_scheme: 3, guard_template: "08".repeat(32) },
    { owner_scheme: 4, guard_template: "08".repeat(32), guard_prefix: "1", guard_suffix: "42" },
  ]) {
    const proof = accountProof(changes);
    assert.equal(verifyKcc20FeeAccountForClaim({ artifact, ...proof, expected }).account.state.owner_scheme,
      changes.owner_scheme ?? 0);
  }
  for (const changes of [
    { owner_scheme: 1, guard_template: "08".repeat(32) },
    { owner_scheme: 2, guard_prefix: "1" },
    { owner_scheme: 3, guard_template: zero },
    { owner_scheme: 4, guard_template: "08".repeat(32), guard_prefix: "1" },
    { self_template: "09".repeat(32) },
    { self_suffix: "24714" },
  ]) {
    const proof = accountProof(changes);
    assert.throws(() => verifyKcc20FeeAccountForClaim({ artifact, ...proof, expected }));
  }
});

test("protocol claim matches the signed consensus commitment vector and preserves creator fees", () => {
  const plan = planKcc20FeeClaimTransition({
    receipts: [receipt], party: "protocol", account: protocolAccount, escrowTemplate, payoutScriptPublicKey,
  });
  assert.equal(plan.commitment, "3fa2f4ab53b3d314e7cfdc0cb25beb4f594a7d690cf0d74d872585872119c88c");
  assert.equal(plan.claimSompi, 50000000n);
  assert.equal(plan.accountPrincipalSompi, 500000000n);
  assert.equal(plan.remainderSompi, 50000000n);
  assert.equal(plan.successorAccountState.action_hash, plan.commitment);
  assert.equal(plan.successorAccountState.owner, state.owner);
  assert.equal(plan.remainderReceiptState.protocol_amount, "0");
  assert.equal(plan.remainderReceiptState.creator_amount, "50000000");
  assert.equal(plan.requiresSeparateNetworkFunding, true);
});

test("creator and protocol can claim either order without consuming the other's share", () => {
  for (const firstParty of ["creator", "protocol"]) {
    const firstAccount = firstParty === "creator" ? creatorAccount : protocolAccount;
    const first = planKcc20FeeClaimTransition({
      receipts: [receipt], party: firstParty, account: firstAccount, escrowTemplate, payoutScriptPublicKey,
    });
    const remaining = {
      ...receipt,
      outpoint: { transactionId: "0d".repeat(32), index: 0 },
      valueSompi: first.remainderSompi,
      protocolSompi: BigInt(first.remainderReceiptState.protocol_amount),
      creatorSompi: BigInt(first.remainderReceiptState.creator_amount),
    };
    const otherParty = firstParty === "creator" ? "protocol" : "creator";
    const second = planKcc20FeeClaimTransition({
      receipts: [remaining], party: otherParty,
      account: otherParty === "creator" ? creatorAccount : protocolAccount,
      escrowTemplate, payoutScriptPublicKey,
    });
    assert.equal(first.claimSompi + second.claimSompi, receipt.valueSompi);
    assert.equal(second.remainderSompi, 0n);
    assert.equal(second.remainderReceiptState, null);
    assert.equal(second.accountPrincipalSompi, 500000000n);
  }
});

test("claim plan rejects wrong account, malformed authorities and mixed receipts", () => {
  const base = { receipts: [receipt], party: "protocol", account: protocolAccount, escrowTemplate, payoutScriptPublicKey };
  for (const account of [
    creatorAccount,
    { ...protocolAccount, principalSompi: 0n },
    { ...protocolAccount, principalSompi: 500000000 },
    { ...protocolAccount, state: { ...state, owner_scheme: 5 } },
    { ...protocolAccount, state: { ...state, owner_scheme: 3, guard_template: zero } },
    { ...protocolAccount, state: { ...state, owner_scheme: 4, guard_template: "08".repeat(32), guard_prefix: "0" } },
    { ...protocolAccount, state: { ...state, protocol_amount: "1" } },
    { ...protocolAccount, state: { ...state, self_template: "09".repeat(32) } },
  ]) assert.throws(() => planKcc20FeeClaimTransition({ ...base, account }));
  assert.throws(() => planKcc20FeeClaimTransition({ ...base, escrowTemplate: { ...escrowTemplate, prefixLength: 2 } }));
  assert.throws(() => planKcc20FeeClaimTransition({
    ...base, receipts: [receipt, { ...receipt, marketId: "09".repeat(32), outpoint: { transactionId: "0e".repeat(32), index: 0 } }],
  }));
});
