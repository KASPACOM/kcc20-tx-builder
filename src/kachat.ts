/** KaPost wire protocol, pinned to KaChat Desktop 90035a816c2abc9462066c99f6df668be555c917.
 * No keys, RPC connections or application state are owned by this module.
 */
import { requireHex, bytesToHex } from "./encoding.js";

export const KACHAT_COMMENT_MAX_BYTES = 2_000;
export const KACHAT_SELF_SEND_SOMPI = 20_000_000n;
export const KACHAT_MARKER = "\u2060";

export type KaChatAction =
  | { kind: "post"; text: string }
  | { kind: "reply"; postId: string; text: string }
  | { kind: "vote"; postId: string; authorPublicKey: string; vote: "upvote" | "unvote" };

export interface KaChatMessageVerifier {
  verifyMessage(input: { message: string; signature: string; publicKey: string }): boolean;
}

/** Preserve compressed identities; x-only wallet keys use BIP340's even convention. */
export function kaChatPublicKey(value: string): string {
  const hex = value.toLowerCase();
  if (/^[0-9a-f]{64}$/.test(hex)) return `02${hex}`;
  if (/^0[23][0-9a-f]{64}$/.test(hex)) return hex;
  throw new Error("KaChat requires a Schnorr public key");
}

function encodedText(text: string): string {
  if (!text.trim()) throw new Error("Comment must not be empty");
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > KACHAT_COMMENT_MAX_BYTES) throw new Error("Comment is too long");
  const marked = new TextEncoder().encode(KACHAT_MARKER + text);
  return btoa(Array.from(marked, byte => String.fromCharCode(byte)).join(""));
}

function fields(action: KaChatAction): string[] {
  switch (action.kind) {
    case "post": return [encodedText(action.text), "[]"];
    case "reply": return [requireHex(action.postId, 32, "parent transaction"), encodedText(action.text), "[]"];
    case "vote": {
      if (action.vote !== "upvote" && action.vote !== "unvote") throw new Error("Unsupported reaction");
      return [requireHex(action.postId, 32, "post transaction"), action.vote, kaChatPublicKey(action.authorPublicKey)];
    }
    default: throw new Error("Unsupported KaChat action");
  }
}

export function kaChatSigningMessage(action: KaChatAction): string {
  return fields(action).join(":");
}

/** Verify the wallet's personal-message signature before embedding it in a transaction. */
export function buildKaChatPayload(
  action: KaChatAction, publicKey: string, signature: string, verifier: KaChatMessageVerifier,
): Uint8Array {
  const key = kaChatPublicKey(publicKey);
  const sig = requireHex(signature, 64, "message signature");
  const body = kaChatSigningMessage(action);
  if (!verifier.verifyMessage({ message: body, signature: sig, publicKey: key.slice(2) })) {
    throw new Error("Wallet message signature is incompatible with KaChat");
  }
  return new TextEncoder().encode(`kchat:1:${action.kind}:${key}:${sig}:${body}`);
}

/** Stable discussion identity does not depend on wrapper version or optional metadata. */
export function kaChatDiscussionKey(network: "testnet-10" | "mainnet", canonicalTokenId: string): string {
  if (network !== "testnet-10" && network !== "mainnet") throw new Error("Unsupported discussion network");
  return `${network}:${requireHex(canonicalTokenId, 32, "canonical token ID")}`;
}

export function kaChatRootText(network: "testnet-10" | "mainnet", canonicalTokenId: string): string {
  return `KaspaCom token discussion\n${kaChatDiscussionKey(network, canonicalTokenId)}`;
}

/** Decode only the supported public protocol and authenticate its exact signed fields. */
export function decodeKaChatPayload(payload: Uint8Array, verifier: KaChatMessageVerifier): {
  action: KaChatAction; publicKey: string; signature: string;
} {
  if (payload.length > 4096) throw new Error("Invalid KaChat payload");
  const parts = new TextDecoder("utf-8", { fatal: true }).decode(payload).split(":");
  const [prefix, version, kind, publicKey, signature, ...values] = parts;
  if (prefix !== "kchat" || version !== "1") throw new Error("Unsupported KaChat payload");
  const text = (value: string) => {
    const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!decoded.startsWith(KACHAT_MARKER)) throw new Error("Invalid comment marker");
    return decoded.slice(KACHAT_MARKER.length);
  };
  let action: KaChatAction;
  if (kind === "post" && values.length === 2 && values[1] === "[]")
    action = { kind, text: text(values[0]) };
  else if (kind === "reply" && values.length === 3 && values[2] === "[]")
    action = { kind, postId: values[0], text: text(values[1]) };
  else if (kind === "vote" && values.length === 3 && (values[1] === "upvote" || values[1] === "unvote"))
    action = { kind, postId: values[0], vote: values[1], authorPublicKey: values[2] };
  else throw new Error("Unsupported KaChat action");
  const expected = buildKaChatPayload(action, publicKey, signature, verifier);
  if (bytesToHex(expected) !== bytesToHex(payload)) throw new Error("Noncanonical KaChat payload");
  return { action, publicKey: kaChatPublicKey(publicKey), signature };
}

