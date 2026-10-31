import { sha256 } from "@noble/hashes/sha256";
import { blake2b } from "@noble/hashes/blake2b";
import { normalizeSilverScriptArtifact, templateParts } from "./abi.js";
import { assertKcc20ArtifactScriptHash } from "./artifacts.js";
import { encodeKcc20EscrowPolicy, type Kcc20EscrowPolicy } from "./escrow-policy.js";

const PINS = {
  receipt: ["KCC20FeeEscrowV1.placeholder.json", "KCC20FeeEscrowV1", "2ff79d6e8ca7176d6346ab7523c72b789f7238865cd9d3b056c83a8af1b5b2cd"],
  root: ["KCC20OrderbookFeeRootV1.placeholder.json", "KCC20OrderbookFeeRootV1", "4f913975eebb0342272912573b9901f84551d9f421b80608c0b872a42479c011"],
  holder: ["KCC20OrderbookFeeHolderV1.placeholder.json", "KCC20OrderbookFeeHolderV1", "78a3fe1ef7a4d7ae142ab78a3a71cef2c1a70ea638cd695e89ea891dd17eec67"],
  ask: ["KCC20OrderbookFeeAskV1.placeholder.json", "KCC20OrderbookFeeAskV1", "b60465af84c75121820323aa83155b6ddcfaae4bff2c64b06740058f5ebc0f95"],
  bid: ["KCC20OrderbookFeeBidV1.placeholder.json", "KCC20OrderbookFeeBidV1", "98d7c97319bbe1ca954c7f4f6a02467e90a7f3e84c14c91db650f8ef5887ee0e"],
  ticket: ["KCC20FeeTicket.placeholder.json", "KCC20FeeTicket", "289f3f74914deb383d2cccc11128187a77e4bcea90e61c83e05d86c5c9d63bc5"],
  wrapper: ["KCC20WrapperFeeV1.placeholder.json", "KCC20WrapperFeeV1", "84c3844493efd4bdf6b2e3435e1ac511f5b5a7f58b5b6c093c91e2edcae1a2e0"],
  argentWrapper: ["KCC20WrapperFeeArgentV1.placeholder.json", "KCC20WrapperFeeArgentV1", "130f25462e070523821579d28809577fac6d010f8d5deabc66ad2de1c11d2c73"],
} as const;

