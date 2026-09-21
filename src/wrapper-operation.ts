import { buildKcc20WalletOperationFromPlan } from "./wallet-operation.js";
import {
  ownerNativeHolderUtxos,
  ownerWrappedHolderUtxos,
  resolveActiveWrapperUtxo,
  selectOwnerNativeHolderUtxo,
  selectOwnerWrappedHolderUtxo,
  selectWrapperReserveUtxo,
  summarizeHolderUtxos,
  type Kcc20IndexedCovenantUtxo,
  type Kcc20WrapperSourceInfo,
} from "./action-source-resolver.js";
import {
  kcc20DisplayScaleForDecimals,
  normalizeKcc20Decimals,
  parseKcc20DisplayAmountToBaseUnits,
} from "./token-amount.js";

export interface Kcc20WrapperWalletInfo {
  walletAddress: string;
  kcc20Owner: string;
}

export interface Kcc20WrapperMarketInfo {
  wrapperId: string;
  marketId: string;
  canonicalTokenId?: string | null;
  contractCanonicalTokenId?: string | null;
  feeTicketId?: string | null;
}

export interface Kcc20WrapperActiveResolution {
  selected?: Record<string, unknown> | null;
  candidates?: Record<string, unknown>[];
  ambiguous?: boolean;
  activeCovenantId?: string | null;
}

export interface Kcc20WrapperHolderSummary {
  aggregateAmount?: string;
  maxSingleUtxoAmount?: string;
  utxoCount?: number;
  fragmented?: boolean;
  maxSingleUtxoOutpoint?: string;
  recommendedAction?: string;
}

export interface Kcc20BuildWrapOperationInput {
  canonicalCovenantId: string;
  wrappedMarketId: string;
  tokenAmount: string;
  priceScale?: string;
  wrapper: Kcc20WrapperMarketInfo;
  activeHolderUtxo: Record<string, unknown> | null;
  activeHolderSummary?: Kcc20WrapperHolderSummary;
  activeWrapperResolution?: Kcc20WrapperActiveResolution;
  activeHolderNativeCovenantId?: string | null;
}

export interface Kcc20WrapOperationOptions {
  network?: string;
  createdAt?: string;
  requestId?: string;
}

export function buildKcc20WrapTokenOperation(
  walletInfo: Kcc20WrapperWalletInfo,
  input: Kcc20BuildWrapOperationInput,
  options: Kcc20WrapOperationOptions = {},
) {
  const appCanonicalId = normalizeHex32(
    input.canonicalCovenantId,
    "canonicalCovenantId",
  );
  const wrappedMarketId = normalizeHex32(
    input.wrappedMarketId || input.wrapper.marketId,
    "wrappedMarketId",
  );
  const holderNativeCovenantId = input.activeHolderNativeCovenantId
    ? normalizeHex32(
        input.activeHolderNativeCovenantId,
        "activeHolderNativeCovenantId",
      )
    : undefined;
  const contractCanonicalId = normalizeHex32(
    input.wrapper.contractCanonicalTokenId ??
      input.wrapper.canonicalTokenId ??
      holderNativeCovenantId ??
      appCanonicalId,
    "contractCanonicalCovenantId",
  );
  const activeWrapperCovenantId = input.activeWrapperResolution
    ?.activeCovenantId
    ? normalizeHex32(
        input.activeWrapperResolution.activeCovenantId,
        "activeWrapperCovenantId",
      )
    : undefined;
  const tokenAmount = parsePositiveIntegerString(
    input.tokenAmount,
    "tokenAmount",
  );
  const priceScale = input.priceScale
    ? parsePositiveIntegerString(input.priceScale, "priceScale")
    : undefined;

  return buildKcc20WalletOperationFromPlan(
    walletInfo,
    {
      builderKey: "kcc20wrapper.wrap",
      operation: "wrap-token",
      contract: "KCC20Wrapper",
      action: "wrap",
      description: "Build a KCC20 to DEX Orderbook V1 deposit request.",
      params: {
        canonicalCovenantId: contractCanonicalId,
        appCanonicalCovenantId: appCanonicalId,
        contractCanonicalCovenantId: contractCanonicalId,
        ...(holderNativeCovenantId
          ? { activeHolderNativeCovenantId: holderNativeCovenantId }
          : {}),
        wrappedMarketId,
        tokenAmount,
        ...(priceScale ? { priceScale } : {}),
        recipientOwner: normalizeHex32(walletInfo.kcc20Owner, "kcc20Owner"),
        recipientOwnerType: "pubkey",
        feeTicketId: input.wrapper.feeTicketId ?? null,
        ...(activeWrapperCovenantId ? { activeWrapperCovenantId } : {}),
        activeHolderUtxo: input.activeHolderUtxo,
        activeWrapperUtxo: input.activeWrapperResolution?.selected,
        activeWrapperCandidateUtxos:
          input.activeWrapperResolution?.candidates ?? [],
      },
      sourceRequirements: [
        {
          type: "kcc20-holder-utxo",
          covenantId: appCanonicalId,
          ...(contractCanonicalId !== appCanonicalId
            ? { contractCanonicalCovenantId: contractCanonicalId }
            : {}),
          ...(holderNativeCovenantId
            ? { activeHolderNativeCovenantId: holderNativeCovenantId }
            : {}),
          owner: normalizeHex32(walletInfo.kcc20Owner, "kcc20Owner"),
          minimumTokenAmount: tokenAmount,
          ...holderSummaryFields(input.activeHolderSummary),
          outpoint: input.activeHolderUtxo
            ? utxoOutpoint(input.activeHolderUtxo)
            : undefined,
          amount: utxoStateAmount(input.activeHolderUtxo),
        },
        wrapperReserveOutput({
          wrapperId: wrappedMarketId,
          activeWrapperResolution: input.activeWrapperResolution,
          purpose:
            "increase wrapper reserve and issue DEX Orderbook V1 holder output",
        }),
      ],
      warnings: [
        "Wallet must preserve canonical reserve accounting between KCC20 escrow and orderbook supply.",
      ],
    },
    options,
  );
}

