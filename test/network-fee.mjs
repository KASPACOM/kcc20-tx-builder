import assert from "node:assert/strict";
import { test } from "node:test";
import {
  priceNetworkFee,
  validateNetworkFeeQuote,
} from "../dist/network-fee.js";

const now = 1794510000000;
const quote = {
  network: "testnet-10",
  source: "wss://node.example/testnet-10",
  observedAtMs: now,
  tier: "priority",
  sompiPerNormalizedMass: "132.97958",
};
test("both delayed deployments must be priced on storage, not compute", () => {
  for (const computeMass of [7871n, 7865n]) {
    const fee = priceNetworkFee(quote, {
      computeMass,
      transientMass: 7684n,
      storageMass: 280000n,
    });
    assert.equal(fee.normalizedMass, "280000");
    assert.equal(fee.requiredFeeSompi, "37234283");
  }
});
test("ceil rate multiplication and normalized transient; retain relay minimum", () => {
  assert.equal(
    priceNetworkFee(
      { ...quote, sompiPerNormalizedMass: "100.000001" },
      { computeMass: 1n, transientMass: 3n, storageMass: 0n },
    ).requiredFeeSompi,
    "201",
  );
  assert.equal(
    priceNetworkFee(
      { ...quote, sompiPerNormalizedMass: "0.1" },
      { computeMass: 10n, transientMass: 0n, storageMass: 0n },
    ).requiredFeeSompi,
    "1000",
  );
});
test("reject stale, future, wrong-network, malformed and overflowing quotes", () => {
  assert.doesNotThrow(() =>
    validateNetworkFeeQuote(quote, "testnet-10", now + 10000),
  );
  assert.throws(
    () => validateNetworkFeeQuote(quote, "testnet-10", now + 10001),
    /stale/i,
  );
  assert.throws(
    () => validateNetworkFeeQuote(quote, "testnet-10", now - 1),
    /future/i,
  );
  assert.throws(
    () => validateNetworkFeeQuote(quote, "mainnet", now),
    /network/i,
  );
  for (const rate of ["NaN", "-1", "0", "1e3", "Infinity", "1.2junk"]) {
    assert.throws(() =>
      validateNetworkFeeQuote(
        { ...quote, sompiPerNormalizedMass: rate },
        "testnet-10",
        now,
      ),
    );
  }
  assert.throws(
    () =>
      priceNetworkFee(
        { ...quote, sompiPerNormalizedMass: "18446744073709551615" },
        { computeMass: 2n, transientMass: 0n, storageMass: 0n },
      ),
    /overflow/i,
  );
});
