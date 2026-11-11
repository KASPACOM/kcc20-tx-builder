import test from 'node:test';
import assert from 'node:assert/strict';
import { formatQuantity, transferReady, walletClient } from '../shared/wallet.ts';

test('quantities preserve integers beyond JS safe range and missing decimals', () => {
  assert.equal(formatQuantity('18446744073709551615', 8), '184467440737.09551615');
  assert.equal(formatQuantity('1', 8), '0.00000001');
  assert.equal(formatQuantity('1200', 2), '12');
  assert.equal(formatQuantity('0', 8), '0');
  assert.equal(formatQuantity('123', null), '123 base units');
  assert.equal(formatQuantity('123', 0), '123');
  for (const bad of ['-1', '1.2', '1e8', 'NaN']) assert.throws(() => formatQuantity(bad, 8));
  assert.throws(() => formatQuantity('1', 9));
});
test('stale, unavailable and unhealthy observations never mean ready', () => {
  const fresh = { ok: true, stale: false, suggestedPollMs: 1000 };
  assert.equal(transferReady({ ok: true }, fresh), true);
  assert.equal(transferReady({ ok: true }, { ...fresh, stale: true }), false);
  assert.equal(transferReady({ ok: true }, { ...fresh, ok: false }), false);
  assert.equal(transferReady({}, fresh), false);
});
test('existing query names retain false and zero, without duplicate requests', async () => {
  const requests: URL[] = [];
  const client = walletClient('https://example.test', async (url) => {
    requests.push(new URL(String(url)));
    return new Response(JSON.stringify({ items: [], total: 0, limit: 1, offset: 0, generatedAtMs: 1 }));
  });
  await client.balances('kaspatest:abc', { limit: 1, offset: 0, refresh: false, q: 'a & b', asset: 'wrapped' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get('refresh'), 'false');
  assert.equal(requests[0].searchParams.get('offset'), '0');
  assert.equal(requests[0].searchParams.get('q'), 'a & b');
  assert.equal(requests[0].pathname, '/wallet-provider/owners/kaspatest%3Aabc/balances');
});
test('API errors remain errors rather than fabricated empty balances', async () => {
  const client = walletClient('https://example.test', async () => new Response('', { status: 503 }));
  await assert.rejects(client.balances('owner'), /HTTP 503/);
  assert.throws(() => client.settlement('bad'), /Invalid transaction/);
});

// Actual pinned WASM + artifacts, with deterministic offline UTXOs only.
import { runtime, loadArtifact } from '../backend/runtime.ts';
import { fixture, recipient } from '../shared/fixture.ts';
import { createBuilder, deployOperation } from '../shared/build.ts';
import { buildSend, signSend } from '../shared/wallet-send.ts';
test('native send validates recipient, funds, spent source, full amount and signer rejection', async () => {
  const wasm = await runtime();
  const f = fixture(wasm);
  const deploy = await createBuilder(wasm, f.sources, loadArtifact)(deployOperation(f.wallet));
  const holder = f.addDeploy(deploy);
  f.rows.get(holder.address)![0].scriptPublicKey = wasm.Transaction.deserializeFromSafeJSON(deploy.psktTransactionJson).outputs[0].scriptPublicKey;
  const rpc = { ...f.sources, getBlockDagInfo: async () => ({ network: 'testnet-10' }) } as unknown as InstanceType<typeof wasm.RpcClient>;
  const request = { wallet: f.wallet, covenantId: String(deploy.metadata.covenantId),
    recipient, quantityBaseUnits: '100000', holders: [holder] };
  const full = await buildSend(wasm, rpc, loadArtifact, request);
  assert.equal(String(full.metadata.tokenAmount), '100000');
  assert.equal(String(full.metadata.changeAmount), '0');
  await assert.rejects(signSend(wasm, rpc, full, async () => { throw new Error('Wallet rejected'); }), /Wallet rejected/);
  await assert.rejects(buildSend(wasm, rpc, loadArtifact, { ...request, recipient: 'invalid' }), /recipientOwner/);
  await assert.rejects(buildSend(wasm, rpc, loadArtifact, { ...request, quantityBaseUnits: '1000.001' }), /integer base units/);
  const funds = f.rows.get(f.wallet.walletAddress)!;
  f.rows.set(f.wallet.walletAddress, []);
  await assert.rejects(buildSend(wasm, rpc, loadArtifact, request));
  f.rows.set(f.wallet.walletAddress, funds);
  f.rows.set(holder.address, []);
  let signerCalled = false;
  await assert.rejects(signSend(wasm, rpc, full, async () => { signerCalled = true; return ''; }), /Input spent/);
  assert.equal(signerCalled, false);
  await assert.rejects(buildSend(wasm, rpc, loadArtifact, request), /missing|spent|UTXO|utxo|not found/i);
});

import { attachScripts, signingInputs } from '../shared/signing.ts';
import { broadcastSend } from '../shared/wallet-send.ts';
test('argument-only covenant inputs do not ask the wallet for signatures', async () => {
  const wasm = await runtime(); const f = fixture(wasm);
  const deploy = await createBuilder(wasm, f.sources, loadArtifact)(deployOperation(f.wallet));
  const built = { ...deploy, signInputs: [], scripts: [{ inputIndex: 0, scriptHex: '51',
    signatureScript: { mode: 'ordered-args' as const, args: [{ type: 'i64' as const, value: '1' }] } }] };
  assert.deepEqual(signingInputs(built), []);
  const assembled = attachScripts(wasm, built.psktTransactionJson, built);
  assert.ok(wasm.Transaction.deserializeFromSafeJSON(assembled).inputs[0].signatureScript);
  assert.throws(() => signingInputs({ ...built, signInputs: [{ index: 0, sighashType: 1 }] }), /Conflicting/);
  const changed = wasm.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  changed.inputs[0].signatureScript = '51';
  assert.throws(() => attachScripts(wasm, changed.serializeToSafeJSON(), built), /intent/);
});
test('broadcast persists intent first and never submits after failed persistence or spent inputs', async () => {
  const wasm = await runtime(); const f = fixture(wasm);
  const built = await createBuilder(wasm, f.sources, loadArtifact)(deployOperation(f.wallet));
  const tx = wasm.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  // Encoding fixture only. Cryptographic signature validation belongs to node tests.
  tx.inputs[0].signatureScript = '41' + '11'.repeat(64) + '01';
  const signed = attachScripts(wasm, tx.serializeToSafeJSON(), built);
  const calls: string[] = [];
  const rpc = { ...f.sources, getBlockDagInfo: async () => ({ network: 'testnet-10' }),
    submitTransaction: async () => { calls.push('submit'); return {}; } } as unknown as InstanceType<typeof wasm.RpcClient>;
  await assert.rejects(broadcastSend(wasm, rpc, signed, async () => { throw Error('Disk unavailable'); }), /Disk unavailable/);
  assert.equal(calls.length, 0);
  await broadcastSend(wasm, rpc, signed, async record => {
    assert.match(record.transactionId, /^[a-f0-9]{64}$/); calls.push('persist');
  });
  assert.deepEqual(calls, ['persist', 'submit']);
  f.rows.clear();
  await assert.rejects(broadcastSend(wasm, rpc, signed, async () => { calls.push('unexpected'); }), /Input spent/);
  assert.deepEqual(calls, ['persist', 'submit']);
});
