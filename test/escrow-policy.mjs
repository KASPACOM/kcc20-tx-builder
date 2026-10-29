import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeKcc20EscrowPolicy, decodeKcc20EscrowPolicy, kcc20EscrowPolicyId, kcc20FeeClaimCommitment, kcc20CreatorFeeConsent } from "../dist/index.js";

const policy = { version: 1, creatorFeeBps: 100,
  protocolAccountId: "04".repeat(32), creatorAccountId: "05".repeat(32),
  receiptTemplate: { hash: "06".repeat(32), prefixLength: 1, suffixLength: 2 },
  rootTemplate: { hash: "07".repeat(32), prefixLength: 3, suffixLength: 4 },
  holderTemplate: { hash: "08".repeat(32), prefixLength: 5, suffixLength: 6 },
  askTemplate: { hash: "09".repeat(32), prefixLength: 7, suffixLength: 8 },
  bidTemplate: { hash: "0a".repeat(32), prefixLength: 9, suffixLength: 10 },
  ticketTemplate: { hash: "0b".repeat(32), prefixLength: 11, suffixLength: 12 } };
const receipt = { outpoint: { transactionId: "0a".repeat(32), index: 0 },
  tokenId: "01".repeat(32), marketId: "02".repeat(32), policyId: "03".repeat(32),
  protocolAccountId: policy.protocolAccountId, creatorAccountId: policy.creatorAccountId,
  valueSompi: 100000000n, protocolSompi: 50000000n, creatorSompi: 50000000n };

test("creator consent matches the wallet personal-message hash and binds immutable market terms", () => {
  const input = { tokenId: receipt.tokenId, marketId: receipt.marketId, feeTicketId: "00".repeat(32), priceScale: 1n, policy };
  const consent = kcc20CreatorFeeConsent(input);
  assert.deepEqual(consent, {
    commitment: "76b8db1c7c0172ca166f6847c3a35b2853ab9d08c8d6ddd8663b339d9c6f592d",
    message: "KCC20 creator fee consent v1 (TN10)\n76b8db1c7c0172ca166f6847c3a35b2853ab9d08c8d6ddd8663b339d9c6f592d",
    personalMessageHash: "f04865728540ec01e3b602472dc496e65aed6f400d98357bb72fe5e4246daf5d",
  });
  for (const change of [{ tokenId: "08".repeat(32) }, { marketId: "09".repeat(32) }, { feeTicketId: "0a".repeat(32) },
    { priceScale: 100n }, { policy: { ...policy, creatorFeeBps: 500 } },
    { policy: { ...policy, creatorAccountId: "0b".repeat(32) } }]) {
    assert.notEqual(kcc20CreatorFeeConsent({ ...input, ...change }).personalMessageHash, consent.personalMessageHash);
  }
  assert.throws(() => kcc20CreatorFeeConsent({ ...input, priceScale: 0n }));
  assert.throws(() => kcc20CreatorFeeConsent({ ...input, policy: { ...policy, creatorFeeBps: 0 } }));
});

test("fixed policy encoding and identity vector", () => {
  const bytes = encodeKcc20EscrowPolicy(policy);
  assert.equal(bytes.length, 361);
  assert.deepEqual(decodeKcc20EscrowPolicy(bytes), policy);
  assert.equal(kcc20EscrowPolicyId({ tokenId: receipt.tokenId, feeTicketId: "00".repeat(32), priceScale: 1n, policy }),
    "fd95ad05f73f170b75645572aed9013c6356074657e1ae478e6334fd6ed73093");
  const shifted = new Uint8Array(367); shifted.set(bytes, 3);
  assert.deepEqual(decodeKcc20EscrowPolicy(shifted.subarray(3, 364)), policy);
});

test("policy rejects forged encoding, invalid accounts and unsupported rates", () => {
  for (const change of [{ version: 2 }, { creatorFeeBps: 501 }, { creatorFeeBps: -1 },
    { creatorAccountId: "00".repeat(32) }, { protocolAccountId: policy.creatorAccountId },
    { receiptTemplate: { ...policy.receiptTemplate, prefixLength: 0 } },
    { ticketTemplate: { ...policy.ticketTemplate, hash: "00".repeat(32) } }]) {
    assert.throws(() => encodeKcc20EscrowPolicy({ ...policy, ...change }));
  }
  const disabled = { ...policy, creatorFeeBps: 0, creatorAccountId: "00".repeat(32) };
  assert.deepEqual(decodeKcc20EscrowPolicy(encodeKcc20EscrowPolicy(disabled)), disabled);
  assert.throws(() => encodeKcc20EscrowPolicy({ ...policy, creatorFeeBps: 0 }));
  const negativeZero = encodeKcc20EscrowPolicy(disabled); negativeZero[8] = 0x80;
  assert.throws(() => decodeKcc20EscrowPolicy(negativeZero));
  assert.throws(() => decodeKcc20EscrowPolicy(new Uint8Array(362)));
  assert.throws(() => kcc20EscrowPolicyId({ tokenId: receipt.tokenId, feeTicketId: "00".repeat(32), priceScale: 0n, policy }));
});

test("claim commitment binds party, receipt order, account outpoint and full payout script", () => {
  const input = { receipts: [receipt], party: "protocol", accountOutpoint: { transactionId: "0b".repeat(32), index: 0 },
    payoutScriptPublicKey: Uint8Array.of(0, 0, 0x51) };
  const hash = kcc20FeeClaimCommitment(input);
  assert.equal(hash, "3fa2f4ab53b3d314e7cfdc0cb25beb4f594a7d690cf0d74d872585872119c88c");
  for (const change of [{ party: "creator" }, { accountOutpoint: { ...input.accountOutpoint, index: 1 } },
    { payoutScriptPublicKey: Uint8Array.of(1, 0, 0x51) }, { payoutScriptPublicKey: Uint8Array.of(0, 0, 0x52) }]) {
    assert.notEqual(kcc20FeeClaimCommitment({ ...input, ...change }), hash);
  }
  const second = { ...receipt, outpoint: { ...receipt.outpoint, index: 1 } };
  assert.notEqual(kcc20FeeClaimCommitment({ ...input, receipts: [receipt, second] }),
    kcc20FeeClaimCommitment({ ...input, receipts: [second, receipt] }));
  assert.throws(() => kcc20FeeClaimCommitment({ ...input, receipts: [receipt, receipt] }));
});
