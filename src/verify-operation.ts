import {
  KCC20_VERIFY_PAID_MINT_MIN_GROSS_SOMPI,
  kcc20MinimumPaidMintAmount,
} from "./paid-mint-amount.js";
import { buildKcc20WalletOperationFromPlan } from "./wallet-operation.js";

const HEX_64_RE = /^[a-f0-9]{64}$/;

export interface Kcc20VerifyWalletInfo {
  walletAddress: string;
  kcc20Owner: string;
}

export interface Kcc20VerifyDeployReceipt {
  amountSompi?: string | null;
  stateAmount?: string | null;
  tokenAmount?: string | null;
  owner?: string | null;
  ownerScheme?: number | null;
  borrowScheme?: number | null;
  borrowGuard?: string | null;
  extensionCommitment?: string | null;
  isMintAuthority?: boolean | null;
  decimals?: string | number | null;
  mintPolicy?: number | null;
  extension?: Record<string, unknown> | null;
}

export interface Kcc20VerifyActiveTokenUtxo {
  txidHex: string;
  vout: number;
  address: string;
  amountSompi?: string | null;
  action?: string | null;
  state?: Record<string, unknown> | null;
}

export interface Kcc20BuildVerifyOperationInput {
  covenantId: string;
  activeTokenUtxo: Kcc20VerifyActiveTokenUtxo;
  deployReceipt?: Kcc20VerifyDeployReceipt | null;
  ticker?: string | null;
  tokenName?: string | null;
  decimals?: string | number | null;
  mintPolicy?: Record<string, unknown> | null;
  tokenIdentity?: Record<string, unknown>;
}

export interface Kcc20VerifyOperationOptions {
  network?: string;
  createdAt?: string;
  requestId?: string;
}

/**
 * Builds the complete verify/reveal wallet operation from an indexed source
 * and the deploy receipt produced by the shared deploy PSKT builder.
 *
 * The host remains responsible for checking that the outpoint is live. All
 * protocol calculations and operation planning stay in this package.
 */
