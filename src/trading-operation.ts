import {
  ownerWrappedHolderUtxos,
  selectConsolidationBatch,
  selectOwnerFeeTicketUtxos,
  selectOwnerWrappedHolderUtxo,
  selectWrappedOrderUtxo,
  selectWrappedRootUtxo,
  summarizeHolderUtxos,
  type Kcc20IndexedCovenantUtxo,
  type Kcc20WrapperSourceInfo,
} from "./action-source-resolver.js";
import {
  buildCreateOrderFeeQuote,
  buildStandaloneFillFeeQuote,
} from "./trade-fee.js";
import {
  kcc20DisplayScaleForDecimals,
  normalizeKcc20Decimals,
  parseKcc20DisplayAmountToBaseUnits,
} from "./token-amount.js";
import { KCC20_ORDERBOOK_MAX_EXPANDED_SWEEP_BID_LEGS } from "./sale-common.js";
import { buildKcc20WalletOperationFromPlan } from "./wallet-operation.js";

export interface Kcc20TradingWalletInfo {
  walletAddress: string;
  kcc20Owner: string;
}

export interface Kcc20TradingOperationContext {
  canonicalCovenantId: string;
  tokenDecimals?: number | null;
  wrapper: Kcc20WrapperSourceInfo;
  wrappedTokenUtxos: readonly Kcc20IndexedCovenantUtxo[];
  feeTicketUtxos?: readonly Kcc20IndexedCovenantUtxo[];
}

export interface Kcc20TradingOperationOptions {
  network?: string;
  createdAt?: string;
  requestId?: string;
}

export interface Kcc20OrderDraft {
  wrappedMarketId: string;
  side: "buy" | "sell";
  tokenAmount: string;
  unitPriceSompi: string;
  feeTicketId?: string;
}

export function buildKcc20OrderOperation(
  wallet: Kcc20TradingWalletInfo,
  context: Kcc20TradingOperationContext,
  draft: Kcc20OrderDraft,
  options: Kcc20TradingOperationOptions = {},
) {
  requireTradableWrapper(context.wrapper, draft.wrappedMarketId);
  const canonicalId = contractCanonicalId(context);
  const marketId = requireHex32(context.wrapper.marketId, "wrappedMarketId");
  const amount = displayAmount(draft.tokenAmount, context.tokenDecimals);
  const priceScale = priceScaleFor(context.tokenDecimals);
  const feeTicketId = validatedWrapperFeeTicket(
    context.wrapper,
    draft.feeTicketId,
  );
  const root =
    draft.side === "buy"
      ? selectWrappedRootUtxo(context.wrappedTokenUtxos, canonicalId)
      : null;
  const holders =
    draft.side === "sell"
      ? ownerWrappedHolderUtxos(
          context.wrappedTokenUtxos,
          wallet.kcc20Owner,
          canonicalId,
        )
      : [];
  const holder =
    draft.side === "sell"
      ? selectOwnerWrappedHolderUtxo(
          context.wrappedTokenUtxos,
          wallet.kcc20Owner,
          amount,
          canonicalId,
          true,
        )
      : null;
  const summary =
    draft.side === "sell" ? summarizeHolderUtxos(holders, amount) : null;
  if (draft.side === "buy" && !root)
    throw new Error("Wrapped market root UTXO is not available");
  if (draft.side === "sell" && !holder) {
    throw new Error(
      summary?.fragmented
        ? "No single wrapped holder UTXO is large enough; consolidate the wrapped balance first"
        : "Sell order requires a wrapped holder UTXO owned by this wallet",
    );
  }
  const buying = draft.side === "buy";
  return buildKcc20WalletOperationFromPlan(
    wallet,
    {
      builderKey: buying
        ? "kcc20orderbook.create-bid"
        : "kcc20orderbook.create-ask",
      operation: buying ? "create-buy-order" : "create-sell-order",
      contract: "KCC20Orderbook",
      action: buying ? "createBid" : "createAsk",
      description: `Build a KCC20 DEX Orderbook V1 ${draft.side} order request.`,
      params: {
        canonicalCovenantId: canonicalId,
        wrappedMarketId: marketId,
        side: draft.side,
        tokenAmount: amount,
        unitPriceSompi: requireUnsigned(draft.unitPriceSompi, "unitPriceSompi"),
        feeTicketId,
        feeTicketSupported: Boolean(feeTicketId),
        feeQuote: buildCreateOrderFeeQuote({
          side: draft.side,
          tokenAmount: amount,
          unitPriceSompi: draft.unitPriceSompi,
          priceScale,
          temporaryKasDepositSompi: buying ? "200000000" : "0",
        }),
        ...(context.wrapper.activeCovenantId
          ? { activeWrapperCovenantId: context.wrapper.activeCovenantId }
          : {}),
        activeWrappedRootUtxo: root,
        activeWrappedHolderUtxo: holder,
      },
      sourceRequirements: buying
        ? [
            {
              type: "kaspa-funding-utxo",
              ownerAddress: wallet.walletAddress,
              minimumGrossSompiExpression:
                "tokenAmount * unitPriceSompi / priceScale + temporary holder deposit + network fee",
            },
            {
              type: "kcc20-orderbook-root-utxo",
              covenantId: marketId,
              outpoint: root?.outpoint,
              amount: root?.state?.["amount"],
              purpose: "authorize bid output creation",
            },
          ]
        : [
            {
              type: "kcc20-orderbook-holder-utxo",
              covenantId: marketId,
              owner: wallet.kcc20Owner,
              minimumTokenAmount: amount,
              ...(summary ?? {}),
              outpoint: holder?.outpoint,
              amount: holder?.state?.["amount"],
            },
          ],
      warnings: [
        "Crossed orders are settled by the backend matcher after normal bid/ask creation.",
        "Fee discount tickets apply only to supported fill paths.",
      ],
    },
    options,
  );
}

