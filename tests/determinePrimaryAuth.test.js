const { test } = require('node:test');
const assert = require('node:assert/strict');
const { determinePrimaryAuth } = require('../src/auth-helpers');

const cases = [
  [{ primary_auth_provider: 'streamlabs', twitch_id: '123', streamlabs_id: '456' }, 'streamlabs', 'explicit streamlabs'],
  [{ primary_auth_provider: 'twitch', twitch_id: '123', streamlabs_id: '456' }, 'twitch', 'explicit twitch'],
  [{ primary_auth_provider: null, twitch_id: '123', streamlabs_id: null }, 'twitch', 'null + only twitch'],
  [{ primary_auth_provider: null, twitch_id: null, streamlabs_id: '456' }, 'streamlabs', 'null + only streamlabs'],
  [{ primary_auth_provider: null, twitch_id: '123', streamlabs_id: '456' }, 'twitch', 'null + both different -> default twitch'],
  [{ primary_auth_provider: null, twitch_id: '123', streamlabs_id: '123' }, 'streamlabs', 'null + both same ID -> streamlabs'],
  [{ primary_auth_provider: '', twitch_id: '123', streamlabs_id: null }, 'twitch', 'empty string + only twitch'],
  [{ primary_auth_provider: undefined, twitch_id: null, streamlabs_id: '456' }, 'streamlabs', 'undefined + only streamlabs'],
];

for (const [input, expected, label] of cases) {
  test(label, () => {
    assert.equal(determinePrimaryAuth(input), expected);
  });
}
