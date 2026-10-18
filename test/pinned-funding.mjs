import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { selectFundingEntry } from "../dist/sale-common.js";
import { createKcc20PsktBuilderEngine, KCC20_CURRENT_NATIVE_ARTIFACT_KEY } from "../dist/index.js";
import { loadPinnedKaspaWasm } from "./load-kaspa-wasm.mjs";

const first = { outpoint: { transactionId: "a".repeat(64), index: 0 }, amount: "900000000" };
const second = { outpoint: { transactionId: "b".repeat(64), index: 1 }, amount: "800000000" };
const entries = [first, second];
const secondOutpoint = `${"b".repeat(64)}:1`;

assert.equal(selectFundingEntry(entries, 100000n), first);
assert.equal(selectFundingEntry(entries, 100000n, [], secondOutpoint), second);
assert.throws(
  () => selectFundingEntry(entries, 900000000n, [], secondOutpoint),
  /pinned funding UTXO .* cannot cover/,
);
assert.throws(
  () => selectFundingEntry([first], 100000n, [], secondOutpoint),
  /pinned funding UTXO .* unavailable/,
);

const engineSource = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");
const selections = engineSource.match(/selectFundingEntry\(/g) ?? [];
const pins = engineSource.match(/(?:request\.params\?|params)\.fundingOutpoint/g) ?? [];
assert.equal(pins.length, selections.length, "every engine funding selection must honor the requested outpoint");

// Exercise a full engine build with two eligible UTXOs. The larger first
// output must not be selected when the second output is pinned.
const wasm = await loadPinnedKaspaWasm(fileURLToPath(new URL("../examples/vendor/kaspa", import.meta.url)));
const walletScript = new wasm.ScriptPublicKey(0, `20${"9".repeat(64)}ac`);
const walletAddress = wasm.addressFromScriptPublicKey(walletScript, "testnet-10").toString();
const walletEntries = [first, second].map((entry) => ({
  ...entry,
  amount: 3000000000n,
  scriptPublicKey: walletScript,
  blockDaaScore: 1n,
  isCoinbase: false,
}));
const artifact = JSON.parse(readFileSync(new URL(`../artifacts/${KCC20_CURRENT_NATIVE_ARTIFACT_KEY}`, import.meta.url), "utf8"));
const feeTicketArtifact = JSON.parse(readFileSync(new URL("../artifacts/KCC20FeeTicket.placeholder.json", import.meta.url), "utf8"));
const engine = createKcc20PsktBuilderEngine({
  wasm,
  artifacts: {
    [KCC20_CURRENT_NATIVE_ARTIFACT_KEY]: artifact,
    "KCC20FeeTicket.placeholder.json": feeTicketArtifact,
  },
  sourceProvider: { getUtxosByAddresses: async () => ({ entries: walletEntries }) },
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
assert.equal(builtTransaction.inputs[0].transactionId.toLowerCase(), "b".repeat(64));
assert.equal(builtTransaction.inputs[0].index, 1);

const feeTicket = await engine.build({
  schema: "kcc20-in-process-pskt-builder-input/v1",
  request: {
    builderKey: "fee-ticket.deploy-root",
    network: "testnet-10",
    owner: { walletAddress, kcc20Owner: "8".repeat(64) },
    params: {
      utilityTokenId: "7".repeat(64),
      utilityTokenAmount: "1000",
      fundingOutpoint: secondOutpoint,
    },
  },
});
const feeTicketTransaction = JSON.parse(feeTicket.psktTransactionJson);
assert.equal(feeTicketTransaction.inputs[0].transactionId.toLowerCase(), "b".repeat(64));
assert.equal(feeTicketTransaction.inputs[0].index, 1);
console.log("pinned wallet funding selection passed");
