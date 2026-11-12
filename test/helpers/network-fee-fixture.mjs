import assert from "node:assert/strict";
import { createKcc20PsktBuilderEngine } from "../../dist/index.js";
// Run the existing signed/conservation cases with a high network fee as well
// as their original baseline. A larger funding cell is needed in the partial
// ten-bid fixture; its trade outputs and mass limits remain unchanged.
export function dynamicFeeOptions() {
  const rate = process.env.KCC20_TEST_PRIORITY_RATE;
  return rate
    ? {
        networkFeeQuoteProvider: async (network) => ({
          network,
          source: "offline-fixture",
          observedAtMs: Date.now(),
          tier: "priority",
          sompiPerNormalizedMass: rate,
        }),
      }
    : {};
}

export function dynamicFeeFunding(baseline, priority) {
  return process.env.KCC20_TEST_PRIORITY_RATE ? priority : baseline;
}

export function assertSignedPriorityFee(wasm, built, transaction) {
  const rate = process.env.KCC20_TEST_PRIORITY_RATE;
  if (!rate) return;
  assert.ok(built.networkFee, "dynamic build must retain its fee quote");
  assert.equal(built.networkFee.quote.sompiPerNormalizedMass, rate);
  const engine = createKcc20PsktBuilderEngine({ wasm, artifacts: {} });
  const result = engine.verifySignedNetworkFee(
    typeof transaction === "string" ? transaction : transaction.serializeToSafeJSON(),
    built.networkFee.quote,
  );
  assert.ok(BigInt(result.paidFeeSompi) >= BigInt(result.requiredFeeSompi));
  return result;
}
