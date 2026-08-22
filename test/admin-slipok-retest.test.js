// Phase A of ADMIN_SLIPOK_RECONNECT: the shared retest service. No production credential is
// used — every fixture is encrypted here with a throwaway key set before src/encryption loads.
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'test-master-key-for-slipok-retest-unit-test';
process.env.ENCRYPTION_SALT = process.env.ENCRYPTION_SALT || 'test-salt-slipok';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { encrypt } = require('../src/encryption');
const {
  validateSlipOkUrl,
  inferSlipOkBasePlan,
  classifySlipOkEndDate,
  resolveSlipOkLane,
  getStoredSlipOkCredentialSets,
  retestStoredSlipOk
} = require('../src/slipok-connection');

const URL_A = 'https://api.slipok.com/api/line/apikey/AAA';
const KEY_A = 'SLIPOK-TEST-KEY-AAA';
const URL_B = 'https://api.slipok.com/api/line/apikey/BBB';
const KEY_B = 'SLIPOK-TEST-KEY-BBB';

function streamerWith({ promptpay, truemoney, ...rest } = {}) {
  return {
    username: 'fixture_user',
    is_active: 1,
    slipok_connected: 0,
    truemoney_slipok_connected: 0,
    slipok_api_encrypted: promptpay ? encrypt(promptpay.url) : null,
    slipok_api_key_encrypted: promptpay ? encrypt(promptpay.key) : null,
    truemoney_slipok_api_encrypted: truemoney ? encrypt(truemoney.url) : null,
    truemoney_slipok_api_key_encrypted: truemoney ? encrypt(truemoney.key) : null,
    ...rest
  };
}

// Records every upstream call so "one call for an identical pair" is provable.
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

const okResponse = quota => Promise.resolve({ data: { success: true, data: { quota, endDate: '2099-12-31' } } });
const quotaResponse = ({ quota = 0, endDate = null } = {}) => Promise.resolve({ data: { success: true, data: { quota, endDate } } });
const slipOkError = code => Promise.reject(Object.assign(new Error(`branch ${URL_A} key ${KEY_A}`), {
  response: { status: 400, data: { code, message: `secret in body: ${KEY_A}` } }
}));

test('expiry classifier treats a strict yyyy-MM-dd as usable through that Bangkok calendar day', () => {
  const endDate = '2026-08-22';
  const beforeBangkokMidnight = classifySlipOkEndDate(endDate, Date.parse('2026-08-22T00:00:00.000Z'));
  const endOfBangkokDay = classifySlipOkEndDate(endDate, Date.parse('2026-08-22T16:59:59.999Z'));
  const nextBangkokDay = classifySlipOkEndDate(endDate, Date.parse('2026-08-22T17:00:00.000Z'));

  assert.equal(beforeBangkokMidnight.valid, true);
  assert.equal(beforeBangkokMidnight.expired, false);
  assert.equal(endOfBangkokDay.expired, false);
  assert.equal(nextBangkokDay.expired, true);
});

test('expiry classifier fails closed for null, invalid, and timestamp-shaped end dates', () => {
  for (const endDate of [null, '', '2026-02-30', '2026-08-22T00:00:00.000Z']) {
    const result = classifySlipOkEndDate(endDate, Date.parse('2026-08-23T00:00:00.000Z'));
    assert.equal(result.valid, false, String(endDate));
    assert.equal(result.expired, false, String(endDate));
  }
});

test('null, invalid, malformed, or success:false quota responses never reconnect or disconnect', async () => {
  const cases = [
    quotaResponse({ quota: 80, endDate: null }),
    quotaResponse({ quota: 80, endDate: '2026-02-30' }),
    Promise.resolve({ data: { success: false } }),
    Promise.resolve({ data: { success: true, data: null } })
  ];

  for (const response of cases) {
    const axiosClient = fakeAxios(() => response);
    const streamer = streamerWith({ promptpay: { url: URL_A, key: KEY_A }, slipok_connected: 1 });
    const { ok, results, patch } = await retestStoredSlipOk({ streamer, axiosClient, now: 'NOW' });
    assert.equal(ok, false);
    assert.equal(results[0].authoritative, false);
    assert.deepEqual(patch, {});
  }
});