export function buildKcc20VerifyTokenOperation(
  walletInfo: Kcc20VerifyWalletInfo,
  input: Kcc20BuildVerifyOperationInput,
  options: Kcc20VerifyOperationOptions = {},
) {
  const covenantId = requireHex64(input.covenantId, "covenantId");
  const owner = requireHex64(walletInfo.kcc20Owner, "kcc20Owner");
  const source = normalizeVerifySource(input.activeTokenUtxo);
  const receipt = input.deployReceipt ?? undefined;
  const indexedState = input.activeTokenUtxo.state ?? {};
  const stateOwner = requireHex64(
    firstDefined(
      indexedState["owner"],
      indexedState["ownerIdentifier"],
      receipt?.owner,
    ),
    "active token owner",
  );
  const stateAmount = requireUnsignedInteger(
    firstDefined(
      indexedState["amount"],
      indexedState["stateAmount"],
      indexedState["tokenAmount"],
      receipt?.stateAmount,
      receipt?.tokenAmount,
    ),
    "active token amount",
  );
  const extensionCommitment = requireHex64(
    firstDefined(
      indexedState["extensionCommitment"],
      receipt?.extensionCommitment,
    ),
    "extensionCommitment",
  );
  const extension =
    recordValue(indexedState["extension"]) ?? receipt?.extension ?? undefined;
  const isMintAuthority =
    booleanValue(indexedState["isMintAuthority"]) ??
    booleanValue(indexedState["isMinter"]) ??
    booleanValue(receipt?.isMintAuthority) ??
    stateAmount === "0";
  const revealMode = isMintAuthority ? "mint" : "self-transfer";
  const decimals = resolveDecimals(
    firstDefined(input.decimals, receipt?.decimals, indexedState["decimals"]),
    firstDefined(
      indexedState["tokenDisplayScale"],
      indexedState["priceScale"],
      indexedState["displayScale"],
      extension?.["displayScale"],
    ),
  );
  const tokenDisplayScale = (10n ** BigInt(decimals)).toString();
  const mintPolicyValue = integerValue(
    firstDefined(
      receipt?.mintPolicy,
      indexedState["mintPolicy"],
      extension?.["mintPolicy"],
      input.mintPolicy?.["policyValue"],
    ),
  );
  const mintPriceSompi = requireUnsignedInteger(
    firstDefined(
      extension?.["mintPriceSompi"],
      indexedState["mintPriceSompi"],
      indexedState["mintPricePerTokenSompi"],
      input.mintPolicy?.["mintPricePerTokenSompi"],
      "0",
    ),
    "mint price",
  );
  const protocolFeeBps = optionalBps(
    firstDefined(
      extension?.["protocolFeeBps"],
      indexedState["protocolFeeBps"],
      indexedState["feeBps"],
      input.mintPolicy?.["protocolFeeBps"],
    ),
  );
  const remainingSupply = optionalUnsignedInteger(
    firstDefined(
      extension?.["remainingSupply"],
      indexedState["remainingSupply"],
      input.mintPolicy?.["remainingSupply"],
    ),
    "remaining supply",
  );
  const tokenAmount = isMintAuthority
    ? revealMintAmount({
        mintPriceSompi,
        priceScale: tokenDisplayScale,
        protocolFeeBps,
        remainingSupply,
      })
    : undefined;
  const activeTokenUtxo = {
    ...source,
    state: {
      ...indexedState,
      owner: stateOwner,
      ownerIdentifier: stateOwner,
      ownerScheme:
        integerValue(
          firstDefined(indexedState["ownerScheme"], receipt?.ownerScheme),
        ) ?? 0,
      stateOwnerType:
        integerValue(
          firstDefined(indexedState["stateOwnerType"], receipt?.ownerScheme),
        ) ?? 0,
      borrowScheme:
        integerValue(
          firstDefined(indexedState["borrowScheme"], receipt?.borrowScheme),
        ) ?? 0,
      borrowGuard:
        optionalHex64(
          firstDefined(indexedState["borrowGuard"], receipt?.borrowGuard),
        ) ?? "0".repeat(64),
      extensionCommitment,
      stateAmount,
      tokenAmount: stateAmount,
      amount: stateAmount,
      balance: stateAmount,
      isMintAuthority,
      isMinter: isMintAuthority,
      ...(extension ? { extension } : {}),
    },
  };
  const mintPolicy =
    input.mintPolicy ??
    (extension || mintPolicyValue !== undefined
      ? {
          policy:
            mintPolicyValue === 2
              ? "public"
              : mintPolicyValue === 1
                ? "controlled"
                : "fixed",
          policyValue: mintPolicyValue,
          remainingSupply,
          mintPricePerTokenSompi: mintPriceSompi,
          protocolFeeBps,
          publicMintActive: firstDefined(
            extension?.["publicMintActive"],
            indexedState["publicMintActive"],
          ),
          ...(extension ? { extension } : {}),
        }
      : null);

  return buildKcc20WalletOperationFromPlan(
    walletInfo,
    {
      builderKey: "kcc20.reveal-token",
      operation: "verify-token",
      contract: "KCC20",
      action: "reveal",
      description: "Build a KCC20 verify/reveal transaction request.",
      params: {
        covenantId,
        revealMode,
        tokenAmount,
        recipientOwner: owner,
        recipientOwnerScheme: 0,
        mintPath: isMintAuthority ? "owner" : undefined,
        ...(isMintAuthority
          ? {
              priceScale: tokenDisplayScale,
              tokenDisplayScale,
            }
          : {}),
        ticker: input.ticker?.trim() || null,
        tokenName: input.tokenName?.trim() || null,
        mintPolicy,
        activeTokenUtxo,
      },
      sourceRequirements: [
        {
          type: "active-kcc20-claimed-token-utxo",
          covenantId,
          outpoint: `${source.txidHex}:${source.vout}`,
          revealMode,
          purpose: isMintAuthority
            ? "spend the claimed mint-authority output so TN10 can verify the KCC20 artifact and state"
            : "spend the claimed holder output through a full self-transfer so TN10 can verify the KCC20 artifact and state",
        },
        {
          type: "kaspa-funding-utxo",
          ownerAddress: walletInfo.walletAddress,
          purpose: "fund output dust and network fee",
        },
      ],
      warnings: [
        isMintAuthority
          ? "Reveal mints the default zero-price verification amount locally."
          : "Fixed-supply reveal recreates the full holder balance to the same owner.",
        "The canonical KCC20 covenantId remains the token identity; wrapper market creation is a separate step after verification.",
      ],
      tokenIdentity: input.tokenIdentity ?? {
        canonicalCovenantId: covenantId,
        deployCandidateId: covenantId,
      },
    },
    options,
  );
}

