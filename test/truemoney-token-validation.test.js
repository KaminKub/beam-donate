'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseTrueMoneyToken } = require('../src/truemoney-token');

test('TrueMoney webhook token rejects a profile URL even when it is longer than 32 characters', () => {
  const result = parseTrueMoneyToken('https://tipkub.com/streamer/example-profile-name');

  assert.equal(result.secret, null);
  assert.equal(result.reason, 'url');
});

test('TrueMoney webhook token rejects a profile URL without a scheme', () => {
  const result = parseTrueMoneyToken('tipkub.com/streamer/example-profile-name');

  assert.equal(result.secret, null);
  assert.equal(result.reason, 'url');
});

test('TrueMoney webhook token accepts a non-URL secret with at least 32 characters', () => {
  const result = parseTrueMoneyToken('a'.repeat(32));

  assert.equal(result.secret, 'a'.repeat(32));
  assert.equal(result.reason, undefined);
});

test('TrueMoney webhook token still rejects short input', () => {
  const result = parseTrueMoneyToken('a'.repeat(31));

  assert.equal(result.secret, null);
  assert.equal(result.reason, 'length');
});