test('an HTTP 200 provider code 1003 remains authoritative expired evidence', async () => {
  const axiosClient = fakeAxios(() => Promise.resolve({ data: { success: false, code: 1003 } }));
  const streamer = streamerWith({ promptpay: { url: URL_A, key: KEY_A }, slipok_connected: 1 });
  const { results, patch } = await retestStoredSlipOk({ streamer, axiosClient, now: 'NOW' });

  assert.equal(results[0].expired, true);
  assert.equal(results[0].authoritative, true);
  assert.deepEqual(patch, { slipok_connected: 0, slipok_last_check: 'NOW' });
});

test('effective lane is primary-first and does not let a connected fallback mask a failed primary', () => {
  const primaryWins = resolveSlipOkLane({
    slipok_api: URL_A,
    slipok_api_key: KEY_A,
    truemoney_slipok_api: URL_B,
    truemoney_slipok_api_key: KEY_B,
    slipok_connected: 0,
    truemoney_slipok_connected: 1
  });
  assert.deepEqual(primaryWins, {
    configured: true,
    effectiveScope: 'promptpay',
    ready: false,
    promptpayConfigured: true,
    truemoneyConfigured: true,
    promptpayConnected: false,
    truemoneyConnected: true
  });

  const fallbackOnly = resolveSlipOkLane({
    slipok_api: URL_A,
    slipok_api_key: '',
    truemoney_slipok_api: URL_B,
    truemoney_slipok_api_key: KEY_B,
    truemoney_slipok_connected: 1
  });
  assert.equal(fallbackOnly.effectiveScope, 'truemoney');
  assert.equal(fallbackOnly.ready, true);
  assert.equal(JSON.stringify(fallbackOnly).includes(KEY_A), false);
  assert.equal(JSON.stringify(fallbackOnly).includes(URL_A), false);
});

test('refuses before any upstream call when no credential pair is stored', async () => {
  const axiosClient = fakeAxios(() => okResponse(10));
  const result = await retestStoredSlipOk({ streamer: streamerWith(), axiosClient });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'USER_ACTION_REQUIRED');
  assert.equal(result.patch, null);
  assert.equal(axiosClient.calls.length, 0);
});

test('a half-configured scope is not testable', () => {
  const half = streamerWith({ promptpay: { url: URL_A, key: KEY_A } });
  half.slipok_api_key_encrypted = null;
  assert.deepEqual(getStoredSlipOkCredentialSets(half), []);
});

test('an identical primary/TrueMoney pair costs one call and updates both scopes', async () => {
  const axiosClient = fakeAxios(() => okResponse(240));
  const streamer = streamerWith({
    promptpay: { url: URL_A, key: KEY_A },
    truemoney: { url: URL_A, key: KEY_A }
  });

  const { ok, results, patch } = await retestStoredSlipOk({ streamer, axiosClient, now: 'NOW' });

  assert.equal(axiosClient.calls.length, 1);
  assert.equal(ok, true);
  assert.deepEqual(results.map(r => r.scope), ['promptpay', 'truemoney']);
  assert.deepEqual(patch, {
    slipok_connected: 1, slipok_last_check: 'NOW', slipok_expiry: '2099-12-31', slipok_quota_total: 500,
    truemoney_slipok_connected: 1, truemoney_slipok_last_check: 'NOW', truemoney_slipok_expiry: '2099-12-31', truemoney_slipok_quota_total: 500
  });
});

test('distinct pairs are isolated — one failure does not flip the other scope', async () => {
  const axiosClient = fakeAxios(url => url.includes('BBB') ? slipOkError(1003) : okResponse(80));
  const streamer = streamerWith({
    promptpay: { url: URL_A, key: KEY_A },
    truemoney: { url: URL_B, key: KEY_B }
  });

  const { ok, results, patch } = await retestStoredSlipOk({ streamer, axiosClient, now: 'NOW' });

  assert.equal(axiosClient.calls.length, 2);
  assert.equal(ok, false);
  assert.deepEqual(results.map(({ scope, success, quota, errorCode, authoritative, expired, reason }) => ({
    scope, success, quota, errorCode, authoritative, expired, reason
  })), [
    { scope: 'promptpay', success: true, quota: 80, errorCode: null, authoritative: false, expired: false, reason: null },
    { scope: 'truemoney', success: false, quota: null, errorCode: '1003', authoritative: true, expired: true, reason: 'expired' }
  ]);
  assert.equal(patch.slipok_connected, 1);
  assert.equal(patch.truemoney_slipok_connected, 0);
  // A failed scope keeps its old quota snapshot rather than zeroing it.
  assert.equal('truemoney_slipok_quota_total' in patch, false);
});

