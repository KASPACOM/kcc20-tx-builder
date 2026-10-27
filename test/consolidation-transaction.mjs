// Deterministic test keys and RPC fixtures. No network or broadcasts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import * as kw from "../examples/vendor/kaspa/kaspa.js";
import {
  buildKcc20TransferSigScript,
  buildKcc20TransferDelegatorSigScript,
} from "../dist/abi.js";
import {
  createKcc20PsktBuilderEngine,
  BUNDLED_TOKEN_PROFILES,
  buildKcc20ScriptForState,
} from "../dist/index.js";
kw.initSync({
  module: await readFile(
    new URL("../examples/vendor/kaspa/kaspa_bg.wasm", import.meta.url),
  ),
});
const key = new kw.PrivateKey("03".padStart(64, "0"));
const owner = key.toKeypair().xOnlyPublicKey.toString();
const wallet = key.toAddress("testnet-10").toString();
const cid = "aa".repeat(32);
const hex = (x) => Buffer.from(x).toString("hex");
const artifactFor = async (key) =>
  JSON.parse(await readFile(new URL("../artifacts/" + key, import.meta.url)));
const outpoint = (i) => ({
  transactionId: i.toString(16).padStart(64, "0"),
  index: 0,
});
const entry = (i, scriptPublicKey, amount, covenantId) => ({
  outpoint: outpoint(i),
  amount,
  scriptPublicKey,
  blockDaaScore: 0n,
  isCoinbase: false,
  ...(covenantId ? { covenantId } : {}),
});
const emitted = [];
async function fixture(profile, count, mutate = () => {}) {
  const artifact = await artifactFor(profile.artifactKey);
  const states = Array.from({ length: count }, (_, i) => ({
    amount: BigInt(101 + i),
    owner: Buffer.from(owner, "hex"),
    ownerScheme: 0,
    borrowScheme: 0,
    borrowGuard: new Uint8Array(32),
    extensionCommitment: new Uint8Array(32).fill(0x44),
  }));
  const sources = states.map((s, i) => {
    const script = buildKcc20ScriptForState(artifact, s),
      spk = kw.payToScriptHashScript(script);
    return {
      script,
      entry: entry(i + 1, spk, 100_000_000n, cid),
      indexed: {
        txidHex: outpoint(i + 1).transactionId,
        vout: 0,
        address: kw.addressFromScriptPublicKey(spk, "testnet-10").toString(),
        amountSompi: "100000000",
        covenantId: cid,
        state: {
          ...s,
          amount: String(s.amount),
          owner,
          ownerIdentifier: owner,
          borrowGuard: hex(s.borrowGuard),
          extensionCommitment: hex(s.extensionCommitment),
        },
      },
    };
  });
  const funding = entry(100, kw.payToAddressScript(wallet), 1_000_000_000n);
  const request = {
    schema: "kcc20-in-process-pskt-builder-input/v1",
    request: {
      builderKey: "kcc20.consolidate-holders",
      network: "testnet-10",
      owner: { walletAddress: wallet, kcc20Owner: owner },
      params: {
        covenantId: cid,
        activeHolderUtxos: sources.map((s) => s.indexed),
      },
    },
  };
  let calls = 0;
  const fundingEntries = [funding];
  mutate({ request, sources, states, funding, fundingEntries });
  const engine = createKcc20PsktBuilderEngine({
    wasm: kw,
    artifacts: {},
    artifactProvider: artifactFor,
    rpcClientFactory: () => ({
      connect: async () => {},
      disconnect: async () => {},
      getUtxosByAddresses: async ({ addresses }) => {
        calls++;
        return {
          entries: addresses.includes(wallet)
            ? fundingEntries
            : sources
                .filter((s) => addresses.includes(s.indexed.address))
                .map((s) => s.entry),
        };
      },
    }),
  });
  return {
    engine,
    request,
    sources,
    states,
    artifact,
    funding,
    calls: () => calls,
  };
}
test('native consolidation pins the smaller funding output without changing unpinned requests', async () => {
  const f = await fixture(BUNDLED_TOKEN_PROFILES.profiles.find(p => p.maxTokenInputs === 8), 8, ({ fundingEntries, funding }) => {
    fundingEntries.push({ ...funding, outpoint: outpoint(101), amount: 500_000_000n });
  });
  const normal = await f.engine.build(f.request);
  assert.equal(JSON.parse(normal.psktTransactionJson).inputs[8].transactionId, outpoint(100).transactionId);
  f.request.request.params.fundingOutpoint = `${outpoint(101).transactionId}:0`;
  const pinned = await f.engine.build(f.request);
  const pinnedJson = JSON.parse(pinned.psktTransactionJson);
  assert.equal(pinnedJson.inputs[8].transactionId, outpoint(101).transactionId);
  assert.deepEqual(pinned.signInputs, [{ index: 8, sighashType: 1 }]);
  assert.deepEqual(pinnedJson.inputs.slice(0, 8), JSON.parse(normal.psktTransactionJson).inputs.slice(0, 8));
  f.request.request.params.fundingOutpoint = `${outpoint(102).transactionId}:0`;
  await assert.rejects(f.engine.build(f.request), /pinned funding UTXO.*unavailable/);
  delete f.request.request.params.fundingOutpoint;
  assert.equal((await f.engine.build(f.request)).psktTransactionJson, normal.psktTransactionJson);
});