export interface Kcc20FillDraft extends Kcc20OrderDraft {
  targetOrderId: string;
  useFeeTicket?: boolean;
}

export function buildKcc20FillOperation(
  wallet: Kcc20TradingWalletInfo,
  context: Kcc20TradingOperationContext,
  draft: Kcc20FillDraft,
  options: Kcc20TradingOperationOptions = {},
) {
  requireTradableWrapper(context.wrapper, draft.wrappedMarketId);
  const canonicalId = contractCanonicalId(context);
  const marketId = requireHex32(context.wrapper.marketId, "wrappedMarketId");
  const amount = displayAmount(draft.tokenAmount, context.tokenDecimals);
  const fillsAsk = draft.side === "buy";
  const order = selectWrappedOrderUtxo(context.wrappedTokenUtxos, {
    orderId: requireOrderId(draft.targetOrderId),
    mode: fillsAsk ? 2 : 3,
    canonicalTokenId: canonicalId,
    requestedAmount: amount,
    unitPriceSompi: requireUnsigned(draft.unitPriceSompi, "unitPriceSompi"),
  });
  if (!order)
    throw new Error(
      `Selected ${fillsAsk ? "ask" : "bid"} order is not open or does not match fill terms`,
    );
  const holders = fillsAsk
    ? []
    : ownerWrappedHolderUtxos(
        context.wrappedTokenUtxos,
        wallet.kcc20Owner,
        canonicalId,
      );
  const holder = fillsAsk
    ? null
    : selectOwnerWrappedHolderUtxo(
        context.wrappedTokenUtxos,
        wallet.kcc20Owner,
        amount,
        canonicalId,
        true,
      );
  const summary = fillsAsk ? null : summarizeHolderUtxos(holders, amount);
  if (!fillsAsk && !holder)
    throw new Error(
      "Fill bid requires a wrapped holder UTXO owned by the seller",
    );
  const requestedTicket = draft.useFeeTicket || draft.feeTicketId;
  const orderTicketId = normalizeOptionalHex32(order.state?.["feeTicketId"]);
  const feeTicketId = requestedTicket
    ? validatedFillFeeTicket(context.wrapper, orderTicketId, draft.feeTicketId)
    : null;
  const ticket = feeTicketId
    ? selectOwnerFeeTicketUtxos(
        context.feeTicketUtxos ?? [],
        wallet.kcc20Owner,
      )[0]
    : undefined;
  if (feeTicketId && !ticket)
    throw new Error("No active FeeTicket UTXO is available for this wallet");
  const feeQuote = buildStandaloneFillFeeQuote({
    side: draft.side,
    tokenAmount: amount,
    unitPriceSompi: draft.unitPriceSompi,
    priceScale: String(
      order.state?.["priceScale"] ??
        order.state?.["tokenDisplayScale"] ??
        priceScaleFor(context.tokenDecimals),
    ),
    feeTicketApplied: Boolean(ticket),
  });
  const operation = fillsAsk ? "fill-ask-order" : "fill-bid-order";
  return buildKcc20WalletOperationFromPlan(
    wallet,
    {
      builderKey: fillsAsk
        ? "kcc20orderbook.fill-ask"
        : "kcc20orderbook.fill-bid",
      operation,
      contract: "KCC20Orderbook",
      action: fillsAsk ? "fillAsk" : "fillBid",
      description: `Build a KCC20 DEX Orderbook V1 ${draft.side} fill request.`,
      params: {
        canonicalCovenantId: canonicalId,
        wrappedMarketId: marketId,
        side: draft.side,
        targetOrderId: draft.targetOrderId.toLowerCase(),
        tokenAmount: amount,
        unitPriceSompi: draft.unitPriceSompi,
        feeTicketId,
        feeTicketSupported: Boolean(feeTicketId),
        feeQuote,
        ...(context.wrapper.activeCovenantId
          ? { activeWrapperCovenantId: context.wrapper.activeCovenantId }
          : {}),
        activeTargetOrderUtxo: order,
        activeWrappedHolderUtxo: holder,
        activeFeeTicketUtxo: ticket ?? null,
      },
      sourceRequirements: [
        {
          type: fillsAsk
            ? "kcc20-orderbook-ask-order-utxo"
            : "kcc20-orderbook-bid-order-utxo",
          orderId: draft.targetOrderId,
          covenantId: marketId,
          outpoint: order.outpoint,
          amount: order.state?.["amount"],
          unitPriceSompi: order.state?.["unitPriceSompi"],
        },
        ...(fillsAsk
          ? [
              {
                type: "kaspa-funding-utxo",
                ownerAddress: wallet.walletAddress,
                minimumGrossSompiExpression:
                  "tokenAmount * unitPriceSompi / priceScale + protocol fee + network fee",
              },
            ]
          : [
              {
                type: "kcc20-orderbook-holder-utxo",
                covenantId: marketId,
                owner: wallet.kcc20Owner,
                minimumTokenAmount: amount,
                ...(summary ?? {}),
                outpoint: holder?.outpoint,
                amount: holder?.state?.["amount"],
              },
            ]),
        ...(ticket
          ? [
              {
                type: "fee-ticket-utxo",
                rootId: feeTicketId,
                owner: wallet.kcc20Owner,
                outpoint: ticket.outpoint,
                amountSompi: ticket.amountSompi,
                address: ticket.address,
                purpose: "burn one FeeTicket for this standalone fill discount",
              },
            ]
          : []),
      ],
      warnings: [
        ticket
          ? "This fill burns one selected FeeTicket UTXO for the protocol-fee discount."
          : "No FeeTicket was selected; this fill pays the normal KAS protocol fee.",
      ],
    },
    options,
  );
}

