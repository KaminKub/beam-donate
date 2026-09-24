const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const {
  classifySlipOkEndDate,
  isSlipOkScopeExpired,
  resolveSlipOkLane
} = require('../src/slipok-connection');

const serverSource = fs.readFileSync(require.resolve('../src/server'), 'utf8');

const PRIMARY = {
  slipok_api: 'https://api.slipok.com/api/line/apikey/test',
  slipok_api_key: 'test-key',
  slipok_connected: 1
};

test('cached authoritative expiry disables the effective lane before legal acceptance is relevant', () => {
  const source = { ...PRIMARY, slipok_expiry: '2026-09-23' };
  const now = Date.parse('2026-09-24T03:00:00.000Z');

  assert.deepEqual(classifySlipOkEndDate(source.slipok_expiry, now), {
    valid: true,
    endDate: '2026-09-23',
    expired: true
  });
  assert.equal(isSlipOkScopeExpired(source, 'promptpay', now), true);
  assert.equal(resolveSlipOkLane(source).ready, false);
});

test('public donor endpoint persists cached expiry and returns the fail-closed lane', () => {
  const endpoint = serverSource.slice(
    serverSource.indexOf("app.get('/api/page/:username/payment-methods'"),
    serverSource.indexOf("const UPLOAD_MAX_SIZES")
  );

  assert.match(endpoint, /const slipOkState = resolveSlipOkLane\(decrypted\);/);
  assert.match(endpoint, /isSlipOkScopeExpired\(decrypted, slipOkState\.effectiveScope\)/);
  assert.match(endpoint, /persistAuthoritativeSlipOkDisconnect\(/);
  assert.match(endpoint, /slipok_ready: slipOkState\.ready/);
});

test('PromptPay QR creation has a server-side expiry guard independent of dashboard legal acceptance', () => {
  const route = serverSource.slice(
    serverSource.indexOf("app.post('/api/create-promptpay-qr'"),
    serverSource.lastIndexOf("// POST /api/truemoney/webhook")
  );

  assert.match(route, /isSlipOkScopeExpired\(decryptedPayment, 'promptpay'\)/);
  assert.match(route, /errorCode: 'SLIPOK_EXPIRED'/);
});
