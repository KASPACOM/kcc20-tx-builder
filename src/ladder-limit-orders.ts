import {
  calculateKcc20OrderTotalSompi,
  parseKcc20DisplayAmountToBaseUnits,
} from "./token-amount.js";
import {
  KCC20_MIN_PROTOCOL_FEE_SOMPI,
  calculateKcc20ProtocolFeeSompi,
} from "./trade-fee.js";

export const KCC20_LADDER_MAX_ORDERS = 20;

export type Kcc20LadderDirection = "increment" | "decrement";

export interface Kcc20LadderLimitPlan {
  unitPriceSompi: string[];
  notionalsSompi: bigint[];
  minNotionalSompi: bigint;
  totalNotionalSompi: bigint;
  totalProtocolFeeSompi: bigint;
  totalBuySettlementSompi: bigint;
}

/**
 * Builds compounded unit prices for a same-amount resting limit-order ladder.
 */
export function kcc20LadderUnitPricesSompi(input: {
  baseUnitPriceSompi: bigint;
  count: number;
  direction: Kcc20LadderDirection;
  percent: number;
}): bigint[] {
  const count = Math.min(
    KCC20_LADDER_MAX_ORDERS,
    Math.max(1, Math.floor(input.count)),
  );
  if (input.baseUnitPriceSompi <= 0n) return [];

  const percent = Number.isFinite(input.percent)
    ? Math.max(0, input.percent)
    : 0;
  const stepPpm = BigInt(Math.round(percent * 10_000));
  const million = 1_000_000n;
  const sign = input.direction === "increment" ? 1n : -1n;
  const prices: bigint[] = [];
  let current = input.baseUnitPriceSompi;

  for (let index = 0; index < count; index += 1) {
    if (current <= 0n) break;
    prices.push(current);
    if (index === count - 1 || stepPpm === 0n) continue;

    const factor = million + sign * stepPpm;
    if (factor <= 0n) break;
    const next = (current * factor + million / 2n) / million;
    current =
      next === current
        ? input.direction === "increment"
          ? current + 1n
          : current - 1n
        : next;
  }
  return prices;
}

export function parseKcc20LadderPercent(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
    ? parsed
    : undefined;
}

export function planKcc20LadderLimitOrders(input: {
  tokenAmount: string;
  baseUnitPriceSompi: string;
  decimals: number;
  count: number;
  direction: Kcc20LadderDirection;
  percent: number;
  protocolFeeBps: number;
}): Kcc20LadderLimitPlan | undefined {
  let base: bigint;
  try {
    base = BigInt(input.baseUnitPriceSompi.trim());
  } catch {
    return undefined;
  }
  if (base <= 0n) return undefined;

  const prices = kcc20LadderUnitPricesSompi({
    baseUnitPriceSompi: base,
    count: input.count,
    direction: input.direction,
    percent: input.percent,
  });
  const requested = Math.min(
    KCC20_LADDER_MAX_ORDERS,
    Math.max(1, Math.floor(input.count)),
  );
  if (prices.length !== requested) return undefined;

  const notionalsSompi: bigint[] = [];
  let totalBuySettlementSompi = 0n;
  for (const price of prices) {
    const total = calculateKcc20OrderTotalSompi(
      input.tokenAmount,
      price.toString(),
      input.decimals,
    );
    if (!total) return undefined;
    const notional = BigInt(total.totalSompi);
    notionalsSompi.push(notional);
    totalBuySettlementSompi +=
      notional + calculateKcc20ProtocolFeeSompi(notional, input.protocolFeeBps);
  }
  const totalNotionalSompi = notionalsSompi.reduce(
    (sum, value) => sum + value,
    0n,
  );
  const minNotionalSompi = notionalsSompi.reduce(
    (min, value) => (value < min ? value : min),
    notionalsSompi[0],
  );
  return {
    unitPriceSompi: prices.map((price) => price.toString()),
    notionalsSompi,
    minNotionalSompi,
    totalNotionalSompi,
    totalProtocolFeeSompi: totalBuySettlementSompi - totalNotionalSompi,
    totalBuySettlementSompi,
  };
}

export function kcc20LadderMeetsMinOrderValue(
  plan: Kcc20LadderLimitPlan,
  minSompi = KCC20_MIN_PROTOCOL_FEE_SOMPI,
): boolean {
  return plan.minNotionalSompi >= minSompi;
}

export function maxAffordableKcc20LadderCount(input: {
  side: "buy" | "sell";
  tokenAmount: string;
  baseUnitPriceSompi: string;
  decimals: number;
  direction: Kcc20LadderDirection;
  percent: number;
  protocolFeeBps: number;
  availableTokenBaseUnits?: bigint;
  availableKasSompi?: bigint;
}): number {
  if (input.side === "sell") {
    if (input.availableTokenBaseUnits === undefined)
      return KCC20_LADDER_MAX_ORDERS;
    let amount: bigint;
    try {
      amount = BigInt(
        parseKcc20DisplayAmountToBaseUnits(
          input.tokenAmount,
          input.decimals,
          "token amount",
        ),
      );
    } catch {
      return KCC20_LADDER_MAX_ORDERS;
    }
    if (amount <= 0n) return KCC20_LADDER_MAX_ORDERS;
    const affordable = input.availableTokenBaseUnits / amount;
    if (affordable < 1n) return 1;
    const asNumber = Number(affordable);
    return Number.isSafeInteger(asNumber)
      ? Math.min(KCC20_LADDER_MAX_ORDERS, asNumber)
      : KCC20_LADDER_MAX_ORDERS;
  }

  if (input.availableKasSompi === undefined) return KCC20_LADDER_MAX_ORDERS;
  for (let count = KCC20_LADDER_MAX_ORDERS; count >= 1; count -= 1) {
    const plan = planKcc20LadderLimitOrders({ ...input, count });
    if (plan && plan.totalBuySettlementSompi <= input.availableKasSompi)
      return count;
  }
  return 1;
}
