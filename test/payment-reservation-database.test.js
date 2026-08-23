'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { reservePendingTransactionWithClient } = require('../src/payment-reservation');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tipkub-payment-reservation-'));
const databasePath = path.join(tempDir, 'reservation.db').replace(/\\/g, '/');
const databaseUrl = `file:${databasePath}`;
const primaryClient = createClient({ url: databaseUrl });
const secondaryClient = createClient({ url: databaseUrl });

function pendingTx(id, paymentMethod, amount = 49.99) {
  return {
    id,
    amount,
    intended_amount: paymentMethod === 'truemoney_webhook' ? 50 : null,
    donor: 'Audit regression',
    message: '',
    status: 'pending',
    streamer_username: 'Streamer',
    payment_method: paymentMethod,
    createdAt: new Date().toISOString()
  };
}

test.before(async () => {
  await primaryClient.executeMultiple(`
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      donor TEXT DEFAULT 'Anonymous',
      message TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      paymentUrl TEXT,
      raw_response TEXT,
      raw_webhook TEXT,
      createdAt TEXT,
      updatedAt TEXT,
      paidAt TEXT,
      streamer_username TEXT,
      payment_method TEXT DEFAULT 'ffp',
      promptpay_slip_id TEXT,
      promptpay_verified INTEGER DEFAULT 0,
      promptpay_verified_at TEXT,
      timer_action TEXT,
      tier_level INTEGER,
      tier_image_url TEXT,
      tier_sound_url TEXT,
      tier_sound_is_temp INTEGER DEFAULT 0,
      tier_sound_youtube_id TEXT,
      tier_sound_youtube_start REAL,
      tier_sound_youtube_end REAL,
      intended_amount REAL
    );
  `);
});

test.beforeEach(async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await primaryClient.execute('DELETE FROM transactions');
      return;
    } catch (error) {
      if (!/SQLITE_BUSY|database is locked/i.test(error.message || '') || attempt === 9) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
});

test.after(async () => {
  primaryClient.close();
  secondaryClient.close();
  await new Promise(resolve => setTimeout(resolve, 25));
  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  } catch (error) {
    // The local libSQL native handle is released at process exit on Windows.
    // The directory lives under os.tmpdir() and is safe for the OS to reap.
    if (error.code !== 'EPERM') throw error;
  }
});

// Audit R5-A1/A2: TrueMoney จองก่อน แล้ว SlipOK donor เลือกยอดเดียวกัน — SlipOK ต้องสร้าง QR ได้ปกติ
// (ยอดของ SlipOK แก้ไม่ได้ ปฏิเสธ = ไล่ donor กลับ) แล้วไปกันเงินซ้ำที่ webhook matcher แทน
test('a later SlipOK transaction at a TrueMoney-held amount is allowed, and makes the webhook matcher ambiguous', async () => {
  const trueMoney = await reservePendingTransactionWithClient(
    primaryClient,
    pendingTx('tm-first', 'truemoney_webhook'),
    [49.99]
  );
  assert.equal(trueMoney.amount, 49.99);

  // SlipOK route ใช้ saveTransaction ธรรมดา ไม่ผ่าน reservation
  await primaryClient.execute({
    sql: `INSERT INTO transactions (id, amount, donor, status, streamer_username, payment_method, createdAt)
          VALUES (?, ?, ?, 'pending', ?, 'promptpay', ?)`,
    args: ['slip-second', 49.99, 'SlipOK donor', 'Streamer', new Date().toISOString()]
  });

  // predicate เดียวกับ db.getPendingTxByPayableAmount() — ไม่กรอง payment_method
  const candidates = await primaryClient.execute({
    sql: `SELECT payment_method FROM transactions
          WHERE streamer_username = ? AND status = 'pending'
            AND CAST(ROUND(amount * 100) AS INTEGER) = ?`,
    args: ['Streamer', 4999]
  });

  assert.equal(candidates.rows.length, 2);
  const wouldConfirm = candidates.rows.length === 1 && candidates.rows[0].payment_method === 'truemoney_webhook';
  assert.equal(wouldConfirm, false, 'webhook ต้องไม่ confirm เมื่อยอดกำกวมข้าม flow');
});

test('SlipOK first makes TrueMoney atomically choose the next available satang slot', async () => {
  const slipOk = await reservePendingTransactionWithClient(
    primaryClient,
    pendingTx('slip-first', 'promptpay'),
    [49.99]
  );
  const trueMoney = await reservePendingTransactionWithClient(
    primaryClient,
    pendingTx('tm-second', 'truemoney_webhook'),
    [49.99, 49.98]
  );

  assert.equal(slipOk.amount, 49.99);
  assert.equal(trueMoney.amount, 49.98);
});

test('two database clients cannot reserve the same streamer amount concurrently', async () => {
  const [first, second] = await Promise.all([
    reservePendingTransactionWithClient(primaryClient, pendingTx('writer-a', 'promptpay'), [49.99]),
    reservePendingTransactionWithClient(secondaryClient, pendingTx('writer-b', 'truemoney_webhook'), [49.99])
  ]);

  assert.equal([first, second].filter(Boolean).length, 1);
  const rows = await primaryClient.execute(
    "SELECT id FROM transactions WHERE status = 'pending' AND ROUND(amount * 100) = 4999"
  );
  assert.equal(rows.rows.length, 1);
});

test('a non-pending transaction releases its payable amount for a new reservation', async () => {
  await reservePendingTransactionWithClient(
    primaryClient,
    pendingTx('completed', 'promptpay'),
    [49.99]
  );
  await primaryClient.execute({
    sql: "UPDATE transactions SET status = 'successful' WHERE id = ?",
    args: ['completed']
  });

  const replacement = await reservePendingTransactionWithClient(
    secondaryClient,
    pendingTx('replacement', 'truemoney_webhook'),
    [49.99]
  );
  assert.equal(replacement.amount, 49.99);
});

test('streamer and transaction identifiers remain parameterized', async () => {
  const malicious = pendingTx("tx'); DROP TABLE transactions; --", 'promptpay');
  malicious.streamer_username = "name' OR 1=1 --";

  const reserved = await reservePendingTransactionWithClient(primaryClient, malicious, [49.99]);
  assert.equal(reserved.streamer_username, malicious.streamer_username);
  const table = await primaryClient.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transactions'");
  assert.equal(table.rows[0].name, 'transactions');
});
