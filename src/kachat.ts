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