function normalizeVerifySource(source: Kcc20VerifyActiveTokenUtxo) {
  const txidHex = requireHex64(source.txidHex, "active token txid");
  if (!Number.isInteger(source.vout) || source.vout < 0) {
    throw new Error("active token vout must be a non-negative integer");
  }
  if (!source.address?.trim()) {
    throw new Error("active token address is required");
  }
  return {
    txidHex,
    vout: source.vout,
    outpoint: `${txidHex}:${source.vout}`,
    address: source.address.trim(),
    amountSompi: optionalUnsignedInteger(source.amountSompi, "amountSompi"),
    action: source.action ?? "deploy",
  };
}

function revealMintAmount(input: {
  mintPriceSompi: string;
  priceScale: string;
  protocolFeeBps?: number;
  remainingSupply?: string;
}): string {
  const unitPriceSompi = BigInt(input.mintPriceSompi);
  const priceScale = BigInt(input.priceScale);
  const minimum =
    unitPriceSompi > 0n
      ? kcc20MinimumPaidMintAmount({
          unitPriceSompi,
          priceScale,
          minGrossSompi: KCC20_VERIFY_PAID_MINT_MIN_GROSS_SOMPI,
          protocolFeeBps: input.protocolFeeBps,
        })
      : priceScale;
  const amount = minimum > priceScale ? minimum : priceScale;
  if (input.remainingSupply && amount > BigInt(input.remainingSupply)) {
    throw new Error(
      "claimed KCC20 token remaining supply is too small to satisfy the verify mint minimum",
    );
  }
  return amount.toString();
}

function resolveDecimals(value: unknown, scale: unknown): number {
  const parsed = integerValue(value);
  if (parsed !== undefined && parsed >= 0 && parsed <= 18) return parsed;
  const normalizedScale = optionalUnsignedInteger(scale, "display scale");
  if (normalizedScale) {
    let current = BigInt(normalizedScale);
    let decimals = 0;
    while (current > 1n && current % 10n === 0n) {
      current /= 10n;
      decimals += 1;
    }
    if (current === 1n && decimals <= 18) return decimals;
  }
  return 8;
}

function requireHex64(value: unknown, field: string): string {
  const normalized = optionalHex64(value);
  if (!normalized) throw new Error(`${field} must be 64 hex characters`);
  return normalized;
}

function optionalHex64(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  return HEX_64_RE.test(normalized) ? normalized : undefined;
}

function requireUnsignedInteger(value: unknown, field: string): string {
  const normalized = optionalUnsignedInteger(value, field);
  if (normalized === undefined) {
    throw new Error(`${field} must be an unsigned integer`);
  }
  return normalized;
}

function optionalUnsignedInteger(
  value: unknown,
  field: string,
): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const normalized =
    typeof value === "bigint"
      ? value.toString()
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : typeof value === "string"
          ? value.trim()
          : "";
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${field} must be an unsigned integer`);
  }
  return normalized;
}

function integerValue(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "bigint"
        ? Number(value)
        : typeof value === "string" && /^\d+$/.test(value.trim())
          ? Number(value)
          : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function optionalBps(value: unknown): number | undefined {
  const parsed = integerValue(value);
  if (parsed === undefined) return undefined;
  if (parsed < 0 || parsed > 10_000) {
    throw new Error("protocolFeeBps must be 0..10000");
  }
  return parsed;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}
