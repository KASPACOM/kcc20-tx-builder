import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateKcc20EscrowFees as fees, quoteKcc20EscrowSettlement as quote,
  quoteKcc20EscrowTradeGroup as group, calculateKcc20FeeClaim as claim,
  KCC20_ESCROW_MAX_INT as MAX } from '../dist/escrow-fee.js';

const KAS = 100_000_000n;
const hex = n => n.toString(16).padStart(64, '0');
const receipt = (index, p = KAS / 2n, c = KAS / 2n) => ({
  outpoint: { transactionId: hex(10), index }, tokenId: hex(1), marketId: hex(2),
  policyId: hex(3), protocolAccountId: hex(4), creatorAccountId: hex(5),
  protocolSompi: p, creatorSompi: c, valueSompi: p + c,
});

test('approved fee examples and exact boundary rounding', () => {
  for (const [gross, bps, waived, p, c] of [
    [10n*KAS, 0, false, KAS/2n, 0n], [10n*KAS, 100, false, KAS/2n, KAS/2n],
    [100n*KAS, 100, false, KAS, KAS], [100n*KAS, 500, false, KAS, 5n*KAS],
    [10n*KAS, 100, true, 0n, KAS/2n], [10n*KAS, 0, true, 0n, 0n],
    [50n*KAS+99n, 100, false, KAS/2n, KAS/2n],
    [50n*KAS+100n, 100, false, KAS/2n+1n, KAS/2n+1n],
  ]) assert.deepEqual(fees({grossSompi:gross, creatorFeeBps:bps, protocolWaived:waived}),
    {protocolFeeSompi:p, creatorFeeSompi:c, totalFeeSompi:p+c});
});

test('rejects malformed rates, gross and waiver flags', () => {
  for (const creatorFeeBps of [-1, 501, 1.5, NaN, Infinity, '100'])
    assert.throws(() => fees({grossSompi:KAS, creatorFeeBps, protocolWaived:false}));
  for (const grossSompi of [-1n, 0n, KAS/2n-1n, MAX+1n, 100000000])
    assert.throws(() => fees({grossSompi, creatorFeeBps:0, protocolWaived:false}));
  assert.throws(() => fees({grossSompi:KAS, creatorFeeBps:0, protocolWaived:'false'}));
});

test('checked arithmetic reaches int64 boundary without intermediate overflow', () => {
  const f = fees({grossSompi:MAX, creatorFeeBps:500, protocolWaived:false});
  assert.equal(f.protocolFeeSompi, MAX/100n);
  assert.equal(f.creatorFeeSompi, MAX*500n/10000n);
  assert.throws(() => quote({grossSompi:MAX, creatorFeeBps:0, protocolWaived:false, kind:'take-ask'}));
});

test('buyer, seller and crossed execution pay exactly once', () => {
  const input = {grossSompi:10n*KAS, creatorFeeBps:100, protocolWaived:false};
  assert.equal(quote({...input, kind:'take-ask'}).buyerPaysSompi, 11n*KAS);
  assert.equal(quote({...input, kind:'fill-bid'}).sellerReceivesSompi, 9n*KAS);
  assert.equal(quote({...input, kind:'cross-match'}).matcherPaysSompi, KAS);
  assert.throws(() => quote({...input, grossSompi:KAS/2n, kind:'fill-bid'}));
  assert.equal(quote({...input, creatorFeeBps:0, protocolWaived:true, kind:'take-ask'}).requiresFeeOutput, false);
});

test('each independent fill pays its minimum', () => {
  const input = {grossSompi:10n*KAS, creatorFeeBps:100, protocolWaived:false};
  assert.equal(Array.from({length:5}, () => fees(input).totalFeeSompi).reduce((a,b)=>a+b), 5n*KAS);
});

