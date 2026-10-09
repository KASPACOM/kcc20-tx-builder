import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtime, loadArtifact } from '../backend/runtime.ts';
import { createBuilder, deployOperation, transferOperation, engineInput, inspect, type Runtime } from '../shared/build.ts';
import { fixture, recipient } from '../shared/fixture.ts';
import { attachScripts, signingInputs } from '../shared/signing.ts';
const wasm = await runtime();
// Offline construction must not silently fall back to any backend or RPC.
globalThis.fetch = async () => { throw new Error('Network access forbidden in offline examples'); };

test('build deploy and transfer with actual WASM, covenant bindings, amounts and change', async () => {
  const data = fixture(wasm);
  const build = createBuilder(Object.freeze({ ...wasm }), data.sources, loadArtifact);
  const deploy = await build(deployOperation(data.wallet));
  const deployTx = JSON.parse(deploy.psktTransactionJson);
  assert.equal(deployTx.version, 1);
  assert.equal(deployTx.outputs[0].covenant.covenantId, deploy.metadata.covenantId);
  const holder = data.addDeploy(deploy);
  const transfer = await build(transferOperation(data.wallet, holder, recipient));
  const tx = JSON.parse(transfer.psktTransactionJson);
  assert.equal(tx.inputs.length, 2);
  assert.equal(tx.outputs.length, 3);
  assert.equal(tx.outputs[0].covenant.covenantId, deploy.metadata.covenantId);
  assert.equal(transfer.metadata.tokenAmount ?? transfer.metadata.transferAmount, '1250');
  assert(BigInt(inspect(transfer).feeSompi) > 0n);
  assert.equal(tx.inputs[0].transactionId, holder.txidHex);
  assert.equal(signingInputs(transfer).length, 2);
  // Exercise script assembly with a synthetic signature only, never submit.
  for (const input of tx.inputs) input.signatureScript = '41' + '11'.repeat(64) + '01';
  const signed = JSON.parse(attachScripts(wasm, JSON.stringify(tx), transfer));
  assert(signed.inputs[0].signatureScript.length > 132);
  assert.equal(signed.inputs[1].signatureScript, tx.inputs[1].signatureScript);
  tx.outputs[0].value = (BigInt(tx.outputs[0].value) + 1n).toString();
  assert.throws(() => attachScripts(wasm, JSON.stringify(tx), transfer), /changed the transaction intent/);
});
test('reject missing funding, stale source, wrong owner, network and incompatible artifact/runtime', async () => {
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
  assert.throws(() => engineInput({ ...operation, payload: { ...operation.payload, network: 'mainnet' } }), /testnet-10/);
  assert.throws(() => transferOperation(data.wallet, { ...holder, state: { ...holder.state, ownerIdentifier: recipient } }, recipient), /holder UTXO/);
  await assert.rejects(createBuilder(wasm, fixture(wasm).sources, async () => ({ script: [1, 2] }))(operation), /hash mismatch/);
  assert.throws(() => createBuilder({} as Runtime, data.sources, loadArtifact), /Incompatible WASM/);
});
