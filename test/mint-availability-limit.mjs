import assert from "node:assert/strict";
import { test } from "node:test";
import { createKcc20PsktBuilderEngine } from "../dist/index.js";

function request(count) {
  return {
    schema: "kcc20-in-process-pskt-builder-input/v1",
    request: {
      builderKey: "kcc20.set-public-mint-active",
      network: "testnet-10",
      owner: { walletAddress: "kaspatest:qwallet", kcc20Owner: "a".repeat(64) },
      params: {
        covenantId: "b".repeat(64),
        active: true,
        activeMinterUtxos: Array.from({ length: count }, (_, vout) => ({
          txidHex: "c".repeat(64),
          vout,
          address: "kaspatest:pminter",
          state: {
            owner: "a".repeat(64),
            ownerScheme: 0,
            isMintAuthority: true,
            mintPolicy: 2,
            publicMintActive: false,
            remainingSupply: "100",
            maxSupply: "1000",
            treasury: "d".repeat(64),
          },
        })),
      },
    },
  };
}

function fixture() {
  const calls = { artifacts: [], rpc: 0 };
  const artifactReached = new Error("normal artifact resolution reached");
  const engine = createKcc20PsktBuilderEngine({
    wasm: {},
    artifacts: {},
    artifactProvider: async (key) => {
      calls.artifacts.push(key);
      throw artifactReached;
    },
    rpcClientFactory: () => {
      calls.rpc += 1;
      throw new Error("test must not connect to RPC");
    },
  });
  return { engine, calls, artifactReached };
}

test("six mint authorities reject before artifact resolution or RPC without truncating input", async () => {
  const { engine, calls } = fixture();
  const input = request(6);
  const original = structuredClone(input);
  await assert.rejects(engine.build(input), {
    message: "Public mint availability updates support at most 5 authorities per transaction",
  });
  assert.deepEqual(calls, { artifacts: [], rpc: 0 });
  assert.deepEqual(input, original);
});

test("exactly five mint authorities continue into normal artifact resolution", async () => {
  const { engine, calls, artifactReached } = fixture();
  const input = request(5);
  const original = structuredClone(input);
  // Stop at the injected artifact boundary: this proves admission without
  // constructing, signing, or broadcasting a funded transaction.
  await assert.rejects(engine.build(input), (error) => error === artifactReached);
  // Artifact promises are cached and shared between lanes.
  assert.equal(calls.artifacts.length, 1);
  assert.equal(calls.rpc, 0);
  assert.deepEqual(input, original);
});