test('one grouped receipt sums exact per-fill fees and preserves ticket scope', () => {
  const sale = group({ kind:'fill-bid', fillGrossSompi:[10n*KAS, 10n*KAS, 100n*KAS],
    creatorFeeBps:100, protocolWaived:false });
  assert.deepEqual(sale.feeVector, [
    {protocolFeeSompi:KAS/2n, creatorFeeSompi:KAS/2n},
    {protocolFeeSompi:KAS/2n, creatorFeeSompi:KAS/2n},
    {protocolFeeSompi:KAS, creatorFeeSompi:KAS},
  ]);
  assert.equal(sale.receiptValueSompi, 4n*KAS);
  assert.equal(sale.sellerReceivesSompi, 116n*KAS);
  const waived = group({ kind:'take-ask', fillGrossSompi:[10n*KAS, 10n*KAS],
    creatorFeeBps:100, protocolWaived:true });
  assert.equal(waived.receiptValueSompi, KAS);
  assert.equal(waived.protocolFeeSompi, 0n);
  assert.equal(waived.buyerPaysSompi, 21n*KAS);
  const free = group({ kind:'take-ask', fillGrossSompi:[10n*KAS, 10n*KAS],
    creatorFeeBps:0, protocolWaived:true });
  assert.equal(free.requiresFeeOutput, false);
  assert.equal(free.receiptValueSompi, 0n);
});

test('trade group rejects crossed tickets and unsupported fill counts', () => {
  const input = { creatorFeeBps:0, protocolWaived:false };
  assert.throws(() => group({ ...input, kind:'cross-match', fillGrossSompi:[KAS], protocolWaived:true }));
  assert.throws(() => group({ ...input, kind:'cross-match', fillGrossSompi:[KAS,KAS] }));
  assert.throws(() => group({ ...input, kind:'fill-bid', fillGrossSompi:Array(11).fill(KAS) }));
  assert.throws(() => group({ ...input, kind:'take-ask', fillGrossSompi:Array(17).fill(KAS) }));
  assert.throws(() => group({ ...input, kind:'take-ask', fillGrossSompi:[] }));
  assert.throws(() => group({ ...input, kind:'take-ask', fillGrossSompi:[MAX,MAX] }));
});

test('both claim orders preserve conservation through a second claim', () => {
  for (const party of ['protocol', 'creator']) {
    const first = claim([receipt(0), receipt(1, KAS, 2n*KAS)], party);
    assert.equal(first.consumedSompi, first.claimSompi + first.remainderSompi);
    const next = receipt(2, first.remainingProtocolSompi, first.remainingCreatorSompi);
    const second = claim([next], party === 'creator' ? 'protocol' : 'creator');
    assert.equal(second.remainderSompi, 0n);
    assert.equal(first.claimSompi + second.claimSompi, first.consumedSompi);
  }
});

test('rejects duplicate receipts, mixed identity, incorrect values and empty entitlements', () => {
  assert.throws(() => claim([], 'protocol'));
  assert.throws(() => claim(Array.from({length:6}, (_,i)=>receipt(i)), 'creator'));
  assert.throws(() => claim([receipt(0), receipt(0)], 'protocol'));
  for (const field of ['tokenId','marketId','policyId','protocolAccountId','creatorAccountId'])
    assert.throws(() => claim([receipt(0), {...receipt(1), [field]:hex(9)}], 'creator'));
  assert.throws(() => claim([{...receipt(0), valueSompi:KAS+1n}], 'creator'));
  assert.throws(() => claim([receipt(0, KAS, 0n)], 'creator'));
  assert.throws(() => claim([receipt(0, 1n, KAS)], 'protocol'));
  assert.throws(() => claim([receipt(0, MAX, 1n)], 'protocol'));
  assert.throws(() => claim([receipt(0, MAX, 0n), receipt(1, KAS, 0n)], 'protocol'));
  for (const field of ['tokenId','marketId','policyId','protocolAccountId'])
    assert.throws(() => claim([{...receipt(0), [field]:hex(0)}], 'protocol'));
  assert.throws(() => claim([{...receipt(0), creatorAccountId:hex(4)}], 'protocol'));
  assert.throws(() => claim([{...receipt(0), creatorAccountId:hex(0)}], 'protocol'));
  assert.equal(claim([{...receipt(0, KAS, 0n), creatorAccountId:hex(0)}], 'protocol').claimSompi, KAS);
});

test('five independent receipts aggregate exactly', () => {
  const result = claim(Array.from({length:5}, (_,i)=>receipt(i)), 'creator');
  assert.equal(result.claimSompi, 5n*KAS/2n);
  assert.equal(result.remainderSompi, 5n*KAS/2n);
});
