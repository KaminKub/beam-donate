'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'check-expiry-test-master-key';
process.env.ENCRYPTION_SALT = process.env.ENCRYPTION_SALT || 'check-expiry-test-salt';

const { encrypt } = require('../src/encryption');
const {
  checkStoredSlipOkExpiry,
  applyExpiryOnlyDisconnects,
  main
} = require('../scripts/check-slipok-expiry');

const PROMPTPAY_URL = 'https://api.slipok.com/api/line/apikey/CHECK-PROMPTPAY';
const PROMPTPAY_KEY = 'CHECK-PROMPTPAY-KEY';
const TRUEMONEY_URL = 'https://api.slipok.com/api/line/apikey/CHECK-TRUEMONEY';
const TRUEMONEY_KEY = 'CHECK-TRUEMONEY-KEY';

function streamer(overrides = {}) {
  return {
    id: 17,
    username: 'noungbob',
    payment_eligibility_version: null,
    slipok_api_encrypted: encrypt(PROMPTPAY_URL),
    slipok_api_key_encrypted: encrypt(PROMPTPAY_KEY),
    slipok_connected: 1,
    slipok_last_check: '2026-09-01T00:00:00.000Z',
    slipok_expiry: '2026-09-08',
    truemoney_slipok_api_encrypted: encrypt(TRUEMONEY_URL),
    truemoney_slipok_api_key_encrypted: encrypt(TRUEMONEY_KEY),
    truemoney_slipok_connected: 1,
    truemoney_slipok_last_check: '2026-09-01T00:00:00.000Z',
    truemoney_slipok_expiry: null,
    ...overrides
  };
}

function fakeAxios(handler) {
  const calls = [];
  return {
    calls,
    get(url, config) {
      calls.push({ url, config });
      return handler(url, config);
    }
  };
}

function quota(endDate, quota = 80) {
  return Promise.resolve({ data: { success: true, data: { quota, endDate } } });
}

test('missing payment eligibility does not block an expiry-only expired result or scoped disconnect', async () => {
  const row = streamer();
  const axiosClient = fakeAxios(url => url.includes('CHECK-PROMPTPAY')
    ? quota('2026-09-08')
    : quota('2099-12-31'));
  const writes = [];
  const database = {
    async disconnectSlipOkScopeIfUnchanged(current, scope, checkedAt, endDate) {
      writes.push({ id: current.id, scope, checkedAt, endDate });
      return { rowsAffected: 1, skipped: false };
    }
  };

  const checks = await checkStoredSlipOkExpiry({
    streamer: row,
    axiosClient,
    nowMs: Date.parse('2026-09-24T03:00:00.000Z')
  });
  assert.deepEqual(checks.map(check => [check.scope, check.status]), [
    ['promptpay', 'expired'],
    ['truemoney', 'renewed']
  ]);

  const result = await applyExpiryOnlyDisconnects(row, checks, {
    database,
    checkedAt: '2026-09-24T00:00:00.000Z'
  });
  assert.deepEqual(writes, [{
    id: 17,
    scope: 'promptpay',
    checkedAt: '2026-09-24T00:00:00.000Z',
    endDate: '2026-09-08'
  }]);
  assert.deepEqual(result, { disconnected: 1, alreadyDisconnected: 0, stale: 0, writeFailures: 0 });
});

test('a renewed provider result is reported but never reconnects or writes state', async () => {
  const row = streamer({ slipok_connected: 0 });
  const axiosClient = fakeAxios(() => quota('2099-12-31'));
  const calls = [];
  const checks = await checkStoredSlipOkExpiry({ streamer: row, axiosClient });
  const result = await applyExpiryOnlyDisconnects(row, checks, {
    database: {
      async disconnectSlipOkScopeIfUnchanged() { calls.push('disconnect'); }
    }
  });

  assert.equal(checks[0].status, 'renewed');
  assert.deepEqual(result, { disconnected: 0, alreadyDisconnected: 0, stale: 0, writeFailures: 0 });
  assert.deepEqual(calls, []);
});

