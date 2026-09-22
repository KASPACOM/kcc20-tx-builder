export const KCC20_PAID_MINT_MIN_GROSS_SOMPI = 50_000_000n;
export const KCC20_VERIFY_PAID_MINT_MIN_GROSS_SOMPI = 100_000_000n;
export const KCC20_RECOMMENDED_PAID_MINT_MIN_GROSS_SOMPI = 55_000_000n;
export const KCC20_MIN_PAID_MINT_TREASURY_OUTPUT_SOMPI = 2_003_085n;

const KCC20_FEE_DENOMINATOR_BPS = 10_000n;
const KCC20_PAID_MINT_GROSS_SEARCH_MAX_DOUBLINGS = 64;

export interface Kcc20PaidMintAmountQuote {
  tokenAmount: bigint;
  adjustedTokenAmount: bigint;
  grossSompi: bigint;
  adjusted: boolean;
  belowMinimumGross: boolean;
}

/**
 * Checks whether all remaining paid-mint supply can produce at least the
 * required gross amount. The comparison is cross-multiplied so fractional
 * display scales are handled without rounding or floating-point arithmetic.
 */
export function kcc20PaidMintCapacityMeetsMinimumGross(input: {
  remainingTokenAmount: bigint;
  unitPriceSompi: bigint;
  priceScale: bigint;
  minimumGrossSompi?: bigint;
}): boolean {
  assertPositivePriceScale(input.priceScale);
  if (input.unitPriceSompi <= 0n) return true;
  if (input.remainingTokenAmount <= 0n) return false;
  const minimumGrossSompi =
    input.minimumGrossSompi ?? KCC20_PAID_MINT_MIN_GROSS_SOMPI;
  if (minimumGrossSompi < 0n) {
    throw new Error("minimumGrossSompi must not be negative");
  }
  return (
    input.remainingTokenAmount * input.unitPriceSompi >=
    minimumGrossSompi * input.priceScale
  );
}

export function kcc20PaidMintExactGrossSompi(input: {
  tokenAmount: bigint;
  unitPriceSompi: bigint;
  priceScale: bigint;
}): bigint {
  if (input.unitPriceSompi <= 0n) {
    return 0n;
  }
  assertPositivePriceScale(input.priceScale);
  const numerator = input.tokenAmount * input.unitPriceSompi;
  const remainder = numerator % input.priceScale;
  if (remainder !== 0n) {
    throw new Error(
      `paid mint amount is not valid for token decimals: tokenAmount=${input.tokenAmount} unitPriceSompi=${input.unitPriceSompi} priceScale=${input.priceScale}`,
    );
  }
  return numerator / input.priceScale;
}

export function kcc20PaidMintAmountStep(
  unitPriceSompi: bigint,
  priceScale: bigint,
): bigint {
  if (unitPriceSompi <= 0n) {
    return 1n;
  }
  assertPositivePriceScale(priceScale);
  return priceScale / gcd(priceScale, unitPriceSompi);
}

export function kcc20SnapPaidMintAmountUp(input: {
  tokenAmount: bigint;
  unitPriceSompi: bigint;
  priceScale: bigint;
}): bigint {
  const step = kcc20PaidMintAmountStep(input.unitPriceSompi, input.priceScale);
  const remainder = input.tokenAmount % step;
  return remainder === 0n
    ? input.tokenAmount
    : input.tokenAmount + step - remainder;
}

export function kcc20MinimumPaidMintAmount(input: {
  unitPriceSompi: bigint;
  priceScale: bigint;
  minGrossSompi?: bigint;
  protocolFeeBps?: number | null;
}): bigint {
  if (input.unitPriceSompi <= 0n) {
    return input.priceScale;
  }
  const minGrossSompi = input.minGrossSompi ?? KCC20_PAID_MINT_MIN_GROSS_SOMPI;
  const minimumAmountAtProtocolFloor = kcc20SnapPaidMintAmountUp({
    tokenAmount: ceilDiv(
      minGrossSompi * input.priceScale,
      input.unitPriceSompi,
    ),
    unitPriceSompi: input.unitPriceSompi,
    priceScale: input.priceScale,
  });
  if (
    normalizeFeeBps(input.protocolFeeBps) >= Number(KCC20_FEE_DENOMINATOR_BPS)
  ) {
    return minimumAmountAtProtocolFloor;
  }

  const wholeDisplayTokens = ceilDiv(
    minimumAmountAtProtocolFloor,
    input.priceScale,
  );
  return kcc20SnapPaidMintAmountUp({
    tokenAmount: wholeDisplayTokens * input.priceScale,
    unitPriceSompi: input.unitPriceSompi,
    priceScale: input.priceScale,
  });
}

