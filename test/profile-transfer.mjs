import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as kw from "../examples/vendor/kaspa/kaspa.js";
import { blake3 } from "@noble/hashes/blake3";
import {
  buildProfileTransferTransaction,
  BUNDLED_TOKEN_PROFILES,
  buildKcc20ScriptForState,
  tokenPublicKeyHash,
  ownerNativeHolderUtxos,
  canonicalRegistryJson,
} from "../dist/index.js";
kw.initSync(
  await readFile(
    new URL("../examples/vendor/kaspa/kaspa_bg.wasm", import.meta.url),
  ),
);
const hex = (b) => Buffer.from(b).toString("hex"),
    bytes = (n) => new Uint8Array(32).fill(n),
    digest = (value) =>
      createHash("sha256").update(canonicalRegistryJson(value)).digest("hex");
const key = new kw.PrivateKey("03".padStart(64, "0")),
  pub = key.toKeypair().xOnlyPublicKey.toString();
const wallet = key.toAddress("testnet-10").toString(),
  walletSpk = kw.payToAddressScript(wallet);
const tokenId = "aa".repeat(32);
const entry = (marker, script, covenantId) => ({
  outpoint: { transactionId: marker.repeat(32), index: 0 },
  amount: 100_000_000n,
  scriptPublicKey: script,
  blockDaaScore: 0n,
  isCoinbase: false,
  ...(covenantId ? { covenantId } : {}),
});
for (const candidate of BUNDLED_TOKEN_PROFILES.profiles) {
  const manifest = structuredClone(BUNDLED_TOKEN_PROFILES),
    profile = manifest.profiles.find((entry) => entry.id === candidate.id);
  profile.review = { status: "approved", evidence: ["offline-test-only"] };
  const tokenProfileRegistry = { manifest, sha256: digest(manifest) };
  const artifact = JSON.parse(
    await readFile(
      new URL("../artifacts/" + candidate.artifactKey, import.meta.url),
    ),
  );
  for (const scheme of [0, 1, 2, 3, 4]) {
    const publicKey = scheme === 2 ? "02" + pub : pub;
    const authoritySpk = kw.payToScriptHashScript(Uint8Array.of(0x51));
    const state = {
      amount: 100n,
      owner:
        scheme === 0
          ? Buffer.from(pub, "hex")
          : scheme <= 2
            ? tokenPublicKeyHash(Buffer.from(publicKey, "hex"))
            : scheme === 3
              ? Buffer.from(authoritySpk.script.slice(4, 68), "hex")
              : bytes(0xbb),
      ownerScheme: scheme,
      borrowScheme: 0,
      borrowGuard: bytes(0),
      extensionCommitment: bytes(0xcc),
    };
    const source = entry(
      "11",
      kw.payToScriptHashScript(buildKcc20ScriptForState(artifact, state)),
      tokenId,
    );
    const plan = {
      tokenProfileRegistry,
      profileId: profile.id,
      artifact,
      tokenInputs: [
        { entry: source, state, publicKey, authorityInputIndex: 1 },
      ],
      nextStates: [
        { ...state, owner: Buffer.from(pub, "hex"), ownerScheme: 0 },
      ],
      authorities:
        scheme >= 3
          ? [
              {
                entry: entry(
                  "22",
                  authoritySpk,
                  scheme === 4 ? "bb".repeat(32) : undefined,
                ),
                revealScript: Uint8Array.of(0x51),
                arguments: [],
              },
            ]
          : [],
      fundingEntry: entry("33", walletSpk),
      fundingAddress: wallet,
      feeSompi: 10000n,
      network: "testnet-10",
      capabilities: { schnorr: true, ecdsa: true },
      mode: "owner",
    };
    const result = buildProfileTransferTransaction(kw, plan),
      tx = JSON.parse(result.psktTransactionJson);
    assert.equal(tx.outputs[0].covenant.covenantId, tokenId);
    assert.equal(result.signInputs[0].index, scheme >= 3 ? 2 : 1);
    assert.throws(
      () =>
        buildProfileTransferTransaction(kw, {
          ...plan,
          tokenProfileRegistry: undefined,
          profile: {
            ...candidate,
            review: { status: "approved", evidence: ["caller-controlled"] },
          },
        }),
      /digest mismatch/,
    );
    const changedManifest = structuredClone(manifest);
    changedManifest.profiles.find((entry) => entry.id === candidate.id).review = {
      status: "approved",
      evidence: ["changed-after-authentication"],
    };
    assert.throws(
      () =>
        buildProfileTransferTransaction(kw, {
          ...plan,
          tokenProfileRegistry: {
            manifest: changedManifest,
            sha256: tokenProfileRegistry.sha256,
          },
        }),
      /digest mismatch/,
    );
    assert.throws(
      () =>
        buildProfileTransferTransaction(kw, {
          ...plan,
          nextStates: [{ ...plan.nextStates[0], amount: 101n }],
        }),
      /conservation/,
    );
    assert.throws(
      () =>
        buildProfileTransferTransaction(kw, { ...plan, fundingEntry: source }),
      /duplicate/,
    );
    if (scheme >= 3)
      assert.throws(
        () => buildProfileTransferTransaction(kw, { ...plan, authorities: [] }),
        /authority/,
      );
    else
      assert.throws(
        () =>
          buildProfileTransferTransaction(kw, {
            ...plan,
            capabilities: { schnorr: false, ecdsa: false },
          }),
        /wallet/,
      );
  }
  // Borrow leader and owner-signed sender share one covenant family.
  const guard = bytes(0x44),
    current = blake3(Uint8Array.from([...guard, ...Buffer.from(pub, "hex")]));
  const leader = {
    amount: 100n,
    owner: bytes(0xbb),
    ownerScheme: 4,
    borrowScheme: 3,
    borrowGuard: current,
    extensionCommitment: bytes(0xcc),
  };
  const sender = {
    ...leader,
    amount: 1n,
    owner: Buffer.from(pub, "hex"),
    ownerScheme: 0,
    borrowScheme: 0,
    borrowGuard: bytes(0),
  };
  const plan = {
    tokenProfileRegistry,
    profileId: profile.id,
    artifact,
    tokenInputs: [leader, sender].map((state, i) => ({
      state,
      entry: entry(
        i ? "22" : "11",
        kw.payToScriptHashScript(buildKcc20ScriptForState(artifact, state)),
        tokenId,
      ),
      publicKey: pub,
    })),
    nextStates: [{ ...leader, amount: 101n, borrowGuard: guard }],
    fundingEntry: entry("33", walletSpk),
    fundingAddress: wallet,
    feeSompi: 10000n,
    tokenOutputSompi: 100_000_000n,
    network: "testnet-10",
    capabilities: { schnorr: true, ecdsa: false },
    mode: "borrow",
    borrow: {
      nextGuard: hex(guard),
      oneTimePublicKey: pub,
      signingPublicKey: pub,
    },
  };
  const built = buildProfileTransferTransaction(kw, plan);
  assert.equal(
    built.scripts[0].signatureScript.args[6].prefixHex,
    "01" + hex(guard) + pub,
  );
  assert.equal(built.scripts[1].signatureScript.args[0].prefixHex, "");
  assert.throws(
    () =>
      buildProfileTransferTransaction(kw, {
        ...plan,
        borrow: { ...plan.borrow, nextGuard: hex(bytes(3)) },
      }),
    /guard/,
  );
  assert.throws(
    () => buildProfileTransferTransaction(kw, { ...plan, mode: "owner" }),
    /authority/,
  );
}
const hashed = hex(tokenPublicKeyHash(Buffer.from(pub, "hex")));
assert.equal(
  ownerNativeHolderUtxos(
    [{ state: { amount: "1", ownerScheme: 1, ownerIdentifier: hashed } }],
    pub,
  ).length,
  1,
);
assert.equal(
  ownerNativeHolderUtxos(
    [{ state: { amount: "1", ownerScheme: 1, ownerIdentifier: pub } }],
    pub,
  ).length,
  0,
);
console.log(
  "Native and independent transfers: all owner schemes, explicit authority inputs, borrow leader/delegator, and rejection cases passed",
);