test('transient and malformed outcomes remain unknown and do not mutate the database', async () => {
  const row = streamer();
  const axiosClient = fakeAxios(url => url.includes('CHECK-PROMPTPAY')
    ? Promise.reject(Object.assign(new Error('timeout with secret body'), { code: 'ETIMEDOUT' }))
    : Promise.resolve({ data: { success: true, data: { quota: 10, endDate: null } } }));
  let writes = 0;
  const checks = await checkStoredSlipOkExpiry({ streamer: row, axiosClient });
  const result = await applyExpiryOnlyDisconnects(row, checks, {
    database: {
      async disconnectSlipOkScopeIfUnchanged() { writes++; }
    }
  });

  assert.deepEqual(checks.map(check => check.status), ['unknown', 'unknown']);
  assert.deepEqual(result, { disconnected: 0, alreadyDisconnected: 0, stale: 0, writeFailures: 0 });
  assert.equal(writes, 0);
});

test('PromptPay and TrueMoney authoritative outcomes stay scoped', async () => {
  const row = streamer();
  const axiosClient = fakeAxios(url => url.includes('CHECK-PROMPTPAY')
    ? Promise.resolve({ data: { success: false, code: 1003 } })
    : Promise.resolve({ data: { success: false, code: 1002 } }));
  const writes = [];
  const checks = await checkStoredSlipOkExpiry({
    streamer: row,
    axiosClient,
    nowMs: Date.parse('2026-09-24T03:00:00.000Z')
  });
  await applyExpiryOnlyDisconnects(row, checks, {
    database: {
      async disconnectSlipOkScopeIfUnchanged(current, scope) {
        writes.push(scope);
        return { rowsAffected: 1 };
      }
    }
  });

  assert.deepEqual(checks.map(check => [check.scope, check.status]), [
    ['promptpay', 'expired'],
    ['truemoney', 'account-issue']
  ]);
  assert.deepEqual(writes, ['promptpay', 'truemoney']);
});

test('not-configured and unreadable scopes are explicit, and output has no secret/provider-body boundary leak', async () => {
  const row = streamer({
    truemoney_slipok_api_encrypted: null,
    truemoney_slipok_api_key_encrypted: encrypt(TRUEMONEY_KEY)
  });
  const checks = await checkStoredSlipOkExpiry({
    streamer: row,
    axiosClient: fakeAxios(() => quota('2099-12-31'))
  });
  assert.equal(checks.find(check => check.scope === 'truemoney').status, 'unknown');

  const noCredentials = streamer({
    slipok_api_encrypted: null,
    slipok_api_key_encrypted: null,
    truemoney_slipok_api_encrypted: null,
    truemoney_slipok_api_key_encrypted: null
  });
  const inventory = await checkStoredSlipOkExpiry({
    streamer: noCredentials,
    axiosClient: fakeAxios(() => quota('2099-12-31'))
  });
  assert.deepEqual(inventory.map(check => [check.scope, check.status]), [
    ['promptpay', 'not-configured'],
    ['truemoney', 'not-configured']
  ]);

  const serialized = JSON.stringify(checks);
  for (const secret of [PROMPTPAY_URL, PROMPTPAY_KEY, TRUEMONEY_URL, TRUEMONEY_KEY, 'timeout with secret body']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('CLI does not use the payment eligibility guard or reconnect/credential mutation paths', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-slipok-expiry.js'), 'utf8');
  assert.doesNotMatch(source, /PAYMENT_ELIGIBILITY_VERSION/);
  assert.doesNotMatch(source, /reconnectSlipOk|saveStreamer|applyScopedSlipOkExplicitRetest/);
});

test('CLI main can probe a user with missing eligibility and only executes scoped disconnects', async () => {
  const row = streamer({ truemoney_slipok_connected: 0 });
  const axiosClient = fakeAxios(url => url.includes('CHECK-PROMPTPAY')
    ? quota('2026-09-08')
    : quota('2099-12-31'));
  const writes = [];
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = line => lines.push(String(line));
  console.error = line => lines.push(String(line));
  try {
    const code = await main({
      argv: ['--username', 'noungbob', '--execute'],
      database: {
        async initDB() {},
        async getStreamer() { return row; },
        async disconnectSlipOkScopeIfUnchanged(current, scope, checkedAt, endDate) {
          writes.push({ current, scope, checkedAt, endDate });
          return { rowsAffected: 1 };
        }
      },
      axiosClient,
      nowMs: Date.parse('2026-09-24T03:00:00.000Z'),
      checkedAt: '2026-09-24T00:00:00.000Z'
    });
    assert.equal(code, 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.deepEqual(writes.map(write => write.scope), ['promptpay']);
  assert.equal(lines.some(line => line.includes(PROMPTPAY_URL) || line.includes(PROMPTPAY_KEY)), false);
  assert.equal(lines.some(line => line.includes('renewed')), true);
  assert.equal(lines.some(line => line.includes('expired')), true);
});
