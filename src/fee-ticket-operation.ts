import { buildKcc20WalletOperationFromPlan } from "./wallet-operation.js";
import {
  ownerNativeHolderUtxos,
  selectOwnerFeeTicketUtxos,
  selectOwnerNativeHolderUtxo,
  summarizeHolderUtxos,
  type Kcc20IndexedCovenantUtxo,
} from "./action-source-resolver.js";
import { normalizeKcc20OwnerIdentifier } from "./token-amount.js";

const HEX_64_RE = /^[a-fA-F0-9]{64}$/;
const U64_MAX = (1n << 64n) - 1n;

export interface FeeTicketRootDeployDraft {
  utilityTokenId: string;
  utilityTokenAmount: string;
  discountBps: number;
  supportedMarketIds?: string[];
}

export interface FeeTicketWalletInfo {
  walletAddress: string;
  kcc20Owner: string;
}

export interface FeeTicketRootOperationOptions {
  network?: string;
  createdAt?: string;
  requestId?: string;
}

export function buildFeeTicketRootDeployOperation(
  walletInfo: FeeTicketWalletInfo,
  draft: FeeTicketRootDeployDraft,
  options: FeeTicketRootOperationOptions = {},
) {
  const utilityTokenId = requireHex64(draft.utilityTokenId, "utilityTokenId");
  const utilityTokenAmount = requireU64(
    draft.utilityTokenAmount,
    "utilityTokenAmount",
  );
  const discountBps = requireBps(draft.discountBps, "discountBps");
  const supportedMarketIds = (draft.supportedMarketIds ?? []).map((id) =>
    requireHex64(id, "supportedMarketIds"),
  );
  const requestId =
    options.requestId ?? `fee-ticket-root-deploy-${randomOperationId()}`;
  const network = options.network ?? "testnet-10";

  return buildKcc20WalletOperationFromPlan(
    walletInfo,
    {
      builderKey: "fee-ticket.deploy-root",
      operation: "deploy-fee-ticket-root",
      contract: "KCC20FeeTicket",
      action: "deployRoot",
      description: "Build a FeeTicket root deploy request.",
      params: {
        utilityTokenId,
        utilityTokenAmount: utilityTokenAmount.toString(),
        discountBps,
        supportedMarketIds,
        rootOwner: walletInfo.kcc20Owner,
        rootOwnerType: "pubkey",
      },
      sourceRequirements: [
        {
          type: "kaspa-funding-utxo",
          ownerAddress: walletInfo.walletAddress,
          purpose: "fund FeeTicket root deploy transaction",
        },
        {
          type: "compiled-fee-ticket-artifact",
          contract: "FeeTicket",
          purpose: "construct FeeTicket root covenant output",
        },
      ],
      signerRequirements: [
        {
          type: "wallet-owner",
          owner: walletInfo.kcc20Owner,
          address: walletInfo.walletAddress,
        },
      ],
      warnings: [
        "This builds the on-chain FeeTicket root transaction only. Save the returned root covenant ID after broadcast so the platform config can trust it.",
      ],
    },
    { ...options, requestId, network },
  );
}

export interface FeeTicketRootInfo {
  configured: boolean;
  enabled: boolean;
  rootId?: string;
  rootOwner?: string;
  utilityTokenId?: string;
  utilityTokenAmount?: string;
  discountBps?: number;
  supportedMarketIds?: string[];
  batchCreateSupported?: boolean;
  maxTicketBatchQuantity?: number;
}