export function kcc20ValidatePaidMintAmount(input: {
  tokenAmount: bigint;
  unitPriceSompi: bigint;
  priceScale: bigint;
  minGrossSompi?: bigint;
  protocolFeeBps?: number | null;
  minimumGrossLabel?: string;
}): void {
  const grossSompi = kcc20PaidMintExactGrossSompi(input);
  const minGrossSompi = input.minGrossSompi ?? KCC20_PAID_MINT_MIN_GROSS_SOMPI;
  if (grossSompi > 0n && grossSompi < minGrossSompi) {
    throw new Error(
      `paid mint gross ${formatSompiAsKas(
        grossSompi,
      )} KAS is below ${input.minimumGrossLabel ?? "minimum protocol fee"} ${formatSompiAsKas(
        minGrossSompi,
      )} KAS`,
    );
  }
}

export function kcc20PaidMintFeeSplit(
  grossSompi: bigint,
  protocolFeeBps: number | null | undefined,
  minGrossSompi = KCC20_PAID_MINT_MIN_GROSS_SOMPI,
): { fee: bigint; net: bigint } {
  if (grossSompi <= 0n) {
    return { fee: 0n, net: 0n };
  }
  const bps = normalizeFeeBps(protocolFeeBps);
  const percentageFee = (grossSompi * BigInt(bps)) / KCC20_FEE_DENOMINATOR_BPS;
  const fee = percentageFee < minGrossSompi ? minGrossSompi : percentageFee;
  return { fee, net: grossSompi - fee };
}

/**
 * Produces a transaction-safe paid-mint amount. It enforces exact sompi,
 * protocol-fee, and non-zero treasury-output dust constraints in one place.
 */
export function buildKcc20PaidMintAmountQuote(input: {
  tokenAmount: bigint;
  unitPriceSompi: bigint;
  priceScale: bigint;
  protocolFeeBps?: number | null;
  minimumGrossSompi?: bigint;
}): Kcc20PaidMintAmountQuote | undefined {
  if (input.tokenAmount <= 0n || input.unitPriceSompi < 0n) return undefined;
  assertPositivePriceScale(input.priceScale);
  if (input.unitPriceSompi === 0n) {
    return {
      tokenAmount: input.tokenAmount,
      adjustedTokenAmount: input.tokenAmount,
      grossSompi: 0n,
      adjusted: false,
      belowMinimumGross: false,
    };
  }

  const minimumGrossSompi =
    input.minimumGrossSompi ?? KCC20_RECOMMENDED_PAID_MINT_MIN_GROSS_SOMPI;
  const step = kcc20PaidMintAmountStep(input.unitPriceSompi, input.priceScale);
  let adjustedTokenAmount = roundUpToStep(input.tokenAmount, step);
  const typedGrossSompi = kcc20PaidMintExactGrossSompi({
    ...input,
    tokenAmount: adjustedTokenAmount,
  });

  if (typedGrossSompi < minimumGrossSompi) {
    return {
      tokenAmount: input.tokenAmount,
      adjustedTokenAmount,
      grossSompi: typedGrossSompi,
      adjusted: adjustedTokenAmount !== input.tokenAmount,
      belowMinimumGross: true,
    };
  }

  const feeBps = normalizeUiFeeBps(input.protocolFeeBps);
  if (!isKcc20SafePaidMintGross(typedGrossSompi, feeBps)) {
    const safeTokenAmount =
      feeBps < Number(KCC20_FEE_DENOMINATOR_BPS)
        ? snapPaidMintToSafeWholeTokens(
            adjustedTokenAmount,
            input.unitPriceSompi,
            input.priceScale,
            step,
            feeBps,
          )
        : snapPaidMintToSafeExact(
            adjustedTokenAmount,
            input.unitPriceSompi,
            input.priceScale,
            step,
            feeBps,
          );
    if (safeTokenAmount === undefined) return undefined;
    adjustedTokenAmount = safeTokenAmount;
  }

  const grossSompi = kcc20PaidMintExactGrossSompi({
    ...input,
    tokenAmount: adjustedTokenAmount,
  });
  if (!isKcc20SafePaidMintGross(grossSompi, feeBps)) return undefined;
  return {
    tokenAmount: input.tokenAmount,
    adjustedTokenAmount,
    grossSompi,
    adjusted: adjustedTokenAmount !== input.tokenAmount,
    belowMinimumGross: false,
  };
}

export function kcc20MinimumSafePaidMintAmount(input: {
  unitPriceSompi: bigint;
  priceScale: bigint;
  protocolFeeBps?: number | null;
  minimumGrossSompi?: bigint;
}): bigint | undefined {
  if (input.unitPriceSompi <= 0n) return undefined;
  const minimumGrossSompi =
    input.minimumGrossSompi ?? KCC20_RECOMMENDED_PAID_MINT_MIN_GROSS_SOMPI;
  const minimum = kcc20SnapPaidMintAmountUp({
    tokenAmount: ceilDiv(
      minimumGrossSompi * input.priceScale,
      input.unitPriceSompi,
    ),
    unitPriceSompi: input.unitPriceSompi,
    priceScale: input.priceScale,
  });
  const quote = buildKcc20PaidMintAmountQuote({
    ...input,
    tokenAmount: minimum,
    minimumGrossSompi,
  });
  return quote?.adjustedTokenAmount ?? minimum;
}

