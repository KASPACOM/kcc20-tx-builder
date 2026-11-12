import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createKcc20PsktBuilderEngine,
  KCC20_CURRENT_NATIVE_ARTIFACT_KEY,
} from "../dist/index.js";
import { loadPinnedKaspaWasm } from "./load-kaspa-wasm.mjs";
const first = { outpoint: { transactionId: "a".repeat(64), index: 0 } };
const second = { outpoint: { transactionId: "b".repeat(64), index: 1 } };
const secondOutpoint = `${"b".repeat(64)}:1`;
const wasm = await loadPinnedKaspaWasm(
  fileURLToPath(new URL("../examples/vendor/kaspa", import.meta.url)),
);
const walletScript = new wasm.ScriptPublicKey(0, `20${"9".repeat(64)}ac`);
const walletAddress = wasm
  .addressFromScriptPublicKey(walletScript, "testnet-10")
  .toString();
const walletEntries = [first, second].map((entry) => ({
  ...entry,
  amount: 3000000000n,
  scriptPublicKey: walletScript,
  blockDaaScore: 1n,
  isCoinbase: false,
}));
const artifact = JSON.parse(
  readFileSync(
    new URL(
      `../artifacts/${KCC20_CURRENT_NATIVE_ARTIFACT_KEY}`,
      import.meta.url,
    ),
    "utf8",
  ),
);
const feeTicketArtifact = JSON.parse(
  readFileSync(
    new URL("../artifacts/KCC20FeeTicket.placeholder.json", import.meta.url),
    "utf8",
  ),
);
const engine = createKcc20PsktBuilderEngine({
  wasm,
  networkFeeQuote: {
    network: "testnet-10",
    source: "fixture",
    observedAtMs: Date.now(),
    tier: "priority",
    sompiPerNormalizedMass: "250",
  },
  artifacts: {
    [KCC20_CURRENT_NATIVE_ARTIFACT_KEY]: artifact,
    "KCC20FeeTicket.placeholder.json": feeTicketArtifact,
  },
  sourceProvider: {
    getUtxosByAddresses: async () => ({ entries: walletEntries }),
  },
});
const built = await engine.build({
  schema: "kcc20-in-process-pskt-builder-input/v1",
  request: {
    builderKey: "kcc20.deploy-token",
    network: "testnet-10",
    owner: { walletAddress, kcc20Owner: "8".repeat(64) },
    params: {
      ticker: "PINTEST",
      tokenName: "Pinned funding test",
      maxSupply: "1000",
      premintSupply: "1000",
      decimals: "0",
      mintPolicy: "fixed",
      fundingOutpoint: secondOutpoint,
    },
  },
});
const builtTransaction = JSON.parse(built.psktTransactionJson);
assert.equal(
  builtTransaction.inputs[0].transactionId.toLowerCase(),
  "b".repeat(64),
);
assert.equal(builtTransaction.inputs[0].index, 1);

const p = engine.protocol;
const tx = wasm.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
const storage = p.calculateToccataStorageMass(tx, "regression");
const paid =
  builtTransaction.inputs.reduce((n, i) => n + BigInt(i.utxo.amount), 0n) -
  builtTransaction.outputs.reduce((n, o) => n + BigInt(o.value), 0n);
assert.ok(
  paid >= storage * 250n,
  `priority fee underpaid: ${paid}, storage ${storage}`,
);
console.log("deployment priority fee regression passed", String(paid));

// Captured signed transactions. Input amount is reconstructed from outputs plus
// the node-reported fee; the funding script is their same-wallet change script.
const captures = JSON.parse(
  readFileSync(
    new URL("./fixtures/priority-deployments.json", import.meta.url),
  ),
);
for (const fixture of captures) {
  const captured = wasm.Transaction.deserializeFromSafeJSON(
    JSON.stringify(fixture.transaction),
  );
  const non = p.calculateToccataV1NonContextualMass(
    captured,
    "captured deployment",
  );
  const storage = p.calculateToccataStorageMass(
    captured,
    "captured deployment",
  );
  assert.equal(storage, 280000n);
  assert.ok(non.computeMass >= 7800n && non.computeMass < 8000n);
  assert.throws(
    () =>
      engine.verifySignedNetworkFee(
        JSON.stringify(fixture.transaction),
        built.networkFee.quote,
      ),
    /priority fee/,
  );
}
const priced = engine.verifySignedNetworkFee(
  built.psktTransactionJson,
  built.networkFee.quote,
);
assert.equal(priced.paidFeeSompi, String(paid));
const underpaid = structuredClone(builtTransaction);
underpaid.outputs.at(-1).value = String(
  BigInt(underpaid.outputs.at(-1).value) + paid - 1n,
);
assert.throws(
  () =>
    engine.verifySignedNetworkFee(
      JSON.stringify(underpaid),
      built.networkFee.quote,
    ),
  /priority fee/,
);
console.log("captured deployment mass and underpayment regressions passed");

const overpaid = structuredClone(builtTransaction);
overpaid.outputs.at(-1).value = String(
  BigInt(overpaid.outputs.at(-1).value) - 10000000n,
);
const repriced = p.transactionWithCalculatedFeeChange(
  wasm,
  wasm.Transaction.deserializeFromSafeJSON(JSON.stringify(overpaid)),
  overpaid.outputs.length - 1,
  "testnet-10",
  "remove obsolete fixed fee floor",
);
assert.deepEqual(
  JSON.parse(repriced.serializeToSafeJSON()).outputs,
  builtTransaction.outputs,
  "old fixed fee surplus returns only to funding change",
);
