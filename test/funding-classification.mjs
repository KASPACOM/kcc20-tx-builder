import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectFundingEntry } from '../dist/sale-common.js';
const entry = (amount, id = 'a') => ({amount, outpoint: { transactionId: id.repeat(64), index: 0 }});
test('0.39 KAS cannot fund a 0.5002 KAS transaction by consolidating', () => {
  assert.throws(() => selectFundingEntry([entry('39000000')], 50020000n), error => {
    assert.equal(error.builderErrorCode, 'INSUFFICIENT_KAS_BALANCE');
    assert.equal(error.builderErrorDetails.shortfallSompi, '11020000');
    return true;
  });
});
test('enough total but no single entry is fragmented', () => {
  assert.throws(() => selectFundingEntry([entry('30000000'), entry('30000000', 'b')], 50020000n), error => {
    assert.equal(error.builderErrorCode, 'INSUFFICIENT_SINGLE_KAS_UTXO');
    assert.equal(error.builderErrorDetails.availableFundingSompi, '60000000');
    return true;
  });
});
test('reserved inputs do not count as available funding', () => {
  assert.throws(() => selectFundingEntry([entry('30000000'), entry('30000000', 'b')], 50020000n, [`${'b'.repeat(64)}:0`]), error => {
    assert.equal(error.builderErrorCode, 'INSUFFICIENT_KAS_BALANCE');
    assert.equal(error.builderErrorDetails.availableFundingSompi, '30000000');
    return true;
  });
});
test('sufficient funding is selected unchanged', () => {
  const good = entry('60000000');
  assert.equal(selectFundingEntry([good], 50020000n), good);
});
