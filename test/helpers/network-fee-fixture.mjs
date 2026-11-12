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