for (const profile of BUNDLED_TOKEN_PROFILES.profiles) {
  for (const count of Array.from(
    { length: profile.maxTokenInputs - 1 },
    (_, i) => i + 2,
  ))
    test(`${profile.id}: builds and signs ${count} input consolidation`, async () => {
      const f = await fixture(profile, count);
      const built = await f.engine.build(f.request);
      const tx = kw.Transaction.deserializeFromSafeJSON(
        built.psktTransactionJson,
      );
      const json = JSON.parse(built.psktTransactionJson);
      const sum = f.states.reduce((a, s) => a + s.amount, 0n);
      assert.equal(built.metadata.tokenAmount, String(sum));
      assert.equal(json.inputs.length, count + 1);
      assert.equal(built.scripts.length, count);
      assert.deepEqual(built.signInputs, [{ index: count, sighashType: 1 }]);
      assert.equal(json.outputs[0].covenant.covenantId, cid);
      assert.equal(json.outputs[0].covenant.authorizingInput, 0);
      const next = { ...f.states[0], amount: sum };
      assert.equal(
        tx.outputs[0].scriptPublicKey.script,
        kw.payToScriptHashScript(buildKcc20ScriptForState(f.artifact, next))
          .script,
      );
      assert.equal(
        BigInt(json.outputs[1].value),
        BigInt(count) * 100_000_000n - BigInt(json.outputs[0].value),
      );
      const signatures = [];
      for (const input of built.scripts) {
        let signature = Buffer.from(
          kw.createInputSignature(
            tx,
            input.inputIndex,
            key,
            kw.SighashType.All,
          ),
          "hex",
        );
        if (signature.length === 66 && signature[0] === 0x41)
          signature = signature.subarray(1);
        assert.equal(signature.length, 65);
        signatures.push(hex(signature));
        const args = new kw.ScriptBuilder();
        for (const arg of input.signatureScript.args) {
          if (arg.type === "signature")
            args.addData(
              Buffer.concat([
                Buffer.from(arg.prefixHex ?? "", "hex"),
                signature,
              ]),
            );
          else if (arg.type === "data")
            args.addData(Buffer.from(arg.hex, "hex"));
          else throw Error("Unexpected argument type " + arg.type);
        }
        tx.inputs[input.inputIndex].signatureScript =
          kw.ScriptBuilder.fromScript(
            Buffer.from(input.scriptHex, "hex"),
          ).encodePayToScriptHashSignatureScript(args.drain());
      }
      tx.inputs[count].signatureScript = kw.createInputSignature(
        tx,
        count,
        key,
        kw.SighashType.All,
      );
      assert(tx.inputs.every((i) => i.signatureScript.length > 0));
      assert.equal(f.calls(), 2);
      emitted.push({
        name: `${profile.id}-${count}`,
        profileId: profile.id,
        count,
        built,
        signatures,
        states: f.states.map((s) => ({
          ...s,
          amount: String(s.amount),
          owner: hex(s.owner),
          borrowGuard: hex(s.borrowGuard),
          extensionCommitment: hex(s.extensionCommitment),
        })),
        signedTransaction: JSON.parse(tx.serializeToSafeJSON()),
      });
      if (count === profile.maxTokenInputs) {
        const altered = structuredClone(emitted.at(-1));
        altered.name = "altered-output-" + profile.id;
        altered.expectFailure = true;
        altered.signedTransaction.outputs[1].value = String(
          BigInt(altered.signedTransaction.outputs[1].value) + 1n,
        );
        emitted.push(altered);
        const badSignature = structuredClone(emitted.at(-2));
        badSignature.name = "invalid-leader-signature-" + profile.id;
        badSignature.expectFailure = true;
        badSignature.signedTransaction.inputs[0].signatureScript =
          badSignature.signedTransaction.inputs[0].signatureScript.replace(
            signatures[0],
            "00".repeat(64) + "01",
          );
        emitted.push(badSignature);
      }
      if (process.env.CONSOLIDATION_EVIDENCE) {
        await mkdir(process.env.CONSOLIDATION_EVIDENCE, { recursive: true });
        await writeFile(
          process.env.CONSOLIDATION_EVIDENCE + "/transactions.json",
          JSON.stringify(emitted, null, 2),
        );
      }
    });
  test(`${profile.id}: rejects limit + 1 before RPC`, async () => {
    const f = await fixture(profile, profile.maxTokenInputs + 1);
    await assert.rejects(f.engine.build(f.request), /profile input bound/);
    assert.equal(f.calls(), 0);
  });
  test(`${profile.id}: rejects forged profile hint and altered state`, async () => {
    const f = await fixture(profile, 2, ({ request }) => {
      request.request.params.tokenProfileId = "kaspacom-kcc20-last-call-v1";
      request.request.params.maxTokenInputs = 255;
      request.request.params.activeHolderUtxos[0].state.amount = "999";
    });
    await assert.rejects(
      f.engine.build(f.request),
      /does not match a bundled token profile/,
    );
    assert.equal(f.calls(), 0);
  });
}

