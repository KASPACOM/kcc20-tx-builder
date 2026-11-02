// @ts-nocheck
import { sha256 } from "@noble/hashes/sha256";
import {
  concatBytes,
  dispatchTagFor,
  normalizeSilverScriptArtifact,
  pushExplicit,
  signedI64Payload,
  templateHash as calculateTemplateHash,
  templateParts,
} from "./abi.js";
import { bytesToHex, hexToBytes } from "./sale-common.js";

export const KCOM_CLAIM_GRAPH_ABI_SHA256 =
  "48d1f29714eb201ca6f31f3d2c80599e5bda10945c46b38155ab15f7b54bdaea";
export const KCOM_CLAIM_OPEN_ABI_SHA256 =
  "626a0fd2f67d7bc3f858b895d702dbfc57e3073b52734a9c132b13adb76da577";
export const KCOM_CLAIM_GRAPH_ARTIFACT_ID =
  "988b773c14ff9e48ca1f92ed0b5d2bd2ce18976785c7442af44c2b8723607433";
export const KCOM_CLAIM_OPEN_ARTIFACT_ID =
  "2201127f5998a97f2a21f167af0d536b9a292f326f11d5fb0a501ce9bcdf4016";

const MAX_I64 = 9223372036854775807n;
const LINKED_GENESIS_HASHES = {
  KCOMFactory: "fc6e57c4cb344a0581bc51e7ed7a6a3dad00421c8ede0611d258e8a493dd2ae9",
  KCOMVault: "a94e2e10883df38eed15f727136e51307d5c42ead7e7e80f8275812ab1d12964",
};
function digest(value) {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
}
function checkedArtifact(raw, expectedId, expectedAbiHash) {
  if (raw?.id !== expectedId || digest(raw.sil_abi) !== expectedAbiHash)
    throw new Error("KCOM claim artifact or ABI pin mismatch");
  return raw;
}
function encodedField(field, value) {
  switch (field.type.kind) {
    case "fixed_bytes": {
      if (typeof value !== "string" || !new RegExp(`^[0-9a-fA-F]{${field.type.len * 2}}$`).test(value))
        throw new Error(`Invalid ${field.name}`);
      return hexToBytes(value);
    }
    case "int": {
      if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > MAX_I64)
        throw new Error(`Invalid ${field.name}`);
      return signedI64Payload(BigInt(value));
    }
    case "byte": {
      if (!Number.isInteger(value) || value < 0 || value > 255)
        throw new Error(`Invalid ${field.name}`);
      return Uint8Array.of(value);
    }
    case "bool": {
      if (typeof value !== "boolean") throw new Error(`Invalid ${field.name}`);
      return Uint8Array.of(value ? 1 : 0);
    }
    default:
      throw new Error(`Unsupported KCOM claim state field: ${field.name}`);
  }
}