test('expired quota disconnects only the tested scope and never reconnects it', async () => {
  const axiosClient = fakeAxios(() => quotaResponse({ quota: 80, endDate: '2026-08-22' }));
  const streamer = streamerWith({
    promptpay: { url: URL_A, key: KEY_A },
    truemoney: { url: URL_B, key: KEY_B },
    slipok_connected: 1,
    truemoney_slipok_connected: 1
  });

  const { ok, results, patch } = await retestStoredSlipOk({
    streamer,
    axiosClient,
    now: 'NOW',
    nowMs: Date.parse('2026-08-22T17:00:00.000Z')
  });

  assert.equal(ok, false);
  assert.equal(results[0].expired, true);
  assert.equal(results[0].authoritative, true);
  assert.equal(results[0].reason, 'expired');
  assert.deepEqual(patch, { slipok_connected: 0, slipok_last_check: 'NOW', slipok_expiry: '2026-08-22', truemoney_slipok_connected: 0, truemoney_slipok_last_check: 'NOW', truemoney_slipok_expiry: '2026-08-22' });
});

test('provider code 1003 is authoritative expired evidence even without an end date', async () => {
  const axiosClient = fakeAxios(() => slipOkError(1003));
  const streamer = streamerWith({
    promptpay: { url: URL_A, key: KEY_A },
    slipok_connected: 1
  });

  const { results, patch } = await retestStoredSlipOk({ streamer, axiosClient, now: 'NOW' });

  assert.equal(results[0].authoritative, true);
  assert.equal(results[0].expired, true);
  assert.equal(results[0].reason, 'expired');
  assert.deepEqual(patch, { slipok_connected: 0, slipok_last_check: 'NOW' });
});

test('account issue codes disconnect only their tested scope, but transient failures do not patch state', async () => {
  for (const code of [1002, 1004, 1015]) {
    const axiosClient = fakeAxios(() => slipOkError(code));
    const streamer = streamerWith({ promptpay: { url: URL_A, key: KEY_A }, slipok_connected: 1 });
    const { results, patch } = await retestStoredSlipOk({ streamer, axiosClient, now: 'NOW' });
    assert.equal(results[0].authoritative, true, String(code));
    assert.equal(results[0].reason, 'account-issue', String(code));
    assert.deepEqual(patch, { slipok_connected: 0, slipok_last_check: 'NOW' }, String(code));
  }

  const timeoutClient = fakeAxios(() => Promise.reject(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })));
  const streamer = streamerWith({ promptpay: { url: URL_A, key: KEY_A }, slipok_connected: 1 });
  const { results, patch } = await retestStoredSlipOk({ streamer, axiosClient: timeoutClient, now: 'NOW' });
  assert.equal(results[0].authoritative, false);
  assert.deepEqual(patch, {});
});

test('an untested scope is absent from the patch', async () => {
  const axiosClient = fakeAxios(() => okResponse(10));
  const streamer = streamerWith({ promptpay: { url: URL_A, key: KEY_A } });

  const { patch } = await retestStoredSlipOk({ streamer, axiosClient, now: 'NOW' });

  assert.deepEqual(Object.keys(patch).sort(), ['slipok_connected', 'slipok_expiry', 'slipok_last_check', 'slipok_quota_total']);
});

