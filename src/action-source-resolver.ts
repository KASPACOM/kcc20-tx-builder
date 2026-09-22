export interface Kcc20IndexedCovenantUtxo {
  [field: string]: unknown;
  txidHex: string;
  vout: number;
  outpoint?: string;
  address: string;
  amountSompi: string;
  action?: string;
  state: Record<string, unknown> | null;
  /** Native covenant id, when the host enriched it from Kaspa RPC. */
  covenantId?: string | null;
}

export interface Kcc20HolderUtxoSummary {
  requestedAmount: string;
  aggregateAmount: string;
  maxSingleUtxoAmount: string;
  utxoCount: number;
  fragmented: boolean;
  maxSingleUtxoOutpoint?: string;
  recommendedAction?: string;
}

export interface Kcc20WrapperSourceInfo {
  wrapperId: string;
  marketId: string;
  canonicalTokenId?: string | null;
  contractCanonicalTokenId?: string | null;
  activeCovenantId?: string | null;
  wrapperAddress?: string | null;
  feeTicketId?: string | null;
  feeTicketSupported?: boolean;
  enabled?: boolean;
  claimedCanonicalTokenId?: string | null;
  pendingReveal?: boolean;
  activeUtxos?: number | null;
  buildable?: boolean;
  buildableReason?: string | null;
}

export interface Kcc20ActiveWrapperResolution {
  selected?: Kcc20IndexedCovenantUtxo;
  candidates: Kcc20IndexedCovenantUtxo[];
  ambiguous: boolean;
  activeCovenantId?: string | null;
}

export interface Kcc20FeeTicketOutpointLike {
  outpoint: string;
  amountSompi: string;
}

export const KCC20_MIN_CONSOLIDATION_INPUTS = 2;
export const KCC20_MAX_CONSOLIDATION_INPUTS = 8;

export function kcc20IndexedUtxoOutpoint(
  utxo: Pick<Kcc20IndexedCovenantUtxo, "txidHex" | "vout" | "outpoint">,
): string {
  return (utxo.outpoint ?? `${utxo.txidHex}:${utxo.vout}`).toLowerCase();
}

export function normalizeKcc20IndexedUtxos(
  values: readonly unknown[],
): Kcc20IndexedCovenantUtxo[] {
  const byOutpoint = new Map<string, Kcc20IndexedCovenantUtxo>();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const txidHex = hex32(row["txidHex"]);
    const vout = Number(row["vout"]);
    const address = typeof row["address"] === "string" ? row["address"] : "";
    const amountSompi = unsigned(row["amountSompi"]);
    if (
      !txidHex ||
      !Number.isInteger(vout) ||
      vout < 0 ||
      !address ||
      amountSompi === null
    ) {
      continue;
    }
    const rawState = record(row["state"]);
    const state = rawState ? normalizeState(rawState) : null;
    const covenantId = hex32(row["covenantId"]);
    const normalized: Kcc20IndexedCovenantUtxo = {
      txidHex,
      vout,
      outpoint: `${txidHex}:${vout}`,
      address,
      amountSompi,
      ...(typeof row["action"] === "string" ? { action: row["action"] } : {}),
      state,
      ...(covenantId ? { covenantId } : {}),
    };
    const key = kcc20IndexedUtxoOutpoint(normalized);
    const existing = byOutpoint.get(key);
    if (!existing || (!existing.state && normalized.state))
      byOutpoint.set(key, normalized);
  }
  return [...byOutpoint.values()].sort((a, b) =>
    kcc20IndexedUtxoOutpoint(a).localeCompare(kcc20IndexedUtxoOutpoint(b)),
  );
}

export function selectActiveMinterUtxo(
  utxos: readonly Kcc20IndexedCovenantUtxo[],
  requestedAmount: string,
): Kcc20IndexedCovenantUtxo | null {
  const requested = requiredAmount(requestedAmount);
  return (
    utxos.find((utxo) => {
      const state = utxo.state;
      const remaining = amount(state?.["remainingSupply"]);
      return (
        state?.["isMintAuthority"] === true &&
        remaining !== null &&
        remaining >= requested
      );
    }) ?? null
  );
}

export function ownerNativeHolderUtxos(
  utxos: readonly Kcc20IndexedCovenantUtxo[],
  owner: string,
): Kcc20IndexedCovenantUtxo[] {
  const normalizedOwner = owner.toLowerCase();
  return utxos.filter((utxo) => {
    const state = utxo.state;
    const value = amount(state?.["amount"]);
    return (
      value !== null &&
      value > 0n &&
      state?.["isMintAuthority"] !== true &&
      numberValue(state?.["ownerScheme"] ?? state?.["identifierType"]) === 0 &&
      stringValue(
        state?.["ownerIdentifier"] ?? state?.["owner"],
      )?.toLowerCase() === normalizedOwner
    );
  });
}