export function buildFeeTicketCreateOperation(
  walletInfo: FeeTicketWalletInfo,
  input: {
    root: FeeTicketRootInfo;
    quantity: number;
    rootUtxos: readonly Kcc20IndexedCovenantUtxo[];
    utilityTokenUtxos: readonly Kcc20IndexedCovenantUtxo[];
  },
  options: FeeTicketRootOperationOptions = {},
) {
  const root = requireConfiguredRoot(input.root);
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new Error("quantity must be a positive integer");
  }
  const maxQuantity = root.maxTicketBatchQuantity ?? 1;
  if (input.quantity > maxQuantity) {
    throw new Error(
      `Active FeeTicket root supports at most ${maxQuantity} ticket(s) per transaction`,
    );
  }
  if (input.quantity > 1 && root.batchCreateSupported !== true) {
    throw new Error("Active FeeTicket root does not support batch creation");
  }
  const rootOwner = requireHex64(root.rootOwner!, "rootOwner");
  const activeRoot = selectSingleRoot(input.rootUtxos, rootOwner);
  const denomination = requireU64(
    root.utilityTokenAmount!,
    "utilityTokenAmount",
  );
  if (denomination <= 0n)
    throw new Error("utilityTokenAmount must be positive");
  const total = denomination * BigInt(input.quantity);
  if (total > U64_MAX)
    throw new Error("FeeTicket batch utility token amount exceeds u64 max");
  const utilityCandidates = ownerNativeHolderUtxos(
    input.utilityTokenUtxos,
    walletInfo.kcc20Owner,
  );
  const utility = selectOwnerNativeHolderUtxo(
    input.utilityTokenUtxos,
    walletInfo.kcc20Owner,
    total.toString(),
  );
  const utilitySummary = summarizeHolderUtxos(
    utilityCandidates,
    total.toString(),
  );
  if (!utility) {
    throw new Error(
      utilitySummary.fragmented
        ? "Utility-token balance is fragmented; consolidate token UTXOs first"
        : "No utility-token holder UTXO has enough balance",
    );
  }
  return buildKcc20WalletOperationFromPlan(
    walletInfo,
    {
      builderKey: "fee-ticket.create-from-utility-burn",
      operation: "create-fee-ticket",
      contract: "FeeTicket",
      action: "createFromUtilityBurn",
      description:
        "Build a FeeTicket creation request from utility-token burn.",
      params: {
        rootId: root.rootId,
        rootOwner,
        utilityTokenId: root.utilityTokenId,
        utilityTokenAmount: root.utilityTokenAmount,
        utilityTokenUtxo: utility,
        activeRootUtxo: activeRoot,
        activeRootCandidateUtxos: [activeRoot],
        quantity: input.quantity,
        totalUtilityTokenAmount: total.toString(),
        discountBps: root.discountBps,
        supportedMarketIds: root.supportedMarketIds ?? [],
        ticketOwner: walletInfo.kcc20Owner,
        ticketOwnerType: "pubkey",
      },
      sourceRequirements: [
        activeRootRequirement(
          root.rootId!,
          rootOwner,
          activeRoot,
          `spend and recreate FeeTicket root while minting ${input.quantity} ticket(s)`,
        ),
        {
          type: "kcc20-utility-token-holder-utxo",
          covenantId: root.utilityTokenId,
          owner: walletInfo.kcc20Owner,
          minimumTokenAmount: total.toString(),
          ...utilitySummary,
          selectedOutpoint: utility.outpoint,
          amount: utility.state?.["amount"],
          address: utility.address,
          identifierType: utility.state?.["identifierType"],
          purpose: "burn utility tokens to mint fee discount tickets",
        },
      ],
      warnings: [
        "Wallet must burn the configured utility-token amount before ticket issuance.",
        "One FeeTicket UTXO represents one fee credit.",
      ],
    },
    options,
  );
}

export function buildFeeTicketBurnOperation(
  walletInfo: FeeTicketWalletInfo,
  input: {
    root: FeeTicketRootInfo;
    ticketOutpoints: readonly string[];
    rootUtxos: readonly Kcc20IndexedCovenantUtxo[];
  },
  options: FeeTicketRootOperationOptions = {},
) {
  const root = requireConfiguredRoot(input.root);
  const outpoints = requireDistinctOutpoints(input.ticketOutpoints);
  const selected = selectOwnerFeeTicketUtxos(
    input.rootUtxos,
    walletInfo.kcc20Owner,
    outpoints,
  );
  return buildKcc20WalletOperationFromPlan(
    walletInfo,
    {
      builderKey: "fee-ticket.burn",
      operation: "burn-fee-ticket",
      contract: "FeeTicket",
      action: "burn",
      description: "Build a fee discount ticket burn/cleanup request.",
      params: {
        rootId: root.rootId,
        ticketOutpoints: outpoints,
        ticketUtxos: selected,
        owner: walletInfo.kcc20Owner,
      },
      sourceRequirements: selected.map((ticket) => ({
        type: "fee-ticket-utxo",
        rootId: root.rootId,
        outpoint: ticket.outpoint,
        owner: walletInfo.kcc20Owner,
        selectedOutpoint: ticket.outpoint,
        amountSompi: ticket.amountSompi,
        address: ticket.address,
      })),
      warnings: ["FeeTicket cleanup burns unused tickets only."],
    },
    options,
  );
}