export interface Kcc20SweepFill {
  orderId: string;
  tokenAmount: string;
  unitPriceSompi: string;
  totalPriceSompi?: string;
  availableAmount?: string | null;
  minFillAmount?: string | null;
}

export interface Kcc20SweepDraft {
  wrappedMarketId: string;
  side: "buy" | "sell";
  tokenAmount: string;
  mode: "market" | "limit";
  limitUnitPriceSompi?: string;
  feeTicketId?: string;
  expectedFills: Kcc20SweepFill[];
  grossSompi: string;
  protocolFeeSompi: string;
  buyerPaysSompi: string;
  sellerReceivesSompi: string;
  averageUnitPriceSompi?: string | null;
  maxBuyerPaysSompi?: string;
  minSellerReceivesSompi?: string;
}

export function buildKcc20SweepOperation(
  wallet: Kcc20TradingWalletInfo,
  context: Kcc20TradingOperationContext,
  draft: Kcc20SweepDraft,
  options: Kcc20TradingOperationOptions = {},
) {
  requireTradableWrapper(context.wrapper, draft.wrappedMarketId);
  if (draft.expectedFills.length < 2)
    throw new Error("Multi-order sweep requires at least two fill legs");
  const canonicalId = contractCanonicalId(context);
  const marketId = requireHex32(context.wrapper.marketId, "wrappedMarketId");
  const tokenAmount = displayAmount(draft.tokenAmount, context.tokenDecimals);
  const sweepsAsks = draft.side === "buy";
  const orders = draft.expectedFills.flatMap((fill) => {
    const selected = selectWrappedOrderUtxo(context.wrappedTokenUtxos, {
      orderId: fill.orderId,
      mode: sweepsAsks ? 2 : 3,
      canonicalTokenId: canonicalId,
      requestedAmount: fill.tokenAmount,
      unitPriceSompi: fill.unitPriceSompi,
    });
    return selected ? [selected] : [];
  });
  if (orders.length !== draft.expectedFills.length)
    throw new Error("One or more matched order UTXOs are no longer open");
  const sweepAmount = draft.expectedFills.reduce(
    (sum, fill) => sum + BigInt(fill.tokenAmount),
    0n,
  );
  const holders = sweepsAsks
    ? []
    : ownerWrappedHolderUtxos(
        context.wrappedTokenUtxos,
        wallet.kcc20Owner,
        canonicalId,
      );
  const singleHolder = sweepsAsks
    ? null
    : selectOwnerWrappedHolderUtxo(
        context.wrappedTokenUtxos,
        wallet.kcc20Owner,
        sweepAmount.toString(),
        canonicalId,
      );
  const pairedHolders: Kcc20IndexedCovenantUtxo[] = [];
  if (!sweepsAsks && !singleHolder) {
    const used = new Set<string>();
    for (const fill of draft.expectedFills) {
      const match = holders
        .filter((candidate) => !used.has(candidate.outpoint!))
        .sort((a, b) =>
          BigInt(String(a.state?.["amount"])) <
          BigInt(String(b.state?.["amount"]))
            ? -1
            : 1,
        )
        .find(
          (candidate) =>
            BigInt(String(candidate.state?.["amount"])) >=
            BigInt(fill.tokenAmount),
        );
      if (match) {
        used.add(match.outpoint!);
        pairedHolders.push(match);
      }
    }
  }
  const hasSingleHolder =
    !sweepsAsks &&
    draft.expectedFills.length <= KCC20_ORDERBOOK_MAX_EXPANDED_SWEEP_BID_LEGS &&
    Boolean(singleHolder);
  if (
    !sweepsAsks &&
    !hasSingleHolder &&
    pairedHolders.length !== draft.expectedFills.length
  ) {
    throw new Error(
      "Sweep bid orders requires one holder covering the full amount or one distinct holder per bid leg",
    );
  }
  const feeTicketId = draft.feeTicketId
    ? requireHex32(draft.feeTicketId, "feeTicketId")
    : null;
  if (feeTicketId && context.wrapper.feeTicketId?.toLowerCase() !== feeTicketId)
    throw new Error(
      "Requested FeeTicket root does not match this wrapped market",
    );
  if (
    feeTicketId &&
    orders.some(
      (order) =>
        normalizeOptionalHex32(order.state?.["feeTicketId"]) !== feeTicketId,
    )
  ) {
    throw new Error(
      "One or more sweep orders are not bound to the requested FeeTicket root",
    );
  }
  const ticket = feeTicketId
    ? selectOwnerFeeTicketUtxos(
        context.feeTicketUtxos ?? [],
        wallet.kcc20Owner,
      )[0]
    : undefined;
  if (feeTicketId && !ticket)
    throw new Error("FeeTicket sweep requires one active ticket UTXO");
  const gross = requireUnsigned(draft.grossSompi, "grossSompi");
  const protocolFee = ticket
    ? "0"
    : requireUnsigned(draft.protocolFeeSompi, "protocolFeeSompi");
  const buyerPays = ticket
    ? gross
    : requireUnsigned(draft.buyerPaysSompi, "buyerPaysSompi");
  const sellerReceives = ticket
    ? gross
    : requireUnsigned(draft.sellerReceivesSompi, "sellerReceivesSompi");
  if (
    draft.maxBuyerPaysSompi &&
    BigInt(buyerPays) > BigInt(draft.maxBuyerPaysSompi)
  )
    throw new Error("The market buy cost is higher than the approved quote");
  if (
    draft.minSellerReceivesSompi &&
    BigInt(sellerReceives) < BigInt(draft.minSellerReceivesSompi)
  )
    throw new Error(
      "The market sell proceeds are lower than the approved quote",
    );
  const summary = sweepsAsks
    ? null
    : summarizeHolderUtxos(holders, sweepAmount.toString());
  return buildKcc20WalletOperationFromPlan(
    wallet,
    {
      builderKey: sweepsAsks
        ? "kcc20orderbook.sweep-asks"
        : "kcc20orderbook.sweep-bids",
      operation: sweepsAsks ? "sweep-ask-orders" : "sweep-bid-orders",
      contract: "KCC20Orderbook",
      action: sweepsAsks ? "sweepAsks" : "sweepBids",
      description: `Build a KCC20 DEX Orderbook V1 ${draft.side} multi-order sweep request.`,
      params: {
        canonicalCovenantId: canonicalId,
        wrappedMarketId: marketId,
        side: draft.side,
        tokenAmount,
        mode: draft.mode,
        limitUnitPriceSompi: draft.limitUnitPriceSompi ?? null,
        fills: draft.expectedFills,
        grossSompi: gross,
        protocolFeeSompi: protocolFee,
        quotedProtocolFeeSompi: ticket ? draft.protocolFeeSompi : null,
        buyerPaysSompi: buyerPays,
        sellerReceivesSompi: sellerReceives,
        averageUnitPriceSompi: draft.averageUnitPriceSompi ?? null,
        feeTicketId,
        activeFeeTicketUtxos: ticket ? [ticket] : [],
        ...(context.wrapper.activeCovenantId
          ? { activeWrapperCovenantId: context.wrapper.activeCovenantId }
          : {}),
        activeTargetOrderUtxos: orders,
        activeWrappedHolderUtxo: singleHolder,
        activeWrappedHolderUtxos: hasSingleHolder ? [] : pairedHolders,
      },
      sourceRequirements: [
        ...draft.expectedFills.map((fill, index) => ({
          type: sweepsAsks
            ? "kcc20-orderbook-ask-order-utxo"
            : "kcc20-orderbook-bid-order-utxo",
          orderId: fill.orderId,
          covenantId: marketId,
          tokenAmount: fill.tokenAmount,
          unitPriceSompi: fill.unitPriceSompi,
          outpoint: orders[index]?.outpoint,
          amount: orders[index]?.state?.["amount"],
        })),
        ...(!sweepsAsks && singleHolder
          ? [
              {
                type: "kcc20-orderbook-holder-utxo",
                covenantId: marketId,
                owner: wallet.kcc20Owner,
                minimumTokenAmount: sweepAmount.toString(),
                outpoint: singleHolder.outpoint,
                amount: singleHolder.state?.["amount"],
              },
            ]
          : []),
        ...(!sweepsAsks && !singleHolder
          ? pairedHolders.map((holder, index) => ({
              type: "kcc20-orderbook-holder-utxo",
              covenantId: marketId,
              owner: wallet.kcc20Owner,
              legIndex: index,
              minimumTokenAmount: draft.expectedFills[index]?.tokenAmount,
              outpoint: holder.outpoint,
              amount: holder.state?.["amount"],
            }))
          : []),
        ...(ticket
          ? [
              {
                type: "kcc20-fee-ticket-utxo",
                covenantId: feeTicketId,
                purpose: "burn one ticket for the sweep transaction",
                outpoint: ticket.outpoint,
                amountSompi: ticket.amountSompi,
              },
            ]
          : []),
        ...(!sweepsAsks
          ? [
              {
                type: "kcc20-orderbook-holder-utxo-summary",
                covenantId: marketId,
                owner: wallet.kcc20Owner,
                minimumTokenAmount: sweepAmount.toString(),
                ...(summary ?? {}),
              },
            ]
          : []),
        {
          type: "kaspa-funding-utxo",
          ownerAddress: wallet.walletAddress,
          purpose: "fund sweep settlement outputs and network fee",
        },
      ],
      warnings: [
        "This sweep spends multiple matched orders atomically in one transaction.",
        ticket
          ? "This sweep burns one FeeTicket UTXO."
          : "This sweep pays the normal KAS protocol fee.",
      ],
    },
    options,
  );
}

