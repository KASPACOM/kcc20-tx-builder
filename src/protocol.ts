export const SUBNETWORK_ID_NATIVE =
  "0000000000000000000000000000000000000000" as const;
export const ZERO_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000" as const;
export const SOMPI_PER_TKAS = 100_000_000n;
export const DEFAULT_TOKEN_OUTPUT_SOMPI = 50_000_000n;
export const DEFAULT_COMPUTE_BUDGET = 200;
export const DEFAULT_KCC20_FEE_BPS = 200n;
export const DEFAULT_KCC20_MIN_PROTOCOL_FEE_SOMPI = 50_000_000n;
export const DEFAULT_KCC20_TOKEN_DECIMALS = 8;
export const KCC20_PUBLIC_MINT_MAX_DISPLAY_TOKENS = 100_000n;
export const KCC20_PUBLIC_MINT_MAX_DISPLAY_TOKENS_LABEL = "100,000";
export const KCC20_TICKER_MAX_LENGTH = 12;
export const KCC20_TOKEN_NAME_MAX_LENGTH = 32;
export const KCC20_ORDERBOOK_MAX_SWEEP_BID_LEGS = 3;
export const KCC20_ORDERBOOK_MAX_EXPANDED_SWEEP_BID_LEGS = 10;
export const KCC20_ORDERBOOK_EXPANDED_SWEEP_OUTPUT_SOMPI = 200_000_000n;
export const DEFAULT_KCC20_PRICE_SCALE =
  10n ** BigInt(DEFAULT_KCC20_TOKEN_DECIMALS);
export const KCC20_MIN_PROTOCOL_FEE_SOMPI =
  DEFAULT_KCC20_MIN_PROTOCOL_FEE_SOMPI;
export const KCC20_DEFAULT_PROTOCOL_FEE_BPS = DEFAULT_KCC20_FEE_BPS;
export const KCC20_DEFAULT_PRICE_SCALE = DEFAULT_KCC20_PRICE_SCALE;

export const KCC20_PLATFORM_PROTOCOL_FEE_RECIPIENT =
  "ce2100e68197c8e695bd781d07e2bd5de7ed77f5a97668884190531bdc632c01" as const;
export const KCC20_ORDERBOOK_PROTOCOL_FEE_RECIPIENT =
  KCC20_PLATFORM_PROTOCOL_FEE_RECIPIENT;

export function splitKcc20MintSupply(
  remainingSupply: bigint,
  laneCount: bigint,
): bigint[] {
  if (remainingSupply <= 0n) {
    throw new Error("remaining mint supply must be greater than zero");
  }
  if (laneCount < 1n || laneCount > 10n) {
    throw new Error("mint lane count must be between 1 and 10");
  }
  if (remainingSupply < laneCount) {
    throw new Error("remaining mint supply must cover every mint lane");
  }
  const base = remainingSupply / laneCount;
  const remainder = remainingSupply % laneCount;
  return Array.from(
    { length: Number(laneCount) },
    (_, index) => base + (BigInt(index) < remainder ? 1n : 0n),
  );
}
