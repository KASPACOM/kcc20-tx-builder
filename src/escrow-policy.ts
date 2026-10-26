import { blake3 } from "@noble/hashes/blake3";
import { blake2b } from "@noble/hashes/blake2b";
import { calculateKcc20FeeClaim, type Kcc20FeeReceiptAmounts } from "./escrow-fee.js";

/** Wire format for KCC20OrderbookFeeV1. Decoding is not artifact authentication. */
export interface Kcc20EscrowPolicy {
  version: 1;
  creatorFeeBps: number;
  protocolAccountId: string;
  creatorAccountId: string;
  escrowTemplate: { hash: string; prefixLength: number; suffixLength: number };
  orderbookTemplate: { hash: string; prefixLength: number; suffixLength: number };
}

const ZERO = "0".repeat(64);
function hex32(value: string, allowZero = false): Uint8Array {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value) || (!allowZero && value === ZERO)) {
    throw new Error("expected nonzero 32-byte identity");
  }
  return Uint8Array.from(value.match(/../g)!.map(byte => Number.parseInt(byte, 16)));
}
function hex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");
}
function int64(value: bigint): Uint8Array {
  if (typeof value !== "bigint" || value < 0n || value > 0x7fff_ffff_ffff_ffffn) throw new Error("expected nonnegative int64");
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, value, true);
  return result;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function template(value: Kcc20EscrowPolicy["escrowTemplate"]): Uint8Array {
  for (const length of [value.prefixLength, value.suffixLength]) {
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error("template lengths must be positive safe integers");
  }
  return concat(hex32(value.hash), int64(BigInt(value.prefixLength)), int64(BigInt(value.suffixLength)));
}

export function encodeKcc20EscrowPolicy(policy: Kcc20EscrowPolicy): Uint8Array {
  if (policy.version !== 1) throw new Error("unsupported fee policy version");
  if (!Number.isInteger(policy.creatorFeeBps) || policy.creatorFeeBps < 0 || policy.creatorFeeBps > 500) throw new Error("creator rate must be 0 to 500 bps");
  const protocol = hex32(policy.protocolAccountId);
  const creator = hex32(policy.creatorAccountId, policy.creatorFeeBps === 0);
  if (hex(protocol) === hex(creator)) throw new Error("fee account identities must differ");
  return concat(Uint8Array.of(1), int64(BigInt(policy.creatorFeeBps)), protocol, creator,
    template(policy.escrowTemplate), template(policy.orderbookTemplate));
}

export function decodeKcc20EscrowPolicy(bytes: Uint8Array): Kcc20EscrowPolicy {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 169 || bytes[0] !== 1) throw new Error("invalid fee policy encoding");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const integer = (offset: number): number => {
    const value = view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("noncanonical or oversized policy integer");
    return Number(value);
  };
  const policy: Kcc20EscrowPolicy = {
    version: 1, creatorFeeBps: integer(1),
    protocolAccountId: hex(bytes.slice(9, 41)), creatorAccountId: hex(bytes.slice(41, 73)),
    escrowTemplate: { hash: hex(bytes.slice(73, 105)), prefixLength: integer(105), suffixLength: integer(113) },
    orderbookTemplate: { hash: hex(bytes.slice(121, 153)), prefixLength: integer(153), suffixLength: integer(161) },
  };
  encodeKcc20EscrowPolicy(policy);
  return policy;
}

export function kcc20EscrowPolicyId(input: {
  tokenId: string; feeTicketId: string; priceScale: bigint; policy: Kcc20EscrowPolicy;
}): string {
  if (typeof input.priceScale !== "bigint" || input.priceScale <= 0n) throw new Error("priceScale must be positive");
  return hex(blake3(concat(hex32(input.tokenId), hex32(input.feeTicketId, true),
    int64(input.priceScale), encodeKcc20EscrowPolicy(input.policy))));
}

/** Public consent can be reused only for this TN10 market and fixed fee policy.
 * Send `message` to the wallet's standard personal-message signing API. A wallet
 * signature is still required; creating this payload does not establish authority.
 */
export function kcc20CreatorFeeConsent(input: {
  tokenId: string; marketId: string; feeTicketId: string; priceScale: bigint; policy: Kcc20EscrowPolicy;
}): { commitment: string; message: string; personalMessageHash: string } {
  if (typeof input.priceScale !== "bigint" || input.priceScale <= 0n) throw new Error("priceScale must be positive");
  const policy = encodeKcc20EscrowPolicy(input.policy);
  if (input.policy.creatorFeeBps === 0) throw new Error("creator consent is only used when creator fees are enabled");
  const commitment = hex(blake3(concat(Uint8Array.of(0xc1), hex32(input.tokenId), hex32(input.marketId),
    hex32(input.feeTicketId, true), int64(input.priceScale), policy)));
  const message = `KCC20 creator fee consent v1 (TN10)\n${commitment}`;
  const encoder = new TextEncoder();
  const personalMessageHash = hex(blake2b(encoder.encode(message), {
    dkLen: 32, key: encoder.encode("PersonalMessageSigningHash"),
  }));
  return { commitment, message, personalMessageHash };
}

function outpoint(value: { transactionId: string; index: number }): Uint8Array {
  if (!Number.isInteger(value.index) || value.index < 0 || value.index > 0xffffffff) throw new Error("outpoint index must be uint32");
  return concat(hex32(value.transactionId, true), int64(BigInt(value.index)));
}

/** Input order must match the covenant family's consensus input order. */
export function kcc20FeeClaimCommitment(input: {
  receipts: readonly Kcc20FeeReceiptAmounts[];
  party: "protocol" | "creator";
  accountOutpoint: { transactionId: string; index: number };
  /** Serialized ScriptPublicKey, including its two-byte little-endian version. */
  payoutScriptPublicKey: Uint8Array;
}): string {
  const amounts = calculateKcc20FeeClaim(input.receipts, input.party);
  if (!(input.payoutScriptPublicKey instanceof Uint8Array) || input.payoutScriptPublicKey.length < 3) throw new Error("serialized payout ScriptPublicKey is required");
  let receiptHash: Uint8Array = new Uint8Array(32);
  for (const receipt of input.receipts) receiptHash = blake3(concat(receiptHash, outpoint(receipt.outpoint)));
  const first = input.receipts[0];
  return hex(blake3(concat(Uint8Array.of(0xf1), hex32(first.tokenId), hex32(first.marketId), hex32(first.policyId),
    receiptHash, outpoint(input.accountOutpoint), int64(input.party === "creator" ? 1n : 0n),
    int64(amounts.claimSompi), int64(amounts.remainderSompi), blake3(input.payoutScriptPublicKey))));
}