export interface Kcc20CancelDraft {
  wrappedMarketId: string;
  side: "ask" | "bid";
  targetOrderId: string;
}

export function buildKcc20CancelOperation(
  wallet: Kcc20TradingWalletInfo,
  context: Kcc20TradingOperationContext,
  draft: Kcc20CancelDraft,
  options: Kcc20TradingOperationOptions = {},
) {
  const canonicalId = contractCanonicalId(context);
  const marketId = requireHex32(context.wrapper.marketId, "wrappedMarketId");
  const orderId = requireOrderId(draft.targetOrderId);
  const cancelsAsk = draft.side === "ask";
  const order = selectWrappedOrderUtxo(context.wrappedTokenUtxos, {
    orderId,
    mode: cancelsAsk ? 2 : 3,
    canonicalTokenId: canonicalId,
    owner: wallet.kcc20Owner,
  });
  if (!order)
    throw new Error(
      `Selected ${draft.side} order is not open or not owned by this wallet`,
    );
  return buildKcc20WalletOperationFromPlan(
    wallet,
    {
      builderKey: cancelsAsk
        ? "kcc20orderbook.cancel-ask"
        : "kcc20orderbook.cancel-bid",
      operation: cancelsAsk ? "cancel-ask-order" : "cancel-bid-order",
      contract: "KCC20Orderbook",
      action: cancelsAsk ? "cancelAsk" : "cancelBid",
      description: `Build a KCC20 DEX Orderbook V1 ${draft.side} cancel request.`,
      params: {
        canonicalCovenantId: canonicalId,
        wrappedMarketId: marketId,
        side: draft.side,
        targetOrderId: orderId,
        ...(context.wrapper.activeCovenantId
          ? { activeWrapperCovenantId: context.wrapper.activeCovenantId }
          : {}),
        activeTargetOrderUtxo: order,
      },
      sourceRequirements: [
        {
          type: cancelsAsk
            ? "kcc20-orderbook-ask-order-utxo"
            : "kcc20-orderbook-bid-order-utxo",
          orderId,
          covenantId: marketId,
          owner: wallet.kcc20Owner,
          outpoint: order.outpoint,
          amount: order.state?.["amount"],
          unitPriceSompi: order.state?.["unitPriceSompi"],
          purpose:
            "consume the open order UTXO and return remaining assets to owner",
        },
        {
          type: "kaspa-funding-utxo",
          ownerAddress: wallet.walletAddress,
          purpose: "fund output dust and network fee",
        },
      ],
      warnings: [
        "Cancel spends the selected open order UTXO and returns remaining assets to the order owner.",
        "Indexer order status remains source of truth after broadcast.",
      ],
    },
    options,
  );
}

