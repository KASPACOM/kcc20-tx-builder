import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadPinnedKaspaWasm } from "./load-kaspa-wasm.mjs";
import {
  createKcc20PsktBuilderEngine,
  createKcomVestingPsktBuilder,
  kcomVestingCodec,
  templateParts,
  buildKcc20ScriptForState,
} from "../dist/index.js";
const require = createRequire(import.meta.url);
const artifact = JSON.parse(
    readFileSync(
      new URL("../artifacts/KCOMVesting.artifact.json", import.meta.url),
    ),
  ),
  canonical = JSON.parse(
    readFileSync(
      new URL("../artifacts/KCC20.placeholder.json", import.meta.url),
    ),
  );
const kw = await loadPinnedKaspaWasm(process.env.SNAPSHOT_TEST_WASM),
  codec = kcomVestingCodec(artifact),
  parts = templateParts(canonical);
assert.equal(
  require("../dist/cjs/index.js").KCOM_VESTING_ABI_SHA256,
  "c041dc0012f22390f1f66fd09c6cc02eadb8865f496684c96e22ed690004d9f0",
);
const walletAddress = new kw.PrivateKey("11".repeat(32))
  .toAddress("testnet-10")
  .toString();
const state = {
  token_id: "11".repeat(32),
  beneficiary: "33".repeat(32),
  beneficiary_scheme: 0,
  extension: "00".repeat(32),
  total: "100003",
  released: "0",
  tier: 1,
  tge_ms: "1800000000000",
  token_prefix_len: parts.prefix.length,
  token_suffix_len: parts.suffix.length,
  token_template_hash: Buffer.from(parts.hash).toString("hex"),
};
assert.throws(
  () =>
    kcomVestingCodec({
      ...artifact,
      sil_abi: { ...artifact.sil_abi, schema_version: 99 },
    }),
  /pin/,
);
for (const tier of [1, 2, 3]) {
  const s = { ...state, tier },
    first = tier === 1 ? 1 : tier === 2 ? 6 : 10,
    count = tier === 3 ? 36 : 18,
    upfront =
      (100003n * BigInt(tier === 1 ? 1000 : tier === 2 ? 500 : 0)) / 10000n;
  assert.equal(codec.availability(s, 1799999999999n).vested, 0n);
  assert.equal(codec.availability(s, 1800000000000n).vested, upfront);
  for (let n = 1; n <= count; n++) {
    const at = 1800000000000n + BigInt(first + n - 1) * 2592000000n;
    assert.equal(
      codec.availability(s, at).vested,
      upfront + ((100003n - upfront) * BigInt(n)) / BigInt(count),
    );
    assert.equal(codec.availability(s, at - 1n).completed, BigInt(n - 1));
  }
}
let marker = 1;
const entry = (script, cid, amount = 200000000n) => ({
  outpoint: {
    transactionId: (marker++).toString(16).padStart(64, "0"),
    index: 0,
  },
  amount,
  scriptPublicKey: script,
  blockDaaScore: 1n,
  isCoinbase: false,
  covenantId: cid,
  entry: { covenantId: cid },
});
const funding = entry(kw.payToAddressScript(walletAddress), null, 10000000000n),
  positionId = "22".repeat(32),
  position = entry(kw.payToScriptHashScript(codec.script(state)), positionId),
  tokenState = {
    amount: 100003n,
    owner: Buffer.from(positionId, "hex"),
    ownerScheme: 4,
    borrowScheme: 0,
    borrowGuard: new Uint8Array(32),
    extensionCommitment: new Uint8Array(32),
  },
  reserve = entry(
    kw.payToScriptHashScript(buildKcc20ScriptForState(canonical, tokenState)),
    state.token_id,
  );