test('the patch never carries credential, account or verified fields', async () => {
  const axiosClient = fakeAxios(() => okResponse(10));
  const streamer = streamerWith({
    promptpay: { url: URL_A, key: KEY_A },
    truemoney: { url: URL_B, key: KEY_B },
    promptpay_value_encrypted: encrypt('0812345678'),
    bank_account_number_encrypted: encrypt('1234567890'),
    promptpay_account_verified: 0,
    bank_account_verified: 0,
    truemoney_account_verified: 0
  });

  const { patch } = await retestStoredSlipOk({ streamer, axiosClient, now: 'NOW' });

  const allowed = new Set([
    'slipok_connected', 'slipok_expiry', 'slipok_last_check', 'slipok_quota_total',
    'truemoney_slipok_connected', 'truemoney_slipok_expiry', 'truemoney_slipok_last_check', 'truemoney_slipok_quota_total'
  ]);
  for (const key of Object.keys(patch)) assert.ok(allowed.has(key), `patch leaked column ${key}`);
});

test('no plaintext or encrypted secret survives into the result', async () => {
  const axiosClient = fakeAxios(() => slipOkError(1002));
  const streamer = streamerWith({ promptpay: { url: URL_A, key: KEY_A } });

  const result = await retestStoredSlipOk({ streamer, axiosClient, now: 'NOW' });
  const serialized = JSON.stringify(result);

  for (const secret of [KEY_A, URL_A, streamer.slipok_api_encrypted, streamer.slipok_api_key_encrypted, 'secret in body']) {
    assert.equal(serialized.includes(secret), false, `result leaked ${secret.slice(0, 12)}…`);
  }
  assert.equal(result.results[0].errorCode, '1002');
});

test('a transport failure reports its code, never its message', async () => {
  const axiosClient = fakeAxios(() => Promise.reject(Object.assign(new Error(`connect ETIMEDOUT ${URL_A}`), { code: 'ETIMEDOUT' })));
  const streamer = streamerWith({ promptpay: { url: URL_A, key: KEY_A } });

  const { results, patch } = await retestStoredSlipOk({ streamer, axiosClient, now: 'NOW' });

  assert.deepEqual(
    (({ scope, success, quota, errorCode, authoritative, expired, reason }) => ({ scope, success, quota, errorCode, authoritative, expired, reason }))(results[0]),
    { scope: 'promptpay', success: false, quota: null, errorCode: 'ETIMEDOUT', authoritative: false, expired: false, reason: null }
  );
  assert.deepEqual(patch, {});
});

test('a stored URL outside the SlipOK allowlist is refused without calling it', async () => {
  const axiosClient = fakeAxios(() => okResponse(10));
  const streamer = streamerWith({ promptpay: { url: 'https://evil.example.com/api/quota', key: KEY_A } });

  const { results } = await retestStoredSlipOk({ streamer, axiosClient, now: 'NOW' });

  assert.equal(axiosClient.calls.length, 0);
  assert.equal(results[0].errorCode, 'INVALID_URL');
});

test('validateSlipOkUrl keeps the SEC-003 allowlist', () => {
  assert.doesNotThrow(() => validateSlipOkUrl(URL_A));
  assert.throws(() => validateSlipOkUrl('http://api.slipok.com/x'), /HTTPS/);
  assert.throws(() => validateSlipOkUrl('https://api.slipok.com.evil.test/x'), /not allowed/);
  assert.throws(() => validateSlipOkUrl(''), /required/);
});

test('inferSlipOkBasePlan picks the smallest package that fits the remainder', () => {
  assert.equal(inferSlipOkBasePlan(0), 100);
  assert.equal(inferSlipOkBasePlan(100), 100);
  assert.equal(inferSlipOkBasePlan(101), 500);
  assert.equal(inferSlipOkBasePlan(12000), 12000);
});

test('the quota snapshot only ever grows', async () => {
  const axiosClient = fakeAxios(() => okResponse(50));
  const streamer = streamerWith({ promptpay: { url: URL_A, key: KEY_A }, slipok_quota_total: 5000 });

  const { patch } = await retestStoredSlipOk({ streamer, axiosClient, now: 'NOW' });

  assert.equal(patch.slipok_quota_total, 5000);
});

test('the admin retest CLI applies post-provider states through scoped CAS, never saveStreamer', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'retest-slipok.js'), 'utf8');

  assert.match(script, /db\.disconnectSlipOkScopeIfUnchanged\(/);
  assert.match(script, /db\.reconnectSlipOkScopeIfUnchanged\(/);
  assert.match(script, /result\.success && result\.endDateValid && !result\.expired/);
  assert.doesNotMatch(script, /db\.saveStreamer\(/);
});
