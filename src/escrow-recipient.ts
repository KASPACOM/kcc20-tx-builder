import { blake2b } from "@noble/hashes/blake2b";
import { blake3 } from "@noble/hashes/blake3";
import { sha256 } from "@noble/hashes/sha256";
import { normalizeSilverScriptArtifact, templateParts, concatBytes, unsignedLe64 } from "./abi.js";
import { assertKcc20ArtifactScriptHash } from "./artifacts.js";
import { requireSchnorrXOnlyPublicKey } from "./escrow-account-setup.js";
import { encodeKcc20FeeState, type Kcc20IndexedFeeReceipt, type Kcc20LiveFeeReceiptUtxo } from "./escrow-receipt.js";
import { KCC20_ESCROW_MAX_INT } from "./escrow-fee.js";
import type { Kcc20FeeAccountState, Kcc20FeeClaimAccount } from "./escrow-claim-plan.js";

const ZERO = "00".repeat(32);
const ARTIFACT_KEY = "KCC20FeeRecipientV1.placeholder.json";
const ARTIFACT_HASH = "d28edbaa0dcad503cc99e7bb0042b17a174431b5177745c435b6c3bec1f9a455";
const hex = (v: Uint8Array): string => Array.from(v, b => b.toString(16).padStart(2, "0")).join("");
function bytes(v: string): Uint8Array {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) throw new Error("recipient identity must be lowercase 32-byte hex");
  return Uint8Array.from(v.match(/../g)!.map(s => parseInt(s, 16)));
}
function template(input: unknown) {
  if (hex(sha256(new TextEncoder().encode(JSON.stringify(input)))) !== ARTIFACT_HASH) {
    throw new Error("fee recipient artifact metadata mismatch");
  }
  const artifact = normalizeSilverScriptArtifact(input);
  assertKcc20ArtifactScriptHash(ARTIFACT_KEY, artifact);
  if (artifact.contract_name !== "KCC20FeeRecipientV1" || artifact.state_layout?.start !== 1 || artifact.state_layout?.len !== 362) {
    throw new Error("unsupported fee recipient layout");
  }
  return templateParts(artifact);
}
function render(input: unknown, state: Kcc20FeeAccountState) {
  const t = template(input);
  if (state.self_template !== hex(t.hash) || state.self_prefix !== String(t.prefixLength) || state.self_suffix !== String(t.suffixLength)) {
    throw new Error("fee recipient self-template mismatch");
  }
  const redeemScript = concatBytes(t.prefix, encodeKcc20FeeState(state as unknown as Record<string, unknown>), t.suffix);
  const scriptHash = hex(blake2b(redeemScript, { dkLen: 32 }));
  return { redeemScript, scriptHash, scriptPublicKey: { version: 0, scriptHex: `aa20${scriptHash}87` },
    recipientTemplate: { hash:hex(t.hash),prefixLength:t.prefixLength,suffixLength:t.suffixLength },
    prefix:t.prefix,suffix:t.suffix };
}

/** Minimal wallet-signed recipient adapter, independent of any rewards logic. */
export function buildKcc20InitialFeeRecipient(input: {
  artifact: unknown; tokenId:string; marketId:string; policyId:string;
  ownerSchnorrPublicKey:string; principalSompi:bigint;
}) {
  for (const id of [input.tokenId,input.marketId,input.policyId]) {
    bytes(id); if (id === ZERO) throw new Error("recipient identity must be nonzero");
  }
  const owner = requireSchnorrXOnlyPublicKey(input.ownerSchnorrPublicKey);
  if (typeof input.principalSompi !== "bigint" || input.principalSompi <= 0n || input.principalSompi > KCC20_ESCROW_MAX_INT) {
    throw new Error("invalid recipient principal");
  }
  const t = template(input.artifact);
  const state: Kcc20FeeAccountState = {
    role:"2", token:input.tokenId, market:input.marketId, policy:input.policyId,
    protocol_account:ZERO,creator_account:ZERO,protocol_amount:"0",creator_amount:"0",
    owner,owner_scheme:0,guard_template:ZERO,guard_prefix:"0",guard_suffix:"0",action_hash:ZERO,
    self_template:hex(t.hash),self_prefix:String(t.prefixLength),self_suffix:String(t.suffixLength),
  };
  return { state, amountSompi:input.principalSompi, ...render(input.artifact,state) };
}