export function buildKcc20WrappedConsolidationOperation(
  wallet: Kcc20TradingWalletInfo,
  context: Kcc20TradingOperationContext,
  sourceOutpoints?: readonly string[],
  options: Kcc20TradingOperationOptions = {},
) {
  const canonicalId = contractCanonicalId(context);
  const marketId = requireHex32(context.wrapper.marketId, "wrappedMarketId");
  const compatible = ownerWrappedHolderUtxos(
    context.wrappedTokenUtxos,
    wallet.kcc20Owner,
    canonicalId,
  );
  const selected = selectConsolidationBatch(compatible, sourceOutpoints, 8);
  if (selected.length < 2)
    throw new Error(
      "at least two compatible wrapped holder UTXOs are required for consolidation",
    );
  const total = selected
    .reduce(
      (sum, utxo) => sum + BigInt(String(utxo.state?.["amount"] ?? "0")),
      0n,
    )
    .toString();
  const summary = summarizeHolderUtxos(compatible, "0");
  return buildKcc20WalletOperationFromPlan(
    wallet,
    {
      builderKey: "kcc20orderbook.consolidate-holders",
      operation: "consolidate-orderbook-holders",
      contract: "KCC20Orderbook",
      action: "consolidate",
      description:
        "Build a KCC20 DEX Orderbook V1 holder consolidation transaction request.",
      params: {
        canonicalCovenantId: canonicalId,
        appCanonicalCovenantId: context.canonicalCovenantId.toLowerCase(),
        wrappedMarketId: marketId,
        activeWrapperCovenantId: context.wrapper.activeCovenantId,
        tokenAmount: total,
        activeWrappedHolderUtxos: selected,
      },
      sourceRequirements: [
        {
          type: "kcc20-orderbook-holder-utxo-batch",
          covenantId: canonicalId,
          wrappedMarketId: marketId,
          activeWrapperCovenantId: context.wrapper.activeCovenantId,
          owner: wallet.kcc20Owner,
          selectedOutpoints: selected.map((utxo) => utxo.outpoint),
          selectedAmounts: selected.map((utxo) => utxo.state?.["amount"]),
          aggregateAmount: summary.aggregateAmount,
          utxoCount: summary.utxoCount,
          purpose:
            "merge wallet-owned KCC20 DEX Orderbook V1 holder outputs into one holder output",
        },
        {
          type: "kaspa-funding-utxo",
          ownerAddress: wallet.walletAddress,
          purpose: "fund network fee for wrapped holder consolidation",
        },
      ],
      warnings: [
        "Consolidation merges between two and eight wallet-owned holder UTXOs into one larger holder UTXO.",
        "Repeat consolidation when more compatible holder UTXOs remain.",
      ],
    },
    options,
  );
}

