import {
  kcc20DecimalsFromDisplayScale,
  kcc20DisplayScaleForDecimals,
} from "./token-amount.js";
import {
  KCC20_DEFAULT_PRICE_SCALE,
  KCC20_DEFAULT_PROTOCOL_FEE_BPS,
  KCC20_MIN_PROTOCOL_FEE_SOMPI,
} from "./protocol.js";

export {
  KCC20_DEFAULT_PRICE_SCALE,
  KCC20_DEFAULT_PROTOCOL_FEE_BPS,
  KCC20_MIN_PROTOCOL_FEE_SOMPI,
} from "./protocol.js";

export interface Kcc20TradeFeeQuote {
  priceScale: string;
  grossSompi: string;
  protocolFeeBps: number;
  minimumProtocolFeeSompi: string;
  estimatedProtocolFeeSompi: string;
  protocolFeeSompi: string;
  feeTicketApplied: boolean;
  feePayer: "buyer" | "seller" | "matcher" | "none";
  feeTiming: "order-creation" | "fill" | "cross-match";
  buyerPaysSompi?: string;
  buyerEscrowSompi?: string;
  buyerTradeEscrowSompi?: string;
  temporaryKasDepositSompi?: string;
  sellerReceivesSompi?: string;
  matcherPaysSompi?: string;
  buyerSurplusRefundSompi?: string;
  note: string;
}

export function buildCreateOrderFeeQuote(input: {
  side: "buy" | "sell";
  tokenAmount: string;
  unitPriceSompi: string;
  priceScale?: unknown;
  temporaryKasDepositSompi?: string;
}): Kcc20TradeFeeQuote {
  const priceScale = normalizePriceScale(input.priceScale);
  const gross = exactGross(input.tokenAmount, input.unitPriceSompi, priceScale);
  const estimatedFee = protocolFee(gross);
  const deposit =
    input.side === "buy"
      ? unsigned(
          input.temporaryKasDepositSompi ?? "0",
          "temporaryKasDepositSompi",
        )
      : 0n;
  return {
    priceScale: priceScale.toString(),
    grossSompi: gross.toString(),
    protocolFeeBps: Number(KCC20_DEFAULT_PROTOCOL_FEE_BPS),
    minimumProtocolFeeSompi: KCC20_MIN_PROTOCOL_FEE_SOMPI.toString(),
    estimatedProtocolFeeSompi: estimatedFee.toString(),
    protocolFeeSompi: "0",
    feeTicketApplied: false,
    feePayer: "none",
    feeTiming: "order-creation",
    ...(input.side === "buy"
      ? {
          buyerEscrowSompi: (gross + deposit).toString(),
          buyerTradeEscrowSompi: gross.toString(),
          temporaryKasDepositSompi: deposit.toString(),
        }
      : {}),
    note:
      input.side === "buy"
        ? "Buy order creation escrows gross KAS plus a Temporary KAS deposit that follows the buyer holder and is returned when that holder lifecycle ends; the protocol fee is paid at settlement."
        : "Sell order creation locks wrapped tokens; protocol fee is paid at settlement.",
  };
}

export function buildStandaloneFillFeeQuote(input: {
  side: "buy" | "sell";
  tokenAmount: string;
  unitPriceSompi: string;
  priceScale?: unknown;
  feeTicketApplied: boolean;
}): Kcc20TradeFeeQuote {
  const priceScale = normalizePriceScale(input.priceScale);
  const gross = exactGross(input.tokenAmount, input.unitPriceSompi, priceScale);
  const estimatedFee = protocolFee(gross);
  const fee = input.feeTicketApplied ? 0n : estimatedFee;
  if (input.side === "buy") {
    return {
      priceScale: priceScale.toString(),
      grossSompi: gross.toString(),
      protocolFeeBps: Number(KCC20_DEFAULT_PROTOCOL_FEE_BPS),
      minimumProtocolFeeSompi: KCC20_MIN_PROTOCOL_FEE_SOMPI.toString(),
      estimatedProtocolFeeSompi: estimatedFee.toString(),
      protocolFeeSompi: fee.toString(),
      feeTicketApplied: input.feeTicketApplied,
      feePayer: "buyer",
      feeTiming: "fill",
      buyerPaysSompi: (gross + fee).toString(),
      sellerReceivesSompi: gross.toString(),
      note: "Buying an ask pays seller gross KAS plus protocol fee unless a FeeTicket is burned.",
    };
  }
  return {
    priceScale: priceScale.toString(),
    grossSompi: gross.toString(),
    protocolFeeBps: Number(KCC20_DEFAULT_PROTOCOL_FEE_BPS),
    minimumProtocolFeeSompi: KCC20_MIN_PROTOCOL_FEE_SOMPI.toString(),
    estimatedProtocolFeeSompi: estimatedFee.toString(),
    protocolFeeSompi: fee.toString(),
    feeTicketApplied: input.feeTicketApplied,
    feePayer: "seller",
    feeTiming: "fill",
    buyerPaysSompi: gross.toString(),
    sellerReceivesSompi: (gross > fee ? gross - fee : 0n).toString(),
    note: "Selling into a bid receives gross KAS minus protocol fee unless a FeeTicket is burned.",
  };
}

