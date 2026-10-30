import { calculateKcc20FeeClaim, KCC20_ESCROW_MAX_INT, type Kcc20FeeReceiptAmounts } from "./escrow-fee.js";
import { kcc20FeeClaimCommitment } from "./escrow-policy.js";

const ZERO = "00".repeat(32);
const HEX_32 = /^[0-9a-f]{64}$/i;

export interface Kcc20FeeAccountState {
  role: string;
  token: string;
  market: string;
  policy: string;
  protocol_account: string;
  creator_account: string;
  protocol_amount: string;
  creator_amount: string;
  owner: string;
  owner_scheme: number;
  guard_template: string;
  guard_prefix: string;
  guard_suffix: string;
  action_hash: string;
  self_template: string;
  self_prefix: string;
  self_suffix: string;
}

export interface Kcc20FeeClaimAccount {
  outpoint: { transactionId: string; index: number };
  covenantId: string;
  principalSompi: bigint;
  state: Kcc20FeeAccountState;
}

function hex32(value: string, label: string): string {
  if (typeof value !== "string" || !HEX_32.test(value)) throw new Error(`${label} must be 32-byte hex`);
  return value.toLowerCase();
}

function natural(value: string, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${label} must be canonical decimal`);
  const result = BigInt(value);
  if (result > KCC20_ESCROW_MAX_INT) throw new Error(`${label} exceeds the contract range`);
  return result;
}

/**
 * Derive the exact claim amounts and covenant successor states. Inputs must
 * already be authenticated against current node UTXOs. This plan does not
 * authorize account ownership, sign, estimate mass or select network funding.
 */
export function planKcc20FeeClaimTransition(input: {
  receipts: readonly Kcc20FeeReceiptAmounts[];
  party: "protocol" | "creator";
  account: Kcc20FeeClaimAccount;
  /** Supplied by a successful pinned receipt verification, not by an indexer hint alone. */
  escrowTemplate: { hash: string; prefixLength: number; suffixLength: number };
  /** Serialized ScriptPublicKey including its two-byte little-endian version. */
  payoutScriptPublicKey: Uint8Array;
}) {
  const amounts = calculateKcc20FeeClaim(input.receipts, input.party);
  const first = input.receipts[0]!;
  const account = input.account;
  const state = account.state;
  const targetAccount = input.party === "protocol" ? first.protocolAccountId : first.creatorAccountId;
  if (hex32(targetAccount, "target account") === ZERO ||
      hex32(account.covenantId, "account covenant") !== hex32(targetAccount, "target account")) {
    throw new Error("claim uses the wrong fee account lineage");
  }
  if (!Number.isInteger(account.outpoint.index) || account.outpoint.index < 0 || account.outpoint.index > 0xffffffff ||
      hex32(account.outpoint.transactionId, "account txid") === ZERO ||
      typeof account.principalSompi !== "bigint" || account.principalSompi <= 0n ||
      account.principalSompi > KCC20_ESCROW_MAX_INT) {
    throw new Error("invalid fee account outpoint or principal");
  }
  if (state.role !== "1" || hex32(state.token, "account token") !== hex32(first.tokenId, "receipt token") ||
      hex32(state.market, "account market") !== hex32(first.marketId, "receipt market") ||
      hex32(state.policy, "account policy") !== hex32(first.policyId, "receipt policy") ||
      [state.protocol_account, state.creator_account, state.owner].some(value => !HEX_32.test(value)) ||
      state.protocol_account.toLowerCase() !== ZERO || state.creator_account.toLowerCase() !== ZERO ||
      state.owner.toLowerCase() === ZERO || state.protocol_amount !== "0" || state.creator_amount !== "0") {
    throw new Error("invalid fee account state");
  }
  if (!Number.isInteger(state.owner_scheme) || state.owner_scheme < 0 || state.owner_scheme > 4 ||
      !HEX_32.test(state.guard_template) || !HEX_32.test(state.action_hash) || !HEX_32.test(state.self_template)) {
    throw new Error("unsupported fee account authority state");
  }
  const guardPrefix = natural(state.guard_prefix, "guard prefix");
  const guardSuffix = natural(state.guard_suffix, "guard suffix");
  const selfPrefix = natural(state.self_prefix, "self prefix");
  const selfSuffix = natural(state.self_suffix, "self suffix");
  if (!Number.isSafeInteger(input.escrowTemplate.prefixLength) ||
      !Number.isSafeInteger(input.escrowTemplate.suffixLength) ||
      input.escrowTemplate.prefixLength <= 0 || input.escrowTemplate.suffixLength <= 0 ||
      state.self_template.toLowerCase() !== hex32(input.escrowTemplate.hash, "escrow template") ||
      selfPrefix !== BigInt(input.escrowTemplate.prefixLength) ||
      selfSuffix !== BigInt(input.escrowTemplate.suffixLength) ||
      (state.owner_scheme === 3 && (state.guard_template.toLowerCase() === ZERO || guardPrefix !== 0n || guardSuffix !== 0n)) ||
      (state.owner_scheme === 4 && (state.guard_template.toLowerCase() === ZERO || guardPrefix === 0n || guardSuffix === 0n)) ||
      (state.owner_scheme <= 2 && (state.guard_template.toLowerCase() !== ZERO || guardPrefix !== 0n || guardSuffix !== 0n))) {
    throw new Error("invalid fee account guard state");
  }
  const commitment = kcc20FeeClaimCommitment({
    receipts: input.receipts,
    party: input.party,
    accountOutpoint: account.outpoint,
    payoutScriptPublicKey: input.payoutScriptPublicKey,
  });
  const successorAccountState: Kcc20FeeAccountState = { ...state, action_hash: commitment };
  const remainderReceiptState = amounts.remainderSompi > 0n ? {
    role: "0", token: first.tokenId, market: first.marketId, policy: first.policyId,
    protocol_account: first.protocolAccountId, creator_account: first.creatorAccountId,
    protocol_amount: amounts.remainingProtocolSompi.toString(),
    creator_amount: amounts.remainingCreatorSompi.toString(),
    owner: ZERO, owner_scheme: 0, guard_template: ZERO,
    guard_prefix: "0", guard_suffix: "0", action_hash: ZERO,
    self_template: input.escrowTemplate.hash.toLowerCase(),
    self_prefix: String(input.escrowTemplate.prefixLength),
    self_suffix: String(input.escrowTemplate.suffixLength),
  } : null;
  return {
    party: input.party,
    claimSompi: amounts.claimSompi,
    accountPrincipalSompi: account.principalSompi,
    remainderSompi: amounts.remainderSompi,
    commitment,
    successorAccountState,
    remainderReceiptState,
    requiresSeparateNetworkFunding: true as const,
  };
}