export interface Kcc20BuildWrapFromSnapshotInput {
  canonicalCovenantId: string;
  tokenDecimals?: number | null;
  wrappedMarketId: string;
  tokenAmount: string;
  wrapper: Kcc20WrapperSourceInfo;
  canonicalTokenUtxos: readonly Kcc20IndexedCovenantUtxo[];
  wrapperUtxos: readonly Kcc20IndexedCovenantUtxo[];
}

/**
 * Resolves the native holder and wrapper controller in the shared package.
 * The host only supplies a generic indexed snapshot; no action planner is
 * consulted.
 */
export function buildKcc20WrapTokenOperationFromSnapshot(
  walletInfo: Kcc20WrapperWalletInfo,
  input: Kcc20BuildWrapFromSnapshotInput,
  options: Kcc20WrapOperationOptions = {},
) {
  if (input.wrapper.enabled === false) {
    throw new Error("Wrapped trading is disabled for this market");
  }
  const decimals = normalizeKcc20Decimals(input.tokenDecimals);
  const tokenAmount = parseKcc20DisplayAmountToBaseUnits(
    input.tokenAmount,
    decimals,
    "tokenAmount",
  );
  const ownerUtxos = ownerNativeHolderUtxos(
    input.canonicalTokenUtxos,
    walletInfo.kcc20Owner,
  );
  const holder = selectOwnerNativeHolderUtxo(
    input.canonicalTokenUtxos,
    walletInfo.kcc20Owner,
    tokenAmount,
  );
  const summary = summarizeHolderUtxos(ownerUtxos, tokenAmount);
  if (!holder) {
    throw new Error(
      summary.fragmented
        ? "No single KCC20 holder UTXO is large enough; consolidate the token balance first"
        : "No KCC20 holder UTXO is available for this wallet and amount",
    );
  }
  const wrapperResolution = resolveActiveWrapperUtxo(
    input.wrapper,
    input.wrapperUtxos,
  );
  return buildKcc20WrapTokenOperation(
    walletInfo,
    {
      canonicalCovenantId: input.canonicalCovenantId,
      wrappedMarketId: input.wrapper.marketId || input.wrappedMarketId,
      tokenAmount,
      priceScale: kcc20DisplayScaleForDecimals(decimals).toString(),
      wrapper: input.wrapper,
      activeHolderUtxo: holder,
      activeHolderSummary: summary,
      activeWrapperResolution: wrapperResolution,
      activeHolderNativeCovenantId:
        holder.covenantId ??
        input.wrapper.contractCanonicalTokenId ??
        input.canonicalCovenantId,
    },
    options,
  );
}

export interface Kcc20BuildUnwrapFromSnapshotInput {
  canonicalCovenantId: string;
  tokenDecimals?: number | null;
  wrappedMarketId: string;
  tokenAmount: string;
  wrapper: Kcc20WrapperSourceInfo;
  canonicalTokenUtxos: readonly Kcc20IndexedCovenantUtxo[];
  wrappedTokenUtxos: readonly Kcc20IndexedCovenantUtxo[];
  wrapperUtxos: readonly Kcc20IndexedCovenantUtxo[];
}

