import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectFundingEntry } from "../dist/sale-common.js";

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

const engine = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");
const selections = engine.match(/selectFundingEntry\(/g) ?? [];
const pins = engine.match(/(?:request\.params\?|params)\.fundingOutpoint/g) ?? [];
assert.equal(pins.length, selections.length, "every engine funding selection must honor the requested outpoint");
console.log("pinned wallet funding selection passed");
