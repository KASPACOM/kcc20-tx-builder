/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { blake3 } from "@noble/hashes/blake3";

function hexBytes(value: string): Uint8Array {
  const hex = value.replace(/^0x/i, "");
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) {
    throw new Error("expected an even-length hexadecimal string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

const MAX_I64 = 9_223_372_036_854_775_807n;
const MIN_I64 = -MAX_I64;

export function normalizeSilverScriptArtifact(rawArtifact) {
  const script = rawArtifact?.script ?? rawArtifact?.bytecode;
  if (Array.isArray(script)) {
    return {
      ...rawArtifact,
      script: Array.from(script, Number),
      bytecode: Array.from(rawArtifact?.bytecode ?? script, Number),
      without_selector: false,
    };
  }

  const portable = normalizePortableSilverScriptArtifact(rawArtifact);
  if (portable) return portable;

  throw new Error(
    `${rawArtifact?.contract_name || "contract"} artifact is missing compiled bytecode`,
  );
}

function normalizePortableSilverScriptArtifact(rawArtifact) {
  if (
    rawArtifact?.schema_version !== 1 ||
    !rawArtifact?.contracts ||
    typeof rawArtifact.contracts !== "object"
  ) {
    return null;
  }

  const entries = Object.entries(rawArtifact.contracts);
  if (entries.length !== 1) {
    throw new Error(
      "portable SilverScript artifact must contain exactly one contract",
    );
  }

  const [contractName, contract] = entries[0];
  const script = contract?.compiled?.bytecode;
  const stateSpan = contract?.compiled?.state_span;
  if (!Array.isArray(script)) {
    throw new Error(
      `${rawArtifact?.contract_name || "contract"} artifact is missing compiled bytecode`,
    );
  }

  const abi = Object.entries(contract.entries || {}).map(([name, entry]) => ({
    name,
    inputs: (entry.params || []).map((param) => ({
      name: param.name,
      type_name: portableTypeName(param.type),
    })),
    dispatch_tag: entry.dispatch_tag,
  }));

  return {
    ...rawArtifact,
    contract_name: contractName,
    bytecode: Array.from(script, Number),
    script: Array.from(script, Number),
    state_layout: {
      start: stateSpan?.offset,
      len: stateSpan?.len,
    },
    abi,
    without_selector: false,
  };
}

function portableTypeName(type) {
  if (!type?.kind) throw new Error("portable ABI param is missing type kind");
  switch (type.kind) {
    case "bool":
    case "byte":
    case "int":
    case "pubkey":
    case "sig":
    case "datasig":
      return type.kind;
    case "bytes":
      return "byte[]";
    case "fixed_bytes":
      return `byte[${type.len}]`;
    case "dynamic_array":
      return `${portableTypeName(type.item)}[]`;
    case "fixed_array":
      return `${portableTypeName(type.item)}[${type.len}]`;
    case "struct":
      return type.name;
    default:
      throw new Error(`unsupported portable ABI type kind: ${type.kind}`);
  }
}

export function canonicalFunctionSignature(abiEntry) {
  if (!abiEntry?.name || !Array.isArray(abiEntry.inputs)) {
    throw new Error("invalid KCC1 ABI entry");
  }
  return `${abiEntry.name}(${abiEntry.inputs.map((input) => input.type_name).join(",")})`;
}

export function dispatchTag(abiEntry) {
  return blake3(
    new TextEncoder().encode(canonicalFunctionSignature(abiEntry)),
  ).slice(0, 4);
}

export function dispatchTagFor(artifact, entrypointName) {
  const entry = artifact?.abi?.find(
    (candidate) => candidate.name === entrypointName,
  );
  if (!entry)
    throw new Error(`artifact is missing ${entrypointName} ABI entry`);
  if (
    typeof entry.dispatch_tag === "string" &&
    /^[0-9a-fA-F]{8}$/.test(entry.dispatch_tag)
  ) {
    return hexBytes(entry.dispatch_tag);
  }
  return dispatchTag(entry);
}

export function templateHash(prefix, suffix) {
  return blake3(
    concatBytes(
      unsignedLe64(BigInt(prefix.length)),
      Uint8Array.from(prefix),
      unsignedLe64(BigInt(suffix.length)),
      Uint8Array.from(suffix),
    ),
  );
}

export function templateParts(artifact) {
  const normalized = normalizeSilverScriptArtifact(artifact);
  const script = Uint8Array.from(normalized.script);
  const start = normalized.state_layout?.start;
  const length = normalized.state_layout?.len;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(length) ||
    start < 0 ||
    length < 0 ||
    start + length > script.length
  ) {
    throw new Error(
      `${normalized.contract_name || "contract"} artifact has invalid state_layout`,
    );
  }
  const prefix = script.slice(0, start);
  const suffix = script.slice(start + length);
  return {
    prefix,
    suffix,
    prefixLength: prefix.length,
    suffixLength: suffix.length,
    hash: templateHash(prefix, suffix),
  };
}

export function mintExtensionCommitment(extension) {
  const { kind = 1, remainingSupply, publicMintActive } = extension;
  const kindValue = Number(kind);
  if (!Number.isInteger(kindValue) || kindValue < 0 || kindValue > 255)
    throw new Error("mint extension kind must be a byte");
  return blake3(
    concatBytes(
      Uint8Array.of(kindValue),
      requireBytes(extension.creator, 32, "creator"),
      requireBytes(extension.ticker, 32, "ticker"),
      requireBytes(extension.name, 32, "name"),
      signedI64Payload(BigInt(extension.displayScale)),
      signedI64Payload(BigInt(extension.maxSupply)),
      signedI64Payload(BigInt(extension.mintLaneCount ?? 1)),
      Uint8Array.of(requireByte(extension.mintPolicy, "mintPolicy")),
      signedI64Payload(BigInt(extension.mintPriceSompi)),
      requireBytes(extension.treasury, 32, "treasury"),
      requireBytes(extension.protocolFeeRecipient, 32, "protocolFeeRecipient"),
      signedI64Payload(BigInt(extension.protocolFeeBps)),
      signedI64Payload(BigInt(remainingSupply)),
      Uint8Array.of(publicMintActive ? 1 : 0),
      requireBytes(
        extension.holderExtensionCommitment,
        32,
        "holderExtensionCommitment",
      ),
    ),
  );
}

export function holderExtensionCommitment(extension) {
  const { kind = 1 } = extension;
  return blake3(
    concatBytes(
      new TextEncoder().encode("KASPACOM/KCC20/HOLDER/V1"),
      Uint8Array.of(requireByte(kind, "kind")),
      requireBytes(extension.creator, 32, "creator"),
      requireBytes(extension.ticker, 32, "ticker"),
      requireBytes(extension.name, 32, "name"),
      signedI64Payload(BigInt(extension.displayScale)),
      signedI64Payload(BigInt(extension.maxSupply)),
      signedI64Payload(BigInt(extension.mintLaneCount ?? 1)),
      Uint8Array.of(requireByte(extension.mintPolicy, "mintPolicy")),
      signedI64Payload(BigInt(extension.mintPriceSompi)),
      requireBytes(extension.treasury, 32, "treasury"),
      requireBytes(extension.protocolFeeRecipient, 32, "protocolFeeRecipient"),
      signedI64Payload(BigInt(extension.protocolFeeBps)),
    ),
  );
}

export function buildKcc20ScriptForState(artifact, state) {
  const normalized = normalizeSilverScriptArtifact(artifact);
  const script = Uint8Array.from(normalized.script);
  const start = normalized.state_layout?.start;
  const length = normalized.state_layout?.len;
  const encodedState = encodeKcc20State(state);
  if (encodedState.length !== length) {
    throw new Error(
      `KCC20 encoded state is ${encodedState.length} bytes, artifact requires ${length}`,
    );
  }
  return concatBytes(
    script.slice(0, start),
    encodedState,
    script.slice(start + length),
  );
}

export function encodeKcc20State(state) {
  return concatBytes(
    pushExplicit(signedI64Payload(BigInt(state.amount))),
    pushExplicit(requireBytes(state.owner, 32, "owner")),
    pushExplicit(Uint8Array.of(requireByte(state.ownerScheme, "ownerScheme"))),
    pushExplicit(
      Uint8Array.of(requireByte(state.borrowScheme, "borrowScheme")),
    ),
    pushExplicit(requireBytes(state.borrowGuard, 32, "borrowGuard")),
    pushExplicit(
      requireBytes(state.extensionCommitment, 32, "extensionCommitment"),
    ),
  );
}

export function encodeKcc20StateRecordArrays(states) {
  if (!Array.isArray(states)) throw new Error("KCC20 states must be an array");
  return [
    concatBytes(
      ...states.map((state) => signedI64Payload(BigInt(state.amount))),
    ),
    concatBytes(
      ...states.map((state) => requireBytes(state.owner, 32, "owner")),
    ),
    Uint8Array.from(
      states.map((state) => requireByte(state.ownerScheme, "ownerScheme")),
    ),
    Uint8Array.from(
      states.map((state) => requireByte(state.borrowScheme, "borrowScheme")),
    ),
    concatBytes(
      ...states.map((state) =>
        requireBytes(state.borrowGuard, 32, "borrowGuard"),
      ),
    ),
    concatBytes(
      ...states.map((state) =>
        requireBytes(state.extensionCommitment, 32, "extensionCommitment"),
      ),
    ),
  ];
}

export function buildKcc20TransferSigScript(
  kw,
  artifact,
  { nextStates, witness },
) {
  const builder = new kw.ScriptBuilder();
  addKcc20StateRecordArrays(builder, nextStates);
  builder.addData(Uint8Array.from(witness));
  builder.addData(dispatchTagFor(artifact, "transfer"));
  return builder.drain();
}

export function buildKcc20TransferDelegatorSigScript(
  kw,
  artifact,
  { witness },
) {
  const builder = new kw.ScriptBuilder();
  builder.addData(Uint8Array.from(witness));
  builder.addData(dispatchTagFor(artifact, "transfer_delegator"));
  return builder.drain();
}

export function buildKcc20MintByOwnerSigScript(kw, artifact, args) {
  const builder = new kw.ScriptBuilder();
  addKcc20MintExtension(builder, args.extension);
  builder.addData(Uint8Array.from(args.authoritySignature));
  addMintDestination(builder, args);
  builder.addData(dispatchTagFor(artifact, "mint_by_owner"));
  return builder.drain();
}

export function buildKcc20MintPublicSigScript(kw, artifact, args) {
  const builder = new kw.ScriptBuilder();
  addKcc20MintExtension(builder, args.extension);
  addMintDestination(builder, args);
  builder.addData(dispatchTagFor(artifact, "mint_public"));
  return builder.drain();
}

export function buildKcc20BurnSigScript(
  kw,
  artifact,
  { nextStates, burnAmount, witness },
) {
  const builder = new kw.ScriptBuilder();
  addKcc20StateRecordArrays(builder, nextStates);
  builder.addI64(BigInt(burnAmount));
  builder.addData(Uint8Array.from(witness));
  builder.addData(dispatchTagFor(artifact, "burn"));
  return builder.drain();
}

export function buildKcc20SetPublicMintActiveSigScript(
  kw,
  artifact,
  { extension, authoritySignature, active, minterOutputIndex },
) {
  const builder = new kw.ScriptBuilder();
  addKcc20MintExtension(builder, extension);
  builder.addData(Uint8Array.from(authoritySignature));
  builder.addI64(active ? 1n : 0n);
  builder.addI64(BigInt(minterOutputIndex));
  builder.addData(dispatchTagFor(artifact, "set_public_mint_active"));
  return builder.drain();
}

export function p2pkOwnerWitness(signature) {
  const bytes = Uint8Array.from(signature);
  if (bytes.length !== 65)
    throw new Error("P2PK Schnorr signature must be 65 bytes");
  return ownerAuthorizationWitness(bytes);
}

export function ownerAuthorizationWitness(witness) {
  return concatBytes(Uint8Array.of(0), Uint8Array.from(witness));
}

function addKcc20StateRecordArrays(builder, states) {
  for (const encodedField of encodeKcc20StateRecordArrays(states))
    builder.addData(encodedField);
}

function addKcc20MintExtension(builder, extension) {
  addExplicitByte(builder, extension.kind ?? 1, "mint extension kind");
  builder.addData(requireBytes(extension.creator, 32, "creator"));
  builder.addData(requireBytes(extension.ticker, 32, "ticker"));
  builder.addData(requireBytes(extension.name, 32, "name"));
  builder.addI64(BigInt(extension.displayScale));
  builder.addI64(BigInt(extension.maxSupply));
  builder.addI64(BigInt(extension.mintLaneCount ?? 1));
  addExplicitByte(builder, extension.mintPolicy, "mintPolicy");
  builder.addI64(BigInt(extension.mintPriceSompi));
  builder.addData(requireBytes(extension.treasury, 32, "treasury"));
  builder.addData(
    requireBytes(extension.protocolFeeRecipient, 32, "protocolFeeRecipient"),
  );
  builder.addI64(BigInt(extension.protocolFeeBps));
  builder.addI64(BigInt(extension.remainingSupply));
  builder.addI64(extension.publicMintActive ? 1n : 0n);
  builder.addData(
    requireBytes(
      extension.holderExtensionCommitment,
      32,
      "holderExtensionCommitment",
    ),
  );
}

function addMintDestination(builder, args) {
  builder.addData(requireBytes(args.toOwner, 32, "toOwner"));
  addExplicitByte(builder, args.toOwnerScheme, "toOwnerScheme");
  addExplicitByte(builder, args.toBorrowScheme, "toBorrowScheme");
  builder.addData(requireBytes(args.toBorrowGuard, 32, "toBorrowGuard"));
  builder.addI64(BigInt(args.tokenAmount));
  builder.addI64(BigInt(args.tokenOutputIndex));
  builder.addI64(BigInt(args.minterOutputIndex));
  builder.addI64(BigInt(args.treasuryOutputIndex));
  builder.addI64(BigInt(args.feeOutputIndex));
}

function addExplicitByte(builder, value, label) {
  const byte = requireByte(value, label);
  builder.addData(Uint8Array.of(byte));
}

export function signedI64Payload(value) {
  const n = BigInt(value);
  if (n < MIN_I64 || n > MAX_I64)
    throw new Error(`KCC1 int is outside signed 64-bit range: ${n}`);
  const negative = n < 0n;
  let magnitude = negative ? -n : n;
  const out = new Uint8Array(8);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number(magnitude & 0xffn);
    magnitude >>= 8n;
  }
  if (negative) out[7] |= 0x80;
  return out;
}

