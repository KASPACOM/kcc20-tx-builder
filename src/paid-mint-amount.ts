export const KCC20_PAID_MINT_MIN_GROSS_SOMPI = 50_000_000n;
export const KCC20_VERIFY_PAID_MINT_MIN_GROSS_SOMPI = 100_000_000n;

const KCC20_FEE_DENOMINATOR_BPS = 10_000n;

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
