import {
  DEFAULT_KCC20_FEE_BPS,
  DEFAULT_KCC20_MIN_PROTOCOL_FEE_SOMPI,
  DEFAULT_KCC20_TOKEN_DECIMALS,
  KCC20_PLATFORM_PROTOCOL_FEE_RECIPIENT,
} from "./protocol.js";
import { buildKcc20WalletOperationFromPlan } from "./wallet-operation.js";

const KCC20_U64_MAX = (1n << 64n) - 1n;
const HEX_64_RE = /^[a-fA-F0-9]{64}$/;
const KASPA_ADDRESS_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const KASPA_ADDRESS_GENERATORS = [
  0x98f2bc8e61n,
  0x79b76d99e2n,
  0xf33e5fb3c4n,
  0xae2eabe2a8n,
  0x1e4f43e470n,
];

export interface Kcc20DeployTokenDraft {
  ticker?: string;
  tokenName?: string;
  maxSupply: string;
  premintSupply: string;
  decimals?: number;
  premintRecipient?: string;
  mintPolicy: "fixed" | "controlled" | "public";
  mintLaneCount?: number;
  mintPricePerTokenSompi: string;
  treasuryRecipient?: string;
}

export interface Kcc20DeployWalletInfo {
  walletAddress: string;
  kcc20Owner: string;
}

export interface Kcc20DeployOperationOptions {
  network?: string;
  protocolFeeRecipient?: string;
  protocolFeeBps?: number | string | bigint;
  createdAt?: string;
  requestId?: string;
}

export function buildKcc20DeployTokenOperation(
  walletInfo: Kcc20DeployWalletInfo,
  draft: Kcc20DeployTokenDraft,
  options: Kcc20DeployOperationOptions = {},
) {
  const validated = validateDeployToken(walletInfo, draft, options);
  const requestId =
    options.requestId ?? `kcc20-deploy-token-${randomOperationId()}`;
  const network = options.network ?? "testnet-10";
  const builderKey = "kcc20.deploy-token";
  const params = {
    ticker: draft.ticker,
    tokenName: draft.tokenName,
    maxSupply: validated.maxSupply.toString(),
    premintSupply: validated.premintSupply.toString(),
    decimals: validated.decimals,
    displayMaxSupply: draft.maxSupply,
    displayPremintSupply: draft.premintSupply,
    mintPolicy: draft.mintPolicy,
    mintPolicyValue: validated.mintPolicy,
    mintPricePerTokenSompi: validated.mintPricePerTokenSompi.toString(),
    creator: walletInfo.kcc20Owner,
    premintRecipient: validated.premintRecipient,
    premintOwnerScheme: 0,
    treasuryRecipient: validated.treasuryRecipient,
    protocolFeeRecipient: validated.protocolFeeRecipient,
    protocolFeeBps: validated.protocolFeeBps,
    ...(validated.mintLaneCount == null
      ? {}
      : { mintLaneCount: validated.mintLaneCount }),
    deployTemplate: deployTemplate(walletInfo, draft, validated),
  };
  const sourceRequirements = [
    {
      type: "kaspa-funding-utxo",
      ownerAddress: walletInfo.walletAddress,
      purpose: "fund deploy outputs and network fee",
    },
  ];
  const signerRequirements = [
    {
      type: "wallet-owner",
      owner: walletInfo.kcc20Owner,
      address: walletInfo.walletAddress,
    },
  ];

  return buildKcc20WalletOperationFromPlan(
    walletInfo,
    {
      builderKey,
      operation: "deploy-token",
      contract: "KCC20",
      action: "deploy",
      description: "Build a KCC20 deploy transaction request.",
      params,
      sourceRequirements,
      signerRequirements,
      warnings: [
        "The wallet must build the standard KCC20 transaction, attach genesis covenant bindings, sign, and broadcast.",
        "Live submission remains wallet-side.",
      ],
    },
    { ...options, requestId, network },
  );
}

