// @ts-nocheck
import { sha256 } from "@noble/hashes/sha256";
import {
  concatBytes,
  dispatchTagFor,
  normalizeSilverScriptArtifact,
  pushExplicit,
  signedI64Payload,
  templateParts,
} from "./abi.js";
import { bytesToHex, hexToBytes } from "./sale-common.js";

export const KCOM_CLAIM_GRAPH_ABI_SHA256 =
  "8b269204214a957ecff34faa766c0ca4ee22f2a095e147b55dff80024d0af667";
export const KCOM_CLAIM_OPEN_ABI_SHA256 =
  "9ef8f0d04c93bac76025c852477ae985058f3059bf5df8af2f1c95812b427c06";
export const KCOM_CLAIM_GRAPH_ARTIFACT_ID =
  "531a05b1c137c2141c71618366fbd8d52a30fe5834667bcf07495914fea875ae";
export const KCOM_CLAIM_OPEN_ARTIFACT_ID =
  "179f28ce8e24aac5e8babc83417fcf4300f3c85b8a61009d892b81f0aaee8337";

const MAX_I64 = 9223372036854775807n;
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
      actors.set(name, { contract, normalized, parts });
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
  return { script, dispatch, templateHash, graphArtifactId: graph.id, openingArtifactId: opening.id };
}
