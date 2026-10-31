import { normalizeSilverScriptArtifact, templateParts } from "./abi.js";
import { KCC20_ESCROW_MAX_INT } from "./escrow-fee.js";
import type { Kcc20FeeAccountState } from "./escrow-claim-plan.js";
import {
  buildKcc20FeeEscrowScript,
  verifyKcc20UnboundFeeAccountForBinding,
  type Kcc20IndexedFeeReceipt,
  type Kcc20LiveFeeReceiptUtxo,
} from "./escrow-receipt.js";

const ZERO = "00".repeat(32);
const SECP256K1_FIELD = (1n << 256n) - (1n << 32n) - 977n;

function hex32(value: string, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${label} must be 32-byte hex`);
  }
  return value.toLowerCase();
}

function principal(value: bigint): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > KCC20_ESCROW_MAX_INT) {
    throw new Error("fee account principal must be a positive contract-range bigint");
  }
  return value;
}

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let factor = base % SECP256K1_FIELD;
  for (let remaining = exponent; remaining > 0n; remaining >>= 1n) {
    if (remaining & 1n) result = (result * factor) % SECP256K1_FIELD;
    factor = (factor * factor) % SECP256K1_FIELD;
  }
  return result;
}

/** BIP340 keys encode an x-coordinate that must lift to a secp256k1 point. */
function requireSchnorrXOnlyPublicKey(value: string): string {
  const key = hex32(value, "owner Schnorr public key");
  const x = BigInt(`0x${key}`);
  if (x >= SECP256K1_FIELD) throw new Error("owner Schnorr public key is not a curve point");
  const square = (x * x % SECP256K1_FIELD * x + 7n) % SECP256K1_FIELD;
  const y = modPow(square, (SECP256K1_FIELD + 1n) / 4n);
  if (y * y % SECP256K1_FIELD !== square) {
    throw new Error("owner Schnorr public key is not a curve point");
  }
  return key;
}

/**
 * Construct the initial account output. Its covenant lineage is assigned by
 * the transaction; the market can bind that lineage only after it is known.
 * This function does not select funding, sign, or estimate transaction mass.
 */
export function buildKcc20InitialFeeAccount(input: {
  artifact: unknown;
  tokenId: string;
  ownerSchnorrPublicKey: string;
  principalSompi: bigint;
}) {
  const token = hex32(input.tokenId, "token");
  const owner = requireSchnorrXOnlyPublicKey(input.ownerSchnorrPublicKey);
  if (token === ZERO || owner === ZERO) throw new Error("fee account token and owner must be nonzero");
  const amountSompi = principal(input.principalSompi);
  const template = templateParts(normalizeSilverScriptArtifact(input.artifact));
  const state: Kcc20FeeAccountState = {
    role: "1", token, market: ZERO, policy: ZERO,
    protocol_account: ZERO, creator_account: ZERO,
    protocol_amount: "0", creator_amount: "0", owner,
    owner_scheme: 0, guard_template: ZERO, guard_prefix: "0", guard_suffix: "0",
    action_hash: ZERO,
    self_template: toHex(template.hash),
    self_prefix: String(template.prefixLength), self_suffix: String(template.suffixLength),
  };
  return { state, amountSompi, ...buildKcc20FeeEscrowScript(input.artifact, state as unknown as Record<string, unknown>) };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify the current unbound account output and plan the exact continuation.
 * The owner signs bindMarket once; later claims use the account's authority.
 */
export function planKcc20FeeAccountBinding(input: {
  artifact: unknown;
  indexed: Kcc20IndexedFeeReceipt;
  live: Kcc20LiveFeeReceiptUtxo;
  tokenId: string;
  accountId: string;
  marketId: string;
  policyId: string;
}) {
  const market = hex32(input.marketId, "market");
  const policy = hex32(input.policyId, "policy");
  if (market === ZERO || policy === ZERO) throw new Error("fee account binding requires a market and policy");
  const verified = verifyKcc20UnboundFeeAccountForBinding({
    artifact: input.artifact,
    indexed: input.indexed,
    live: input.live,
    expected: { tokenId: input.tokenId, accountId: input.accountId },
  });
  const successorState: Kcc20FeeAccountState = {
    ...verified.account.state,
    market, policy,
  };
  const successor = buildKcc20FeeEscrowScript(
    input.artifact,
    successorState as unknown as Record<string, unknown>,
  );
  return {
    entrypoint: "bindMarket" as const,
    account: verified.account,
    currentRedeemScript: verified.redeemScript,
    successorState,
    successorRedeemScript: successor.redeemScript,
    successorScriptPublicKey: successor.scriptPublicKey,
    successorAmountSompi: verified.account.principalSompi,
    requiresOwnerSchnorrSignature: true as const,
    requiresSeparateNetworkFunding: true as const,
  };
}