/** Wallets may add witnesses only. Never broadcast a modified self-payment. */
export function validateKaChatSignedTransaction(unsigned: any, signed: any,
  measure: (tx: any) => { computeMass: bigint; transientMass: bigint; storageMass: bigint },
) {
  const immutable = (tx: any) => JSON.stringify({
    version: tx.version, lockTime: tx.lockTime, subnetworkId: tx.subnetworkId, gas: tx.gas, payload: tx.payload,
    inputs: Array.from(tx.inputs, (i: any) => ({
      outpoint: `${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`, sequence: i.sequence,
      sigOpCount: i.sigOpCount, computeBudget: i.computeBudget,
      amount: i.utxo?.amount, utxoScript: i.utxo?.scriptPublicKey?.script,
      utxoVersion: i.utxo?.scriptPublicKey?.version, covenantId: i.utxo?.covenantId,
    })),
    outputs: Array.from(tx.outputs, (o: any) => ({ value: o.value,
      script: o.scriptPublicKey.script, version: o.scriptPublicKey.version, covenant: o.covenant })),
  }, (_, v) => typeof v === "bigint" ? v.toString() : v);
  if (immutable(unsigned) !== immutable(signed) || signed.inputs.length !== 1 ||
    !/^41[0-9a-f]{128}01$/i.test(signed.inputs[0].signatureScript))
    throw new Error("Wallet changed the comment transaction or omitted its signature");
  // Never trust amounts/UTXO scripts returned by a wallet when measuring storage mass.
  if (!signed.inputs[0].utxo || !unsigned.inputs[0].utxo) throw new Error("Missing comment funding evidence");
  const mass = measure(signed);
  if (mass.computeMass > 450_000n || mass.transientMass > 900_000n || mass.storageMass > 450_000n)
    throw new Error("Signed comment exceeds mass budget");
  return mass;
}

/** Parameters for the host's standard P2PK transaction generator. Never spend token inputs. */
export function kaChatSelfSendRequest(input: {
  network: "testnet-10" | "mainnet";
  walletAddress: string;
  payload: Uint8Array;
  entries: readonly unknown[];
}) {
  kaChatDiscussionKey(input.network, "0".repeat(64));
  const prefix = input.network === "mainnet" ? "kaspa:" : "kaspatest:";
  if (!input.walletAddress.startsWith(prefix)) throw new Error("Wallet network does not match discussion");
  // The host must verify the exact RPC network; testnet address prefixes do not identify TN10.
  const wire = new TextDecoder("utf-8", { fatal: true }).decode(input.payload);
  if (!/^kchat:1:(post|reply|vote):/.test(wire) || input.payload.length > 4_096) {
    throw new Error("Invalid KaChat payload");
  }
  return {
    networkId: input.network,
    entries: [...input.entries],
    outputs: [{ address: input.walletAddress, amount: KACHAT_SELF_SEND_SOMPI }],
    changeAddress: input.walletAddress,
    priorityFee: 0n,
    payload: bytesToHex(input.payload),
  };
}

/** Version-1 single-output self-send. Combining the self-payment and change avoids
 * creating a small extra output with disproportionate contextual storage mass.
 * Runtime and consensus mass calculation are supplied by the existing host engine.
 */
export function buildKaChatSelfSend(input: {
  network: "testnet-10" | "mainnet";
  observedNetwork: string;
  walletAddress: string;
  payload: Uint8Array;
  entry: {
    outpoint: { transactionId: string; index: number };
    amount: bigint;
    scriptPublicKey: { script: string; version: number };
    blockDaaScore: bigint;
    isCoinbase: boolean;
    covenantId?: unknown;
  };
  feeRate: number;
  maxFeeSompi: bigint;
  runtime: {
    Transaction: new (args: any) => any;
    payToAddressScript: (address: string) => { script: string; version: number };
  };
  measure: (transaction: any) => { computeMass: bigint; transientMass: bigint; storageMass: bigint };
}) {
  if (input.observedNetwork !== input.network) throw new Error("RPC network does not match discussion");
  kaChatSelfSendRequest({ ...input, entries: [] });
  if (!Number.isFinite(input.feeRate) || input.feeRate < 1 || input.feeRate > 10_000 || input.maxFeeSompi <= 0n)
    throw new Error("Invalid comment fee budget");
  const script = input.runtime.payToAddressScript(input.walletAddress);
  if (input.entry.covenantId || input.entry.isCoinbase || input.entry.scriptPublicKey.script !== script.script ||
      input.entry.scriptPublicKey.version !== script.version)
    throw new Error("Comments require an ordinary wallet funding input");
  requireHex(input.entry.outpoint.transactionId, 32, "funding transaction");
  if (!Number.isSafeInteger(input.entry.outpoint.index) || input.entry.outpoint.index < 0)
    throw new Error("Invalid funding output index");
  let fee = 0n;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (fee > input.maxFeeSompi || input.entry.amount - fee < KACHAT_SELF_SEND_SOMPI)
      throw new Error("Insufficient funding within comment fee budget");
    const transaction = new input.runtime.Transaction({
      version: 1, lockTime: 0n, subnetworkId: "0".repeat(40), gas: 0n,
      payload: bytesToHex(input.payload),
      inputs: [{ previousOutpoint: input.entry.outpoint, sequence: 0n,
        sigOpCount: 0, computeBudget: 30,
        // Budget the full P2PK witness before asking the wallet to sign.
        signatureScript: `41${"00".repeat(64)}01`, utxo: input.entry }],
      outputs: [{ value: input.entry.amount - fee, scriptPublicKey: script }],
    });
    const mass = input.measure(transaction);
    if (mass.computeMass < 0n || mass.transientMass < 0n || mass.storageMass < 0n ||
      mass.computeMass > 450_000n || mass.transientMass > 900_000n || mass.storageMass > 450_000n)
      throw new Error("Comment exceeds signed transaction mass budget");
    const normalized = [mass.computeMass, (mass.transientMass + 1n) / 2n, mass.storageMass]
      .reduce((a, b) => a > b ? a : b);
    const required = normalized * BigInt(Math.ceil(input.feeRate));
    if (required <= fee) {
      transaction.inputs[0].signatureScript = "";
      return { transaction, feeSompi: fee, mass };
    }
    fee = required;
  }
  throw new Error("Comment fee estimation did not converge");
}