const hex = (b) => Buffer.from(b).toString("hex");
const reserveState = {
  amount: "100003",
  owner: positionId,
  ownerScheme: 4,
  borrowScheme: 0,
  borrowGuard: "00".repeat(32),
  extensionCommitment: "00".repeat(32),
};
const entries = new Map([
  [
    walletAddress,
    [
      entry(
        kw.payToAddressScript(walletAddress),
        "55".repeat(32),
        20000000000n,
      ),
      funding,
    ],
  ],
  [
    kw
      .addressFromScriptPublicKey(position.scriptPublicKey, "testnet-10")
      .toString(),
    [position],
  ],
  [
    kw
      .addressFromScriptPublicKey(reserve.scriptPublicKey, "testnet-10")
      .toString(),
    [reserve],
  ],
]);
const rpc = {
  connect: async () => {},
  disconnect: async () => {},
  getBlockDagInfo: async () => ({ pastMedianTime: 2000000000000n }),
  getUtxosByAddresses: async (addresses) => ({
    entries: entries.get(addresses[0]) ?? [],
  }),
};
const build = createKcomVestingPsktBuilder({
  wasm: kw,
  artifacts: {
    "KCOMVesting.artifact.json": artifact,
    "KCC20.placeholder.json": canonical,
  },
  rpcClientFactory: () => rpc,
});
const input = (key, extra = {}) => ({
  schema: "kcc20-in-process-pskt-builder-input/v1",
  request: {
    builderKey: key,
    network: "testnet-10",
    owner: { walletAddress },
    params: {
      state,
      positionId,
      position: position.outpoint,
      reserve: { ...reserve.outpoint, state: reserveState },
      ...extra,
    },
  },
});
const deploy = await build(input("kcom-vesting.deploy"));
assert.equal(deploy.signInputs[0].index, 0);
assert.ok(deploy.metadata.positionId);
const engine = createKcc20PsktBuilderEngine({
  wasm: kw,
  artifacts: {
    "KCOMVesting.artifact.json": artifact,
    "KCC20.placeholder.json": canonical,
  },
  rpcClientFactory: () => rpc,
});
const integrated = await engine.build(input("kcom-vesting.deploy"));
const tx = kw.Transaction.deserializeFromSafeJSON(
  integrated.psktTransactionJson,
);
assert.equal(
  String(tx.inputs[0].previousOutpoint.transactionId),
  funding.outpoint.transactionId,
);
const fee = funding.amount - tx.outputs.reduce((n, o) => n + o.value, 0n);
assert.equal(fee, 60000000n, "engine must not deduct the fee twice");
const partial = await build(
  input("kcom-vesting.release", { amountRaw: "1000" }),
);
assert.equal(partial.signInputs[0].index, 2);
assert.equal(partial.metadata.releaseRaw, "1000");
const finish = await build(
  input("kcom-vesting.finish", { amountRaw: "100003" }),
);
assert.equal(finish.metadata.positionClosed, true);
assert.equal(finish.metadata.positionOutputIndex, null);
await assert.rejects(
  build(input("kcom-vesting.release", { amountRaw: "100004" })),
  /NOT_RELEASABLE/,
);
await assert.rejects(
  build({
    ...input("kcom-vesting.deploy"),
    request: { ...input("kcom-vesting.deploy").request, network: "mainnet" },
  }),
  /TN10/,
);
// Final closure preserves both covenant cells in the beneficiary output; it needs only fee funding.
entries.set(walletAddress, [{...funding, amount:100000000n}]);
const feeOnlyFinish = await build(input("kcom-vesting.finish", {amountRaw:"100003"}));
assert.equal(feeOnlyFinish.metadata.positionClosed,true);
entries.set(walletAddress,[funding]);
entries.set(
  kw
    .addressFromScriptPublicKey(position.scriptPublicKey, "testnet-10")
    .toString(),
  [],
);
await assert.rejects(
  build(input("kcom-vesting.release", { amountRaw: "1000" })),
  /SOURCE_STALE/,
);
console.log(
  "ok KCOM vesting ABI pins, monthly boundaries, ESM/CJS, deploy/partial/final PSKTs and stale source rejection",
);

assert.throws(() => codec.validate({...state,total:9007199254740992}), /Invalid/);
assert.equal(codec.availability({...state,released:"1"},1799999999999n).releasable,0n);
assert.equal(codec.availability(state,1799999999999n).nextTrancheMs,state.tge_ms);
