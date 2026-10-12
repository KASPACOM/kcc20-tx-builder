import { blake3 } from "@noble/hashes/blake3";
import { requireTokenCapability, type TokenProfile } from "./token-profiles.js";

export interface TokenSigningCapabilities {
  schnorr: boolean;
  ecdsa: boolean;
}
export type TokenWitnessArgument =
  | { type: "data"; hex: string }
  | { type: "signature"; prefixHex: string };
export interface TokenAuthorityInput {
  index: number;
  scriptPublicKeyHex: string;
  covenantId?: string;
}
const hex = (v: Uint8Array) =>
  Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (v: string, size: number, label: string) => {
  if (!new RegExp(`^[0-9a-f]{${size * 2}}$`, "i").test(v))
    throw new Error(`invalid ${label}`);
  return Uint8Array.from(v.match(/../g)!, (b) => parseInt(b, 16));
};
export function tokenPublicKeyHash(publicKey: Uint8Array): Uint8Array {
  if (![32, 33].includes(publicKey.length))
    throw new Error("invalid token public key length");
  return blake3(publicKey);
}
/** Authority inputs must come from the authenticated transaction UTXOs, never an uploaded artifact. */
export function planTokenOwnerWitness(input: {
  profile: TokenProfile;
  owner: string;
  ownerScheme: number;
  publicKey?: string;
  capabilities: TokenSigningCapabilities;
  authorityInputIndex?: number;
  authorityInputs?: readonly TokenAuthorityInput[];
  role: "leader" | "delegator";
}): {
  argument: TokenWitnessArgument;
  signatureAlgorithm?: "schnorr" | "ecdsa";
  authorityInputIndex?: number;
} {
  const { profile, ownerScheme } = input;
  requireTokenCapability(profile, "transfer");
  bytes(input.owner, 32, "token owner");
  if (!profile.ownerSchemes.includes(ownerScheme))
    throw new Error("token profile does not support this owner scheme");
  const prefix = input.role === "leader" ? "00" : "";
  if (ownerScheme <= 2) {
    const algorithm = ownerScheme === 2 ? "ecdsa" : "schnorr";
    if (!input.capabilities[algorithm])
      throw new Error(`wallet does not support ${algorithm} token signatures`);
    const key = bytes(
      input.publicKey ?? "",
      ownerScheme === 2 ? 33 : 32,
      "wallet public key",
    );
    if (ownerScheme === 2 && key[0] !== 2 && key[0] !== 3)
      throw new Error("ECDSA key must be compressed");
    const expected =
      ownerScheme === 0 ? hex(key) : hex(tokenPublicKeyHash(key));
    if (expected !== input.owner.toLowerCase())
      throw new Error("wallet public key does not own the token output");
    return {
      argument: {
        type: "signature",
        prefixHex: prefix + (ownerScheme === 0 ? "" : hex(key)),
      },
      signatureAlgorithm: algorithm,
    };
  }
  const index = input.authorityInputIndex;
  if (!Number.isSafeInteger(index) || index! < 0 || index! > 255)
    throw new Error("explicit authority input index is required");
  const matches = (input.authorityInputs ?? []).filter(
    (a) => a.index === index,
  );
  if (matches.length !== 1)
    throw new Error("authority input is missing or ambiguous");
  const authority = matches[0];
  if (
    ownerScheme === 3 &&
    authority.scriptPublicKeyHex.toLowerCase() !==
      `aa20${input.owner.toLowerCase()}87`
  )
    throw new Error("authority input does not match token P2SH owner");
  if (
    ownerScheme === 4 &&
    authority.covenantId?.toLowerCase() !== input.owner.toLowerCase()
  )
    throw new Error("authority input does not match token covenant owner");
  return {
    argument: {
      type: "data",
      hex:
        prefix +
        (ownerScheme === 3 ? index!.toString(16).padStart(2, "0") : ""),
    },
    authorityInputIndex: index,
  };
}
/** Borrowing is an explicit mode. This function never converts an ordinary send into a borrow. */
export function buildTokenBorrowWitness(input: {
  profile: TokenProfile;
  borrowScheme: number;
  currentGuard: string;
  signature?: string;
  nextGuard?: string;
  oneTimePublicKey?: string;
}): Uint8Array {
  requireTokenCapability(input.profile, "borrow");
  const current = bytes(input.currentGuard, 32, "borrow guard");
  if (input.borrowScheme === 1) {
    if (
      input.signature !== undefined ||
      input.nextGuard !== undefined ||
      input.oneTimePublicKey !== undefined
    )
      throw new Error("threshold borrowing requires an empty authorization");
    return Uint8Array.of(1);
  }
  const sig = bytes(input.signature ?? "", 65, "borrow signature");
  if (input.borrowScheme === 2) {
    if (input.nextGuard !== undefined || input.oneTimePublicKey !== undefined)
      throw new Error("Schnorr borrowing does not rotate its guard");
    return Uint8Array.from([1, ...sig]);
  }
  if (input.borrowScheme !== 3)
    throw new Error("unsupported or disabled borrow scheme");
  const guard = bytes(input.nextGuard ?? "", 32, "next borrow guard");
  const key = bytes(input.oneTimePublicKey ?? "", 32, "one-time public key");
  if (hex(blake3(Uint8Array.from([...guard, ...key]))) !== hex(current))
    throw new Error("hash-chain link does not match current guard");
  return Uint8Array.from([1, ...guard, ...key, ...sig]);
}
