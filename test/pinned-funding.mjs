import assert from "node:assert/strict";
import ts from "typescript";
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
const source = ts.createSourceFile('engine.ts', engineSource, ts.ScriptTarget.Latest, true);
let selectionCount = 0;
function checkPins(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'selectFundingEntry') {
    selectionCount++;
    assert.equal(node.arguments.length, 4, `funding selection at ${source.getLineAndCharacterOfPosition(node.pos).line + 1} must forward its pin`);
    assert.match(node.arguments[3].getText(source).replace(/\s/g, ''), /^(?:request\.params\?|params)\.fundingOutpoint$/);
  }
  ts.forEachChild(node, checkPins);
}
checkPins(source);
assert.ok(selectionCount > 0, 'must inspect actual engine funding calls');

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

// Ordinary callers keep the existing largest-sufficient-output selection.
for (const pin of [undefined, null]) {
  assert.equal(selectFundingEntry(entries, 100000n, [], pin), first);
}
assert.equal(selectFundingEntry(entries, 100000n, [], second.outpoint), second);
assert.equal(selectFundingEntry(entries, 100000n, [], secondOutpoint.toUpperCase()), second);
assert.throws(() => selectFundingEntry(entries, 100000n, [], 'bad-pin'), /invalid/);
assert.throws(() => selectFundingEntry(entries, 100000n, [secondOutpoint], secondOutpoint), /unavailable/);
assert.equal(selectFundingEntry(entries, 100000n, [`${'a'.repeat(64)}:0`]), second);

const feeTicketRequest = (pin) => ({
  schema: 'kcc20-in-process-pskt-builder-input/v1',
  request: {
    builderKey: 'fee-ticket.deploy-root', network: 'testnet-10',
    owner: { walletAddress, kcc20Owner: '8'.repeat(64) },
    params: { utilityTokenId: '7'.repeat(64), utilityTokenAmount: '1000', ...(pin === undefined ? {} : { fundingOutpoint: pin }) },
  },
});
const normalBefore = await engine.build(feeTicketRequest());
assert.equal(JSON.parse(normalBefore.psktTransactionJson).inputs[0].transactionId, 'a'.repeat(64));
await engine.build(feeTicketRequest(second.outpoint));
const normalAfter = await engine.build(feeTicketRequest());
assert.equal(normalAfter.psktTransactionJson, normalBefore.psktTransactionJson, 'a pinned request must not change later unpinned requests');
await assert.rejects(engine.build(feeTicketRequest(`${'c'.repeat(64)}:0`)), /pinned funding UTXO.*unavailable/);
await assert.rejects(engine.build(feeTicketRequest('invalid')), /pinned funding outpoint is invalid/);
console.log('unpinned funding behavior and strict pin failures passed');
