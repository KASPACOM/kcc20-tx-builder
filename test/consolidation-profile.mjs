import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import * as kw from "../examples/vendor/kaspa/kaspa.js";
import {
  createKcc20PsktBuilderEngine,
  BUNDLED_TOKEN_PROFILES,
  buildKcc20ScriptForState,
} from "../dist/index.js";
import { KCC20_MAX_NATIVE_CONSOLIDATION_INPUTS } from "../dist/action-source-resolver.js";
kw.initSync(
  await readFile(
    new URL("../examples/vendor/kaspa/kaspa_bg.wasm", import.meta.url),
  ),
);
const owner = "11".repeat(32);
const wallet = kw
  .addressFromScriptPublicKey(
    new kw.ScriptPublicKey(0, `20${owner}ac`),
    "testnet-10",
  )
  .toString();
const reachedRpc = new Error("validated scripts reached RPC");
for (const profile of BUNDLED_TOKEN_PROFILES.profiles) {
  for (const count of [2, 3])
    test(`${profile.id}: ${count} non-default holder states preserve authenticated scripts`, async () => {
      const artifact = JSON.parse(
        await readFile(
          new URL("../artifacts/" + profile.artifactKey, import.meta.url),
        ),
      );
      const state = {
        amount: 111n,
        owner: Buffer.from(owner, "hex"),
        ownerScheme: 0,
        borrowScheme: 2,
        borrowGuard: new Uint8Array(32).fill(0x44),
        extensionCommitment: new Uint8Array(32).fill(0x55),
      };
      const address = kw
        .addressFromScriptPublicKey(
          kw.payToScriptHashScript(buildKcc20ScriptForState(artifact, state)),
          "testnet-10",
        )
        .toString();
      const engine = createKcc20PsktBuilderEngine({
        wasm: kw,
        artifacts: {},
        artifactProvider: async (key) =>
          JSON.parse(
            await readFile(new URL("../artifacts/" + key, import.meta.url)),
          ),
        rpcClientFactory: () => {
          throw reachedRpc;
        },
      });
      const input = {
        schema: "kcc20-in-process-pskt-builder-input/v1",
        request: {
          builderKey: "kcc20.consolidate-holders",
          network: "testnet-10",
          owner: { walletAddress: wallet, kcc20Owner: owner },
          params: {
            covenantId: "aa".repeat(32),
            activeHolderUtxos: Array.from({ length: count }, (_, i) => ({
              txidHex: (i + 1).toString(16).padStart(2, "0").repeat(32),
              vout: 0,
              address,
              amountSompi: "100000000",
              state: {
                ...state,
                amount: "111",
                owner,
                borrowGuard: Buffer.from(state.borrowGuard).toString("hex"),
                extensionCommitment: Buffer.from(
                  state.extensionCommitment,
                ).toString("hex"),
              },
            })),
          },
        },
      };
      await assert.rejects(
        engine.build(input),
        (error) => error === reachedRpc,
      );
      input.request.params.activeHolderUtxos[0].state.amount = "112";
      await assert.rejects(
        engine.build(input),
        /does not match a bundled token profile/,
      );
    });
}
test("native consolidation advertises the same three-input limit enforced by the engine", () => {
  assert.equal(KCC20_MAX_NATIVE_CONSOLIDATION_INPUTS, 3);
});

test("native planner selects a three-source batch and rejects oversized explicit selection", async () => {
  const { buildKcc20NativeConsolidationOperation } = await import(
    "../dist/token-operation.js"
  );
  const activeUtxos = Array.from({ length: 8 }, (_, i) => ({
    txidHex: (i + 1).toString(16).padStart(64, "0"),
    vout: 0,
    address: "kaspatest:holder",
    amountSompi: "100000000",
    covenantId: "aa".repeat(32),
    state: {
      ownerIdentifier: owner,
      ownerScheme: 0,
      amount: "100",
      isMintAuthority: false,
    },
  }));
  const walletInfo = { walletAddress: wallet, kcc20Owner: owner };
  const input = {
    token: { covenantId: "aa".repeat(32), decimals: 0 },
    activeUtxos,
  };
  const operation = buildKcc20NativeConsolidationOperation(walletInfo, input);
  assert.equal(operation.payload.params.activeHolderUtxos.length, 3);
  assert.equal(operation.payload.params.tokenAmount, "300");
  assert.throws(
    () =>
      buildKcc20NativeConsolidationOperation(walletInfo, {
        ...input,
        sourceOutpoints: activeUtxos.slice(0, 4).map((u) => `${u.txidHex}:0`),
      }),
    /3|three|too many|maximum|at most/i,
  );
});
