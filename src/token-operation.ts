import {
  ownerNativeHolderUtxos,
  selectActiveMinterUtxo,
  selectConsolidationBatch,
  selectOwnerNativeHolderUtxo,
  summarizeHolderUtxos,
  type Kcc20IndexedCovenantUtxo,
} from "./action-source-resolver.js";
import {
  kcc20DisplayScaleForDecimals,
  normalizeKcc20Decimals,
  normalizeKcc20OwnerIdentifier,
  parseKcc20DisplayAmountToBaseUnits,
} from "./token-amount.js";
import { kcc20ValidatePaidMintAmount } from "./paid-mint-amount.js";
import { buildKcc20WalletOperationFromPlan } from "./wallet-operation.js";

export interface Kcc20ActionWalletInfo {
  walletAddress: string;
  kcc20Owner: string;
}

export interface Kcc20ActionTokenInfo {
  covenantId: string;
  ticker?: string | null;
  tokenName?: string | null;
  decimals?: number | null;
  mintPolicy?: {
    mintable?: boolean;
    policy?: string;
    publicMintActive?: boolean | null;
    remainingSupply?: string | null;
    mintPricePerTokenSompi?: string | null;
    treasuryRecipient?: string | null;
    protocolFeeRecipient?: string | null;
    protocolFeeBps?: number | null;
  };
}

export interface Kcc20TokenOperationOptions {
  network?: string;
  createdAt?: string;
  requestId?: string;
}

export function buildKcc20MintTokenOperation(
  wallet: Kcc20ActionWalletInfo,
  input: {
    token: Kcc20ActionTokenInfo;
    tokenAmount: string;
    recipientOwner?: string;
    activeUtxos: readonly Kcc20IndexedCovenantUtxo[];
    publicRequest?: boolean;
  },
  options: Kcc20TokenOperationOptions = {},
) {
  const covenantId = requireHex32(input.token.covenantId, "covenantId");
  const policy = input.token.mintPolicy?.policy;
  if (
    !input.token.mintPolicy?.mintable ||
    (policy !== "public" && policy !== "controlled")
  ) {
    throw new Error(
      `Unsupported KCC20 mint policy: ${policy ?? "not-mintable"}`,
    );
  }
  const pausedPublicMint =
    policy === "public" && input.token.mintPolicy.publicMintActive === false;
  if (pausedPublicMint && input.publicRequest !== false) {
    throw new Error("Public mint is paused by the token creator");
  }
  const decimals = normalizeKcc20Decimals(input.token.decimals);
  const priceScale = kcc20DisplayScaleForDecimals(decimals);
  const tokenAmount = parseKcc20DisplayAmountToBaseUnits(
    input.tokenAmount,
    decimals,
    "tokenAmount",
  );
  if (policy === "public" && BigInt(tokenAmount) > 100_000n * priceScale) {
    throw new Error(
      "Public mint amount exceeds the maximum per mint transaction of 100,000 tokens",
    );
  }
  const mintPrice = input.token.mintPolicy.mintPricePerTokenSompi;
  if (mintPrice && /^\d+$/.test(mintPrice) && BigInt(mintPrice) > 0n) {
    kcc20ValidatePaidMintAmount({
      tokenAmount: BigInt(tokenAmount),
      unitPriceSompi: BigInt(mintPrice),
      priceScale,
      protocolFeeBps: input.token.mintPolicy.protocolFeeBps,
    });
  }
  const minter = selectActiveMinterUtxo(input.activeUtxos, tokenAmount);
  if (!minter?.state)
    throw new Error(
      "No active KCC20 mint-authority UTXO has enough remaining supply",
    );
  const walletOwner = normalizeKcc20OwnerIdentifier(
    wallet.kcc20Owner,
    "wallet owner",
  );
  const authorityOwner = String(
    minter.state["ownerIdentifier"] ?? minter.state["owner"] ?? "",
  ).toLowerCase();
  const authorityScheme = Number(
    minter.state["ownerScheme"] ?? minter.state["identifierType"],
  );
  if (
    (policy === "controlled" || pausedPublicMint) &&
    (authorityScheme !== 0 || authorityOwner !== walletOwner)
  ) {
    throw new Error(
      policy === "controlled"
        ? "Controlled mint requires the active mint-authority owner"
        : "Paused public mint requires the active minter owner",
    );
  }
  const recipientOwner = input.recipientOwner
    ? normalizeKcc20OwnerIdentifier(input.recipientOwner, "recipientOwner")
    : walletOwner;
  if (
    recipientOwner !== walletOwner &&
    policy !== "controlled" &&
    !pausedPublicMint
  ) {
    throw new Error(
      "Mint recipient override requires controlled mint authority",
    );
  }
  const mintPath =
    policy === "controlled" || authorityOwner === walletOwner
      ? "owner"
      : "public";
  return buildKcc20WalletOperationFromPlan(
    wallet,
    {
      builderKey: "kcc20.mint",
      operation: "mint-token",
      contract: "KCC20",
      action: "mint",
      description: "Build a KCC20 mint transaction request.",
      params: {
        covenantId,
        tokenAmount,
        tokenDisplayScale: priceScale.toString(),
        priceScale: priceScale.toString(),
        recipientOwner,
        recipientOwnerScheme: 0,
        mintPath,
        ticker: input.token.ticker ?? null,
        tokenName: input.token.tokenName ?? null,
        mintPolicy: input.token.mintPolicy ?? null,
        activeMinterUtxo: minter,
      },
      sourceRequirements: [
        {
          type: "kcc20-mint-authority-utxo",
          covenantId,
          outpoint: minter.outpoint,
          remainingSupply: minter.state["remainingSupply"],
          purpose: "authorize mint supply reduction and recipient output",
        },
        {
          type: "kcc20-mint-recipient-owner",
          owner: recipientOwner,
          ownerType: "pubkey",
          purpose: "create minted holder output for the intended recipient",
        },
        {
          type: "kaspa-funding-utxo",
          ownerAddress: wallet.walletAddress,
          purpose: "fund output dust and network fee",
        },
      ],
      warnings: [
        "Wallet must enforce remaining-supply accounting before signing.",
        ...(mintPath === "owner"
          ? [
              "Owner-authorized mint requires the wallet to sign the mint-authority covenant input.",
            ]
          : []),
      ],
    },
    options,
  );
}