/** Encode only reviewed graph actors; generated cross-actor template hashes never come from a caller. */
export function kcomClaimCodec({ graph: rawGraph, opening: rawOpening }) {
  const graph = checkedArtifact(rawGraph, KCOM_CLAIM_GRAPH_ARTIFACT_ID, KCOM_CLAIM_GRAPH_ABI_SHA256);
  const opening = checkedArtifact(rawOpening, KCOM_CLAIM_OPEN_ARTIFACT_ID, KCOM_CLAIM_OPEN_ABI_SHA256);
  const plans = [...graph.argent.template_plan.templates, ...opening.argent.template_plan.templates];
  const bySymbol = new Map();
  for (const plan of plans) {
    if (bySymbol.has(plan.symbol) || !Array.isArray(plan.sil_template_hash) || plan.sil_template_hash.length !== 32)
      throw new Error("Invalid KCOM claim template plan");
    bySymbol.set(plan.symbol, Uint8Array.from(plan.sil_template_hash));
  }
  const actors = new Map();
  for (const raw of [graph, opening]) {
    for (const [name, contract] of Object.entries(raw.sil_abi.contracts)) {
      if (actors.has(name)) throw new Error("Duplicate KCOM claim actor");
      const portable = { schema_version: 1, contracts: { [name]: contract } };
      const normalized = normalizeSilverScriptArtifact(portable);
      const parts = templateParts(portable);
      const plan = plans.find((entry) => entry.actor === name);
      if (!plan || bytesToHex(parts.hash) !== bytesToHex(Uint8Array.from(plan.sil_template_hash)))
        throw new Error(`KCOM claim ${name} template plan mismatch`);
      const argentActor = raw.argent.actors.find((entry) => entry.name === name);
      if (!argentActor) throw new Error(`Missing ${name} Argent actor`);
      actors.set(name, { contract, normalized, parts, argentActor });
    }
  }
  function actor(name) {
    const found = actors.get(name);
    if (!found) throw new Error(`Unknown KCOM claim actor: ${name}`);
    return found;
  }
  function generatedValue(name) {
    const value = bySymbol.get(name);
    if (!value) throw new Error(`Missing ${name} template`);
    return bytesToHex(value);
  }
  function script(name, state) {
    const { contract, normalized, parts } = actor(name);
    const fields = contract.runtime_state.fields;
    const callerFields = fields.filter((field) => !field.name.startsWith("gen__"));
    if (!state || Object.keys(state).length !== callerFields.length || callerFields.some((field) => !(field.name in state)))
      throw new Error(`Exact ${name} state required`);
    const payload = concatBytes(...fields.map((field) =>
      pushExplicit(encodedField(field, field.name.startsWith("gen__")
        ? generatedValue(field.name) : state[field.name]))));
    if (payload.length !== normalized.state_layout.len)
      throw new Error(`${name} state width mismatch`);
    return concatBytes(parts.prefix, payload, parts.suffix);
  }
  function dispatch(name, entry) {
    return dispatchTagFor(actor(name).normalized, entry);
  }
  function templateHash(name) {
    return bytesToHex(actor(name).parts.hash);
  }
  function linkedTemplateParts(name) {
    const receipt = graph.argent.template_plan.templates.find(item => item.actor === name);
    const raw = receipt?.actor_type_handle?.template;
    if (!raw || !Array.isArray(raw.prefix) || !Array.isArray(raw.suffix) || !Array.isArray(raw.hash))
      throw new Error(`Missing reviewed linked ${name} template`);
    const prefix = Uint8Array.from(raw.prefix), suffix = Uint8Array.from(raw.suffix);
    const hash = Uint8Array.from(raw.hash);
    if (hash.length !== 32 || bytesToHex(hash) !== LINKED_GENESIS_HASHES[name] ||
        bytesToHex(calculateTemplateHash(prefix, suffix)) !== bytesToHex(hash))
      throw new Error(`Invalid linked ${name} template hash`);
    return { prefix, suffix, hash };
  }
  function linkedScript(name, state) {
    const ordinary = script(name, state);
    const { prefix, suffix } = linkedTemplateParts(name);
    const fields = actor(name).contract.runtime_state.fields.filter(field => !field.name.startsWith("gen__"));
    const linked = concatBytes(prefix, ...fields.map(field => pushExplicit(encodedField(field, state[field.name]))), suffix);
    if (bytesToHex(linked) !== bytesToHex(ordinary))
      throw new Error(`Linked ${name} genesis script differs from reviewed graph script`);
    return linked;
  }
  /** Append compiler-generated arguments in ABI order; callers must add explicit arguments first. */
  function appendHiddenWitness(kw, witness, name, entry, { externalTemplates = {}, spawnOutputIndex, spawnOutputIndices = {} } = {}) {
    const source = actor(name);
    const argentEntry = source.argentActor.entries.find((item) => item.name === entry);
    const abiEntry = source.contract.entries[entry];
    if (!argentEntry || !abiEntry) throw new Error(`Missing ${name}.${entry} ABI entry`);
    const hidden = argentEntry.hidden_params ?? [];
    const tail = abiEntry.params.slice(-hidden.length || abiEntry.params.length);
    if (hidden.length > abiEntry.params.length || hidden.some((item, i) =>
      tail[i]?.name !== item.name || tail[i]?.type?.kind !== item.type.kind))
      throw new Error(`KCOM claim ${name}.${entry} hidden ABI mismatch`);
    for (const item of hidden) {
      const subject = item.subject?.actor;
      const parts = subject && (actors.get(subject)?.parts ?? externalTemplates[subject]);
      switch (item.purpose?.kind) {
        case "template_prefix_len":
          if (!parts) throw new Error(`Missing ${subject} template`);
          witness.addI64(BigInt(parts.prefix.length));
          break;
        case "template_suffix_len":
          if (!parts) throw new Error(`Missing ${subject} template`);
          witness.addI64(BigInt(parts.suffix.length));
          break;
        case "template_prefix_bytes":
          if (!parts) throw new Error(`Missing ${subject} template`);
          witness.addData(parts.prefix);
          break;
        case "template_suffix_bytes":
          if (!parts) throw new Error(`Missing ${subject} template`);
          witness.addData(parts.suffix);
          break;
        case "spawn_output_index":
          const index = spawnOutputIndices[item.subject?.handle] ?? spawnOutputIndex;
          if (item.subject?.kind !== "spawn_actor" || !Number.isSafeInteger(index) || index < 0)
            throw new Error(`Missing ${name}.${entry} spawn output index`);
          witness.addI64(BigInt(index));
          break;
        default:
          throw new Error(`Unsupported ${name}.${entry} hidden witness ${item.name}`);
      }
    }
  }
  return { script, dispatch, templateHash, templateParts: name => actor(name).parts,
    linkedTemplateParts, linkedScript, appendHiddenWitness,
    graphArtifactId: graph.id, openingArtifactId: opening.id };
}