export function unsignedLe64(value) {
  let n = BigInt(value);
  if (n < 0n || n > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`KCC1 length is outside unsigned 64-bit range: ${n}`);
  }
  const out = new Uint8Array(8);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

export function pushExplicit(payload) {
  const bytes = Uint8Array.from(payload);
  if (bytes.length === 0) return Uint8Array.of(0x00);
  if (bytes.length <= 75)
    return concatBytes(Uint8Array.of(bytes.length), bytes);
  if (bytes.length <= 0xff)
    return concatBytes(Uint8Array.of(0x4c, bytes.length), bytes);
  if (bytes.length <= 0xffff) {
    return concatBytes(
      Uint8Array.of(0x4d, bytes.length & 0xff, bytes.length >> 8),
      bytes,
    );
  }
  throw new Error(`explicit payload is too large: ${bytes.length}`);
}

export function concatBytes(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function requireByte(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255)
    throw new Error(`${label} must be a byte`);
  return parsed;
}

function requireBytes(value, length, label) {
  const bytes =
    typeof value === "string"
      ? hexBytes(value)
      : value instanceof Uint8Array
        ? value
        : Array.isArray(value)
          ? Uint8Array.from(value)
          : null;
  if (!bytes) {
    throw new Error(`${label} must be ${length} bytes or hex`);
  }
  if (bytes.length !== length)
    throw new Error(`${label} must be ${length} bytes`);
  return bytes;
}
