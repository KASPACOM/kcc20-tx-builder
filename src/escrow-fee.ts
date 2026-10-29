/** Fee arithmetic for new escrow markets only. Legacy trading is unchanged. */
export const KCC20_ESCROW_POLICY_VERSION = 1 as const;
export const KCC20_ESCROW_PROTOCOL_BPS = 100;
export const KCC20_ESCROW_MAX_CREATOR_BPS = 500;
export const KCC20_ESCROW_MIN_FEE_SOMPI = 50_000_000n;
export const KCC20_ESCROW_MAX_CLAIM_RECEIPTS = 5;
export const KCC20_ESCROW_MAX_INT = 9_223_372_036_854_775_807n;

export interface Kcc20EscrowFeeAmounts {
  protocolFeeSompi: bigint;
  creatorFeeSompi: bigint;
  totalFeeSompi: bigint;
}

function amount(value: bigint, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > KCC20_ESCROW_MAX_INT) {
    throw new Error(`${name} must be a nonnegative signed-64-bit bigint`);
  }
  return value;
}

function add(left: bigint, right: bigint): bigint {
  return amount(left + right, "sum");
}

function fee(gross: bigint, bps: number): bigint {
  // Match the contract without overflowing the intermediate multiplication.
  const rate = BigInt(bps);
  const percentage = (gross / 10_000n) * rate + ((gross % 10_000n) * rate) / 10_000n;
  return percentage < KCC20_ESCROW_MIN_FEE_SOMPI ? KCC20_ESCROW_MIN_FEE_SOMPI : percentage;
}

/** A waiver here is a quote assumption, never proof of FeeTicket eligibility. */
export function calculateKcc20EscrowFees(input: {
  grossSompi: bigint;
  creatorFeeBps: number;
  protocolWaived: boolean;
}): Kcc20EscrowFeeAmounts {
  const gross = amount(input.grossSompi, "grossSompi");
  if (gross < 50_000_000n) throw new Error("fill gross must be at least 0.5 KAS");
  if (!Number.isInteger(input.creatorFeeBps) || input.creatorFeeBps < 0 || input.creatorFeeBps > KCC20_ESCROW_MAX_CREATOR_BPS) {
    throw new Error("creatorFeeBps must be an integer from 0 to 500");
  }
  if (typeof input.protocolWaived !== "boolean") throw new Error("protocolWaived must be boolean");
  const protocolFeeSompi = input.protocolWaived ? 0n : fee(gross, KCC20_ESCROW_PROTOCOL_BPS);
  const creatorFeeSompi = input.creatorFeeBps === 0 ? 0n : fee(gross, input.creatorFeeBps);
  return { protocolFeeSompi, creatorFeeSompi, totalFeeSompi: add(protocolFeeSompi, creatorFeeSompi) };
}

/** Trading-price components only; excludes network fees and storage deposits.
 * One matched ask/bid is one fill. Call separately for independent fills. */
export function quoteKcc20EscrowSettlement(input: {
  grossSompi: bigint;
  creatorFeeBps: number;
  protocolWaived: boolean;
  kind: "take-ask" | "fill-bid" | "cross-match";
}) {
  const fees = calculateKcc20EscrowFees(input);
  if (!["take-ask", "fill-bid", "cross-match"].includes(input.kind)) throw new Error("unsupported settlement kind");
  if (input.kind === "fill-bid" && input.grossSompi < fees.totalFeeSompi) {
    throw new Error("fill gross cannot cover protocol and creator fees");
  }
  return {
    ...fees,
    grossSompi: input.grossSompi,
    buyerPaysSompi: input.kind === "take-ask" ? add(input.grossSompi, fees.totalFeeSompi) : input.grossSompi,
    sellerReceivesSompi: input.kind === "fill-bid" ? input.grossSompi - fees.totalFeeSompi : input.grossSompi,
    matcherPaysSompi: input.kind === "cross-match" ? fees.totalFeeSompi : 0n,
    requiresFeeOutput: fees.totalFeeSompi > 0n,
  };
}

/** Arithmetic for one atomic trade group. Artifact and UTXO checks belong to
 * the signed transaction builder; this quote does not authorize a FeeTicket. */