function contractCanonicalId(context: Kcc20TradingOperationContext): string {
  return requireHex32(
    context.wrapper.contractCanonicalTokenId ??
      context.wrapper.canonicalTokenId ??
      context.canonicalCovenantId,
    "canonicalCovenantId",
  );
}

function requireTradableWrapper(
  wrapper: Kcc20WrapperSourceInfo,
  requestedMarketId: string,
): void {
  if (wrapper.enabled === false)
    throw new Error("Wrapped trading is disabled for this market");
  if (wrapper.marketId.toLowerCase() !== requestedMarketId.toLowerCase())
    throw new Error(
      "Requested wrapped market does not match the selected wrapper",
    );
}

function validatedWrapperFeeTicket(
  wrapper: Kcc20WrapperSourceInfo,
  requested?: string,
): string | null {
  const configured = normalizeOptionalHex32(wrapper.feeTicketId);
  const normalized = normalizeOptionalHex32(requested);
  if (requested && !normalized) throw new Error("FeeTicket root id is invalid");
  if (normalized && !configured)
    throw new Error("FeeTicket is not enabled for this wrapped market");
  if (normalized && configured !== normalized)
    throw new Error(
      "Requested FeeTicket root does not match this wrapped market",
    );
  if (wrapper.feeTicketSupported && !configured)
    throw new Error("Wrapped market FeeTicket root is invalid");
  return configured;
}

