import { sha256 } from "@noble/hashes/sha256";
import {
  buildKcc20ScriptForState,
  normalizeSilverScriptArtifact,
  templateHash,
  dispatchTagFor,
} from "./abi.js";

export const KCC20_STANDARD_REVISION =
  "3fbec524abfbc20e87652eb938db218f8c17db17";
export type TokenOperation =
  | "transfer"
  | "borrow"
  | "mint"
  | "burn"
  | "wrap"
  | "unwrap"
  | "trade";
export interface TokenWrapperProfile {
  fingerprint: string;
  artifactKey: string;
  artifactSha256: string;
  artifactCanonicalSha256: string;
  scriptSha256: string;
  scriptLength: number;
  templateHash: string;
  stateLayout: { start: number; len: number };
  tokenTemplateHash: string;
}
export interface TokenProfile {
  id: string;
  artifactKey: string;
  artifactSha256: string;
  artifactCanonicalSha256: string;
  scriptSha256: string;
  templateHash: string;
  scriptLength: number;
  stateLayout: { start: number; len: number };
  standardRevision: string;
  transferTag: string;
  delegatorTag: string;
  transferEntrypoint: string;
  delegatorEntrypoint: string;
  ownerSchemes: number[];
  maxTokenInputs: number;
  maxTokenOutputs: number;
  operations: TokenOperation[];
  fungibility: "single-holder-class" | "unverified";
  nativeExtensions: boolean;
  wrapper?: TokenWrapperProfile;
  /** Reviewed fixed display convention for programs without token metadata. */
  displayDecimals?: number;
}
export interface TokenProfileRegistry {
  schema: "kcc20-token-profiles/v2";
  standardRevision: string;
  profiles: TokenProfile[];
}

export interface AuthenticatedTokenProfileRegistry {
  readonly manifest: TokenProfileRegistry;
  readonly sha256: string;
}
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const hashPattern = /^[0-9a-f]{64}$/;

/** JSON canonicalization is shared with the registry generator and Rust decoder. */
export function canonicalRegistryJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalRegistryJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalRegistryJson(object[k])}`)
    .join(",")}}`;
}

export function validateTokenProfileRegistry(
  value: unknown,
  expectedDigest: string,
): TokenProfileRegistry {
  if (
    !hashPattern.test(expectedDigest) ||
    hex(sha256(new TextEncoder().encode(canonicalRegistryJson(value)))) !==
      expectedDigest
  ) {
    throw new Error("KCC20 profile registry digest mismatch");
  }
  const registry = value as TokenProfileRegistry;
  if (
    registry?.schema !== "kcc20-token-profiles/v2" ||
    registry.standardRevision !== KCC20_STANDARD_REVISION ||
    !Array.isArray(registry.profiles)
  ) {
    throw new Error("unsupported KCC20 profile registry");
  }
  const ids = new Set<string>(),
    templates = new Set<string>();
  for (const p of registry.profiles) {
    if (
      !p ||
      !/^[a-z0-9][a-z0-9-]{1,95}$/.test(p.id) ||
      ids.has(p.id) ||
      templates.has(p.templateHash) ||
      !/^[A-Za-z0-9.-]+\.json$/.test(p.artifactKey) ||
      ![
        p.artifactSha256,
        p.artifactCanonicalSha256,
        p.scriptSha256,
        p.templateHash,
      ].every((h) => hashPattern.test(h)) ||
      p.standardRevision !== registry.standardRevision ||
      !Number.isSafeInteger(p.scriptLength) ||
      p.scriptLength <= 112 ||
      !Number.isSafeInteger(p.stateLayout?.start) ||
      p.stateLayout.start < 0 ||
      p.stateLayout.len !== 112 ||
      p.stateLayout.start + 112 > p.scriptLength ||
      !/^[0-9a-f]{8}$/.test(p.transferTag) ||
      !/^[0-9a-f]{8}$/.test(p.delegatorTag) ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,95}$/.test(p.transferEntrypoint) ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,95}$/.test(p.delegatorEntrypoint) ||
      !Array.isArray(p.ownerSchemes) ||
      !p.ownerSchemes.length ||
      p.ownerSchemes.some((s) => !Number.isInteger(s) || s < 0 || s > 4) ||
      new Set(p.ownerSchemes).size !== p.ownerSchemes.length ||
      ![p.maxTokenInputs, p.maxTokenOutputs].every(
        (n) => Number.isSafeInteger(n) && n > 0 && n <= 255,
      ) ||
      !Array.isArray(p.operations) ||
      p.operations.some(
        (op) =>
          ![
            "transfer",
            "borrow",
            "mint",
            "burn",
            "wrap",
            "unwrap",
            "trade",
          ].includes(op),
      ) ||
      !["single-holder-class", "unverified"].includes(p.fungibility) ||
      typeof p.nativeExtensions !== "boolean"
    ) {
      throw new Error("invalid or duplicate KCC20 token profile");
    }
    if (
      p.displayDecimals !== undefined &&
      (!Number.isInteger(p.displayDecimals) ||
        p.displayDecimals < 0 ||
        p.displayDecimals > 8)
    )
      throw new Error("unsupported profile display precision");
    if (p.wrapper) {
      const w = p.wrapper;
      if (
        !/^[A-Za-z0-9.-]+\.json$/.test(w.artifactKey) ||
        w.tokenTemplateHash !== p.templateHash ||
        ![
          w.fingerprint,
          w.artifactSha256,
          w.artifactCanonicalSha256,
          w.scriptSha256,
          w.templateHash,
        ].every((h) => hashPattern.test(h)) ||
        !Number.isSafeInteger(w.scriptLength) ||
        w.stateLayout?.start !== 1 ||
        w.stateLayout.len !== 44 ||
        w.scriptLength <= 45
      )
        throw new Error("invalid token wrapper binding");
    }
    ids.add(p.id);
    templates.add(p.templateHash);
  }
  // Snapshot caller-owned data so changing an upload cannot change a bundled profile.
  return deepFreeze(JSON.parse(JSON.stringify(registry)));
}