function validateDeployToken(
  walletInfo: Kcc20DeployWalletInfo,
  draft: Kcc20DeployTokenDraft,
  options: Kcc20DeployOperationOptions,
) {
  const decimals = DEFAULT_KCC20_TOKEN_DECIMALS;
  const maxSupply = BigInt(
    parseDisplayAmountToBaseUnits(draft.maxSupply, decimals, "maxSupply"),
  );
  const premintSupply = BigInt(
    parseDisplayAmountToBaseUnits(
      draft.premintSupply,
      decimals,
      "premintSupply",
      {
        allowZero: true,
      },
    ),
  );
  const mintPricePerTokenSompi = parseU64(
    draft.mintPricePerTokenSompi,
    "mintPricePerTokenSompi",
  );
  const mintPolicy = { fixed: 0, controlled: 1, public: 2 }[draft.mintPolicy];
  if (mintPolicy === undefined) {
    throw new Error("mintPolicy is invalid");
  }
  const mintLaneCount = draft.mintLaneCount ?? 10;
  if (
    !Number.isInteger(mintLaneCount) ||
    mintLaneCount < 1 ||
    mintLaneCount > 10
  ) {
    throw new Error("mintLaneCount must be 1..10");
  }
  if (!HEX_64_RE.test(walletInfo.kcc20Owner)) {
    throw new Error("wallet owner must be 64 hex");
  }
  if (maxSupply <= 0n) {
    throw new Error("maxSupply must be greater than zero");
  }
  if (premintSupply > maxSupply) {
    throw new Error("premintSupply cannot exceed maxSupply");
  }
  if (mintPolicy === 0 && premintSupply !== maxSupply) {
    throw new Error("fixed deploys must premint the full maxSupply");
  }
  if (mintPolicy !== 0 && premintSupply === maxSupply) {
    throw new Error(
      "controlled/public mint deploys must leave remaining mint supply",
    );
  }
  if (mintPolicy !== 2 && mintPricePerTokenSompi > 0n) {
    throw new Error("mintPricePerTokenSompi is only valid for public deploys");
  }
  if (
    mintPolicy === 2 &&
    mintPricePerTokenSompi > 0n &&
    (maxSupply - premintSupply) * mintPricePerTokenSompi <
      DEFAULT_KCC20_MIN_PROTOCOL_FEE_SOMPI
  ) {
    throw new Error(
      "public deploys with a mint price must leave enough mintable supply to satisfy the minimum protocol fee",
    );
  }
  if (mintPolicy !== 0 && maxSupply - premintSupply < BigInt(mintLaneCount)) {
    throw new Error("remaining mint supply must cover every mint lane");
  }
  const premintRecipientInput = draft.premintRecipient?.trim();
  if (premintRecipientInput && (mintPolicy === 0 || premintSupply === 0n)) {
    throw new Error(
      "premintRecipient is only valid when controlled/public mint deploys create a premint holder output",
    );
  }

  return {
    maxSupply,
    premintSupply,
    decimals,
    mintPolicy,
    mintPricePerTokenSompi,
    premintRecipient:
      normalizeOptionalOwner(premintRecipientInput, "premintRecipient") ??
      walletInfo.kcc20Owner,
    treasuryRecipient:
      normalizeOptionalOwner(draft.treasuryRecipient, "treasuryRecipient") ??
      walletInfo.kcc20Owner,
    protocolFeeRecipient:
      options.protocolFeeRecipient ?? KCC20_PLATFORM_PROTOCOL_FEE_RECIPIENT,
    protocolFeeBps: Number(options.protocolFeeBps ?? DEFAULT_KCC20_FEE_BPS),
    mintLaneCount: mintPolicy === 0 ? 1 : mintLaneCount,
  };
}

function deployTemplate(
  walletInfo: Kcc20DeployWalletInfo,
  draft: Kcc20DeployTokenDraft,
  validated: ReturnType<typeof validateDeployToken>,
) {
  return {
    tmpl: "KCC20",
    v: 1,
    args: [
      { name: "creator", type: "byte[32]", value: walletInfo.kcc20Owner },
      { name: "maxSupply", type: "u64", value: validated.maxSupply.toString() },
      {
        name: "premintSupply",
        type: "u64",
        value: validated.premintSupply.toString(),
      },
      {
        name: "premintRecipient",
        type: "byte[32]",
        value: validated.premintRecipient,
      },
      { name: "premintOwnerScheme", type: "u64", value: "0" },
      { name: "mintPolicy", type: "u64", value: String(validated.mintPolicy) },
      ...(validated.mintLaneCount == null
        ? []
        : [
            {
              name: "mintLaneCount",
              type: "u64",
              value: String(validated.mintLaneCount),
            },
          ]),
      {
        name: "displayScale",
        type: "u64",
        value: displayScaleForDecimals(validated.decimals).toString(),
      },
      {
        name: "mintPriceSompi",
        type: "u64",
        value: validated.mintPricePerTokenSompi.toString(),
      },
      {
        name: "treasury",
        type: "byte[32]",
        value: validated.treasuryRecipient,
      },
      {
        name: "protocolFeeRecipient",
        type: "byte[32]",
        value: validated.protocolFeeRecipient,
      },
      {
        name: "protocolFeeBps",
        type: "u64",
        value: String(validated.protocolFeeBps),
      },
      { name: "ticker", type: "string", value: draft.ticker ?? "" },
      { name: "name", type: "string", value: draft.tokenName ?? "" },
    ],
  };
}

