import { blake3 } from "@noble/hashes/blake3";
import { blake2b } from "@noble/hashes/blake2b";
import type { TokenSigningCapabilities } from "./token-authorization.js";

export type FeeAuthorityArgument =
  | { type: "data"; hex: string }
  | { type: "i64"; value: string }
  | { type: "signature"; prefixHex?: string };
export interface FeeP2shAuthority {
  txidHex: string;
  vout: number;
  address: string;
  redeemScriptHex: string;
  arguments: FeeAuthorityArgument[];
  computeBudget: number;
}
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const bytes = (s: string) => Uint8Array.from(s.match(/../g) ?? [], x => parseInt(x, 16));

/** Validate ownership before network access. Live account and authority scripts are
 * authenticated separately before these witness instructions are used. Funding
 * remains with the connected Schnorr wallet; ECDSA uses that key's compressed form.
 */
export function planFeeAccountAuthority(input: {
  scheme: number; accountOwner: string; guardKey: string; signingOwner: string;
  publicKey?: string; capabilities: TokenSigningCapabilities;
  authority?: FeeP2shAuthority;
}): { algorithm: "schnorr" | "ecdsa"; prefixHex: string; authority?: FeeP2shAuthority } {
  const { scheme, signingOwner, capabilities } = input;
  if (!capabilities.schnorr) throw Error("fee account funding requires Schnorr signing");
  if (scheme === 4) return { algorithm: "schnorr", prefixHex: "" };
  if (scheme === 2) {
    if (!capabilities.ecdsa) throw Error("wallet does not support ECDSA fee account signatures");
    const key = String(input.publicKey ?? "").toLowerCase();
    if (!/^(02|03)[0-9a-f]{64}$/.test(key) || key.slice(2) !== signingOwner ||
        hex(blake3(bytes(key))) !== input.accountOwner)
      throw Error("ECDSA fee account public key does not match the account and wallet");
    return { algorithm: "ecdsa", prefixHex: key };
  }
  if (scheme === 3) {
    if (input.guardKey !== signingOwner) throw Error("P2SH fee account action key does not match wallet");
    const a = input.authority;
    if (!a || !/^[0-9a-f]{64}$/i.test(a.txidHex) ||
        !Number.isSafeInteger(a.vout) || a.vout < 0 || a.vout > 0xffffffff ||
        !/^(?:[0-9a-f]{2}){1,10000}$/i.test(a.redeemScriptHex) ||
        !Number.isInteger(a.computeBudget) || a.computeBudget < 1 || a.computeBudget > 1000 ||
        !Array.isArray(a.arguments) || a.arguments.length > 32)
      throw Error("valid P2SH fee account authority is required");
    if (hex(blake2b(bytes(a.redeemScriptHex), { dkLen: 32 })) !== input.accountOwner)
      throw Error("P2SH fee account authority script does not match owner");
    let signatures = 0, dataBytes = 0;
    for (const arg of a.arguments) {
      if (arg.type === "signature") {
        signatures++;
        if (arg.prefixHex !== undefined && !/^(?:[0-9a-f]{2}){0,256}$/i.test(arg.prefixHex))
          throw Error("invalid P2SH authority signature prefix");
      } else if (arg.type === "data") {
        if (!/^(?:[0-9a-f]{2})*$/i.test(arg.hex)) throw Error("invalid P2SH authority data");
        dataBytes += arg.hex.length / 2;
      } else if (arg.type === "i64") {
        if (!/^-?\d{1,19}$/.test(arg.value) || BigInt(arg.value) < -(1n << 63n) || BigInt(arg.value) >= 1n << 63n)
          throw Error("invalid P2SH authority integer");
      } else throw Error("unsupported P2SH authority argument");
    }
    if (signatures > 1 || dataBytes > 10000) throw Error("P2SH authority witness exceeds bounds");
    return { algorithm: "schnorr", prefixHex: "", authority: a };
  }
  const expected = scheme === 1 ? hex(blake3(bytes(signingOwner))) : signingOwner;
  if ((scheme !== 0 && scheme !== 1) || expected !== input.accountOwner)
    throw Error("fee account is not controlled by the signing wallet");
  return { algorithm: "schnorr", prefixHex: scheme === 1 ? signingOwner : "" };
}
