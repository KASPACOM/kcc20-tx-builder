import { recipes } from "../shared/recipes.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runtime, loadArtifact } from "../backend/runtime.ts";
import {
  createBuilder,
  deployOperation,
  transferOperation,
  engineInput,
  inspect,
  type Runtime,
} from "../shared/build.ts";
import { fixture, recipient } from "../shared/fixture.ts";
import { attachScripts, signingInputs } from "../shared/signing.ts";
const wasm = await runtime();
// Offline construction must not silently fall back to any backend or RPC.
globalThis.fetch = async () => {
  throw new Error("Network access forbidden in offline examples");
};

test("build deploy and transfer with actual WASM, covenant bindings, amounts and change", async () => {
  const data = fixture(wasm);
  const build = createBuilder(
    Object.freeze({ ...wasm }),
    data.sources,
    loadArtifact,
  );
  const deploy = await build(deployOperation(data.wallet));
  const deployTx = JSON.parse(deploy.psktTransactionJson);
  assert.equal(deployTx.version, 1);
  assert.equal(
    deployTx.outputs[0].covenant.covenantId,
    deploy.metadata.covenantId,
  );
  const holder = data.addDeploy(deploy);
  const transfer = await build(
    transferOperation(data.wallet, holder, recipient),
  );
  const tx = JSON.parse(transfer.psktTransactionJson);
  assert.equal(tx.inputs.length, 2);
  assert.equal(tx.outputs.length, 3);
  assert.equal(tx.outputs[0].covenant.covenantId, deploy.metadata.covenantId);
  assert.equal(
    transfer.metadata.tokenAmount ?? transfer.metadata.transferAmount,
    "1250",
  );
  assert(BigInt(inspect(transfer).feeSompi) > 0n);
  assert.equal(tx.inputs[0].transactionId, holder.txidHex);
  assert.equal(signingInputs(transfer).length, 2);
  // Exercise script assembly with a synthetic signature only, never submit.
  for (const input of tx.inputs)
    input.signatureScript = "41" + "11".repeat(64) + "01";
  const signed = JSON.parse(attachScripts(wasm, JSON.stringify(tx), transfer));
  assert(signed.inputs[0].signatureScript.length > 132);
  assert.equal(signed.inputs[1].signatureScript, tx.inputs[1].signatureScript);
  tx.outputs[0].value = (BigInt(tx.outputs[0].value) + 1n).toString();
  assert.throws(
    () => attachScripts(wasm, JSON.stringify(tx), transfer),
    /changed the transaction intent/,
  );
});
test("reject missing funding, stale source, wrong owner, network and incompatible artifact/runtime", async () => {
  const data = fixture(wasm);
  const build = createBuilder(wasm, data.sources, loadArtifact);
  const operation = deployOperation(data.wallet);
  const deploy = await build(operation);
  const holder = data.addDeploy(deploy);
  const transfer = transferOperation(data.wallet, holder, recipient);
  data.rows.delete(holder.address);
  await assert.rejects(build(transfer), /not found/);
  data.rows.clear();
  await assert.rejects(build(operation), /funding|UTXO|insufficient/i);
  assert.throws(
    () =>
      engineInput({
        ...operation,
        payload: { ...operation.payload, network: "mainnet" },
      }),
    /testnet-10/,
  );
  assert.throws(
    () =>
      transferOperation(
        data.wallet,
        { ...holder, state: { ...holder.state, ownerIdentifier: recipient } },
        recipient,
      ),
    /holder UTXO/,
  );
  await assert.rejects(
    createBuilder(wasm, fixture(wasm).sources, async () => ({
      script: [1, 2],
    }))(operation),
    /hash mismatch/,
  );
  assert.throws(
    () => createBuilder({} as Runtime, data.sources, loadArtifact),
    /Incompatible WASM/,
  );
});

test("reject conflicting explicit native identity, but retain legacy alias resolution", async () => {
  const data = fixture(wasm);
  const build = createBuilder(wasm, data.sources, loadArtifact);
  const holder = data.addDeploy(await build(deployOperation(data.wallet)));
  const operation = transferOperation(data.wallet, holder, recipient);
  const entry = data.rows.get(holder.address)![0];
  entry.covenantId = "ff".repeat(32);
  await assert.rejects(build(operation), /covenant id does not match/);
  delete entry.covenantId;
  await assert.rejects(build(operation), /missing covenant id/);
  entry.covenantId = holder.covenantId;
  const aliasedOperation = recipes.transfer(
    data.wallet,
    {
      token: { covenantId: "ff".repeat(32), decimals: 2 },
      activeUtxos: [{ ...holder, covenantId: undefined }],
      recipientOwner: recipient,
      tokenAmount: "1.00",
    },
    { network: "testnet-10" },
  );
  assert.equal(
    aliasedOperation.payload.params.activeHolderNativeCovenantId,
    undefined,
  );
  const aliased = await build(aliasedOperation);
  assert.equal(aliased.metadata.covenantId, holder.covenantId);
});

test("preserve witnesses outside requested signing inputs and reject malformed signatures", async () => {
  const data = fixture(wasm);
  const build = createBuilder(wasm, data.sources, loadArtifact);
  const deploy = await build(deployOperation(data.wallet));
  const holder = data.addDeploy(deploy);
  const transfer = await build(
    transferOperation(data.wallet, holder, recipient),
  );
  // Model a pre-authorized covenant input: the wallet must sign funding only.
  const original = JSON.parse(transfer.psktTransactionJson);
  original.inputs[0].signatureScript = "0101";
  const preauthorized = {
    ...transfer,
    scripts: [],
    psktTransactionJson: JSON.stringify(original),
  };
  original.inputs[1].signatureScript = "41" + "11".repeat(64) + "01";
  assert.equal(
    JSON.parse(attachScripts(wasm, JSON.stringify(original), preauthorized))
      .inputs[0].signatureScript,
    "0101",
  );
  original.inputs[0].signatureScript = "";
  assert.throws(
    () => attachScripts(wasm, JSON.stringify(original), preauthorized),
    /changed the transaction intent/,
  );
  for (const signatureScript of [
    "00",
    "41" + "11".repeat(64) + "02",
    "11".repeat(65),
  ]) {
    const tx = JSON.parse(deploy.psktTransactionJson);
    tx.inputs[0].signatureScript = signatureScript;
    assert.throws(
      () => attachScripts(wasm, JSON.stringify(tx), deploy),
      /signature encoding or sighash/,
    );
  }
});

test("generic transfer rejects conflicting RPC scripts and KAS amounts", async () => {
  const data = fixture(wasm),
    build = createBuilder(wasm, data.sources, loadArtifact);
  const holder = data.addDeploy(await build(deployOperation(data.wallet)));
  const operation = transferOperation(data.wallet, holder, recipient);
  const row = data.rows.get(holder.address)![0];
  const originalScript = row.scriptPublicKey;
  row.scriptPublicKey = wasm.payToAddressScript(data.wallet.walletAddress);
  await assert.rejects(build(operation), /RPC script does not match/);
  row.scriptPublicKey = originalScript;
  row.amount += 1n;
  await assert.rejects(build(operation), /KAS amount does not match/);
});

test("reject a present funding input that cannot cover the required KAS", async () => {
  const data = fixture(wasm);
  data.rows.get(data.wallet.walletAddress)![0].amount = 1n;
  await assert.rejects(
    createBuilder(
      wasm,
      data.sources,
      loadArtifact,
    )(deployOperation(data.wallet)),
    /no single funding UTXO can cover/,
  );
});
