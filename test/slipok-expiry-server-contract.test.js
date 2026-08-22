'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeSlipOkScope } = require('../src/slipok-connection');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const dashboardSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard', 'dashboard.js'), 'utf8');

function routeSlice(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, `missing route start: ${start}`);
  assert.notEqual(to, -1, `missing route end: ${end}`);
  return source.slice(from, to);
}

test('bank SlipOK tests use the shared primary PromptPay credential lane', () => {
  assert.equal(normalizeSlipOkScope('bank'), 'promptpay');
  assert.equal(normalizeSlipOkScope('promptpay'), 'promptpay');
  assert.equal(normalizeSlipOkScope('truemoney'), 'truemoney');
  assert.equal(normalizeSlipOkScope('unknown'), null);
});

test('inline SlipOK links own their busy state while the shared test runs', () => {
  assert.match(dashboardSource, /testSlipOkConnection\(btn\.getAttribute\('data-method'\) \|\| 'promptpay', btn\)/);
  assert.match(dashboardSource, /async function testSlipOkConnection\(method, triggerButton = null\)/);
  assert.match(dashboardSource, /const btn = triggerButton \|\| document\.getElementById\('btnTestSlipOk'\);/);
});

test('inline SlipOK links restore their own label after a failed request', async () => {
  const start = dashboardSource.indexOf('async function testSlipOkConnection');
  const end = dashboardSource.indexOf('\n\nasync function savePaymentSettings', start);
  assert.ok(start >= 0 && end > start, 'SlipOK test function boundaries should remain discoverable');

  const button = { disabled: false, innerHTML: 'คลิกทดสอบ API' };
  const fields = {
    inputSlipOkApi: { value: 'https://api.slipok.dev' },
    inputSlipOkApiKey: { value: 'test-key' },
    inputPromptPayType: { value: 'phone' },
    inputPromptPay: { value: '0812345678' },
    inputTrueMoneyPhone: { value: '0812345678' }
  };
  const context = {
    document: { getElementById: id => fields[id] || button },
    fetchWithCsrf: async () => { throw new Error('simulated provider failure'); },
    showNotification: () => {}
  };
  const testSlipOkConnection = vm.runInNewContext(`(${dashboardSource.slice(start, end)})`, context);

  await testSlipOkConnection('bank', button);

  assert.equal(button.disabled, false);
  assert.equal(button.innerHTML, 'คลิกทดสอบ API');
});

test('quota refresh uses server classification and scoped compare-and-set disconnects', () => {
  const quota = routeSlice("app.get('/api/payment/slipok-quota'", "// POST /api/truemoney/webhook");

  assert.match(quota, /requestedScope = normalizeSlipOkScope\(method\);/);
  assert.match(quota, /const quotaOutcome = classifySlipOkQuotaResponse\(response\.data, Date\.now\(\)\);/);
  assert.match(quota, /await persistAuthoritativeSlipOkDisconnect\(streamer, requestedScope, now, quotaOutcome\.endDate\);/);
  assert.match(quota, /await persistSlipOkQuotaSnapshot\(streamer, requestedScope, quotaCandidate, quotaOutcome\.endDate\);/);
  assert.match(quota, /Unknown\/malformed quota payloads are deliberately read-only/);
  assert.doesNotMatch(quota, /err\.message/);
  assert.doesNotMatch(quota, /db\.saveStreamer/);
  assert.doesNotMatch(quota, /slipok_connected: 0, slipok_last_check: .*truemoney_slipok_connected: 0/);
});

test('explicit test only reconnects after a valid usable date and never echoes raw errors', () => {
  const testRoute = routeSlice("app.post('/api/payment/test-slipok'", "// GET /api/payment/slipok-quota");

  assert.match(testRoute, /const quotaOutcome = classifySlipOkQuotaResponse\(response\.data, Date\.now\(\)\);/);
  assert.match(testRoute, /if \(!quotaOutcome\.success \|\| !quotaOutcome\.endDateValid\)/);
  assert.match(testRoute, /storedCredentialMatch = realApi === storedSet\.url && realApiKey === storedSet\.key;/);
  assert.match(testRoute, /persistAuthoritativeSlipOkDisconnect\(streamerBeforeProbe, evidenceScope/);
  assert.match(testRoute, /await persistExplicitSlipOkRetest\(streamerBeforeProbe, evidenceScope/);
  assert.doesNotMatch(testRoute, /err\.message/);
  assert.doesNotMatch(testRoute, /db\.saveStreamer/);
});

test('donor verification disconnects only the effective credential lane', () => {
  const verify = routeSlice("app.post('/api/verify-slip'", "app.post('/api/verify-promptpay-slip'");

  assert.match(verify, /const effectiveSlipOk = getEffectiveSlipOkCredentialSet\(decrypted\);/);
  assert.match(verify, /const accountIssue = classifySlipOkErrorCode\(result\.slipSubCode\);/);
  assert.match(verify, /persistAuthoritativeSlipOkDisconnect\(streamer, slipOkScope/);
  assert.doesNotMatch(verify, /truemoney_slipok_connected: 0/);
});