export type Kcc20FeeArtifactRole = keyof typeof PINS;
export type Kcc20FeeArtifactSet = { [K in Kcc20FeeArtifactRole]: unknown };
const POLICY_ROLES = ["receipt", "root", "holder", "ask", "bid", "ticket"] as const;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function fixedBytes(value: unknown, width: number, field: string): Uint8Array {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-fA-F]{${width * 2}}$`).test(value)) {
    throw new Error(`${field} must be ${width}-byte hex`);
  }
  return Uint8Array.from(value.match(/../g)!, part => Number.parseInt(part, 16));
}

/** Render a pinned versioned role with exact SilverScript runtime-state encoding. */
export function buildKcc20FeeMarketRoleScript(input: {
  artifact: unknown;
  role: "root" | "wrapper" | "argentWrapper";
  state: Record<string, unknown>;
}) {
  const [key, name, metadataHash] = PINS[input.role];
  const raw = input.artifact as {
    contracts?: Record<string, { runtime_state?: { fields?: Array<{ name: string; type: { kind: string; len?: number } }> } }>;
  };
  if (!raw || typeof raw !== "object" ||
      hex(sha256(new TextEncoder().encode(JSON.stringify(raw)))) !== metadataHash) {
    throw new Error(`${input.role} fee-market artifact metadata mismatch`);
  }
  const artifact = normalizeSilverScriptArtifact(raw);
  if (artifact.contract_name !== name) throw new Error(`${input.role} contract mismatch`);
  assertKcc20ArtifactScriptHash(key, artifact);
  const fields = Object.values(raw.contracts ?? {})[0]?.runtime_state?.fields;
  if (!fields || Object.keys(input.state).length !== fields.length ||
      fields.some(field => !Object.hasOwn(input.state, field.name))) {
    throw new Error(`${input.role} runtime state fields mismatch`);
  }
  const encoded: number[] = [];
  for (const field of fields) {
    const value = input.state[field.name];
    const { kind, len } = field.type;
    let bytes: Uint8Array;
    if (kind === "fixed_bytes" && Number.isInteger(len) && len! > 0) {
      bytes = fixedBytes(value, len!, field.name);
    } else if (kind === "bool" && typeof value === "boolean") {
      bytes = Uint8Array.of(value ? 1 : 0);
    } else if (kind === "byte" && Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 255) {
      bytes = Uint8Array.of(Number(value));
    } else if (kind === "int" && typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) &&
        BigInt(value) <= (1n << 63n) - 1n) {
      bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    } else {
      throw new Error(`invalid ${input.role} state field ${field.name}`);
    }
    if (bytes.length <= 75) encoded.push(bytes.length, ...bytes);
    else if (bytes.length <= 65535) encoded.push(77, bytes.length & 255, bytes.length >> 8, ...bytes);
    else throw new Error(`${field.name} exceeds script push size`);
  }
  const layout = artifact.state_layout;
  if (!layout || encoded.length !== layout.len) throw new Error(`${input.role} state width mismatch`);
  const parts = templateParts(artifact);
  const redeemScript = Uint8Array.from([...parts.prefix, ...encoded, ...parts.suffix]);
  const scriptHash = hex(blake2b(redeemScript, { dkLen: 32 }));
  return {
    redeemScript,
    scriptHash,
    scriptPublicKey: { version: 0 as const, scriptHex: `aa20${scriptHash}87` },
    template: { hash: hex(parts.hash), prefixLength: parts.prefixLength, suffixLength: parts.suffixLength },
  };
}

/** Check the compiled programs and immutable policy before any fee-market PSKT is built. */
export function verifyKcc20FeeMarketArtifacts(input: {
  policy: Kcc20EscrowPolicy;
  artifacts: Kcc20FeeArtifactSet;
  wrapperProfile: "native" | "argent";
}) {
  if (encodeKcc20EscrowPolicy(input.policy).length !== 361) {
    throw new Error("invalid fee-market policy width");
  }
  const verified = {} as Record<Kcc20FeeArtifactRole, ReturnType<typeof templateParts>>;
  for (const role of [...POLICY_ROLES, input.wrapperProfile === "native" ? "wrapper" : "argentWrapper"] as Kcc20FeeArtifactRole[]) {
    const artifact = input.artifacts[role];
    const [key, name, metadataHash] = PINS[role];
    if (!artifact || typeof artifact !== "object") throw new Error(`missing ${role} fee-market artifact`);
    const actualMetadataHash = hex(sha256(new TextEncoder().encode(JSON.stringify(artifact))));
    if (actualMetadataHash !== metadataHash) throw new Error(`${role} fee-market artifact metadata mismatch`);
    const normalized = normalizeSilverScriptArtifact(artifact);
    if (normalized.contract_name !== name) throw new Error(`${role} fee-market artifact contract mismatch`);
    assertKcc20ArtifactScriptHash(key, normalized);
    verified[role] = templateParts(normalized);
  }
  for (const role of POLICY_ROLES) {
    const actual = verified[role];
    const expected = input.policy[`${role}Template`];
    if (hex(actual.hash) !== expected.hash.toLowerCase() ||
        actual.prefixLength !== expected.prefixLength ||
        actual.suffixLength !== expected.suffixLength) {
      throw new Error(`${role} fee-market policy template mismatch`);
    }
  }
  return {
    wrapper: input.wrapperProfile === "native" ? verified.wrapper : verified.argentWrapper,
    receipt: verified.receipt,
    root: verified.root,
    holder: verified.holder,
    ask: verified.ask,
    bid: verified.bid,
    ticket: verified.ticket,
  };
}
