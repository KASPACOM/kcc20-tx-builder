import { test } from "node:test";
import assert from "node:assert/strict";
import { runtime, loadArtifact } from "../backend/runtime.ts";
import { recipeFixtures } from "../shared/recipe-fixtures.ts";
import { inspect } from "../shared/build.ts";
import { recipes } from "../shared/recipes.ts";
import { attachScripts, signingInputs } from "../shared/signing.ts";
import { owner } from "../shared/fixture.ts";
const wasm = await runtime();
const fixture = await recipeFixtures(wasm, loadArtifact);
for (const name of Object.keys(recipes) as (keyof typeof recipes)[]) {
  test(`${name}: helper to unsigned transaction to offline signing`, async () => {
    const operation = fixture.operation(name);
    const result = await fixture.build(operation);
    assert.equal(
      result.metadata.builderKey,
      operation.payload.signing.builderKey,
    );
    assert(BigInt(inspect(result).feeSompi) > 0n);
    const tx = wasm.Transaction.deserializeFromSafeJSON(
      result.psktTransactionJson,
    );
    // Public generator test vectors (scalars 1 and 2), never funded wallets.
    const scalar = operation.payload.owner.kcc20Owner === owner ? 1n : 2n;
    const key = new wasm.PrivateKey(scalar.toString(16).padStart(64, "0"));
    for (const input of signingInputs(result)) {
      assert.equal(input.sighashType, 1); // Wire SIGHASH_ALL byte; WASM enum All is 0.
      tx.inputs[input.index].signatureScript = wasm.createInputSignature(
        tx,
        input.index,
        key,
        wasm.SighashType.All,
      );
    }
    const signed = JSON.parse(
      attachScripts(wasm, tx.serializeToSafeJSON(), result),
    );
    assert(
      signed.inputs.every(
        (input: { signatureScript: string }) =>
          input.signatureScript.length > 0,
      ),
    );
    if (name === "publicMint") {
      assert.equal(result.scripts?.length ?? 0, 0);
      assert(
        JSON.parse(result.psktTransactionJson).inputs[0].signatureScript
          .length > 100,
      );
      signed.inputs[0].signatureScript = "";
      assert.throws(
        () => attachScripts(wasm, JSON.stringify(signed), result),
        /changed the transaction intent/,
      );
    }
    key.free();
    tx.free();
  });
}
