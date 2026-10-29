import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeKcc20FeeVector,
  kcc20MarketInputHash,
  kcc20FeeGroupCommitment,
} from "../dist/index.js";

const marketInputs = [
  { transactionId: "07".repeat(32), index: 0 },
  { transactionId: "08".repeat(32), index: 2 },
];
const feeSlots = [{ protocolFeeSompi: 50_000_000n, creatorFeeSompi: 50_000_000n }];
const group = {
  tokenId: "01".repeat(32), marketId: "02".repeat(32),
  policyId: "03".repeat(32), taker: "04".repeat(32),
  marketInputs, feeSlots,
};

test("group encoding matches the locked covenant proof vectors", () => {
  assert.equal(Buffer.from(encodeKcc20FeeVector(feeSlots)).toString("hex"), "80f0fa020000000080f0fa0200000000");
  assert.equal(kcc20MarketInputHash(marketInputs), "63133051cc7cf43ec8d110b528ca863ca77c542d7d9eed1895dd1c7eb3a5db7a");
  assert.equal(kcc20FeeGroupCommitment(group), "3d104db41153410e89dd177de90d58b063b01dc0e22632ee374aa6489093980a");
});

test("group commitment binds order, taker, market, fee slots and ticket", () => {
  const original = kcc20FeeGroupCommitment(group);
  for (const change of [
    { marketInputs: [...marketInputs].reverse() },
    { taker: "05".repeat(32) },
    { marketId: "05".repeat(32) },
    { feeSlots: [{ ...feeSlots[0], creatorFeeSompi: 50_000_001n }] },
    { ticketOutpoint: { transactionId: "06".repeat(32), index: 1 } },
  ]) assert.notEqual(kcc20FeeGroupCommitment({ ...group, ...change }), original);
  assert.throws(() => kcc20FeeGroupCommitment({ ...group, marketInputs: [marketInputs[0], marketInputs[0]] }), /repeats/);
  assert.throws(() => kcc20FeeGroupCommitment({ ...group, feeSlots: [] }), /slots/);
  assert.throws(() => encodeKcc20FeeVector([{ protocolFeeSompi: 0x7fff_ffff_ffff_ffffn, creatorFeeSompi: 1n }]), /range/);
});