export function buildKcc20UnwrapTokenOperationFromSnapshot(
  walletInfo: Kcc20WrapperWalletInfo,
  input: Kcc20BuildUnwrapFromSnapshotInput,
  options: Kcc20WrapOperationOptions = {},
) {
  if (input.wrapper.enabled === false) {
    throw new Error("Wrapped trading is disabled for this market");
  }
  const appCanonicalId = normalizeHex32(
    input.canonicalCovenantId,
    "canonicalCovenantId",
  );
  const contractCanonicalId = normalizeHex32(
    input.wrapper.contractCanonicalTokenId ??
      input.wrapper.canonicalTokenId ??
      appCanonicalId,
    "contractCanonicalCovenantId",
  );
  const marketId = normalizeHex32(
    input.wrapper.marketId || input.wrappedMarketId,
    "wrappedMarketId",
  );
  const decimals = normalizeKcc20Decimals(input.tokenDecimals);
  const tokenAmount = parseKcc20DisplayAmountToBaseUnits(
    input.tokenAmount,
    decimals,
    "tokenAmount",
  );
  const holderCandidates = ownerWrappedHolderUtxos(
    input.wrappedTokenUtxos,
    walletInfo.kcc20Owner,
    contractCanonicalId,
  );
  const holder = selectOwnerWrappedHolderUtxo(
    input.wrappedTokenUtxos,
    walletInfo.kcc20Owner,
    tokenAmount,
    contractCanonicalId,
  );
  const holderSummary = summarizeHolderUtxos(holderCandidates, tokenAmount);
  if (!holder) {
    throw new Error(
      holderSummary.fragmented
        ? "No single wrapped holder UTXO is large enough; consolidate the wrapped balance first"
        : "No wrapped holder UTXO is available for this wallet and amount",
    );
  }
  const wrapperResolution = resolveActiveWrapperUtxo(
    input.wrapper,
    input.wrapperUtxos,
  );
  const reserveIds = [
    wrapperResolution.activeCovenantId,
    input.wrapper.activeCovenantId,
    input.wrapper.wrapperId,
    marketId,
  ].filter((value): value is string => Boolean(value));
  const reserve = selectWrapperReserveUtxo(
    input.canonicalTokenUtxos,
    reserveIds,
    tokenAmount,
  );
  if (!reserve) {
    throw new Error(
      "Wrapper reserve does not contain enough canonical token balance",
    );
  }

  return buildKcc20WalletOperationFromPlan(
    walletInfo,
    {
      builderKey: "kcc20wrapper.unwrap",
      operation: "unwrap",
      contract: "KCC20Wrapper",
      action: "unwrap",
      description:
        "Build a KCC20 DEX Orderbook V1 to Token V1 withdrawal request.",
      params: {
        canonicalCovenantId: contractCanonicalId,
        appCanonicalCovenantId: appCanonicalId,
        contractCanonicalCovenantId: contractCanonicalId,
        wrappedMarketId: marketId,
        tokenAmount,
        recipientOwner: normalizeHex32(walletInfo.kcc20Owner, "kcc20Owner"),
        recipientOwnerType: "pubkey",
        ...(wrapperResolution.activeCovenantId
          ? { activeWrapperCovenantId: wrapperResolution.activeCovenantId }
          : {}),
        activeWrappedHolderUtxo: holder,
        activeReserveUtxo: reserve,
        activeWrapperUtxo: wrapperResolution.selected,
        activeWrapperCandidateUtxos: wrapperResolution.candidates,
      },
      sourceRequirements: [
        {
          type: "kcc20-orderbook-holder-utxo",
          covenantId: marketId,
          contractCanonicalCovenantId: contractCanonicalId,
          owner: walletInfo.kcc20Owner,
          minimumTokenAmount: tokenAmount,
          ...holderSummaryFields(holderSummary),
          outpoint: holder.outpoint,
          amount: holder.state?.["amount"],
        },
        wrapperReserveOutput({
          wrapperId: marketId,
          activeWrapperResolution: wrapperResolution,
          reserveUtxo: reserve,
          purpose:
            "release canonical Token V1 reserve and burn DEX Orderbook V1 amount",
        }),
      ],
      warnings: [
        "Wallet must prove wrapped burn and canonical reserve release in the same transaction.",
      ],
    },
    options,
  );
}

