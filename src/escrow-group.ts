import { blake3 } from "@noble/hashes/blake3";

const MAX_I64 = 0x7fff_ffff_ffff_ffffn;
const ZERO_OUTPOINT = new Uint8Array(40);

export interface Kcc20FeeGroupOutpoint {
  transactionId: string;
  index: number;
}

export interface Kcc20FeeGroupSlot {
  protocolFeeSompi: bigint;
  creatorFeeSompi: bigint;
}

function bytes32(value: string, label: string): Uint8Array {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be 32-byte hex`);
  }
  return Uint8Array.from(value.match(/../g)!.map(byte => Number.parseInt(byte, 16)));
}

function i64(value: bigint, label: string): Uint8Array {
  if (typeof value !== "bigint" || value < 0n || value > MAX_I64) {
    throw new Error(`${label} must be a nonnegative signed-64-bit integer`);
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function outpoint(value: Kcc20FeeGroupOutpoint, label: string): Uint8Array {
  if (!value || !Number.isInteger(value.index) || value.index < 0 || value.index > 0xffff_ffff) {
    throw new Error(`${label} index must be uint32`);
  }
  return join(bytes32(value.transactionId, `${label} transactionId`), i64(BigInt(value.index), `${label} index`));
}

/** Contract fee-vector encoding: one checked protocol/creator pair per fill. */
export function encodeKcc20FeeVector(slots: readonly Kcc20FeeGroupSlot[]): Uint8Array {
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > 16) {
    throw new Error("fee vector needs one through 16 fills");
  }
  let protocol = 0n;
  let creator = 0n;
  const pairs = slots.map((slot, index) => {
    const p = i64(slot.protocolFeeSompi, `fill ${index} protocol fee`);
    const c = i64(slot.creatorFeeSompi, `fill ${index} creator fee`);
    protocol += slot.protocolFeeSompi;
    creator += slot.creatorFeeSompi;
    if (protocol > MAX_I64 || creator > MAX_I64 || protocol + creator > MAX_I64) {
      throw new Error("grouped fee total exceeds signed-64-bit range");
    }
    return join(p, c);
  });
  return join(...pairs);
}

/** Hashes the complete, ordered market input set. Funding and ticket inputs are excluded. */
export function kcc20MarketInputHash(inputs: readonly Kcc20FeeGroupOutpoint[]): string {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 17) {
    throw new Error("market input set needs one through 17 outpoints");
  }
  const encoded = inputs.map((input, index) => outpoint(input, `market input ${index}`));
  if (new Set(encoded.map(hex)).size !== encoded.length) {
    throw new Error("market input set repeats an outpoint");
  }
  return hex(blake3(join(Uint8Array.of(0xe1), i64(BigInt(inputs.length), "market input count"), ...encoded)));
}

/** Commitment used by the grouped receipt. The signed builder must still verify live inputs. */
export function kcc20FeeGroupCommitment(input: {
  tokenId: string;
  marketId: string;
  policyId: string;
  taker: string;
  marketInputs: readonly Kcc20FeeGroupOutpoint[];
  feeSlots: readonly Kcc20FeeGroupSlot[];
  ticketOutpoint?: Kcc20FeeGroupOutpoint | null;
}): string {
  if (input.feeSlots.length !== input.marketInputs.length && input.feeSlots.length + 1 !== input.marketInputs.length) {
    throw new Error("fee slots must match the market input group");
  }
  const hash = bytes32(kcc20MarketInputHash(input.marketInputs), "market input hash");
  const ticket = input.ticketOutpoint ? outpoint(input.ticketOutpoint, "ticket") : ZERO_OUTPOINT;
  return hex(blake3(join(Uint8Array.of(0xe2),
    bytes32(input.tokenId, "token"), bytes32(input.marketId, "market"),
    bytes32(input.policyId, "policy"), bytes32(input.taker, "taker"),
    ticket, hash, encodeKcc20FeeVector(input.feeSlots),
  )));
}