export function selectOwnerNativeHolderUtxo(
  utxos: readonly Kcc20IndexedCovenantUtxo[],
  owner: string,
  requestedAmount: string,
  outpoint?: string,
): Kcc20IndexedCovenantUtxo | null {
  const requested = requiredAmount(requestedAmount);
  const requestedOutpoint = outpoint?.toLowerCase();
  return (
    ownerNativeHolderUtxos(utxos, owner)
      .filter(
        (utxo) =>
          !requestedOutpoint ||
          kcc20IndexedUtxoOutpoint(utxo) === requestedOutpoint,
      )
      .filter((utxo) => amount(utxo.state?.["amount"])! >= requested)
      .sort(compareStateAmount)[0] ?? null
  );
}

export function ownerWrappedHolderUtxos(
  utxos: readonly Kcc20IndexedCovenantUtxo[],
  owner: string,
  canonicalTokenId: string,
): Kcc20IndexedCovenantUtxo[] {
  const normalizedOwner = owner.toLowerCase();
  const canonical = canonicalTokenId.toLowerCase();
  return utxos.filter((utxo) => {
    const state = utxo.state;
    const value = amount(state?.["amount"]);
    return (
      value !== null &&
      value > 0n &&
      numberValue(state?.["mode"] ?? state?.["stateMode"]) === 0 &&
      numberValue(state?.["identifierType"] ?? state?.["ownerScheme"]) === 0 &&
      stringValue(
        state?.["ownerIdentifier"] ?? state?.["owner"],
      )?.toLowerCase() === normalizedOwner &&
      stringValue(
        state?.["canonicalTokenId"] ?? state?.["tokenId"],
      )?.toLowerCase() === canonical
    );
  });
}

export function selectOwnerWrappedHolderUtxo(
  utxos: readonly Kcc20IndexedCovenantUtxo[],
  owner: string,
  requestedAmount: string,
  canonicalTokenId: string,
  largest = false,
): Kcc20IndexedCovenantUtxo | null {
  const requested = requiredAmount(requestedAmount);
  const candidates = ownerWrappedHolderUtxos(utxos, owner, canonicalTokenId)
    .filter((utxo) => amount(utxo.state?.["amount"])! >= requested)
    .sort(compareStateAmount);
  return (largest ? candidates.at(-1) : candidates[0]) ?? null;
}

export function selectOwnerWrappedHolderUtxosForSweep(
  utxos: readonly Kcc20IndexedCovenantUtxo[],
  owner: string,
  requestedAmounts: readonly string[],
  canonicalTokenId: string,
): Kcc20IndexedCovenantUtxo[] {
  const candidates = ownerWrappedHolderUtxos(
    utxos,
    owner,
    canonicalTokenId,
  ).sort(compareStateAmount);
  const selected: Kcc20IndexedCovenantUtxo[] = [];
  const used = new Set<string>();

  for (const requestedText of requestedAmounts) {
    const requested = amount(requestedText);
    if (requested === null) return selected;
    const match = candidates.find(
      (utxo) =>
        !used.has(kcc20IndexedUtxoOutpoint(utxo)) &&
        amount(utxo.state?.["amount"])! >= requested,
    );
    if (!match) return selected;
    used.add(kcc20IndexedUtxoOutpoint(match));
    selected.push(match);
  }

  return selected;
}

export function selectWrappedRootUtxo(
  utxos: readonly Kcc20IndexedCovenantUtxo[],
  canonicalTokenId: string,
): Kcc20IndexedCovenantUtxo | null {
  const canonical = canonicalTokenId.toLowerCase();
  return (
    utxos.find(
      (utxo) =>
        numberValue(utxo.state?.["mode"] ?? utxo.state?.["stateMode"]) === 1 &&
        stringValue(
          utxo.state?.["canonicalTokenId"] ?? utxo.state?.["tokenId"],
        )?.toLowerCase() === canonical,
    ) ?? null
  );
}