export function buildKcc20WrapperMarketDeployOperation(
  walletInfo: Kcc20WrapperWalletInfo,
  input: {
    canonicalCovenantId: string;
    contractCanonicalCovenantId?: string | null;
    tokenDecimals?: number | null;
    wrappedRootAmount?: string;
    feeTicketId?: string | null;
  },
  options: Kcc20WrapOperationOptions = {},
) {
  const appCanonicalId = normalizeHex32(
    input.canonicalCovenantId,
    "canonicalCovenantId",
  );
  const contractCanonicalId = normalizeHex32(
    input.contractCanonicalCovenantId ?? appCanonicalId,
    "contractCanonicalCovenantId",
  );
  const rootAmount = String(input.wrappedRootAmount ?? "0").trim();
  if (!/^\d+$/.test(rootAmount)) {
    throw new Error("wrappedRootAmount must be an unsigned integer string");
  }
  const decimals = normalizeKcc20Decimals(input.tokenDecimals);
  const feeTicketId = input.feeTicketId
    ? normalizeHex32(input.feeTicketId, "feeTicketId")
    : null;
  return buildKcc20WalletOperationFromPlan(
    walletInfo,
    {
      builderKey: "kcc20wrapper.deploy-market",
      operation: "deploy-wrapper-market",
      contract: "KCC20Wrapper",
      action: "deployMarket",
      description: "Build a KCC20 Wrapper Reserve V1 market deploy request.",
      params: {
        canonicalCovenantId: appCanonicalId,
        contractCanonicalCovenantId: contractCanonicalId,
        feeTicketId,
        wrappedRootAmount: rootAmount,
        priceScale: kcc20DisplayScaleForDecimals(decimals).toString(),
        tokenDecimals: String(decimals),
        deployerOwner: normalizeHex32(walletInfo.kcc20Owner, "kcc20Owner"),
        deployerOwnerType: "pubkey",
      },
      sourceRequirements: [
        {
          type: "canonical-kcc20-token",
          covenantId: appCanonicalId,
          ...(contractCanonicalId !== appCanonicalId
            ? { contractCanonicalCovenantId: contractCanonicalId }
            : {}),
          purpose: "bind wrapper market to the canonical token identity",
        },
        {
          type: "kaspa-funding-utxo",
          ownerAddress: walletInfo.walletAddress,
          purpose: "fund wrapper/root outputs and network fee",
        },
        {
          type: "compiled-contract-artifacts",
          templates: ["KCC20Wrapper", "KCC20Orderbook"],
        },
        ...(feeTicketId
          ? [
              {
                type: "fee-ticket-root",
                covenantId: feeTicketId,
                purpose: "bind configured standalone fill discount policy",
              },
            ]
          : []),
      ],
      warnings: [
        "The canonical KCC20 covenantId remains the token identity; the wrapper market ID is only the DEX orderbook mode.",
        "Wrapper deploy builders must create both wrapper reserve and wrapped-root outputs consistently.",
      ],
    },
    options,
  );
}

function wrapperReserveOutput(input: {
  wrapperId: string;
  activeWrapperResolution?: Kcc20WrapperActiveResolution;
  reserveUtxo?: Record<string, unknown> | null;
  purpose: string;
}): Record<string, unknown> {
  const selected = input.activeWrapperResolution?.selected;
  return {
    type: "wrapper-reserve-output",
    wrapperId: input.wrapperId,
    ...(input.reserveUtxo
      ? {
          reserveOutpoint: utxoOutpoint(input.reserveUtxo),
          reserveAmount: utxoStateAmount(input.reserveUtxo),
        }
      : {}),
    ...(selected
      ? {
          selectedOutpoint: selected["outpoint"],
          amountSompi: selected["amountSompi"],
          address: selected["address"],
        }
      : {}),
    ...(input.activeWrapperResolution?.ambiguous
      ? {
          ambiguous: true,
          candidateOutpoints: (
            input.activeWrapperResolution.candidates ?? []
          ).map((candidate) => candidate["outpoint"]),
        }
      : {}),
    purpose: input.purpose,
  };
}

function holderSummaryFields(
  summary?: Kcc20WrapperHolderSummary,
): Record<string, unknown> {
  if (!summary) return {};
  return {
    aggregateAmount: summary.aggregateAmount,
    maxSingleUtxoAmount: summary.maxSingleUtxoAmount,
    utxoCount: summary.utxoCount,
    fragmented: summary.fragmented,
    maxSingleUtxoOutpoint: summary.maxSingleUtxoOutpoint,
    recommendedAction: summary.recommendedAction,
  };
}

function utxoOutpoint(utxo: Record<string, unknown>): string | undefined {
  const txidHex = typeof utxo["txidHex"] === "string" ? utxo["txidHex"] : "";
  const vout = utxo["vout"];
  if (!txidHex || (typeof vout !== "number" && typeof vout !== "string")) {
    return undefined;
  }
  return `${txidHex}:${vout}`;
}

function utxoStateAmount(
  utxo: Record<string, unknown> | null,
): string | undefined {
  const state =
    utxo && typeof utxo["state"] === "object" && utxo["state"] !== null
      ? (utxo["state"] as Record<string, unknown>)
      : undefined;
  return typeof state?.["amount"] === "string" ? state["amount"] : undefined;
}

function parsePositiveIntegerString(value: string, field: string): string {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${field} must be a positive integer string`);
  }
  return value;
}

function normalizeHex32(value: string, field: string): string {
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${field} must be 64 hex characters`);
  }
  return normalized;
}
