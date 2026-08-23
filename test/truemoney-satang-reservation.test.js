'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  acquirePaymentReservationLock,
  buildDescendingSatangAmounts
} = require('../src/payment-reservation');

test('satang candidates run smallest-deduction-first so the donor always pays at most the intended amount', () => {
  const candidates = buildDescendingSatangAmounts(50);
  assert.equal(candidates.length, 99);
  assert.deepEqual(candidates.slice(0, 3), [49.99, 49.98, 49.97]);
  assert.equal(candidates[98], 49.01);
  assert.ok(candidates.every(amount => amount < 50));
});

test('satang candidates fail closed when the intended amount is too small to deduct from', () => {
  assert.deepEqual(buildDescendingSatangAmounts(0.99), []);
});

test('same streamer reservation lock serializes concurrent allocators', async () => {
  const first = await acquirePaymentReservationLock('Streamer');
  let secondEntered = false;
  const second = acquirePaymentReservationLock('streamer').then(release => {
    secondEntered = true;
    release();
  });
  await Promise.resolve();
  assert.equal(secondEntered, false);
  first();
  await second;
  assert.equal(secondEntered, true);
});