export function isKcc20SafePaidMintGross(
  grossSompi: bigint,
  protocolFeeBps?: number | null,
): boolean {
  if (grossSompi < KCC20_PAID_MINT_MIN_GROSS_SOMPI) return false;
  const split = kcc20PaidMintFeeSplit(
    grossSompi,
    normalizeUiFeeBps(protocolFeeBps),
  );
  return (
    split.net >= 0n &&
    (split.net === 0n || split.net >= KCC20_MIN_PAID_MINT_TREASURY_OUTPUT_SOMPI)
  );
}

function snapPaidMintToSafeExact(
  start: bigint,
  price: bigint,
  scale: bigint,
  step: bigint,
  feeBps: number,
): bigint | undefined {
  let amount = start;
  for (
    let index = 0;
    index < KCC20_PAID_MINT_GROSS_SEARCH_MAX_DOUBLINGS;
    index += 1
  ) {
    const gross = kcc20PaidMintExactGrossSompi({
      tokenAmount: amount,
      unitPriceSompi: price,
      priceScale: scale,
    });
    if (isKcc20SafePaidMintGross(gross, feeBps)) return amount;
    const nextGross = smallestSafePaidMintGrossSompi(gross + 1n, feeBps);
    if (nextGross === undefined) return undefined;
    const next = roundUpToStep(ceilDiv(nextGross * scale, price), step);
    amount = next > amount ? next : amount + step;
  }
  return undefined;
}

function snapPaidMintToSafeWholeTokens(
  start: bigint,
  price: bigint,
  scale: bigint,
  step: bigint,
  feeBps: number,
): bigint | undefined {
  let amount = roundUpToStep(ceilDiv(start, scale) * scale, step);
  for (
    let index = 0;
    index < KCC20_PAID_MINT_GROSS_SEARCH_MAX_DOUBLINGS;
    index += 1
  ) {
    const gross = kcc20PaidMintExactGrossSompi({
      tokenAmount: amount,
      unitPriceSompi: price,
      priceScale: scale,
    });
    if (isKcc20SafePaidMintGross(gross, feeBps)) return amount;
    const nextGross = smallestSafePaidMintGrossSompi(gross + 1n, feeBps);
    if (nextGross === undefined) return undefined;
    let next = roundUpToStep(ceilDiv(nextGross * scale, price), step);
    next = roundUpToStep(ceilDiv(next, scale) * scale, step);
    amount = next > amount ? next : roundUpToStep(amount + scale, step);
  }
  return undefined;
}

function smallestSafePaidMintGrossSompi(
  minimum: bigint,
  feeBps: number,
): bigint | undefined {
  let low =
    minimum < KCC20_PAID_MINT_MIN_GROSS_SOMPI
      ? KCC20_PAID_MINT_MIN_GROSS_SOMPI
      : minimum;
  if (isKcc20SafePaidMintGross(low, feeBps)) return low;
  let high = low + 1n;
  for (
    let index = 0;
    index < KCC20_PAID_MINT_GROSS_SEARCH_MAX_DOUBLINGS;
    index += 1
  ) {
    if (isKcc20SafePaidMintGross(high, feeBps)) {
      while (low + 1n < high) {
        const middle = low + (high - low) / 2n;
        if (isKcc20SafePaidMintGross(middle, feeBps)) high = middle;
        else low = middle;
      }
      return high;
    }
    high += high - low + 1n;
  }
  return undefined;
}

function normalizeUiFeeBps(value: number | null | undefined): number {
  return Number.isInteger(value) && value !== null && value !== undefined
    ? Math.min(10_000, Math.max(0, value))
    : 200;
}

function roundUpToStep(value: bigint, step: bigint): bigint {
  const remainder = value % step;
  return remainder === 0n ? value : value + step - remainder;
}

function normalizeFeeBps(value: number | null | undefined): number {
  if (value === null || value === undefined) {
    return 200;
  }
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error("protocolFeeBps must be 0..10000");
  }
  return value;
}

function ceilDiv(left: bigint, right: bigint): bigint {
  return (left + right - 1n) / right;
}

function assertPositivePriceScale(priceScale: bigint): void {
  if (priceScale <= 0n) {
    throw new Error("paid mint priceScale must be greater than zero");
  }
}

function formatSompiAsKas(value: bigint): string {
  const whole = value / 100_000_000n;
  const fractional = value % 100_000_000n;
  if (fractional === 0n) return whole.toString();
  return `${whole}.${fractional.toString().padStart(8, "0").replace(/0+$/, "")}`;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}
