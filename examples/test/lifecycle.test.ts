import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtime, loadArtifact } from '../backend/runtime.ts';
import { lifecycleBuilder, validateRequest, walletDebit } from '../shared/lifecycle.ts';
import { fixture } from '../shared/fixture.ts';
import { deployOperation, engineInput } from '../shared/build.ts';
const wasm = await runtime();
// Public deterministic fixture only. No node connection or broadcast.
const key = new wasm.PrivateKey('1'.padStart(64, '0'));
function signer() {
  return { capabilities: { schnorr: true, ecdsa: false }, async sign(raw: string, inputs: { index: number; sighashType: number }[]) {
    const tx = wasm.Transaction.deserializeFromSafeJSON(raw);
    for (const i of inputs) tx.inputs[i.index].signatureScript = wasm.createInputSignature(tx, i.index, key, wasm.SighashType.All);
    return tx.serializeToSafeJSON();
  } };
}
test('public runner signs a deploy from the published package and reports signed mass', async () => {
  const f = fixture(wasm);
  const b = lifecycleBuilder(wasm, f.sources, loadArtifact);
  const built = await b.build(engineInput(deployOperation(f.wallet)));
  assert(walletDebit(wasm, built, f.wallet.walletAddress) > 0n);
  const signed = await b.sign(built, signer());
  assert(signed.mass.computeMass > 0n);
  assert(signed.mass.transientMass > 0n);
  assert(signed.mass.storageMass > 0n);
  assert.match(signed.transaction.id, /^[a-f0-9]{64}$/);
  const roundtrip = wasm.Transaction.deserializeFromSafeJSON(signed.signed);
  roundtrip.finalize();
  assert.equal(signed.transaction.id, roundtrip.id, 'journal ID must be the finalized signed transaction ID');
});
test('fee account setup retains principal and records a resumable genesis hint', async () => {
  const f = fixture(wasm);
  const b = lifecycleBuilder(wasm, f.sources, loadArtifact);
  const built = await b.build({ schema: 'kcc20-in-process-pskt-builder-input/v1', request: {
    network: 'testnet-10', builderKey: 'kcc20fee.create-account', owner: f.wallet,
    params: { tokenId: '12'.repeat(32), principalSompi: '50000000' },
  } });
  assert.equal(built.metadata.accountGenesisHint.amountSompiExact, '50000000');
  const signed = await b.sign(built, signer());
  assert.equal(signed.transaction.outputs[0].value, 50000000n);
});
test('reject excluded operations and wrong network before source access', () => {
  const f = fixture(wasm);
  for (const builderKey of ['kcc20-snapshot.claim', 'kcc20wrapper.wrap', 'kcc20orderbook.matcher-settle-crossed', 'unknown']) {
    assert.throws(() => validateRequest({ schema: 'kcc20-in-process-pskt-builder-input/v1', request: {
      network: 'testnet-10', builderKey, owner: f.wallet, params: {},
    } }), /Unsupported/);
  }
  assert.throws(() => validateRequest({ schema: 'kcc20-in-process-pskt-builder-input/v1', request: {
    network: 'mainnet', builderKey: 'kcc20.deploy-token', owner: f.wallet, params: {},
  } }), /testnet-10/);
});
test('wallet rejection and changed intent never produce a signed result', async () => {
  const f = fixture(wasm);
  const b = lifecycleBuilder(wasm, f.sources, loadArtifact);
  const built = await b.build(engineInput(deployOperation(f.wallet)));
  await assert.rejects(b.sign(built, { ...signer(), async sign() { throw Error('User rejected'); } }), /User rejected/);
  await assert.rejects(b.sign(built, { ...signer(), async sign(raw, inputs) {
    const signed = JSON.parse(await signer().sign(raw, inputs));
    signed.outputs[0].value = '1';
    return JSON.stringify(signed);
  } }), /changed the transaction intent/);
});
test('fresh source failures propagate rather than using a cached build', async () => {
  const f = fixture(wasm);
  const b = lifecycleBuilder(wasm, { async getUtxosByAddresses() { throw Error('RPC unavailable'); } }, loadArtifact);
  await assert.rejects(b.build(engineInput(deployOperation(f.wallet))), /RPC unavailable/);
});
test('spent funding is rejected again at signing time', async () => {
  const f = fixture(wasm);
  const b = lifecycleBuilder(wasm, f.sources, loadArtifact);
  const built = await b.build(engineInput(deployOperation(f.wallet)));
  f.rows.clear();
  await assert.rejects(b.sign(built, signer()), /Input spent/);
});
test('recipe generator produces versioned keys and rejects missing source inputs', async () => {
  const { feeRequest } = await import('../shared/fee-recipes.ts');
  const f = fixture(wasm);
  const request = feeRequest('create-account', { owner: f.wallet,
    params: { tokenId: '12'.repeat(32), principalSompi: '50000000' } });
  assert.equal(request.request.builderKey, 'kcc20fee.create-account');
  const b = lifecycleBuilder(wasm, f.sources, loadArtifact);
  const built = await b.build(request);
  assert.equal(built.metadata.accountGenesisHint.state.token, '12'.repeat(32));
  assert.throws(() => feeRequest('wrap', { owner: f.wallet, params: {} }), /Missing wrap parameter/);
  assert.throws(() => feeRequest('__proto__', { owner: f.wallet, params: {} }), /Unknown/);
});
test('activation argument-only inputs are not signed, while creator and funding inputs are signed', async () => {
  const { signingInputs, attachScripts } = await import('../shared/signing.ts');
  const f = fixture(wasm);
  const b = lifecycleBuilder(wasm, f.sources, loadArtifact);
  const built = await b.build(engineInput(deployOperation(f.wallet)));
  const tx = JSON.parse(built.psktTransactionJson);
  const funding = tx.inputs[0];
  tx.inputs = [
    { ...funding, transactionId: '11'.repeat(32), signatureScript: '' },
    { ...funding, transactionId: '22'.repeat(32), signatureScript: '' },
    { ...funding, signatureScript: '' },
  ];
  const activation = { ...built, psktTransactionJson: JSON.stringify(tx), signInputs: [{ index: 2, sighashType: 1 }], scripts: [
    { inputIndex: 0, scriptHex: '51', signatureScript: { mode: 'ordered-args' as const, args: [{ type: 'i64' as const, value: '0' }] } },
    { inputIndex: 1, scriptHex: '51', signatureScript: { mode: 'ordered-args' as const, args: [{ type: 'signature' as const }] } },
  ] };
  assert.deepEqual(signingInputs(activation).map(x => x.index), [1, 2]);
  const raw = await signer().sign(activation.psktTransactionJson, signingInputs(activation));
  const completed = JSON.parse(attachScripts(wasm, raw, activation));
  assert(completed.inputs[0].signatureScript.length > 0);
  assert(completed.inputs[0].signatureScript.length < 132);
  assert(completed.inputs[1].signatureScript.length > 132);
  const changed = JSON.parse(raw); changed.inputs[0].signatureScript = '51';
  assert.throws(() => attachScripts(wasm, JSON.stringify(changed), activation), /changed the transaction intent/);
});
for (const creatorFeeBps of [0, 100, 500]) test(`published fee-v2 activation signs creator rate ${creatorFeeBps}`, async () => {
  const { prepareKcc20FeeMarketGenesis, templateParts, buildKcc20ScriptForState, kcc20CreatorFeeConsent } = await import('@kaspacom/kcc20-tx-builder');
  const { blake3 } = await import('@noble/hashes/blake3');
  const f = fixture(wasm);
  const names = { receipt: 'KCC20FeeEscrowV1', root: 'KCC20OrderbookFeeRootV1',
    holder: 'KCC20OrderbookFeeHolderV1', ask: 'KCC20OrderbookFeeAskV1', bid: 'KCC20OrderbookFeeBidV1',
    ticket: 'KCC20FeeTicket', wrapper: 'KCC20WrapperFeeV2', argentWrapper: 'KCC20WrapperFeeArgentV2' };
  const artifacts: any = Object.fromEntries(await Promise.all(Object.entries(names).map(async ([role, name]) => [role, await loadArtifact(`${name}.placeholder.json`)])));
  const tuple = (role: string) => { const t = templateParts(artifacts[role]); return {
    hash: Buffer.from(t.hash).toString('hex'), prefixLength: t.prefixLength, suffixLength: t.suffixLength,
  }; };
  const policy: any = { version: 1, creatorFeeBps, protocolAccountId: '04'.repeat(32), creatorAccountId: (creatorFeeBps ? '07' : '00').repeat(32),
    ...Object.fromEntries(['receipt', 'root', 'holder', 'ask', 'bid', 'ticket'].map(role => [`${role}Template`, tuple(role)])) };
  const tokenId = '01'.repeat(32), marketId = '02'.repeat(32);
  const genesis = prepareKcc20FeeMarketGenesis({ tokenId, feeTicketId: '00'.repeat(32), priceScale: 1n,
    policy, wrapperProfile: 'native', artifacts });
  const spk = wasm.payToScriptHashScript(genesis.wrapper.redeemScript);
  const address = wasm.addressFromScriptPublicKey(spk, 'testnet-10')!.toString();
  const entry = { outpoint: { transactionId: '0a'.repeat(32), index: 0 }, amount: 100000000n,
    scriptPublicKey: spk, blockDaaScore: 0n, isCoinbase: false, covenantId: marketId };
  f.rows.set(address, [entry]);
  const creator: Record<string, unknown> = {};
  if (creatorFeeBps) {
    const extension = Buffer.alloc(202); extension[0] = 1;
    Buffer.from(f.wallet.kcc20Owner, 'hex').copy(extension, 1); extension.writeBigInt64LE(1n, 97);
    const commitment = blake3(Buffer.concat([Buffer.from('KASPACOM/KCC20/HOLDER/V1'), extension]));
    const tokenState = { amount: 10n, owner: Buffer.from(f.wallet.kcc20Owner, 'hex'), ownerScheme: 0,
      borrowScheme: 0, borrowGuard: new Uint8Array(32), extensionCommitment: commitment };
    const script = buildKcc20ScriptForState(await loadArtifact('KCC20.placeholder.json'), tokenState);
    const tokenSpk = wasm.payToScriptHashScript(script);
    const tokenAddress = wasm.addressFromScriptPublicKey(tokenSpk, 'testnet-10')!.toString();
    const tokenEntry = { outpoint: { transactionId: '0c'.repeat(32), index: 0 }, amount: 70000000n,
      scriptPublicKey: tokenSpk, blockDaaScore: 0n, isCoinbase: false, covenantId: tokenId };
    f.rows.set(tokenAddress, [tokenEntry]);
    creator.creatorTokenUtxo = { txidHex: tokenEntry.outpoint.transactionId, vout: 0,
      address: tokenAddress, amountSompiExact: '70000000', state: { stateAmount: '10', owner: f.wallet.kcc20Owner,
        ownerScheme: 0, borrowScheme: 0, borrowGuard: '00'.repeat(32), extensionCommitment: Buffer.from(commitment).toString('hex') } };
    const consent = kcc20CreatorFeeConsent({ tokenId, marketId, feeTicketId: '00'.repeat(32), priceScale: 1n, policy });
    creator.creatorEvidence = { contractCanonicalTokenId: tokenId, creatorOwner: f.wallet.kcc20Owner,
      claimVerified: true, verificationStatus: 'verified', classificationStatus: 'matched', ownerScheme: 0, creatorConsentAvailable: true };
    creator.creatorConsent = { creatorOwner: f.wallet.kcc20Owner, signature: wasm.signMessage({ message: consent.message, privateKey: key }) };
    creator.creatorAccount = { accountId: policy.creatorAccountId };
    creator.creatorHolderExtensionHex = extension.toString('hex');
  }
  const b = lifecycleBuilder(wasm, f.sources, loadArtifact);
  const built = await b.build({ schema: 'kcc20-in-process-pskt-builder-input/v1', request: {
    builderKey: 'kcc20fee.bind-market', network: 'testnet-10', owner: f.wallet,
    params: { ...creator, wrapperVersion: 2, marketId, contractCanonicalTokenId: tokenId, feeTicketId: '00'.repeat(32),
      priceScale: '1', wrapperProfile: 'native', feePolicy: policy, policyId: genesis.policyId,
      rootPrincipalSompi: '100000000', wrapperGenesisHint: { txidHex: entry.outpoint.transactionId, vout: 0,
        address, covenantIdHex: marketId, scriptHashHex: genesis.wrapper.scriptHash,
        amountSompiExact: '100000000', state: genesis.state } },
  } });
  const signed = await b.sign(built, signer());
  assert(signed.mass.computeMass > 0n);
  const output = JSON.parse(signed.signed);
  assert.equal(output.outputs[0].covenant.covenantId, marketId);
  assert.equal(output.outputs[1].covenant.covenantId, marketId);
  entry.covenantId = 'ff'.repeat(32);
  await assert.rejects(b.assertFresh(built), /lineage changed/);
});

