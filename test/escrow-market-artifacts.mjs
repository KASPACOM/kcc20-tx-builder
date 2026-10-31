import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildKcc20FeeMarketRoleScript,
  normalizeSilverScriptArtifact,
  prepareKcc20FeeMarketBinding,
  prepareKcc20FeeMarketGenesis,
  templateParts,
  verifyKcc20FeeMarketArtifacts,
} from "../dist/index.js";

const keys = {
  receipt: "KCC20FeeEscrowV1",
  root: "KCC20OrderbookFeeRootV1",
  holder: "KCC20OrderbookFeeHolderV1",
  ask: "KCC20OrderbookFeeAskV1",
  bid: "KCC20OrderbookFeeBidV1",
  ticket: "KCC20FeeTicket",
  wrapper: "KCC20WrapperFeeV1",
  argentWrapper: "KCC20WrapperFeeArgentV1",
};
const artifacts = Object.fromEntries(Object.entries(keys).map(([role, name]) => [
  role,
  JSON.parse(readFileSync(new URL(`../artifacts/${name}.placeholder.json`, import.meta.url))),
]));
const manifest = JSON.parse(readFileSync(new URL("../artifacts/KCC20FeePolicyV1.manifest.json", import.meta.url)));
const hex = bytes => Buffer.from(bytes).toString("hex");
const tuple = artifact => {
  const parts = templateParts(artifact);
  return { hash: hex(parts.hash), prefixLength: parts.prefixLength, suffixLength: parts.suffixLength };
};
const policy = {
  version: 1,
  creatorFeeBps: 0,
  protocolAccountId: "04".repeat(32),
  creatorAccountId: "00".repeat(32),
  ...Object.fromEntries(["receipt", "root", "holder", "ask", "bid", "ticket"]
    .map(role => [`${role}Template`, tuple(artifacts[role])])),
};

test("accepts pinned fee-market programs for both wrapper profiles", () => {
  for (const wrapperProfile of ["native", "argent"]) {
    const verified = verifyKcc20FeeMarketArtifacts({ policy, artifacts, wrapperProfile });
    assert.equal(hex(verified.root.hash), policy.rootTemplate.hash);
    assert.equal(hex(verified.wrapper.hash), tuple(artifacts[wrapperProfile === "native" ? "wrapper" : "argentWrapper"]).hash);
  }
});

test("rejects a policy that names another role template", () => {
  assert.throws(() => verifyKcc20FeeMarketArtifacts({
    policy: { ...policy, bidTemplate: policy.askTemplate }, artifacts, wrapperProfile: "native",
  }), /bid fee-market policy template mismatch/);
});

test("rejects artifact ABI changes even when the compiled script is unchanged", () => {
  const altered = structuredClone(artifacts);
  altered.root.abi[0].name = "differentEntry";
  assert.throws(() => verifyKcc20FeeMarketArtifacts({
    policy, artifacts: altered, wrapperProfile: "native",
  }), /root fee-market artifact metadata mismatch/);
});

test("renders exact pinned placeholder state for both wrappers and the root", () => {
  const wrapperState = {
    canonicalTokenId: "01".repeat(32), enabled: true, priceScale: "1",
    feeTicketId: "00".repeat(32), feePolicy: manifest.policyHex,
    authenticatedMarketId: "02".repeat(32),
  };
  for (const role of ["wrapper", "argentWrapper"]) {
    const rendered = buildKcc20FeeMarketRoleScript({ artifact: artifacts[role], role, state: wrapperState });
    assert.deepEqual(rendered.redeemScript, Uint8Array.from(normalizeSilverScriptArtifact(artifacts[role]).script));
  }
  const rootState = {
    canonicalTokenId: "01".repeat(32), owner: "07".repeat(32),
    owner_scheme: 0, amount: "0", mode: "1", unitPrice: "0",
    feeTicketId: "00".repeat(32), priceScale: "1", feePolicy: manifest.policyHex,
    payout_script_hash: "08".repeat(32), wrapper_spk_hash: "03".repeat(32),
  };
  const rendered = buildKcc20FeeMarketRoleScript({ artifact: artifacts.root, role: "root", state: rootState });
  assert.deepEqual(rendered.redeemScript, Uint8Array.from(normalizeSilverScriptArtifact(artifacts.root).script));
});

test("requires a complete canonical wrapper state", () => {
  const state = { canonicalTokenId: "01".repeat(32) };
  assert.throws(() => buildKcc20FeeMarketRoleScript({
    artifact: artifacts.wrapper, role: "wrapper", state,
  }), /runtime state fields mismatch/);
});

test("market setup separates genesis ID from the bound root script", () => {
  const input = {
    tokenId: "01".repeat(32), feeTicketId: "00".repeat(32), priceScale: 1n,
    policy, wrapperProfile: "native", artifacts,
  };
  const genesis = prepareKcc20FeeMarketGenesis(input);
  assert.equal(genesis.state.enabled, false);
  assert.equal(genesis.state.authenticatedMarketId, "00".repeat(32));
  const bound = prepareKcc20FeeMarketBinding({
    ...input, marketId: "02".repeat(32), rootOwner: "07".repeat(32),
    rootOwnerScheme: 0, rootPayoutScriptHash: "08".repeat(32),
  });
  assert.equal(bound.rootState.wrapper_spk_hash, bound.wrapper.scriptHash);
  assert.notEqual(bound.wrapper.scriptHash, genesis.wrapper.scriptHash);
  assert.equal(bound.rootState.feePolicy, genesis.state.feePolicy);
});

test("Argent market setup rejects unsupported creator fees", () => {
  assert.throws(() => prepareKcc20FeeMarketGenesis({
    tokenId: "01".repeat(32), feeTicketId: "00".repeat(32), priceScale: 1n,
    policy: { ...policy, creatorFeeBps: 100, creatorAccountId: "05".repeat(32) },
    wrapperProfile: "argent", artifacts,
  }), /cannot authorize creator fees/);
});

test("market setup rejects unknown wrapper profiles", () => {
  assert.throws(() => prepareKcc20FeeMarketGenesis({
    tokenId: "01".repeat(32), feeTicketId: "00".repeat(32), priceScale: 1n,
    policy, wrapperProfile: "unknown", artifacts,
  }), /unsupported fee-market wrapper profile/);
});