test("genuine Argent sources cannot borrow a platform profile hint to exceed three", async () => {
  const p = BUNDLED_TOKEN_PROFILES.profiles.find(
    (p) => p.id === "argent-reference-kcc20-v1",
  );
  const f = await fixture(p, 4, ({ request }) => {
    request.request.params.tokenProfileId = "kaspacom-kcc20-last-call-v1";
    request.request.params.maxTokenInputs = 8;
  });
  await assert.rejects(f.engine.build(f.request), /profile input bound \(3\)/);
  assert.equal(f.calls(), 0);
});
test("duplicate native outpoints reject before RPC", async () => {
  const f = await fixture(
    BUNDLED_TOKEN_PROFILES.profiles[0],
    2,
    ({ request }) => {
      request.request.params.activeHolderUtxos[1] = structuredClone(
        request.request.params.activeHolderUtxos[0],
      );
    },
  );
  await assert.rejects(f.engine.build(f.request), /distinct holder outpoints/);
  assert.equal(f.calls(), 0);
});

// Deliberately bypass the planner for negative consensus cases: even valid owner
// signatures must not permit excess inputs or inflation at the contract itself.
for (const profile of BUNDLED_TOKEN_PROFILES.profiles)
  for (const violation of ["limit", "conservation"])
    test(`${profile.id}: prepares signed ${violation} rejection vector`, async () => {
      const count = violation === "limit" ? profile.maxTokenInputs + 1 : 2;
      const f = await fixture(profile, count);
      const next = {
        ...f.states[0],
        amount:
          f.states.reduce((a, s) => a + s.amount, 0n) +
          (violation === "conservation" ? 1n : 0n),
      };
      const allEntries = [...f.sources.map((s) => s.entry), f.funding];
      const tx = new kw.Transaction({
        version: 1,
        lockTime: 0n,
        inputs: allEntries.map((e) => ({
          previousOutpoint: e.outpoint,
          utxo: e,
          sequence: 0n,
          sigOpCount: 0,
          computeBudget: 2000,
        })),
        outputs: [
          new kw.TransactionOutput(
            100_000_000n,
            kw.payToScriptHashScript(
              buildKcc20ScriptForState(f.artifact, next),
            ),
            new kw.CovenantBinding(0, new kw.Hash(cid)),
          ),
          new kw.TransactionOutput(
            BigInt(count - 1) * 100_000_000n + 990_000_000n,
            kw.payToAddressScript(wallet),
          ),
        ],
        subnetworkId: "00".repeat(20),
        gas: 0n,
        payload: "",
      });
      for (let i = 0; i < count; i++) {
        let signature = Buffer.from(
          kw.createInputSignature(tx, i, key, kw.SighashType.All),
          "hex",
        );
        if (signature.length === 66 && signature[0] === 0x41)
          signature = signature.subarray(1);
        const args =
          i === 0
            ? buildKcc20TransferSigScript(kw, f.artifact, {
                nextStates: [next],
                witness: Buffer.concat([Buffer.from([0]), signature]),
              })
            : buildKcc20TransferDelegatorSigScript(kw, f.artifact, {
                witness: signature,
              });
        tx.inputs[i].signatureScript = kw.ScriptBuilder.fromScript(
          f.sources[i].script,
        ).encodePayToScriptHashSignatureScript(args);
      }
      tx.inputs[count].signatureScript = kw.createInputSignature(
        tx,
        count,
        key,
        kw.SighashType.All,
      );
      emitted.push({
        name: violation + "-" + profile.id,
        expectFailure: true,
        profileId: profile.id,
        count,
        built: { metadata: { covenantId: cid } },
        signedTransaction: JSON.parse(tx.serializeToSafeJSON()),
      });
      if (process.env.CONSOLIDATION_EVIDENCE) {
        await mkdir(process.env.CONSOLIDATION_EVIDENCE, { recursive: true });
        await writeFile(
          process.env.CONSOLIDATION_EVIDENCE + "/transactions.json",
          JSON.stringify(emitted, null, 2),
        );
      }
    });

test("equivalent numeric and string vout values cannot duplicate a source", async () => {
  const f = await fixture(
    BUNDLED_TOKEN_PROFILES.profiles[0],
    2,
    ({ request }) => {
      request.request.params.activeHolderUtxos[1] = structuredClone(
        request.request.params.activeHolderUtxos[0],
      );
      request.request.params.activeHolderUtxos[1].vout = "00";
    },
  );
  await assert.rejects(f.engine.build(f.request), /distinct holder outpoints/);
  assert.equal(f.calls(), 0);
});
