export const KCC20_MIN_PROTOCOL_FEE_SOMPI = 50_000_000n;
export const KCC20_DEFAULT_PROTOCOL_FEE_BPS = 200n;
export const KCC20_DEFAULT_PRICE_SCALE = 100_000_000n;

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
  note: string;
}

export function buildCreateOrderFeeQuote(input: {
  side: "buy" | "sell";
  tokenAmount: string;
  unitPriceSompi: string;
  priceScale: string;
  temporaryKasDepositSompi?: string;
}): Kcc20TradeFeeQuote {
  const priceScale = positive(input.priceScale, "priceScale");
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
        ? "Buy order creation escrows gross KAS plus the temporary holder deposit; protocol fee is paid at settlement."
        : "Sell order creation locks wrapped tokens; protocol fee is paid at settlement.",
  };
}

export function buildStandaloneFillFeeQuote(input: {
  side: "buy" | "sell";
  tokenAmount: string;
  unitPriceSompi: string;
  priceScale: string;
  feeTicketApplied: boolean;
}): Kcc20TradeFeeQuote {
  const priceScale = positive(input.priceScale, "priceScale");
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

export function calculateKcc20ProtocolFeeSompi(grossSompi: bigint): bigint {
  return protocolFee(grossSompi);
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

function positive(value: unknown, field: string): bigint {
  const parsed = unsigned(value, field);
  if (parsed <= 0n) throw new Error(`${field} must be greater than zero`);
  return parsed;
}
