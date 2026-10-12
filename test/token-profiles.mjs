import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { blake3 } from "@noble/hashes/blake3";
import {
  BUNDLED_TOKEN_PROFILES,
  BUNDLED_TOKEN_PROFILE_DIGEST,
  validateTokenProfileRegistry,
  authenticateTokenArtifact,
  authenticateTokenWrapper,
  requireTokenCapability,
  evaluateTokenReadiness,
  resolveTokenProfilePriceScale,
  canonicalRegistryJson,
  planTokenOwnerWitness,
  tokenPublicKeyHash,
  buildTokenBorrowWitness,
  buildAuthenticatedKcc20TransferPayload,
} from "../dist/index.js";
const digest = (x) =>
  createHash("sha256").update(canonicalRegistryJson(x)).digest("hex");
const registry = validateTokenProfileRegistry(
  BUNDLED_TOKEN_PROFILES,
  BUNDLED_TOKEN_PROFILE_DIGEST,
);
assert(Object.isFrozen(registry.profiles[0]));
const candidate = registry.profiles[0];
const artifact = JSON.parse(
  await readFile(
    new URL("../artifacts/" + candidate.artifactKey, import.meta.url),
  ),
);
authenticateTokenArtifact(candidate, artifact);
for (const profile of registry.profiles) {
  const wrapper = JSON.parse(
    await readFile(
      new URL("../artifacts/" + profile.wrapper.artifactKey, import.meta.url),
    ),
  );
  authenticateTokenWrapper(profile, wrapper);
  const changedWrapper = structuredClone(wrapper);
  changedWrapper.abi[0].name = "malicious";
  assert.throws(
    () => authenticateTokenWrapper(profile, changedWrapper),
    /approved profile/,
  );
}
assert.throws(
  () => requireTokenCapability(candidate, "transfer"),
  /awaiting review/,
);
const changed = structuredClone(BUNDLED_TOKEN_PROFILES);
changed.profiles[0].review.status = "approved";
assert.throws(
  () => validateTokenProfileRegistry(changed, BUNDLED_TOKEN_PROFILE_DIGEST),
  /digest mismatch/,
);
assert.throws(
  () => validateTokenProfileRegistry(changed, digest(changed)),
  /invalid/,
);
const duplicate = structuredClone(BUNDLED_TOKEN_PROFILES);
duplicate.profiles.push(duplicate.profiles[0]);
assert.throws(
  () => validateTokenProfileRegistry(duplicate, digest(duplicate)),
  /duplicate/,
);
const altered = structuredClone(artifact);
altered.abi[0].name = "malicious";
assert.throws(
  () => authenticateTokenArtifact(candidate, altered),
  /ABI or metadata/,
);
// Approval here belongs only to this offline test. The shipped manifest stays a candidate.
const approved = {
  ...candidate,
  review: { status: "approved", evidence: ["offline-test-fixture"] },
  fundedTradingVerified: true,
};
const base = {
  profile: approved,
  authenticated: true,
  tokenVerified: true,
  decimals: 8,
  singleHolderClass: true,
  wrapper: "ready",
};
assert.equal(evaluateTokenReadiness(base).status, "imported");
for (const [input, code] of [
  [{ profile: undefined }, "TEMPLATE_REVIEW_REQUIRED"],
  [{ profile: candidate }, "TEMPLATE_REVIEW_REQUIRED"],
  [{ authenticated: false }, "TOKEN_EVIDENCE_UNAVAILABLE"],
  [{ singleHolderClass: false }, "HOLDER_CLASS_UNSUPPORTED"],
  [{ decimals: 9 }, "TRADING_PRECISION_UNSUPPORTED"],
  [{ wrapper: "indexing" }, "WRAPPER_INDEXING"],
  [
    { profile: { ...approved, fundedTradingVerified: false } },
    "TRADING_PROFILE_UNVERIFIED",
  ],
  [{ tokenVerified: false }, "TOKEN_VERIFICATION_REQUIRED"],
])
  assert.equal(evaluateTokenReadiness({ ...base, ...input }).reasonCode, code);
assert.equal(
  evaluateTokenReadiness({ ...base, wrapper: "missing" }).status,
  "queued",
);
assert.throws(
  () =>
    requireTokenCapability({ ...approved, nativeExtensions: false }, "mint"),
  /adapter/,
);
const key = "11".repeat(32),
  key33 = "02" + key;
const owner = (scheme) =>
  scheme === 0
    ? key
    : Buffer.from(
        tokenPublicKeyHash(Buffer.from(scheme === 2 ? key33 : key, "hex")),
      ).toString("hex");
