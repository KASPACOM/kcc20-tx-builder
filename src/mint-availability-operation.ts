import { buildKcc20WalletOperationFromPlan } from "./wallet-operation.js";

const HEX_64_RE = /^[a-f0-9]{64}$/;

export interface Kcc20MintAvailabilityWalletInfo {
  walletAddress: string;
  kcc20Owner: string;
}

export interface Kcc20BuildMintAvailabilityOperationInput {
  covenantId: string;
  active: boolean;
  activeMinterUtxo: Record<string, unknown>;
  activeMinterUtxos: Record<string, unknown>[];
}

export interface Kcc20MintAvailabilityOperationOptions {
  network?: string;
  createdAt?: string;
  requestId?: string;
}

export function buildKcc20MintAvailabilityOperation(
  walletInfo: Kcc20MintAvailabilityWalletInfo,
  input: Kcc20BuildMintAvailabilityOperationInput,
  options: Kcc20MintAvailabilityOperationOptions = {},
) {
  const covenantId = requireHex64(input.covenantId, "covenantId");
  if (typeof input.active !== "boolean") {
    throw new Error("active must be a boolean");
  }
  if (!input.activeMinterUtxo || typeof input.activeMinterUtxo !== "object") {
    throw new Error("activeMinterUtxo is required");
  }
  if (
    !Array.isArray(input.activeMinterUtxos) ||
    !input.activeMinterUtxos.length
  ) {
    throw new Error("activeMinterUtxos must contain at least one source");
  }
  const outpoints = input.activeMinterUtxos.map((utxo) => utxoOutpoint(utxo));
  const selectedOutpoint = utxoOutpoint(input.activeMinterUtxo);

  return buildKcc20WalletOperationFromPlan(
    walletInfo,
    {
      builderKey: "kcc20.set-public-mint-active",
      operation: "set-mint-availability",
      contract: "KCC20",
      action: "setPublicMintActive",
      description: "Build a public mint availability update request.",
      params: {
        covenantId,
        active: input.active,
        activeMinterUtxo: input.activeMinterUtxo,
        activeMinterUtxos: input.activeMinterUtxos,
      },
      sourceRequirements: [
        {
          type: "kcc20-mint-authority-utxo",
          covenantId,
          outpoint: selectedOutpoint,
          outpoints,
          purpose:
            "preserve remaining supply while updating public mint availability",
        },
        {
          type: "kaspa-funding-utxo",
          ownerAddress: walletInfo.walletAddress,
          purpose: "fund network fee",
        },
      ],
      warnings: [],
      tokenIdentity: {
        canonicalCovenantId: covenantId,
        deployCandidateId: covenantId,
      },
    },
    options,
  );
}

function utxoOutpoint(utxo: Record<string, unknown>): string {
  const txidHex = requireHex64(utxo["txidHex"], "minter txid");
  const vout = Number(utxo["vout"]);
  if (!Number.isInteger(vout) || vout < 0) {
    throw new Error("minter vout must be a non-negative integer");
  }
  return `${txidHex}:${vout}`;
}

function requireHex64(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be 64 hex characters`);
  }
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  if (!HEX_64_RE.test(normalized)) {
    throw new Error(`${field} must be 64 hex characters`);
  }
  return normalized;
}