export function buildKcc20TransferTokenOperation(
  wallet: Kcc20ActionWalletInfo,
  input: {
    token: Kcc20ActionTokenInfo;
    tokenAmount: string;
    recipientOwner: string;
    activeUtxos: readonly Kcc20IndexedCovenantUtxo[];
    holderOutpoint?: string;
  },
  options: Kcc20TokenOperationOptions = {},
) {
  const covenantId = requireHex32(input.token.covenantId, "covenantId");
  const decimals = normalizeKcc20Decimals(input.token.decimals);
  const tokenAmount = parseKcc20DisplayAmountToBaseUnits(
    input.tokenAmount,
    decimals,
    "tokenAmount",
  );
  const owner = normalizeKcc20OwnerIdentifier(
    wallet.kcc20Owner,
    "wallet owner",
  );
  const recipientOwner = normalizeKcc20OwnerIdentifier(
    input.recipientOwner,
    "recipientOwner",
  );
  const holder = selectOwnerNativeHolderUtxo(
    input.activeUtxos,
    owner,
    tokenAmount,
    input.holderOutpoint,
  );
  const ownerUtxos = ownerNativeHolderUtxos(input.activeUtxos, owner);
  const summary = summarizeHolderUtxos(ownerUtxos, tokenAmount);
  if (!holder) {
    throw new Error(
      summary.fragmented
        ? "No single KCC20 holder UTXO is large enough; consolidate the token balance first"
        : "No single KCC20 holder UTXO is available for this wallet and amount",
    );
  }
  const nativeCovenantId = holder.covenantId ?? covenantId;
  return buildKcc20WalletOperationFromPlan(
    wallet,
    {
      builderKey: "kcc20.transfer",
      operation: "transfer-token",
      contract: "KCC20",
      action: "transfer",
      description: "Build a KCC20 holder transfer transaction request.",
      params: {
        covenantId,
        appCanonicalCovenantId: covenantId,
        activeHolderNativeCovenantId: nativeCovenantId,
        tokenAmount,
        recipientOwner,
        recipientOwnerScheme: 0,
        ticker: input.token.ticker ?? null,
        tokenName: input.token.tokenName ?? null,
        activeHolderUtxo: holder,
      },
      sourceRequirements: [
        {
          type: "kcc20-holder-utxo",
          covenantId,
          activeHolderNativeCovenantId: nativeCovenantId,
          owner,
          minimumTokenAmount: tokenAmount,
          ...summary,
          outpoint: holder.outpoint,
          amount: holder.state?.["amount"],
          purpose:
            "spend native holder balance into recipient output and optional owner change output",
        },
        {
          type: "kcc20-transfer-recipient-owner",
          owner: recipientOwner,
          ownerType: "pubkey",
          purpose:
            "create transferred holder output for the intended recipient",
        },
        {
          type: "kaspa-funding-utxo",
          ownerAddress: wallet.walletAddress,
          purpose: "fund output dust and network fee",
        },
      ],
      warnings: [
        `This transfers ${input.tokenAmount} KCC20 balance to the selected recipient owner.`,
        "Only pubkey-owned holder outputs can be transferred directly from this wallet flow.",
        "Transfer spends one KCC20 holder UTXO; fragmented balances require consolidation.",
      ],
    },
    options,
  );
}