export function calculateKcc20ProtocolFeeSompi(
  grossSompi: bigint,
  feeBps = Number(KCC20_DEFAULT_PROTOCOL_FEE_BPS),
  minimumFeeSompi = KCC20_MIN_PROTOCOL_FEE_SOMPI,
): bigint {
  if (grossSompi <= 0n || feeBps <= 0) return 0n;
  if (!Number.isInteger(feeBps) || feeBps > 10_000) {
    throw new Error("feeBps must be an integer from 0 to 10000");
  }
  if (minimumFeeSompi < 0n) {
    throw new Error("minimumFeeSompi must not be negative");
  }
  const percentage = (grossSompi * BigInt(feeBps)) / 10_000n;
  return percentage < minimumFeeSompi ? minimumFeeSompi : percentage;
}

/**
 * Largest trade gross that fits a buyer budget after the protocol fee and a
 * host-selected network reserve. All values are integer sompi.
 */
export function calculateKcc20MaximumBuyerGrossSompi(input: {
  availableSompi: bigint;
  networkReserveSompi?: bigint;
  protocolFeeBps?: number;
  minimumProtocolFeeSompi?: bigint;
}): bigint {
  const reserve = input.networkReserveSompi ?? 0n;
  const feeBps = input.protocolFeeBps ?? Number(KCC20_DEFAULT_PROTOCOL_FEE_BPS);
  const minimumFee =
    input.minimumProtocolFeeSompi ?? KCC20_MIN_PROTOCOL_FEE_SOMPI;
  if (input.availableSompi < 0n) {
    throw new Error("availableSompi must not be negative");
  }
  if (reserve < 0n) {
    throw new Error("networkReserveSompi must not be negative");
  }
  // Validate even when no balance is available.
  calculateKcc20ProtocolFeeSompi(1n, feeBps, minimumFee);
  const budget =
    input.availableSompi > reserve ? input.availableSompi - reserve : 0n;
  let low = 0n;
  let high = budget;
  while (low < high) {
    const middle = low + (high - low + 1n) / 2n;
    const fee = calculateKcc20ProtocolFeeSompi(middle, feeBps, minimumFee);
    if (middle + fee <= budget) low = middle;
    else high = middle - 1n;
  }
  return low;
}

/** Returns the largest base-unit token amount affordable by a buyer. */
export function calculateKcc20MaximumBuyTokenBaseUnits(input: {
  availableSompi: bigint;
  unitPriceSompi: bigint;
  priceScale: bigint;
  networkReserveSompi?: bigint;
  protocolFeeBps?: number;
  minimumProtocolFeeSompi?: bigint;
}): bigint {
  if (input.unitPriceSompi <= 0n) return 0n;
  if (input.priceScale <= 0n) {
    throw new Error("priceScale must be greater than zero");
  }
  const gross = calculateKcc20MaximumBuyerGrossSompi(input);
  return (gross * input.priceScale) / input.unitPriceSompi;
}

export function buildCrossMatchFeeQuote(input: {
  tokenAmount: string;
  askUnitPriceSompi: string;
  bidUnitPriceSompi: string;
  priceScale?: unknown;
}): Kcc20TradeFeeQuote {
  const priceScale = normalizePriceScale(input.priceScale);
  const askUnitPrice = unsigned(input.askUnitPriceSompi, "askUnitPriceSompi");
  const bidUnitPrice = unsigned(input.bidUnitPriceSompi, "bidUnitPriceSompi");
  const gross = exactGross(
    input.tokenAmount,
    input.askUnitPriceSompi,
    priceScale,
  );
  const fee = protocolFee(gross);
  const surplus =
    bidUnitPrice > askUnitPrice
      ? exactGross(
          input.tokenAmount,
          (bidUnitPrice - askUnitPrice).toString(),
          priceScale,
        )
      : 0n;
  return {
    priceScale: priceScale.toString(),
    grossSompi: gross.toString(),
    protocolFeeBps: Number(KCC20_DEFAULT_PROTOCOL_FEE_BPS),
    minimumProtocolFeeSompi: KCC20_MIN_PROTOCOL_FEE_SOMPI.toString(),
    estimatedProtocolFeeSompi: fee.toString(),
    protocolFeeSompi: fee.toString(),
    feeTicketApplied: false,
    feePayer: "matcher",
    feeTiming: "cross-match",
    buyerPaysSompi: (gross + surplus).toString(),
    sellerReceivesSompi: gross.toString(),
    matcherPaysSompi: fee.toString(),
    buyerSurplusRefundSompi: surplus.toString(),
    note: "Crossed settlement currently pays seller gross and refunds all buyer surplus; the backend matcher funds the protocol fee under the deployed covenant artifact.",
  };
}

function normalizePriceScale(value: unknown): bigint {
  if (value === undefined || value === null) return KCC20_DEFAULT_PRICE_SCALE;
  const decimals = kcc20DecimalsFromDisplayScale(value);
  if (decimals !== null) return kcc20DisplayScaleForDecimals(decimals);
  throw new Error(
    "priceScale must be an exact power-of-ten display scale for decimals 0-8",
  );
}

function exactGross(
  amountValue: string,
  priceValue: string,
  scale: bigint,
): bigint {
  const product =
    unsigned(amountValue, "tokenAmount") *
    unsigned(priceValue, "unitPriceSompi");
  if (product % scale !== 0n)
    throw new Error("trade gross amount is not an exact sompi value");
  return product / scale;
}

function protocolFee(gross: bigint): bigint {
  const percentage = (gross * KCC20_DEFAULT_PROTOCOL_FEE_BPS) / 10_000n;
  return percentage < KCC20_MIN_PROTOCOL_FEE_SOMPI
    ? KCC20_MIN_PROTOCOL_FEE_SOMPI
    : percentage;
}

function unsigned(value: unknown, field: string): bigint {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw))
    throw new Error(`${field} must be an unsigned integer string`);
  return BigInt(raw);
}