for (const scheme of [0, 1, 2]) {
  const plan = planTokenOwnerWitness({
    profile: approved,
    owner: owner(scheme),
    ownerScheme: scheme,
    publicKey: scheme === 2 ? key33 : key,
    capabilities: { schnorr: true, ecdsa: true },
    role: "leader",
  });
  assert.equal(
    plan.argument.prefixHex,
    "00" + (scheme === 0 ? "" : scheme === 2 ? key33 : key),
  );
  assert.equal(plan.signatureAlgorithm, scheme === 2 ? "ecdsa" : "schnorr");
  assert.throws(
    () =>
      planTokenOwnerWitness({
        profile: approved,
        owner: owner(scheme),
        ownerScheme: scheme,
        publicKey: key,
        capabilities: { schnorr: false, ecdsa: false },
        role: "leader",
      }),
    /wallet does not support/,
  );
}
for (const scheme of [1, 2]) {
  const publicKey = scheme === 2 ? key33 : key,
    stateOwner = owner(scheme),
    payload = JSON.parse(
      new TextDecoder().decode(
        buildAuthenticatedKcc20TransferPayload({
          covenantId: "aa".repeat(32),
          fromOwnerIdentifier: stateOwner,
          recipientOwner: "bb".repeat(32),
          recipientOwnerScheme: 0,
          tokenAmount: 1n,
        }),
      ),
    ),
    fromOwner = payload.tn12.args.find((arg) => arg.name === "fromOwner");
  assert.equal(fromOwner.value, stateOwner);
  assert.notEqual(fromOwner.value, publicKey);
}
for (const scheme of [3, 4]) {
  const auth = {
    index: 2,
    scriptPublicKeyHex: "aa20" + key + "87",
    covenantId: key,
  };
  const request = {
    profile: approved,
    owner: key,
    ownerScheme: scheme,
    capabilities: { schnorr: false, ecdsa: false },
    role: "leader",
    authorityInputIndex: 2,
    authorityInputs: [auth],
  };
  assert.equal(
    planTokenOwnerWitness(request).argument.hex,
    scheme === 3 ? "0002" : "00",
  );
  assert.throws(
    () => planTokenOwnerWitness({ ...request, authorityInputs: [] }),
    /missing/,
  );
  assert.throws(
    () => planTokenOwnerWitness({ ...request, owner: "22".repeat(32) }),
    /does not match/,
  );
}
const guard = "22".repeat(32),
  signature = "33".repeat(64) + "01";
const current = Buffer.from(blake3(Buffer.from(guard + key, "hex"))).toString(
  "hex",
);
const borrow = {
  profile: approved,
  borrowScheme: 3,
  currentGuard: current,
  nextGuard: guard,
  oneTimePublicKey: key,
  signature,
};
assert.equal(buildTokenBorrowWitness(borrow).length, 130);
assert.throws(
  () => buildTokenBorrowWitness({ ...borrow, signature: "33".repeat(32) }),
  /signature/,
);
assert.throws(
  () => buildTokenBorrowWitness({ ...borrow, nextGuard: "44".repeat(32) }),
  /link/,
);
assert.throws(
  () => buildTokenBorrowWitness({ ...borrow, borrowScheme: 0 }),
  /disabled/,
);
console.log(
  "Token profiles: integrity, readiness, all owner witness schemes and explicit borrow checks passed",
);
const independent = registry.profiles.find(
  (p) => p.id === "argent-reference-kcc20-v1",
);
assert(independent && !independent.nativeExtensions);
const approvedIndependent = {
  ...independent,
  review: { status: "approved", evidence: ["offline-test"] },
  fundedTradingVerified: true,
};
assert.equal(
  evaluateTokenReadiness({
    ...base,
    profile: approvedIndependent,
    decimals: 8,
  }).reasonCode,
  "TRADING_PRECISION_MISMATCH",
);
assert.equal(
  evaluateTokenReadiness({
    ...base,
    profile: approvedIndependent,
    decimals: 0,
  }).status,
  "imported",
);
assert.equal(resolveTokenProfilePriceScale(approvedIndependent, undefined, 100_000_000n), 1n);
assert.throws(
  () => resolveTokenProfilePriceScale(approvedIndependent, 100_000_000n, 100_000_000n),
  /display precision/,
);
const externalArtifact = JSON.parse(
  await readFile(
    new URL("../artifacts/" + independent.artifactKey, import.meta.url),
  ),
);
authenticateTokenArtifact(independent, externalArtifact);
assert.notEqual(independent.scriptLength, candidate.scriptLength);
assert.notEqual(independent.stateLayout.start, candidate.stateLayout.start);
assert.equal(independent.maxTokenInputs, 3);
assert.throws(() => requireTokenCapability(independent, "transfer"), /review/);
assert.throws(
  () =>
    requireTokenCapability(
      {
        ...independent,
        review: { status: "approved", evidence: ["offline-test"] },
      },
      "mint",
    ),
  /does not support/,
);
console.log(
  "Independent Argent artifact authenticates with separate bounds and no mint/trading authority",
);
