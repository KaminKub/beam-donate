const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isSlipUploadWindowClosed, SLIP_UPLOAD_GRACE_MS } = require('../src/payment-helpers');

const root = path.join(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'public/donate-template/index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'public/donate-template/app.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');

test('expired QR UI has a blurred overlay state for both QR flows', () => {
  assert.match(htmlSource, /id="qrContainer"[^>]*class="qr-container"/);
  assert.match(htmlSource, /id="trueMoneyQrDisplayBox"[^>]*class="qr-display-box"/);
  assert.match(htmlSource, /id="qrExpiredOverlay"/);
  assert.match(htmlSource, /id="trueMoneyQrExpiredOverlay"/);
  assert.match(htmlSource, /qr-display-expired #qrImage[\s\S]*filter: blur\(10px\)/);
  assert.match(htmlSource, /qr-display-expired #trueMoneyQrImage[\s\S]*filter: blur\(10px\)/);
  assert.match(appSource, /function setQrExpiredVisualState\(expired\)/);
  assert.match(appSource, /qrContainer\?\.classList\.toggle\('qr-display-expired', expired\)/);
  assert.match(appSource, /trueMoneyQrDisplayBox\?\.classList\.toggle\('qr-display-expired', expired\)/);
  assert.match(appSource, /function showQRExpired\(\)[\s\S]*setQrExpiredVisualState\(true\)/);
  assert.match(appSource, /remaining <= 0[\s\S]*setQrExpiredVisualState\(true\)/);
});

test('referenced expired transactions are rejected before SlipOK verification', () => {
  const verifySlip = serverSource.slice(serverSource.indexOf("app.post('/api/verify-slip'"));
  assert.match(verifySlip, /errorCode: 'QR_EXPIRED'/);
  assert.match(verifySlip, /isSlipUploadWindowClosed\(pendingTx\)/);
  assert.match(verifySlip, /return res\.status\(410\)\.json/);
  assert.ok(verifySlip.indexOf("errorCode: 'QR_EXPIRED'") < verifySlip.indexOf('callSlipOkVerify('));
});

test('slip upload stays open through the grace window the donor UI restores into', () => {
  const t0 = Date.parse('2026-08-12T00:00:00.000Z');
  const promptpay = { status: 'pending', payment_method: 'promptpay', createdAt: '2026-08-12T00:00:00.000Z' };
  const min = (n) => t0 + n * 60 * 1000;

  // countdown hits zero at 10 min, but the donor may have transferred at 9:50 and only then reloaded
  assert.equal(isSlipUploadWindowClosed(promptpay, min(9)), false);
  assert.equal(isSlipUploadWindowClosed(promptpay, min(11)), false, 'grace window must not 410 a donor who already paid');
  assert.equal(isSlipUploadWindowClosed(promptpay, min(19)), false);
  assert.equal(isSlipUploadWindowClosed(promptpay, min(20)), true, 'closes at lifetime + grace');

  // TrueMoney webhook QR lives 30 min, so its window closes at 40
  const truemoney = { ...promptpay, payment_method: 'truemoney_webhook' };
  assert.equal(isSlipUploadWindowClosed(truemoney, min(39)), false);
  assert.equal(isSlipUploadWindowClosed(truemoney, min(40)), true);

  // fail closed, and never touch direct uploads that carry no transaction
  assert.equal(isSlipUploadWindowClosed({ ...promptpay, createdAt: 'not-a-date' }, min(1)), true);
  assert.equal(isSlipUploadWindowClosed({ ...promptpay, status: 'expired' }, min(1)), true);
  assert.equal(isSlipUploadWindowClosed(null, min(999)), false);
});

test('donor-side grace constant matches the server cutoff', () => {
  assert.match(appSource, /const EXPIRED_QR_GRACE_MS = 10 \* 60 \* 1000;/);
  assert.equal(SLIP_UPLOAD_GRACE_MS, 10 * 60 * 1000);
});