/** Resolve a profile only after authenticating the complete registry manifest. */
export function resolveAuthenticatedTokenProfile(
  registry: AuthenticatedTokenProfileRegistry,
  profileId: string,
): TokenProfile {
  const manifest = validateTokenProfileRegistry(
    registry?.manifest,
    registry?.sha256,
  );
  const profile = manifest.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error("KCC20 token profile is unavailable");
  return profile;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export function authenticateTokenArtifact(
  profile: TokenProfile,
  raw: unknown,
): ReturnType<typeof normalizeSilverScriptArtifact> {
  if (
    hex(sha256(new TextEncoder().encode(canonicalRegistryJson(raw)))) !==
    profile.artifactCanonicalSha256
  ) {
    throw new Error(
      "KCC20 artifact ABI or metadata does not match the bundled profile",
    );
  }
  const a = normalizeSilverScriptArtifact(raw);
  if (
    !Array.isArray(a.script) ||
    a.script.some((b: number) => !Number.isInteger(b) || b < 0 || b > 255) ||
    a.script.length !== profile.scriptLength ||
    a.state_layout?.start !== profile.stateLayout.start ||
    a.state_layout?.len !== 112
  ) {
    throw new Error("KCC20 artifact layout does not match the bundled profile");
  }
  const bytes = Uint8Array.from(a.script);
  if (
    hex(sha256(bytes)) !== profile.scriptSha256 ||
    hex(
      templateHash(
        bytes.slice(0, profile.stateLayout.start),
        bytes.slice(profile.stateLayout.start + 112),
      ),
    ) !== profile.templateHash
  ) {
    throw new Error("KCC20 artifact script does not match the bundled profile");
  }
  for (const name of [
    profile.transferEntrypoint,
    profile.delegatorEntrypoint,
  ]) {
    if (!a.abi.some((entry: { name: string }) => entry.name === name))
      throw new Error("KCC20 profile entrypoint missing from artifact");
  }
  if (
    hex(dispatchTagFor(a, profile.transferEntrypoint)) !==
      profile.transferTag ||
    hex(dispatchTagFor(a, profile.delegatorEntrypoint)) !== profile.delegatorTag
  )
    throw new Error("profile dispatch tags do not match artifact");
  const config = (raw as any).program_information;
  if (
    !config ||
    config.max_token_inputs !== profile.maxTokenInputs ||
    config.max_token_outputs !== profile.maxTokenOutputs ||
    JSON.stringify(config.owner_schemes) !==
      JSON.stringify(profile.ownerSchemes)
  )
    throw new Error("profile token configuration does not match artifact");
  return a;
}

export function authenticateTokenWrapper(
  profile: TokenProfile,
  raw: unknown,
): ReturnType<typeof normalizeSilverScriptArtifact> {
  const w = profile.wrapper;
  if (!w || w.tokenTemplateHash !== profile.templateHash)
    throw new Error("token has no bundled wrapper binding");
  if (
    hex(sha256(new TextEncoder().encode(canonicalRegistryJson(raw)))) !==
    w.artifactCanonicalSha256
  )
    throw new Error("wrapper artifact does not match the bundled profile");
  const a = normalizeSilverScriptArtifact(raw),
    bytes = Uint8Array.from(a.script);
  if (
    bytes.length !== w.scriptLength ||
    a.state_layout.start !== w.stateLayout.start ||
    a.state_layout.len !== w.stateLayout.len ||
    hex(sha256(bytes)) !== w.scriptSha256 ||
    hex(
      templateHash(
        bytes.slice(0, w.stateLayout.start),
        bytes.slice(w.stateLayout.start + w.stateLayout.len),
      ),
    ) !== w.templateHash
  )
    throw new Error("wrapper template does not match the bundled profile");
  return a;
}

export function requireTokenCapability(
  profile: TokenProfile,
  operation: TokenOperation,
): void {
  if (!profile.operations.includes(operation))
    throw new Error(`KCC20 profile does not support ${operation}`);
  if (
    ["wrap", "unwrap", "trade"].includes(operation) &&
    (profile.fungibility !== "single-holder-class" ||
      !profile.ownerSchemes.includes(4) ||
      !profile.wrapper)
  ) {
    throw new Error("KCC20 profile does not support this trading operation");
  }
  if (["mint", "burn"].includes(operation) && !profile.nativeExtensions)
    throw new Error("external mint/burn adapter is unavailable");
}

/** Resolve the trading scale, enforcing profiles with a fixed precision. */
export function resolveTokenProfilePriceScale(
  profile: TokenProfile,
  requested: bigint | undefined,
  fallback: bigint,
): bigint {
  const expected =
    profile.displayDecimals === undefined
      ? undefined
      : 10n ** BigInt(profile.displayDecimals);
  if (expected !== undefined) {
    if (requested !== undefined && requested !== expected)
      throw new Error(
        "priceScale does not match token profile display precision",
      );
    return expected;
  }
  return requested ?? fallback;
}

/** Caller must authenticate the returned script against the source UTXO on chain. */
export function rebuildProfileToken(
  profile: TokenProfile,
  artifact: unknown,
  state: unknown,
): Uint8Array {
  return buildKcc20ScriptForState(
    authenticateTokenArtifact(profile, artifact),
    state,
  );
}

export interface TokenReadiness {
  status:
    | "needs_verification"
    | "blocked"
    | "queued"
    | "wrapper_indexing"
    | "imported";
  reasonCode: string | null;
  reason: string | null;
  profileId: string | null;
  standardRevision: string;
  capabilities: Partial<Record<TokenOperation, boolean>>;
}
/** One evaluator for import, token pages and wrapper scheduling; never authorizes signing. */
export function evaluateTokenReadiness(input: {
  profile?: TokenProfile | null;
  authenticated: boolean;
  tokenVerified: boolean;
  decimals?: number | null;
  singleHolderClass: boolean;
  wrapper: "missing" | "indexing" | "ready" | "blocked";
}): TokenReadiness {
  const p = input.profile;
  const result: TokenReadiness = {
    status: "blocked",
    reasonCode: null,
    reason: null,
    profileId: p?.id ?? null,
    standardRevision: KCC20_STANDARD_REVISION,
    capabilities: {},
  };
  const stop = (
    status: TokenReadiness["status"],
    code: string,
    reason: string,
  ) => ({ ...result, status, reasonCode: code, reason });
  if (!p)
    return stop(
      "blocked",
      "TOKEN_PROFILE_UNAVAILABLE",
      "Token contract template is unavailable.",
    );
  if (!input.authenticated)
    return stop(
      "blocked",
      "TOKEN_EVIDENCE_UNAVAILABLE",
      "Current token outputs have not been authenticated against the token template.",
    );
  if (!input.tokenVerified)
    return stop(
      "needs_verification",
      "TOKEN_VERIFICATION_REQUIRED",
      "Token identity has not been verified.",
    );
  for (const op of p.operations) {
    try {
      requireTokenCapability(p, op);
      result.capabilities[op] = true;
    } catch {
      result.capabilities[op] = false;
    }
  }
  if (!input.singleHolderClass || p.fungibility !== "single-holder-class")
    return stop(
      "blocked",
      "HOLDER_CLASS_UNSUPPORTED",
      "Token holder variants cannot share a trading market.",
    );
  if (
    !Number.isInteger(input.decimals) ||
    input.decimals! < 0 ||
    input.decimals! > 8
  )
    return stop(
      "blocked",
      "TRADING_PRECISION_UNSUPPORTED",
      "Trading requires verified token decimals between 0 and 8.",
    );
  if (p.displayDecimals !== undefined && input.decimals !== p.displayDecimals)
    return stop(
      "blocked",
      "TRADING_PRECISION_MISMATCH",
      "Trading precision does not match the token profile.",
    );
  if (
    !result.capabilities.wrap ||
    !result.capabilities.unwrap ||
    !result.capabilities.trade
  )
    return stop(
      "blocked",
      "TRADING_PROFILE_UNSUPPORTED",
      "Token template does not support wrap, trade and unwrap.",
    );
  if (input.wrapper === "blocked")
    return stop(
      "blocked",
      "WRAPPER_UNAVAILABLE",
      "The trading wrapper is unavailable.",
    );
  if (input.wrapper === "missing")
    return stop(
      "queued",
      "WRAPPER_REQUIRED",
      "Trading wrapper creation is required.",
    );
  if (input.wrapper === "indexing")
    return stop(
      "wrapper_indexing",
      "WRAPPER_INDEXING",
      "Trading wrapper is being indexed.",
    );
  return { ...result, status: "imported" };
}
