'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
const databaseSource = fs.readFileSync(path.join(__dirname, '../src/database.js'), 'utf8');
const donateSource = fs.readFileSync(path.join(__dirname, '../public/donate-template/app.js'), 'utf8');

function routeSource(startMarker, endMarker) {
  const start = serverSource.indexOf(startMarker);
  const end = serverSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing route marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing route end marker: ${endMarker}`);
  return serverSource.slice(start, end);
}

// Audit R5-A1: SlipOK ยืนยันด้วย referenceId และบังคับยอดสลิป == tx.amount เป๊ะ หักสตางค์ไม่ได้
// ⇒ reservation/409 ที่ route นี้ = ไล่ donor คนที่สองที่โดเนทยอดเดียวกันกลับบ้าน ห้ามใส่กลับมา
test('SlipOK PromptPay route never reserves or 409s on a duplicate amount', () => {
  const source = routeSource(
    "app.post('/api/create-promptpay-qr'",
    '// POST /api/truemoney/webhook'
  );

  assert.match(source, /db\.saveTransaction\(txData\)/);
  assert.doesNotMatch(source, /reservePendingTransaction/);
  assert.doesNotMatch(source, /acquirePaymentReservationLock/);
  assert.doesNotMatch(source, /res\.status\(409\)/);
});

// Audit R5-A2: เงินพร้อมเพย์ SlipOK เข้าบัญชีเดียวกับ TrueMoney ได้ ⇒ ยอดที่ซ้ำกับ flow อื่น
// แปลว่าไม่รู้ว่าเป็นเงินของใคร ต้องปล่อย unmatched ห้าม confirm รายการที่ยังไม่จ่าย
test('TrueMoney PROMPTPAY_IN matcher fails closed when another flow holds the same pending amount', () => {
  const source = routeSource(
    "app.post('/api/truemoney/webhook'",
    '// POST /api/truemoney/setup-webhook - Enable/disable'
  );

  assert.match(source, /db\.getPendingTxByPayableAmount\(streamerId, decoded\.amount\)/);
  assert.match(source, /candidates\.length === 1 && candidates\[0\]\.payment_method === 'truemoney_webhook'/);
  assert.doesNotMatch(serverSource, /getPendingWebhookTxByAmount/);
  assert.doesNotMatch(databaseSource, /getPendingWebhookTxByAmount/);
});

test('TrueMoney PROMPTPAY_IN route atomically claims its ordered satang candidates', () => {
  const source = routeSource(
    "app.post('/api/truemoney/create-qr'",
    '// GET /api/donate/status/stream'
  );

  assert.match(source, /buildDescendingSatangAmounts\(baseAmount\)/);
  assert.match(source, /db\.reservePendingTransaction\(pendingTransaction, candidates\)/);
  assert.match(source, /displayAmount = reserved\.amount/);
  assert.doesNotMatch(source, /getPendingTransactionAmounts/);
});

test('database adapter delegates the durable path to the single-statement atomic reservation', () => {
  assert.match(databaseSource, /return reservePendingTransactionWithClient\(db, data, candidates\.map\(item => item\.amount\)\)/);
  assert.match(databaseSource, /CREATE INDEX IF NOT EXISTS idx_transactions_pending_payable_amount/);
});

test('only the TrueMoney QR flow handles a reservation conflict, and its error is visible on the QR step', () => {
  const conflictHandlers = donateSource.match(/response\.status === 409/g) || [];
  assert.equal(conflictHandlers.length, 1);
  assert.match(donateSource, /ยอดนี้มีรายการรอชำระอยู่แล้ว กรุณาเลือกยอดอื่น/);
  // R5-A3: error ของ step QR ต้องไม่ไปโผล่ที่ #proceedError ซึ่งอยู่คนละ step (spinner ค้าง ไม่มีข้อความ)
  assert.match(donateSource, /function showTrueMoneyQrError\(message\)/);
  assert.match(donateSource, /showTrueMoneyQrError\(response\.status === 409/);
});
