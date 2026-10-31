import { encodeKcc20EscrowPolicy, kcc20EscrowPolicyId, type Kcc20EscrowPolicy } from "./escrow-policy.js";
import {
  buildKcc20FeeMarketRoleScript,
  verifyKcc20FeeMarketArtifacts,
  type Kcc20FeeArtifactSet,
} from "./escrow-market-artifacts.js";

const ZERO = "00".repeat(32);
const MAX = (1n << 63n) - 1n;

function hex32(value: unknown, label: string, allowZero = false): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value) ||
      (!allowZero && value.toLowerCase() === ZERO)) {
    throw new Error(`${label} must be a ${allowZero ? "valid" : "nonzero"} 32-byte hex value`);
  }
  return value.toLowerCase();
}

export interface Kcc20FeeMarketGenesisInput {
  tokenId: string;
  feeTicketId: string;
  priceScale: bigint;
  policy: Kcc20EscrowPolicy;
  wrapperProfile: "native" | "argent";
  artifacts: Kcc20FeeArtifactSet;
}

/** Produce the only genesis role: an unbound wrapper with no orderbook root. */
export function prepareKcc20FeeMarketGenesis(input: Kcc20FeeMarketGenesisInput) {
  const tokenId = hex32(input.tokenId, "token ID");
  const feeTicketId = hex32(input.feeTicketId, "FeeTicket ID", true);
  if (typeof input.priceScale !== "bigint" || input.priceScale <= 0n || input.priceScale > MAX) {
    throw new Error("market price scale is outside the contract range");
  }
  if (input.wrapperProfile !== "native" && input.wrapperProfile !== "argent") {
    throw new Error("unsupported fee-market wrapper profile");
  }
  if (input.wrapperProfile === "argent" && input.policy.creatorFeeBps !== 0) {
    throw new Error("Argent token profile cannot authorize creator fees");
  }
  verifyKcc20FeeMarketArtifacts(input);
  const feePolicy = Array.from(encodeKcc20EscrowPolicy(input.policy),
    byte => byte.toString(16).padStart(2, "0")).join("");
  const policyId = kcc20EscrowPolicyId({ tokenId, feeTicketId, priceScale: input.priceScale, policy: input.policy });
  const state = {
    canonicalTokenId: tokenId, enabled: false, priceScale: input.priceScale.toString(),
    feeTicketId, feePolicy, authenticatedMarketId: ZERO,
  };
  const role = input.wrapperProfile === "native" ? "wrapper" : "argentWrapper";
  const wrapper = buildKcc20FeeMarketRoleScript({ artifact: input.artifacts[role], role, state });
  return { tokenId, feeTicketId, policyId, state, wrapper };
}

/** Render both bound outputs after the accepted genesis has fixed market ID. */
export function prepareKcc20FeeMarketBinding(input: Kcc20FeeMarketGenesisInput & {
  marketId: string;
  rootOwner: string;
  rootOwnerScheme: number;
  rootPayoutScriptHash: string;
}) {
  const genesis = prepareKcc20FeeMarketGenesis(input);
  const marketId = hex32(input.marketId, "market ID");
  const rootOwner = hex32(input.rootOwner, "root owner");
  const rootPayoutScriptHash = hex32(input.rootPayoutScriptHash, "root payout script hash");
  if (!Number.isInteger(input.rootOwnerScheme) || input.rootOwnerScheme < 0 || input.rootOwnerScheme > 4) {
    throw new Error("unsupported root owner scheme");
  }
  const role = input.wrapperProfile === "native" ? "wrapper" : "argentWrapper";
  const wrapperState = { ...genesis.state, enabled: true, authenticatedMarketId: marketId };
  const wrapper = buildKcc20FeeMarketRoleScript({ artifact: input.artifacts[role], role, state: wrapperState });
  const rootState = {
    canonicalTokenId: genesis.tokenId, owner: rootOwner, owner_scheme: input.rootOwnerScheme,
    amount: "0", mode: "1", unitPrice: "0", feeTicketId: genesis.feeTicketId,
    priceScale: input.priceScale.toString(), feePolicy: genesis.state.feePolicy,
    payout_script_hash: rootPayoutScriptHash, wrapper_spk_hash: wrapper.scriptHash,
  };
  const root = buildKcc20FeeMarketRoleScript({ artifact: input.artifacts.root, role: "root", state: rootState });
  return { genesis, marketId, wrapperState, wrapper, rootState, root };
}