/** Verify live recipient ownership before binding its signed approval to an account action. */
export function planKcc20FeeRecipientApproval(input: {
  artifact: unknown; indexed:Kcc20IndexedFeeReceipt; live:Kcc20LiveFeeReceiptUtxo;
  account:Kcc20FeeClaimAccount; nextAccount:Kcc20FeeAccountState; signingOwner:string; action:1|2;
}) {
  const {indexed,live,account,nextAccount,action} = input;
  const s = indexed.state as unknown as Kcc20FeeAccountState;
  if (!s || s.role !== "2" || s.owner_scheme !== 0 || s.owner !== requireSchnorrXOnlyPublicKey(input.signingOwner) ||
      s.protocol_account !== ZERO || s.creator_account !== ZERO || s.protocol_amount !== "0" || s.creator_amount !== "0" ||
      s.guard_template !== ZERO || s.guard_prefix !== "0" || s.guard_suffix !== "0") {
    throw new Error("fee recipient is not controlled by the signing wallet");
  }
  for (const k of ["token","market","policy"] as const) {
    bytes(s[k]); if (s[k] === ZERO || s[k] !== account.state[k]) throw new Error(`fee recipient ${k} mismatch`);
  }
  if (account.state.owner_scheme !== 4 || account.state.owner !== indexed.covenantIdHex ||
      account.state.owner !== live.covenantIdHex || indexed.status !== "active" || indexed.spentByTxidHex ||
      indexed.txidHex !== live.outpoint.transactionId || indexed.vout !== live.outpoint.index ||
      !Number.isInteger(indexed.vout) || indexed.vout < 0 || indexed.vout > 0xffffffff ||
      !/^[1-9][0-9]*$/.test(indexed.amountSompiExact) ||
      BigInt(indexed.amountSompiExact) !== live.amountSompi || live.amountSompi > KCC20_ESCROW_MAX_INT) {
    throw new Error("fee recipient live outpoint, lineage or principal mismatch");
  }
  bytes(indexed.txidHex); bytes(indexed.covenantIdHex);
  const current = render(input.artifact,s);
  if (current.scriptHash !== indexed.scriptHashHex || current.scriptPublicKey.scriptHex !== live.scriptPublicKey.scriptHex ||
      live.scriptPublicKey.version !== 0 || account.state.guard_template !== s.self_template ||
      account.state.guard_prefix !== s.self_prefix || account.state.guard_suffix !== s.self_suffix) {
    throw new Error("fee recipient script or account guard mismatch");
  }
  if (action !== 1 && action !== 2) throw new Error("unsupported fee account action");
  encodeKcc20FeeState(nextAccount as unknown as Record<string, unknown>);
  if (nextAccount.owner === ZERO || nextAccount.owner_scheme < 0 || nextAccount.owner_scheme > 4 ||
      (nextAccount.owner_scheme <= 2 && (nextAccount.guard_template !== ZERO || nextAccount.guard_prefix !== "0" || nextAccount.guard_suffix !== "0")) ||
      (nextAccount.owner_scheme === 3 && (nextAccount.guard_template === ZERO || nextAccount.guard_prefix !== "0" || nextAccount.guard_suffix !== "0")) ||
      (nextAccount.owner_scheme === 4 && (nextAccount.guard_template === ZERO || BigInt(nextAccount.guard_prefix) <= 0n || BigInt(nextAccount.guard_suffix) <= 0n))) {
    throw new Error("invalid next account authority");
  }
  const mutable = new Set(action === 1 ? ["action_hash"] : ["action_hash","owner","owner_scheme","guard_template","guard_prefix","guard_suffix"]);
  for (const key of Object.keys(account.state) as (keyof Kcc20FeeAccountState)[]) {
    if (!mutable.has(key) && nextAccount[key] !== account.state[key]) throw new Error(`fee account action changes ${key}`);
  }
  if (action === 1 ? nextAccount.action_hash === ZERO : nextAccount.action_hash !== ZERO) throw new Error("invalid account action commitment");
  if (!Number.isInteger(account.outpoint.index) || account.outpoint.index < 0 || account.outpoint.index > 0xffffffff) throw new Error("invalid account outpoint");
  const approval = blake3(concatBytes(Uint8Array.of(0xa1),bytes(account.outpoint.transactionId),
    unsignedLe64(BigInt(account.outpoint.index)),unsignedLe64(BigInt(action)),bytes(nextAccount.action_hash),
    bytes(nextAccount.owner),Uint8Array.of(nextAccount.owner_scheme),bytes(nextAccount.guard_template),
    unsignedLe64(BigInt(nextAccount.guard_prefix)),unsignedLe64(BigInt(nextAccount.guard_suffix))));
  const nextState = {...s,action_hash:hex(approval)};
  const successor = render(input.artifact,nextState);
  return {nextState,principalSompi:live.amountSompi,covenantId:live.covenantIdHex,
    currentRedeemScript:current.redeemScript,successorRedeemScript:successor.redeemScript,
    templatePrefix:current.prefix,templateSuffix:current.suffix};
}