export function selectWrappedOrderUtxo(
  utxos: readonly Kcc20IndexedCovenantUtxo[],
  input: {
    orderId: string;
    mode: 2 | 3;
    canonicalTokenId: string;
    requestedAmount?: string;
    unitPriceSompi?: string;
    owner?: string;
  },
): Kcc20IndexedCovenantUtxo | null {
  const canonical = input.canonicalTokenId.toLowerCase();
  const requested = input.requestedAmount
    ? requiredAmount(input.requestedAmount)
    : null;
  const owner = input.owner?.toLowerCase();
  return (
    utxos.find((utxo) => {
      const state = utxo.state;
      const value = amount(state?.["amount"]);
      return (
        kcc20IndexedUtxoOutpoint(utxo) === input.orderId.toLowerCase() &&
        numberValue(state?.["mode"] ?? state?.["stateMode"]) === input.mode &&
        stringValue(
          state?.["canonicalTokenId"] ?? state?.["tokenId"],
        )?.toLowerCase() === canonical &&
        (!input.unitPriceSompi ||
          stringValue(state?.["unitPriceSompi"]) === input.unitPriceSompi) &&
        (requested === null || (value !== null && value >= requested)) &&
        (!owner ||
          stringValue(
            state?.["ownerIdentifier"] ?? state?.["owner"],
          )?.toLowerCase() === owner)
      );
    }) ?? null
  );
}

export function wrapperReserveUtxos(
  utxos: readonly Kcc20IndexedCovenantUtxo[],
  wrapperIds: readonly string[],
): Kcc20IndexedCovenantUtxo[] {
  const ids = new Set(
    wrapperIds
      .map((id) => id?.toLowerCase())
      .filter((id) => /^[a-f0-9]{64}$/.test(id)),
  );
  return utxos
    .filter((utxo) => {
      const state = utxo.state;
      const value = amount(state?.["amount"]);
      return (
        value !== null &&
        value > 0n &&
        state?.["isMintAuthority"] !== true &&
        numberValue(state?.["ownerScheme"] ?? state?.["identifierType"]) ===
          4 &&
        ids.has(
          stringValue(
            state?.["ownerIdentifier"] ?? state?.["owner"],
          )?.toLowerCase() ?? "",
        )
      );
    })
    .sort(compareStateAmount);
}

export function selectWrapperReserveUtxo(
  utxos: readonly Kcc20IndexedCovenantUtxo[],
  wrapperIds: readonly string[],
  requestedAmount: string,
): Kcc20IndexedCovenantUtxo | null {
  const requested = requiredAmount(requestedAmount);
  return (
    wrapperReserveUtxos(utxos, wrapperIds).find(
      (utxo) => amount(utxo.state?.["amount"])! >= requested,
    ) ?? null
  );
}

export function resolveActiveWrapperUtxo(
  wrapper: Kcc20WrapperSourceInfo,
  utxos: readonly Kcc20IndexedCovenantUtxo[],
): Kcc20ActiveWrapperResolution {
  const address = wrapper.wrapperAddress?.toLowerCase();
  const candidates = utxos.filter(
    (utxo) => !address || utxo.address.toLowerCase() === address,
  );
  const activeId = wrapper.activeCovenantId?.toLowerCase();
  const byNativeId = activeId
    ? candidates.filter((utxo) => utxo.covenantId?.toLowerCase() === activeId)
    : [];
  const selectable = byNativeId.length ? byNativeId : candidates;
  if (!selectable.length)
    throw new Error("wrapped market has no active wrapper UTXO");
  if (selectable.length > 1) {
    throw new Error(
      "wrapped market has multiple active wrapper UTXOs; refresh the indexer snapshot",
    );
  }
  return {
    selected: selectable[0],
    candidates: selectable,
    ambiguous: false,
    ...(activeId || selectable[0].covenantId
      ? { activeCovenantId: activeId ?? selectable[0].covenantId }
      : {}),
  };
}

