/** Rates are decimal sompi per normalized mining mass, never per compute mass. */
export interface NetworkFeeQuote {
  network: string;
  source: string;
  observedAtMs: number;
  tier: "priority";
  sompiPerNormalizedMass: string;
}

export interface TransactionMasses {
  computeMass: bigint;
  transientMass: bigint;
  storageMass: bigint;
}

export interface NetworkFeeSummary {
  quote: NetworkFeeQuote;
  computeMass: string;
  transientMass: string;
  storageMass: string;
  normalizedMass: string;
  requiredFeeSompi: string;
}

const MAX_U64 = (1n << 64n) - 1n;
export const NETWORK_FEE_QUOTE_MAX_AGE_MS = 10_000;

function rateFraction(rate: string): [bigint, bigint] {
  if (typeof rate !== "string" || !/^\d{1,20}(?:\.\d{1,18})?$/.test(rate)) {
    throw new Error("Invalid priority fee rate");
  }
  const [whole, fraction = ""] = rate.split(".");
  const numerator = BigInt(whole + fraction);
  if (numerator <= 0n) throw new Error("Priority fee rate must be positive");
  return [numerator, 10n ** BigInt(fraction.length)];
}

export function validateNetworkFeeQuote(
  quote: NetworkFeeQuote,
  network: string,
  nowMs = Date.now(),
): void {
  if (!quote || quote.network !== network)
    throw new Error("Fee quote network mismatch");
  if (network !== "testnet-10")
    throw new Error("Dynamic fee mass policy is only qualified for testnet-10");
  if (quote.tier !== "priority" || !quote.source?.trim())
    throw new Error("Invalid priority fee quote provenance");
  if (!Number.isSafeInteger(quote.observedAtMs) || !Number.isSafeInteger(nowMs))
    throw new Error("Invalid fee observation time");
  if (quote.observedAtMs > nowMs)
    throw new Error("Fee quote is from the future");
  if (nowMs - quote.observedAtMs > NETWORK_FEE_QUOTE_MAX_AGE_MS)
    throw new Error("Priority fee quote is stale; refresh before building");
  rateFraction(quote.sompiPerNormalizedMass);
}

export function priceNetworkFee(
  quote: NetworkFeeQuote,
  masses: TransactionMasses,
): NetworkFeeSummary {
  const { computeMass, transientMass, storageMass } = masses;
  for (const mass of [computeMass, transientMass, storageMass]) {
    if (typeof mass !== "bigint" || mass < 0n || mass > MAX_U64)
      throw new Error("Invalid transaction mass");
  }
  const normalizedTransient = (transientMass + 1n) / 2n;
  const relayMass =
    computeMass > normalizedTransient ? computeMass : normalizedTransient;
  const normalizedMass = relayMass > storageMass ? relayMass : storageMass;
  const [numerator, denominator] = rateFraction(quote.sompiPerNormalizedMass);
  const priority =
    (normalizedMass * numerator + denominator - 1n) / denominator;
  const relay = relayMass * 100n;
  const required = priority > relay ? priority : relay;
  if (required > MAX_U64) throw new Error("Network fee overflow");
  return {
    quote: { ...quote },
    computeMass: String(computeMass),
    transientMass: String(transientMass),
    storageMass: String(storageMass),
    normalizedMass: String(normalizedMass),
    requiredFeeSompi: String(required),
  };
}
