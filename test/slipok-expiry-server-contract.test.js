'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

function routeSlice(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, `missing route start: ${start}`);
  assert.notEqual(to, -1, `missing route end: ${end}`);
  return source.slice(from, to);
}

test('quota refresh uses server classification and scoped compare-and-set disconnects', () => {
  const quota = routeSlice("app.get('/api/payment/slipok-quota'", "// POST /api/truemoney/webhook");

  assert.match(quota, /requestedScope = getRequestedSlipOkScope\(method\);/);
  assert.match(quota, /const quotaOutcome = classifySlipOkQuotaResponse\(response\.data, Date\.now\(\)\);/);
  assert.match(quota, /await persistAuthoritativeSlipOkDisconnect\(streamer, requestedScope, now\);/);
  assert.match(quota, /await persistSlipOkQuotaSnapshot\(streamer, requestedScope, quotaCandidate\);/);
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