export function buildFeeTicketTransferOperation(
  walletInfo: FeeTicketWalletInfo,
  input: {
    root: FeeTicketRootInfo;
    recipientOwner: string;
    ticketOutpoints: readonly string[];
    rootUtxos: readonly Kcc20IndexedCovenantUtxo[];
  },
  options: FeeTicketRootOperationOptions = {},
) {
  const root = requireConfiguredRoot(input.root);
  const owner = normalizeKcc20OwnerIdentifier(
    walletInfo.kcc20Owner,
    "wallet owner",
  );
  const recipientOwner = normalizeKcc20OwnerIdentifier(
    input.recipientOwner,
    "recipientOwner",
  );
  if (recipientOwner === owner)
    throw new Error("recipientOwner must be different from the wallet owner");
  const outpoints = requireDistinctOutpoints(input.ticketOutpoints);
  const selected = selectOwnerFeeTicketUtxos(input.rootUtxos, owner, outpoints);
  return buildKcc20WalletOperationFromPlan(
    walletInfo,
    {
      builderKey: "fee-ticket.transfer",
      operation: "transfer-fee-ticket",
      contract: "FeeTicket",
      action: "transferByOwnerSig",
      description: "Build a fee discount ticket owner-transfer request.",
      params: {
        rootId: root.rootId,
        utilityTokenId: root.utilityTokenId,
        owner,
        recipientOwner,
        ticketOutpoints: outpoints,
        ticketUtxos: selected,
      },
      sourceRequirements: selected.map((ticket) => ({
        type: "fee-ticket-utxo",
        rootId: root.rootId,
        outpoint: ticket.outpoint,
        owner,
        recipientOwner,
        purpose: "transfer FeeTicket ownership while preserving locked KAS",
        selectedOutpoint: ticket.outpoint,
        amountSompi: ticket.amountSompi,
        address: ticket.address,
      })),
      warnings: [
        "Transferred coupons remain one-use FeeTicket UTXOs and retain their locked KAS.",
        "Only the recipient owner can use, burn, or transfer the recreated coupons.",
      ],
    },
    options,
  );
}

export function buildFeeTicketRootUpdateOperation(
  walletInfo: FeeTicketWalletInfo,
  input: {
    root: FeeTicketRootInfo;
    utilityTokenAmount?: string;
    discountBps?: number;
    supportedMarketIds?: string[];
    enabled?: boolean;
    rootUtxos: readonly Kcc20IndexedCovenantUtxo[];
  },
  options: FeeTicketRootOperationOptions = {},
) {
  const root = requireConfiguredRoot(input.root, false);
  const rootOwner = requireHex64(root.rootOwner!, "rootOwner");
  if (rootOwner !== walletInfo.kcc20Owner.toLowerCase()) {
    throw new Error("FeeTicket root update requires the configured root owner");
  }
  const activeRoot = selectSingleRoot(input.rootUtxos, rootOwner);
  const utilityTokenAmount = (input.utilityTokenAmount ??
    root.utilityTokenAmount)!;
  if (requireU64(utilityTokenAmount, "utilityTokenAmount") <= 0n) {
    throw new Error("utilityTokenAmount must be positive");
  }
  const discountBps = requireBps(
    input.discountBps ?? root.discountBps!,
    "discountBps",
  );
  const supportedMarketIds = (
    input.supportedMarketIds ??
    root.supportedMarketIds ??
    []
  ).map((id) => requireHex64(id, "supportedMarketIds"));
  return buildKcc20WalletOperationFromPlan(
    walletInfo,
    {
      builderKey: "fee-ticket.update-denomination",
      operation: "update-fee-ticket-denomination",
      contract: "FeeTicket",
      action: "updateDenomination",
      description: "Build a FeeTicket root denomination update request.",
      params: {
        rootId: root.rootId,
        utilityTokenId: root.utilityTokenId,
        currentUtilityTokenAmount: root.utilityTokenAmount,
        utilityTokenAmount,
        discountBps,
        supportedMarketIds,
        enabled: input.enabled ?? root.enabled,
        rootOwner,
        rootOwnerType: "pubkey",
        activeRootUtxo: activeRoot,
        activeRootCandidateUtxos: [activeRoot],
      },
      sourceRequirements: [
        activeRootRequirement(
          root.rootId!,
          rootOwner,
          activeRoot,
          "spend and recreate FeeTicket root with updated denomination",
        ),
        {
          type: "kaspa-funding-utxo",
          ownerAddress: walletInfo.walletAddress,
          purpose: "fund FeeTicket root update transaction",
        },
      ],
      warnings: [
        "Update backend root configuration only after the signed transaction is broadcast and indexed.",
      ],
    },
    options,
  );
}