export function kcc20WrapperBelongsToToken(
  wrapper: Kcc20WrapperSourceInfo,
  canonicalTokenId: string,
): boolean {
  const expected = canonicalTokenId.toLowerCase();
  const appCanonicalIds = [
    wrapper.canonicalTokenId,
    wrapper.claimedCanonicalTokenId,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  return !appCanonicalIds.length || appCanonicalIds.includes(expected);
}

export function isKcc20WrapperReadyToBuild(
  wrapper: Kcc20WrapperSourceInfo | null | undefined,
): boolean {
  if (!wrapper?.enabled) return false;
  if (wrapper.pendingReveal === true)
    return wrapper.buildable === true && (wrapper.activeUtxos ?? 0) > 0;
  return wrapper.buildable !== false && Boolean(wrapper.activeCovenantId);
}

export function kcc20WrapperNotReadyReason(
  wrapper: Kcc20WrapperSourceInfo | null | undefined,
): string {
  if (!wrapper) return "No wrapper is ready to wrap.";
  if (!wrapper.enabled) return "Wrapped trading is disabled for this market.";
  if (wrapper.buildable === false)
    return wrapper.buildableReason?.trim() || "Wrapper is not buildable yet.";
  return "No wrapper is ready to wrap.";
}

export function selectOwnerFeeTicketUtxos(
  utxos: readonly Kcc20IndexedCovenantUtxo[],
  owner: string,
  outpoints?: readonly string[],
): Kcc20IndexedCovenantUtxo[] {
  const normalizedOwner = hex32(owner);
  if (!normalizedOwner) return [];
  const requested = outpoints
    ? new Set(outpoints.map((item) => item.toLowerCase()))
    : null;
  const selected = utxos
    .filter((utxo) => {
      const state = utxo.state;
      return (
        numberValue(state?.["mode"] ?? state?.["stateMode"]) === 2 &&
        feeTicketStateOwner(state) === normalizedOwner &&
        (!requested || requested.has(kcc20IndexedUtxoOutpoint(utxo)))
      );
    })
    .sort((a, b) =>
      kcc20IndexedUtxoOutpoint(a).localeCompare(kcc20IndexedUtxoOutpoint(b)),
    );
  if (requested && selected.length !== requested.size) {
    throw new Error(
      "One or more selected FeeTicket UTXOs are not active for this wallet",
    );
  }
  return selected;
}

function feeTicketStateOwner(
  state: Record<string, unknown> | null,
): string | null {
  if (!state) return null;
  for (const key of [
    "ownerIdentifier",
    "stateOwner",
    "ticketOwner",
    "owner",
    "recipientOwner",
    "holderOwner",
  ]) {
    const owner = hex32(state[key]);
    if (owner) return owner;
  }
  return null;
}

export function selectFeeTicketOutpoints(
  tickets: readonly Kcc20FeeTicketOutpointLike[],
  quantity: number,
  options: {
    maxQuantity?: number;
    shortageAction?: string;
  } = {},
): string[] {
  const maxQuantity = options.maxQuantity ?? 10;
  const shortageAction = options.shortageAction ?? "use";
  if (
    !Number.isInteger(maxQuantity) ||
    maxQuantity < 1 ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > maxQuantity
  ) {
    throw new Error(`Coupon quantity must be between 1 and ${maxQuantity}.`);
  }

  const normalized = tickets.map((ticket) => {
    const outpoint = ticket.outpoint.trim().toLowerCase();
    if (
      !/^[0-9a-f]{64}:\d+$/.test(outpoint) ||
      unsigned(ticket.amountSompi) === null
    ) {
      throw new Error("Coupon availability is invalid. Refresh and try again.");
    }
    return { outpoint, collateral: BigInt(ticket.amountSompi) };
  });
  const unique = new Set(normalized.map((ticket) => ticket.outpoint));
  if (unique.size !== normalized.length)
    throw new Error("Coupon availability contains duplicate outpoints.");
  if (normalized.length < quantity) {
    throw new Error(
      `Not enough active coupons are available to ${shortageAction}.`,
    );
  }

  return normalized
    .sort((left, right) =>
      left.collateral < right.collateral
        ? -1
        : left.collateral > right.collateral
          ? 1
          : left.outpoint.localeCompare(right.outpoint),
    )
    .slice(0, quantity)
    .map((ticket) => ticket.outpoint);
}

export function selectConsolidationBatch(
  candidates: readonly Kcc20IndexedCovenantUtxo[],
  sourceOutpoints?: readonly string[],
  maximum = KCC20_MAX_CONSOLIDATION_INPUTS,
  order: "smallest" | "largest" = "smallest",
  minimum = 1,
): Kcc20IndexedCovenantUtxo[] {
  const sorted = [...candidates].sort((left, right) =>
    order === "largest"
      ? compareStateAmount(right, left)
      : compareStateAmount(left, right),
  );
  if (!sourceOutpoints?.length) return sorted.slice(0, maximum);
  const requested = new Set(
    sourceOutpoints.map((value) => value.toLowerCase()),
  );
  if (sourceOutpoints.length < minimum)
    throw new Error(`at least ${minimum} holder UTXOs must be selected`);
  if (requested.size !== sourceOutpoints.length)
    throw new Error("distinct source outpoints are required");
  const byOutpoint = new Map(
    candidates.map((utxo) => [kcc20IndexedUtxoOutpoint(utxo), utxo]),
  );
  const selected = sourceOutpoints.flatMap((outpoint) => {
    const match = byOutpoint.get(outpoint.toLowerCase());
    return match ? [match] : [];
  });
  if (selected.length !== requested.size)
    throw new Error("selected holder UTXOs are not available");
  if (selected.length > maximum)
    throw new Error(`at most ${maximum} holder UTXOs can be consolidated`);
  return selected;
}

export function summarizeHolderUtxos(
  candidates: readonly Kcc20IndexedCovenantUtxo[],
  requestedAmount: string,
): Kcc20HolderUtxoSummary {
  const requested = requiredAmount(requestedAmount);
  const amounts = candidates.map(
    (utxo) => amount(utxo.state?.["amount"]) ?? 0n,
  );
  const aggregate = amounts.reduce((sum, value) => sum + value, 0n);
  let max = 0n;
  let maxIndex = -1;
  amounts.forEach((value, index) => {
    if (value > max) {
      max = value;
      maxIndex = index;
    }
  });
  const fragmented = aggregate >= requested && max < requested;
  return {
    requestedAmount: requested.toString(),
    aggregateAmount: aggregate.toString(),
    maxSingleUtxoAmount: max.toString(),
    utxoCount: candidates.length,
    fragmented,
    ...(maxIndex >= 0
      ? {
          maxSingleUtxoOutpoint: kcc20IndexedUtxoOutpoint(candidates[maxIndex]),
        }
      : {}),
    ...(fragmented ? { recommendedAction: "consolidate" } : {}),
  };
}

function normalizeState(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const extension = record(state["extension"]);
  const owner = hex32(state["owner"] ?? state["ownerIdentifier"]);
  const ownerScheme = numberValue(
    state["ownerScheme"] ?? state["identifierType"],
  );
  const normalized: Record<string, unknown> = { ...state };
  if (owner) {
    normalized["owner"] = owner;
    normalized["ownerIdentifier"] = owner;
  }
  if (ownerScheme !== null) {
    normalized["ownerScheme"] = ownerScheme;
    normalized["identifierType"] = ownerScheme;
  }
  const amountValue = unsigned(state["amount"]);
  if (amountValue !== null) normalized["amount"] = amountValue;
  const remaining = unsigned(
    state["remainingSupply"] ?? extension?.["remainingSupply"],
  );
  if (remaining !== null) normalized["remainingSupply"] = remaining;
  const canonical = hex32(state["canonicalTokenId"] ?? state["tokenId"]);
  if (canonical) normalized["canonicalTokenId"] = canonical;
  const mode = numberValue(state["mode"] ?? state["stateMode"]);
  if (mode !== null) normalized["mode"] = mode;
  const unitPrice = unsigned(
    state["unitPriceSompi"] ?? state["marketUnitPriceSompi"],
  );
  if (unitPrice !== null) normalized["unitPriceSompi"] = unitPrice;
  const feeTicketId = hex32(state["feeTicketId"]);
  if (feeTicketId) normalized["feeTicketId"] = feeTicketId;
  const displayScale = unsigned(
    state["displayScale"] ??
      state["priceScale"] ??
      state["tokenDisplayScale"] ??
      extension?.["displayScale"],
  );
  if (displayScale !== null) {
    normalized["displayScale"] = displayScale;
    normalized["priceScale"] = displayScale;
    normalized["tokenDisplayScale"] = displayScale;
  }
  return normalized;
}

function compareStateAmount(
  left: Kcc20IndexedCovenantUtxo,
  right: Kcc20IndexedCovenantUtxo,
): number {
  const a = amount(left.state?.["amount"]) ?? 0n;
  const b = amount(right.state?.["amount"]) ?? 0n;
  return a < b
    ? -1
    : a > b
      ? 1
      : kcc20IndexedUtxoOutpoint(left).localeCompare(
          kcc20IndexedUtxoOutpoint(right),
        );
}

function amount(value: unknown): bigint | null {
  const normalized = unsigned(value);
  return normalized === null ? null : BigInt(normalized);
}

function requiredAmount(value: unknown): bigint {
  const normalized = amount(value);
  if (normalized === null)
    throw new Error("indexed covenant amount is invalid");
  return normalized;
}

function unsigned(value: unknown): string | null {
  if (typeof value === "bigint") return value >= 0n ? value.toString() : null;
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? value.toString() : null;
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)
    ? value
    : null;
}

function hex32(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  const parsed =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) ? parsed : null;
}