export function quoteKcc20EscrowTradeGroup(input: {
  kind: "take-ask" | "fill-bid" | "cross-match";
  fillGrossSompi: readonly bigint[];
  creatorFeeBps: number;
  protocolWaived: boolean;
}) {
  const maxFills = input.kind === "take-ask" ? 16 : input.kind === "fill-bid" ? 10 : input.kind === "cross-match" ? 1 : 0;
  if (!Array.isArray(input.fillGrossSompi) || input.fillGrossSompi.length < 1 || input.fillGrossSompi.length > maxFills) {
    throw new Error("invalid trade group size");
  }
  if (input.kind === "cross-match" && input.protocolWaived) {
    throw new Error("crossed matches cannot use a FeeTicket");
  }
  const feeVector = input.fillGrossSompi.map(grossSompi =>
    quoteKcc20EscrowSettlement({
      grossSompi, creatorFeeBps: input.creatorFeeBps,
      protocolWaived: input.protocolWaived, kind: input.kind,
    }));
  const totals = feeVector.reduce((sum, fill) => ({
    grossSompi: add(sum.grossSompi, fill.grossSompi),
    protocolFeeSompi: add(sum.protocolFeeSompi, fill.protocolFeeSompi),
    creatorFeeSompi: add(sum.creatorFeeSompi, fill.creatorFeeSompi),
    buyerPaysSompi: add(sum.buyerPaysSompi, fill.buyerPaysSompi),
    sellerReceivesSompi: add(sum.sellerReceivesSompi, fill.sellerReceivesSompi),
    matcherPaysSompi: add(sum.matcherPaysSompi, fill.matcherPaysSompi),
  }), {
    grossSompi: 0n, protocolFeeSompi: 0n, creatorFeeSompi: 0n,
    buyerPaysSompi: 0n, sellerReceivesSompi: 0n, matcherPaysSompi: 0n,
  });
  return {
    ...totals,
    feeVector: feeVector.map(fill => ({
      protocolFeeSompi: fill.protocolFeeSompi,
      creatorFeeSompi: fill.creatorFeeSompi,
    })),
    receiptValueSompi: add(totals.protocolFeeSompi, totals.creatorFeeSompi),
    requiresFeeOutput: totals.protocolFeeSompi + totals.creatorFeeSompi > 0n,
  };
}

/** Accounting description only. The transaction builder must authenticate scripts and live UTXOs. */
export interface Kcc20FeeReceiptAmounts {
  outpoint: { transactionId: string; index: number };
  tokenId: string;
  marketId: string;
  policyId: string;
  protocolAccountId: string;
  creatorAccountId: string;
  valueSompi: bigint;
  protocolSompi: bigint;
  creatorSompi: bigint;
}

function id(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) throw new Error("identity must be 32-byte hex");
  return value.toLowerCase();
}

/** Computes a single claim's conservation amounts, without authorizing a spend. */
export function calculateKcc20FeeClaim(
  receipts: readonly Kcc20FeeReceiptAmounts[],
  party: "protocol" | "creator",
) {
  if (party !== "protocol" && party !== "creator") throw new Error("unknown claiming party");
  if (!Array.isArray(receipts) || receipts.length < 1 || receipts.length > KCC20_ESCROW_MAX_CLAIM_RECEIPTS) {
    throw new Error("claim must select between one and five receipts");
  }
  const seen = new Set<string>();
  let group: string | undefined;
  let protocol = 0n;
  let creator = 0n;
  let consumed = 0n;
  for (const receipt of receipts) {
    const txid = id(receipt.outpoint.transactionId);
    if (!Number.isInteger(receipt.outpoint.index) || receipt.outpoint.index < 0 || receipt.outpoint.index > 0xffffffff) {
      throw new Error("outpoint index must be uint32");
    }
    const outpoint = `${txid}:${receipt.outpoint.index}`;
    if (seen.has(outpoint)) throw new Error("duplicate receipt outpoint");
    seen.add(outpoint);
    const identity = [receipt.tokenId, receipt.marketId, receipt.policyId, receipt.protocolAccountId, receipt.creatorAccountId].map(id).join(":");
    const zero = "0".repeat(64);
    if ([receipt.tokenId, receipt.marketId, receipt.policyId, receipt.protocolAccountId].some(value => id(value) === zero)) {
      throw new Error("token, market, policy and protocol account must be nonzero");
    }
    if (id(receipt.protocolAccountId) === id(receipt.creatorAccountId)) throw new Error("fee accounts must differ");
    if (id(receipt.creatorAccountId) === zero && receipt.creatorSompi !== 0n) throw new Error("disabled creator account cannot hold fees");
    if (group !== undefined && identity !== group) throw new Error("receipts must share token, market, policy and accounts");
    group = identity;
    const p = amount(receipt.protocolSompi, "protocolSompi");
    const c = amount(receipt.creatorSompi, "creatorSompi");
    const value = amount(receipt.valueSompi, "valueSompi");
    if (value === 0n || value !== add(p, c)) throw new Error("receipt value must equal nonzero entitlements");
    if ((p > 0n && p < KCC20_ESCROW_MIN_FEE_SOMPI) || (c > 0n && c < KCC20_ESCROW_MIN_FEE_SOMPI)) {
      throw new Error("nonzero entitlement is below the policy minimum");
    }
    if ((party === "protocol" ? p : c) === 0n) throw new Error("receipt has no entitlement for claimant");
    protocol = add(protocol, p);
    creator = add(creator, c);
    consumed = add(consumed, value);
  }
  const claimSompi = party === "protocol" ? protocol : creator;
  const remainingProtocolSompi = party === "protocol" ? 0n : protocol;
  const remainingCreatorSompi = party === "creator" ? 0n : creator;
  return { claimSompi, remainingProtocolSompi, remainingCreatorSompi, consumedSompi: consumed,
    remainderSompi: add(remainingProtocolSompi, remainingCreatorSompi) };
}