function requireConfiguredRoot(
  root: FeeTicketRootInfo,
  requireEnabled = true,
): Required<
  Pick<
    FeeTicketRootInfo,
    | "rootId"
    | "rootOwner"
    | "utilityTokenId"
    | "utilityTokenAmount"
    | "discountBps"
  >
> &
  FeeTicketRootInfo {
  if (!root.configured || (requireEnabled && !root.enabled))
    throw new Error("FeeTicket root is not configured");
  requireHex64(root.rootId!, "rootId");
  requireHex64(root.rootOwner!, "rootOwner");
  requireHex64(root.utilityTokenId!, "utilityTokenId");
  requireU64(root.utilityTokenAmount!, "utilityTokenAmount");
  requireBps(root.discountBps!, "discountBps");
  return root as Required<
    Pick<
      FeeTicketRootInfo,
      | "rootId"
      | "rootOwner"
      | "utilityTokenId"
      | "utilityTokenAmount"
      | "discountBps"
    >
  > &
    FeeTicketRootInfo;
}

function selectSingleRoot(
  utxos: readonly Kcc20IndexedCovenantUtxo[],
  rootOwner: string,
): Kcc20IndexedCovenantUtxo {
  const candidates = utxos.filter(
    (utxo) =>
      Number(utxo.state?.["mode"] ?? utxo.state?.["stateMode"]) === 1 &&
      (!utxo.state?.["ownerIdentifier"] ||
        String(utxo.state["ownerIdentifier"]).toLowerCase() === rootOwner),
  );
  if (candidates.length !== 1)
    throw new Error(
      candidates.length
        ? "FeeTicket root has multiple active UTXOs"
        : "FeeTicket root has no active UTXO",
    );
  return candidates[0];
}

function activeRootRequirement(
  rootId: string,
  owner: string,
  root: Kcc20IndexedCovenantUtxo,
  purpose: string,
) {
  return {
    type: "active-fee-ticket-root",
    rootId,
    owner,
    selectedOutpoint: root.outpoint,
    amountSompi: root.amountSompi,
    address: root.address,
    purpose,
  };
}

function requireDistinctOutpoints(values: readonly string[]): string[] {
  if (!values.length)
    throw new Error("at least one FeeTicket outpoint is required");
  const normalized = values.map((value) => {
    const item = String(value).trim().toLowerCase();
    if (!/^[a-f0-9]{64}:\d+$/.test(item))
      throw new Error(`invalid FeeTicket outpoint: ${value}`);
    return item;
  });
  if (new Set(normalized).size !== normalized.length)
    throw new Error("FeeTicket outpoints must be distinct");
  return normalized;
}

function requireHex64(value: string, field: string): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^0x/, "");
  if (!HEX_64_RE.test(normalized)) {
    throw new Error(`${field} must be 64 hex characters`);
  }
  return normalized;
}

function requireU64(value: string, field: string): bigint {
  const normalized = String(value ?? "").trim();
  if (!/^(0|[1-9]\d*)$/.test(normalized)) {
    throw new Error(`${field} must be an unsigned integer`);
  }
  const parsed = BigInt(normalized);
  if (parsed > U64_MAX) {
    throw new Error(`${field} exceeds u64 max`);
  }
  return parsed;
}

function requireBps(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`${field} must be 0..10000`);
  }
  return value;
}

function randomOperationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? fallbackRandomId();
}

function fallbackRandomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.some((byte) => byte !== 0)) {
    return [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
