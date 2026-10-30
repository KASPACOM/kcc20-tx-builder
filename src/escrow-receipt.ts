import { blake2b } from "@noble/hashes/blake2b";
import { sha256 } from "@noble/hashes/sha256";
import { assertKcc20ArtifactScriptHash } from "./artifacts.js";
import { normalizeSilverScriptArtifact, templateHash } from "./abi.js";
import { KCC20_ESCROW_MAX_INT, KCC20_ESCROW_MIN_FEE_SOMPI, type Kcc20FeeReceiptAmounts } from "./escrow-fee.js";
import type { Kcc20FeeAccountState, Kcc20FeeClaimAccount } from "./escrow-claim-plan.js";

const ARTIFACT_KEY = "KCC20FeeEscrowV1.placeholder.json";
// SHA-256 of JSON.stringify(JSON.parse(the packaged artifact)). This pins the
// ABI and runtime-state layout as well as both copies of the compiled script.
const ARTIFACT_CANONICAL_SHA256 = "2ff79d6e8ca7176d6346ab7523c72b789f7238865cd9d3b056c83a8af1b5b2cd";
const STATE_START = 1;
const STATE_LENGTH = 362;
const ZERO = "00".repeat(32);
const FIELDS = [
  ["role", "int"], ["token", "bytes32"], ["market", "bytes32"],
  ["policy", "bytes32"], ["protocol_account", "bytes32"],
  ["creator_account", "bytes32"], ["protocol_amount", "int"],
  ["creator_amount", "int"], ["owner", "bytes32"],
  ["owner_scheme", "byte"], ["guard_template", "bytes32"],
  ["guard_prefix", "int"], ["guard_suffix", "int"],
  ["action_hash", "bytes32"], ["self_template", "bytes32"],
  ["self_prefix", "int"], ["self_suffix", "int"],
] as const;

export interface Kcc20IndexedFeeReceipt {
  txidHex: string;
  vout: number;
  covenantIdHex: string;
  scriptHashHex: string;
  amountSompiExact: string;
  status: string;
  spentByTxidHex?: string | null;
  state: Record<string, unknown> | null;
}

/** Obtain this UTXO from the canonical node immediately before construction. */
export interface Kcc20LiveFeeReceiptUtxo {
  outpoint: { transactionId: string; index: number };
  amountSompi: bigint;
  covenantIdHex: string;
  scriptPublicKey: { version: number; scriptHex: string };
}

export interface Kcc20FeeReceiptIdentity {
  tokenId: string;
  marketId: string;
  policyId: string;
  protocolAccountId: string;
  creatorAccountId: string;
}

function hex32(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) throw new Error(`${name} must be 32-byte hex`);
  return value.toLowerCase();
}