test('public snapshot fee sources retain exact KAS amounts and reject unsafe numbers', async () => {
  const { normalizeFeeSources } = await import('../shared/fee-recipes.ts');
  const source = { txidHex: '01'.repeat(32), vout: 0, address: 'kaspatest:fixture', amountSompi: '100000000' };
  const normalized: any = normalizeFeeSources({ wrapperUtxo: source, asks: [source] });
  assert.equal(normalized.wrapperUtxo.amountSompiExact, '100000000');
  assert.equal(normalized.asks[0].amountSompiExact, '100000000');
  assert.throws(() => normalizeFeeSources({ ...source, amountSompi: Number.MAX_SAFE_INTEGER + 1 }), /exact integer/);
  assert.equal((normalizeFeeSources({ ...source, amountSompiExact: '9007199254740993' }) as any).amountSompiExact, '9007199254740993');
});

test('resume checks both mismatch IDs without signing or resubmitting', async () => {
  const { resumeAcceptance } = await import('../shared/lifecycle.ts');
  const local = '01'.repeat(32), broadcast = '02'.repeat(32), seen: string[] = [];
  const lookup = async (_rest: string, id: string) => { seen.push(id); return id === broadcast; };
  const result = await resumeAcceptance('https://example.invalid/', { network: 'testnet-10', transactionId: local, broadcastTransactionId: broadcast }, lookup);
  assert.deepEqual(seen, [local, broadcast]);
  assert.deepEqual(result.observations, [{ transactionId: local, accepted: false }, { transactionId: broadcast, accepted: true }]);
  assert.equal(result.requiresReconciliation, true);
  seen.length = 0;
  await resumeAcceptance('https://example.invalid/', { network: 'testnet-10', transactionId: local, broadcastTransactionId: local }, lookup);
  assert.deepEqual(seen, [local]);
  seen.length = 0;
  await assert.rejects(resumeAcceptance('https://example.invalid/', { network: 'testnet-10', transactionId: local, broadcastTransactionId: 'invalid' }, lookup), /invalid transaction ID/);
  assert.equal(seen.length, 0);
});