export function buildKcc20NativeConsolidationOperation(
  wallet: Kcc20ActionWalletInfo,
  input: {
    token: Kcc20ActionTokenInfo;
    activeUtxos: readonly Kcc20IndexedCovenantUtxo[];
    sourceOutpoints?: readonly string[];
  },
  options: Kcc20TokenOperationOptions = {},
) {
  const covenantId = requireHex32(input.token.covenantId, "covenantId");
  const owner = normalizeKcc20OwnerIdentifier(
    wallet.kcc20Owner,
    "wallet owner",
  );
  const compatible = ownerNativeHolderUtxos(input.activeUtxos, owner);
  const selected = selectConsolidationBatch(
    compatible,
    input.sourceOutpoints,
    8,
  );
  if (selected.length < 2)
    throw new Error(
      "at least two compatible KCC20 holder UTXOs are required for consolidation",
    );
  const nativeIds = new Set(
    selected.map((utxo) => utxo.covenantId ?? covenantId),
  );
  if (nativeIds.size !== 1)
    throw new Error(
      "selected holder UTXOs belong to different active covenant ids",
    );
  const nativeCovenantId = [...nativeIds][0];
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
      builderKey: "kcc20.consolidate-holders",
      operation: "consolidate-native-holders",
      contract: "KCC20",
      action: "consolidate",
      description: "Build a KCC20 holder consolidation transaction request.",
      params: {
        covenantId,
        appCanonicalCovenantId: covenantId,
        activeHolderNativeCovenantId: nativeCovenantId,
        tokenAmount: total,
        ticker: input.token.ticker ?? null,
        tokenName: input.token.tokenName ?? null,
        activeHolderUtxos: selected,
      },
      sourceRequirements: [
        {
          type: "kcc20-holder-utxo-batch",
          covenantId,
          activeHolderNativeCovenantId: nativeCovenantId,
          owner,
          selectedOutpoints: selected.map((utxo) => utxo.outpoint),
          selectedAmounts: selected.map((utxo) => utxo.state?.["amount"]),
          aggregateAmount: summary.aggregateAmount,
          utxoCount: summary.utxoCount,
          purpose:
            "merge wallet-owned KCC20 holder outputs into one holder output",
        },
        {
          type: "kaspa-funding-utxo",
          ownerAddress: wallet.walletAddress,
          purpose: "fund network fee for holder consolidation",
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

function requireHex32(value: string, field: string): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^0x/, "");
  if (!/^[a-f0-9]{64}$/.test(normalized))
    throw new Error(`${field} must be 64 hex characters`);
  return normalized;
}