function parseDisplayAmountToBaseUnits(
  value: string,
  decimals: number,
  field: string,
  options: { allowZero?: boolean } = {},
): string {
  const raw = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    throw new Error(`${field} must be a non-negative decimal token amount`);
  }
  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > decimals) {
    throw new Error(`${field} supports at most ${decimals} decimal places`);
  }
  const scale = 10n ** BigInt(decimals);
  const base =
    BigInt(whole) * scale +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (!options.allowZero && base <= 0n) {
    throw new Error(`${field} must be greater than zero`);
  }
  if (base > KCC20_U64_MAX) {
    throw new Error(`${field} exceeds u64 max`);
  }
  return base.toString();
}

function displayScaleForDecimals(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) {
    throw new Error(`unsupported KCC20 decimals ${decimals}`);
  }
  return 10n ** BigInt(decimals);
}

function parseU64(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${field} must be an unsigned integer`);
  }
  const parsed = BigInt(value);
  if (parsed > KCC20_U64_MAX) {
    throw new Error(`${field} exceeds u64 max`);
  }
  return parsed;
}

function normalizeOptionalOwner(
  value: string | undefined,
  field: string,
): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (HEX_64_RE.test(normalized)) return normalized;
  const owner = ownerFromKaspaAddress(normalized);
  if (owner) return owner;
  throw new Error(`${field} must be a 64 hex owner or Kaspa P2PK address`);
}

function ownerFromKaspaAddress(value: string): string | undefined {
  const [prefix, payload, extra] = value.split(":");
  if (!prefix || !payload || extra !== undefined) return undefined;
  const data: number[] = [];
  for (const char of payload) {
    const index = KASPA_ADDRESS_CHARSET.indexOf(char);
    if (index === -1) return undefined;
    data.push(index);
  }
  if (
    data.length <= 8 ||
    kaspaAddressPolymod(kaspaAddressPrefixExpand(prefix).concat(data)) !== 1n
  ) {
    return undefined;
  }
  const bytes = convertBits(data.slice(0, -8), 5, 8, false);
  if (!bytes || bytes.length !== 33) return undefined;
  const [version, ...ownerBytes] = bytes;
  if (version !== 0 && version !== 1) return undefined;
  const owner = bytesToHex(ownerBytes);
  return HEX_64_RE.test(owner) ? owner : undefined;
}

function kaspaAddressPrefixExpand(prefix: string): number[] {
  return [...prefix].map((char) => char.charCodeAt(0) & 0x1f).concat([0]);
}

function kaspaAddressPolymod(values: number[]): bigint {
  let checksum = 1n;
  for (const value of values) {
    const top = checksum >> 35n;
    checksum = ((checksum & 0x07ffffffffn) << 5n) ^ BigInt(value);
    for (let index = 0; index < KASPA_ADDRESS_GENERATORS.length; index += 1) {
      if (((top >> BigInt(index)) & 1n) === 1n) {
        checksum ^= KASPA_ADDRESS_GENERATORS[index];
      }
    }
  }
  return checksum;
}

function convertBits(
  data: number[],
  fromBits: number,
  toBits: number,
  pad: boolean,
): number[] | undefined {
  let accumulator = 0;
  let bits = 0;
  const result: number[] = [];
  const maxValue = (1 << toBits) - 1;
  const maxAccumulator = (1 << (fromBits + toBits - 1)) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits) return undefined;
    accumulator = ((accumulator << fromBits) | value) & maxAccumulator;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((accumulator >> bits) & maxValue);
    }
  }
  if (pad) {
    if (bits > 0) result.push((accumulator << (toBits - bits)) & maxValue);
  } else if (bits >= fromBits || (accumulator << (toBits - bits)) & maxValue) {
    return undefined;
  }
  return result;
}

function bytesToHex(bytes: number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomOperationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}`;
}