function natural(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${name} must be a canonical decimal string`);
  const result = BigInt(value);
  if (result > KCC20_ESCROW_MAX_INT) throw new Error(`${name} exceeds the contract range`);
  return result;
}

function bytes(value: unknown, name: string): Uint8Array {
  const text = hex32(value, name);
  return Uint8Array.from(text.match(/../g)!.map(part => Number.parseInt(part, 16)));
}

function encodeState(state: Record<string, unknown>): Uint8Array {
  const encoded: number[] = [];
  for (const [name, kind] of FIELDS) {
    let field: Uint8Array;
    if (kind === "bytes32") field = bytes(state[name], name);
    else if (kind === "byte") {
      const value = state[name];
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 255) throw new Error(`${name} must be a byte`);
      field = Uint8Array.of(value as number);
    } else {
      const value = natural(state[name], name);
      field = new Uint8Array(8);
      new DataView(field.buffer).setBigUint64(0, value, true);
    }
    encoded.push(field.length, ...field);
  }
  if (encoded.length !== STATE_LENGTH) throw new Error("fee receipt state width mismatch");
  return Uint8Array.from(encoded);
}

/**
 * Check a receipt hint against the pinned program and a fresh node UTXO.
 * The caller must fetch `live` from a qualified canonical node, authenticate
 * the market root/policy, and refresh the UTXO again before signing.
 */
export function verifyKcc20FeeReceiptForClaim(input: {
  artifact: unknown;
  indexed: Kcc20IndexedFeeReceipt;
  live: Kcc20LiveFeeReceiptUtxo;
  expected: Kcc20FeeReceiptIdentity;
}): { receipt: Kcc20FeeReceiptAmounts; redeemScript: Uint8Array;
      escrowTemplate: { hash: string; prefixLength: number; suffixLength: number } } {
  const artifactHash = Array.from(sha256(new TextEncoder().encode(JSON.stringify(input.artifact))),
    byte => byte.toString(16).padStart(2, "0")).join("");
  if (artifactHash !== ARTIFACT_CANONICAL_SHA256) throw new Error("fee receipt artifact metadata mismatch");
  const artifact = normalizeSilverScriptArtifact(input.artifact);
  assertKcc20ArtifactScriptHash(ARTIFACT_KEY, artifact);
  if (artifact.contract_name !== "KCC20FeeEscrowV1" ||
      artifact.state_layout?.start !== STATE_START || artifact.state_layout?.len !== STATE_LENGTH) {
    throw new Error("unsupported fee receipt artifact layout");
  }
  const base = Uint8Array.from(artifact.script);
  const prefix = base.slice(0, STATE_START);
  const suffix = base.slice(STATE_START + STATE_LENGTH);
  const state = input.indexed.state;
  if (!state || Array.isArray(state) || typeof state !== "object") throw new Error("missing indexed fee receipt state");
  const expected = input.expected;
  const tokenId = hex32(expected.tokenId, "expected token");
  const marketId = hex32(expected.marketId, "expected market");
  const policyId = hex32(expected.policyId, "expected policy");
  const protocolAccountId = hex32(expected.protocolAccountId, "expected protocol account");
  const creatorAccountId = hex32(expected.creatorAccountId, "expected creator account");
  if ([tokenId, marketId, policyId, protocolAccountId].includes(ZERO) ||
      protocolAccountId === creatorAccountId) throw new Error("invalid fee receipt identity");
  for (const [name, value] of [
    ["token", tokenId], ["market", marketId], ["policy", policyId],
    ["protocol_account", protocolAccountId], ["creator_account", creatorAccountId],
  ] as const) {
    if (hex32(state[name], name) !== hex32(value, `expected ${name}`)) throw new Error(`fee receipt ${name} mismatch`);
  }
  if (state.role !== "0" || state.roleName !== "receipt" || state.owner_scheme !== 0 ||
      state.owner !== ZERO || state.guard_template !== ZERO ||
      state.guard_prefix !== "0" || state.guard_suffix !== "0") {
    throw new Error("invalid fee receipt role or owner state");
  }
  const selfHash = Array.from(templateHash(prefix, suffix), byte => byte.toString(16).padStart(2, "0")).join("");
  if (state.self_template !== selfHash || state.self_prefix !== String(prefix.length) ||
      state.self_suffix !== String(suffix.length)) {
    throw new Error("fee receipt self-template mismatch");
  }
  const protocol = natural(state.protocol_amount, "protocol_amount");
  const creator = natural(state.creator_amount, "creator_amount");
  const total = protocol + creator;
  if (total === 0n || total > KCC20_ESCROW_MAX_INT ||
      (protocol > 0n && protocol < KCC20_ESCROW_MIN_FEE_SOMPI) ||
      (creator > 0n && creator < KCC20_ESCROW_MIN_FEE_SOMPI) ||
      (creatorAccountId === ZERO && creator !== 0n)) {
    throw new Error("invalid fee receipt entitlements");
  }
  if (input.indexed.status !== "active" || input.indexed.spentByTxidHex) throw new Error("fee receipt is not active");
  const txid = hex32(input.indexed.txidHex, "indexed txid");
  if (!Number.isInteger(input.indexed.vout) || input.indexed.vout < 0 || input.indexed.vout > 0xffffffff ||
      txid !== hex32(input.live.outpoint.transactionId, "live txid") || input.indexed.vout !== input.live.outpoint.index) {
    throw new Error("fee receipt outpoint mismatch");
  }
  if (hex32(input.indexed.covenantIdHex, "indexed covenant") !== hex32(expected.marketId, "expected market") ||
      hex32(input.live.covenantIdHex, "live covenant") !== hex32(expected.marketId, "expected market")) {
    throw new Error("fee receipt covenant lineage mismatch");
  }
  if (natural(input.indexed.amountSompiExact, "indexed amount") !== total || input.live.amountSompi !== total) {
    throw new Error("fee receipt amount mismatch");
  }
  const stateBytes = encodeState(state);
  const redeemScript = new Uint8Array(prefix.length + stateBytes.length + suffix.length);
  redeemScript.set(prefix);
  redeemScript.set(stateBytes, prefix.length);
  redeemScript.set(suffix, prefix.length + stateBytes.length);
  const scriptHash = Array.from(blake2b(redeemScript, { dkLen: 32 }), byte => byte.toString(16).padStart(2, "0")).join("");
  if (hex32(input.indexed.scriptHashHex, "indexed script hash") !== scriptHash ||
      input.live.scriptPublicKey.version !== 0 ||
      input.live.scriptPublicKey.scriptHex.toLowerCase() !== `aa20${scriptHash}87`) {
    throw new Error("fee receipt script hash mismatch");
  }
  return {
    receipt: {
      outpoint: { transactionId: txid, index: input.indexed.vout },
      tokenId, marketId, policyId, protocolAccountId, creatorAccountId,
      valueSompi: total, protocolSompi: protocol, creatorSompi: creator,
    },
    redeemScript,
    escrowTemplate: { hash: selfHash, prefixLength: prefix.length, suffixLength: suffix.length },
  };
}

/** Authenticate a fee-account hint against the pinned escrow artifact and a fresh node UTXO. */
export function verifyKcc20FeeAccountForClaim(input: {
  artifact: unknown;
  indexed: Kcc20IndexedFeeReceipt;
  live: Kcc20LiveFeeReceiptUtxo;
  expected: { tokenId: string; marketId: string; policyId: string; accountId: string };
}): { account: Kcc20FeeClaimAccount; redeemScript: Uint8Array;
      escrowTemplate: { hash: string; prefixLength: number; suffixLength: number } } {
  const artifactHash = Array.from(sha256(new TextEncoder().encode(JSON.stringify(input.artifact))),
    byte => byte.toString(16).padStart(2, "0")).join("");
  if (artifactHash !== ARTIFACT_CANONICAL_SHA256) throw new Error("fee account artifact metadata mismatch");
  const artifact = normalizeSilverScriptArtifact(input.artifact);
  assertKcc20ArtifactScriptHash(ARTIFACT_KEY, artifact);
  if (artifact.contract_name !== "KCC20FeeEscrowV1" ||
      artifact.state_layout?.start !== STATE_START || artifact.state_layout?.len !== STATE_LENGTH) {
    throw new Error("unsupported fee account artifact layout");
  }
  const base = Uint8Array.from(artifact.script);
  const prefix = base.slice(0, STATE_START);
  const suffix = base.slice(STATE_START + STATE_LENGTH);
  const state = input.indexed.state;
  if (!state || Array.isArray(state) || typeof state !== "object") throw new Error("missing indexed fee account state");
  const tokenId = hex32(input.expected.tokenId, "expected token");
  const marketId = hex32(input.expected.marketId, "expected market");
  const policyId = hex32(input.expected.policyId, "expected policy");
  const accountId = hex32(input.expected.accountId, "expected account");
  if ([tokenId, marketId, policyId, accountId].includes(ZERO)) throw new Error("invalid fee account identity");
  for (const [name, expected] of [["token", tokenId], ["market", marketId], ["policy", policyId]] as const) {
    if (hex32(state[name], name) !== expected) throw new Error(`fee account ${name} mismatch`);
  }
  if (state.role !== "1" || state.roleName !== "account" ||
      hex32(state.protocol_account, "protocol_account") !== ZERO ||
      hex32(state.creator_account, "creator_account") !== ZERO ||
      natural(state.protocol_amount, "protocol_amount") !== 0n ||
      natural(state.creator_amount, "creator_amount") !== 0n ||
      hex32(state.owner, "owner") === ZERO ||
      !Number.isInteger(state.owner_scheme) || (state.owner_scheme as number) < 0 ||
      (state.owner_scheme as number) > 4) {
    throw new Error("invalid fee account role or owner state");
  }
  const guard = hex32(state.guard_template, "guard_template");
  const guardPrefix = natural(state.guard_prefix, "guard_prefix");
  const guardSuffix = natural(state.guard_suffix, "guard_suffix");
  const scheme = state.owner_scheme as number;
  if ((scheme <= 2 && (guard !== ZERO || guardPrefix !== 0n || guardSuffix !== 0n)) ||
      (scheme === 3 && (guard === ZERO || guardPrefix !== 0n || guardSuffix !== 0n)) ||
      (scheme === 4 && (guard === ZERO || guardPrefix === 0n || guardSuffix === 0n))) {
    throw new Error("invalid fee account guard state");
  }
  hex32(state.action_hash, "action_hash");
  const selfHash = Array.from(templateHash(prefix, suffix), byte => byte.toString(16).padStart(2, "0")).join("");
  if (hex32(state.self_template, "self_template") !== selfHash ||
      natural(state.self_prefix, "self_prefix") !== BigInt(prefix.length) ||
      natural(state.self_suffix, "self_suffix") !== BigInt(suffix.length)) {
    throw new Error("fee account self-template mismatch");
  }
  if (input.indexed.status !== "active" || input.indexed.spentByTxidHex) throw new Error("fee account is not active");
  const txid = hex32(input.indexed.txidHex, "indexed txid");
  if (!Number.isInteger(input.indexed.vout) || input.indexed.vout < 0 || input.indexed.vout > 0xffffffff ||
      txid !== hex32(input.live.outpoint.transactionId, "live txid") || input.indexed.vout !== input.live.outpoint.index ||
      hex32(input.indexed.covenantIdHex, "indexed covenant") !== accountId ||
      hex32(input.live.covenantIdHex, "live covenant") !== accountId) {
    throw new Error("fee account outpoint or lineage mismatch");
  }
  const principal = natural(input.indexed.amountSompiExact, "account principal");
  if (principal === 0n || input.live.amountSompi !== principal) throw new Error("fee account principal mismatch");
  const stateBytes = encodeState(state);
  const redeemScript = new Uint8Array(prefix.length + stateBytes.length + suffix.length);
  redeemScript.set(prefix);
  redeemScript.set(stateBytes, prefix.length);
  redeemScript.set(suffix, prefix.length + stateBytes.length);
  const scriptHash = Array.from(blake2b(redeemScript, { dkLen: 32 }), byte => byte.toString(16).padStart(2, "0")).join("");
  if (hex32(input.indexed.scriptHashHex, "indexed script hash") !== scriptHash ||
      input.live.scriptPublicKey.version !== 0 ||
      input.live.scriptPublicKey.scriptHex.toLowerCase() !== `aa20${scriptHash}87`) {
    throw new Error("fee account script hash mismatch");
  }
  return {
    account: {
      outpoint: { transactionId: txid, index: input.indexed.vout },
      covenantId: accountId, principalSompi: principal,
      state: state as unknown as Kcc20FeeAccountState,
    },
    redeemScript,
    escrowTemplate: { hash: selfHash, prefixLength: prefix.length, suffixLength: suffix.length },
  };
}