function validatedFillFeeTicket(
  wrapper: Kcc20WrapperSourceInfo,
  orderTicketId: string | null,
  requested?: string,
): string {
  if (!orderTicketId)
    throw new Error("Selected order is not bound to a FeeTicket root");
  const explicit = requested
    ? requireHex32(requested, "feeTicketId")
    : orderTicketId;
  if (explicit !== orderTicketId)
    throw new Error(
      "Selected order is not bound to the requested FeeTicket root",
    );
  const active = normalizeOptionalHex32(wrapper.feeTicketId);
  if (!active || active !== explicit)
    throw new Error(
      "Selected order FeeTicket root is not the active platform root",
    );
  return explicit;
}

function displayAmount(
  value: string,
  decimals: number | null | undefined,
): string {
  return parseKcc20DisplayAmountToBaseUnits(
    value,
    normalizeKcc20Decimals(decimals),
    "tokenAmount",
  );
}

function priceScaleFor(decimals: number | null | undefined): string {
  return kcc20DisplayScaleForDecimals(
    normalizeKcc20Decimals(decimals),
  ).toString();
}

function requireHex32(value: unknown, field: string): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^0x/, "");
  if (!/^[a-f0-9]{64}$/.test(normalized))
    throw new Error(`${field} must be 64 hex characters`);
  return normalized;
}

function normalizeOptionalHex32(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim().toLowerCase().replace(/^0x/, "");
  return /^[a-f0-9]{64}$/.test(normalized) && !/^0{64}$/.test(normalized)
    ? normalized
    : null;
}

function requireUnsigned(value: unknown, field: string): string {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw))
    throw new Error(`${field} must be an unsigned integer string`);
  return raw;
}

function requireOrderId(value: string): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}:\d+$/.test(normalized))
    throw new Error("targetOrderId must be txid:vout");
  return normalized;
}
