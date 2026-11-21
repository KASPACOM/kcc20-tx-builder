import { buildKcc20MintTokenOperation } from "../dist/token-operation.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildKcc20VerifyTokenOperation } from "../dist/verify-operation.js";
import { validateKcc20DeployToken } from "../dist/deploy-operation.js";
const wallet = { walletAddress: "kaspatest:test", kcc20Owner: "a".repeat(64) };
const draft = {
  ticker: "ESCP",
  tokenName: "ESCP",
  decimals: 0,
  maxSupply: "900",
  premintSupply: "0",
  mintPolicy: "public",
  mintPricePerTokenSompi: "1000000",
  mintLaneCount: 10,
};
test("RT2-96: aggregate supply cannot satisfy a single-lane verification", () => {
  assert.throws(
    () => validateKcc20DeployToken(wallet, draft),
    /verif.*lane|lane.*verif/i,
  );
});
for (const decimals of [0, 2, 8])
  for (const lanes of [1, 3, 10]) {
    test(`verification boundary decimals=${decimals}, lanes=${lanes}`, () => {
      const scale = 10n ** BigInt(decimals);
      const display = (n) =>
        decimals
          ? `${n / scale}.${(n % scale).toString().padStart(decimals, "0")}`
          : String(n);
      // Each lane is 100 tokens at the threshold; all lanes one base unit below it fail.
      const threshold = 100n * scale;
      assert.throws(
        () =>
          validateKcc20DeployToken(wallet, {
            ...draft,
            decimals,
            mintLaneCount: lanes,
            maxSupply: display((threshold - 1n) * BigInt(lanes)),
          }),
        /verif.*lane|lane.*verif/i,
      );
      for (const amount of [threshold, threshold + 1n]) {
        assert.doesNotThrow(() =>
          validateKcc20DeployToken(wallet, {
            ...draft,
            decimals,
            mintLaneCount: lanes,
            maxSupply: display(amount * BigInt(lanes)),
          }),
        );
      }
    });
  }
test("fixed and sufficiently funded free/controlled deployments remain supported", () => {
  for (const mintPolicy of ["public", "controlled"])
    assert.doesNotThrow(() =>
      validateKcc20DeployToken(wallet, {
        ...draft,
        mintPolicy,
        mintPricePerTokenSompi: "0",
        maxSupply: "10",
      }),
    );
  assert.doesNotThrow(() =>
    validateKcc20DeployToken(wallet, {
      ...draft,
      mintPolicy: "fixed",
      mintPricePerTokenSompi: "0",
      maxSupply: "1",
      premintSupply: "1",
    }),
  );
});

test("free verification can reveal a fractional lane instead of requiring one whole token", () => {
  const operation = buildKcc20VerifyTokenOperation(wallet, {
    covenantId: "b".repeat(64),
    activeTokenUtxo: {
      txidHex: "c".repeat(64),
      vout: 0,
      address: "kaspatest:lane",
      amountSompi: "100000000",
    },
    deployReceipt: {
      stateAmount: "0",
      owner: wallet.kcc20Owner,
      ownerScheme: 0,
      extensionCommitment: "d".repeat(64),
      isMintAuthority: true,
      decimals: "2",
      mintPolicy: 2,
      extension: {
        mintPriceSompi: "0",
        protocolFeeBps: 200,
        remainingSupply: "9",
      },
    },
  });
  assert.equal(operation.payload.params.tokenAmount, "9");
});

test("one lane is required, and a fresh changed lane cannot authorize the old quote", () => {
  const token = {
    covenantId: "b".repeat(64),
    decimals: 0,
    mintPolicy: {
      mintable: true,
      policy: "public",
      publicMintActive: true,
      mintPricePerTokenSompi: "0",
    },
  };
  const lanes = (amounts) =>
    amounts.map((remaining, i) => ({
      txidHex: "c".repeat(64),
      vout: i,
      outpoint: "c".repeat(64) + ":" + i,
      address: "kaspatest:lane",
      amountSompi: "100000000",
      state: {
        isMintAuthority: true,
        remainingSupply: String(remaining),
        ownerIdentifier: wallet.kcc20Owner,
        ownerScheme: 0,
      },
    }));
  assert.equal(
    buildKcc20MintTokenOperation(wallet, {
      token,
      tokenAmount: "90",
      activeUtxos: lanes([90, 40]),
    }).payload.params.tokenAmount,
    "90",
  );
  for (const [tokenAmount, amounts] of [
    ["91", [90, 40]],
    ["90", [89, 40]],
    ["1", [0, 0]],
  ]) {
    assert.throws(
      () =>
        buildKcc20MintTokenOperation(wallet, {
          token,
          tokenAmount,
          activeUtxos: lanes(amounts),
        }),
      (error) =>
        error.code === "KCC20_MINT_AMOUNT_EXCEEDS_SINGLE_LANE_CAP" &&
        error.retryable === false,
    );
  }
});

for (const remainingSupply of ["90", 90n, 90]) {
  test(`lane maximum agrees with selection for ${typeof remainingSupply} balances`, () => {
    const token = {
      covenantId: "b".repeat(64),
      decimals: 0,
      mintPolicy: {
        mintable: true,
        policy: "public",
        publicMintActive: true,
        mintPricePerTokenSompi: "0",
      },
    };
    const lane = {
      txidHex: "c".repeat(64),
      vout: 0,
      address: "kaspatest:lane",
      amountSompi: "100000000",
      state: {
        isMintAuthority: true,
        remainingSupply,
        ownerIdentifier: wallet.kcc20Owner,
        ownerScheme: 0,
      },
    };
    assert.equal(
      buildKcc20MintTokenOperation(wallet, {
        token,
        tokenAmount: "90",
        activeUtxos: [lane],
      }).payload.params.tokenAmount,
      "90",
    );
    const invalid = [
      -1n,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      "0100",
      " 100",
      "1e3",
      null,
      undefined,
    ];
    const invalidLanes = invalid.map((raw) => ({
      ...lane,
      state: { ...lane.state, remainingSupply: raw },
    }));
    const holder = {
      ...lane,
      state: {
        ...lane.state,
        isMintAuthority: false,
        remainingSupply: "10000",
      },
    };
    assert.throws(
      () =>
        buildKcc20MintTokenOperation(wallet, {
          token,
          tokenAmount: "91",
          activeUtxos: [lane],
        }),
      (error) => {
        assert.equal(error.code, "KCC20_MINT_AMOUNT_EXCEEDS_SINGLE_LANE_CAP");
        assert.equal(error.maxMintAmountPerRequest, "90");
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.throws(
      () =>
        buildKcc20MintTokenOperation(wallet, {
          token,
          tokenAmount: "91",
          activeUtxos: [...invalidLanes, holder, lane],
        }),
      (error) => error.maxMintAmountPerRequest === "90",
    );
  });
}
