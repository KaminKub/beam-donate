'use strict';

// Live money-path smoke test for TrueMoney webhook race/satang/idempotency.
// Node's default discovery executes this file, so it must remain inert unless
// an operator explicitly opts in to a disposable Turso database.

const LIVE_OPT_IN = 'RUN_LIVE_MONEY_TEST';
const DISPOSABLE_DB = 'MPT_DISPOSABLE_DB_URL';
const DISPOSABLE_HOST = /(?:^|[-.])(dev|test|sandbox)(?:[-.]|$)/i;

function getLiveTestConfig(env = process.env) {
  if (env[LIVE_OPT_IN] !== '1') {
    throw new Error(`${LIVE_OPT_IN}=1 is required`);
  }

  const databaseUrl = env.TURSO_DATABASE_URL;
  const declaredDisposableUrl = env[DISPOSABLE_DB];
  if (!databaseUrl || !declaredDisposableUrl || databaseUrl !== declaredDisposableUrl) {
    throw new Error(`${DISPOSABLE_DB} must exactly match TURSO_DATABASE_URL`);
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('TURSO_DATABASE_URL must be a valid libsql or https URL');
  }
  if (!['libsql:', 'https:'].includes(parsed.protocol) || !DISPOSABLE_HOST.test(parsed.hostname)) {
    throw new Error('TURSO_DATABASE_URL must target a disposable dev, test, or sandbox database');
  }
  if (!env.MPT_STREAMER) {
    throw new Error('MPT_STREAMER is required for the disposable test database');
  }

  return { streamer: env.MPT_STREAMER };
}

let failures = 0;
const madeTxIds = [];
const madeHashes = [];
const check = (condition, message) => {
  console.log((condition ? 'PASS ' : 'FAIL ') + message);
  if (!condition) failures++;
};
const iso = () => new Date().toISOString();

async function cleanup(raw) {
  if (!raw) return;

  let cleanupFailed = false;
  for (const id of madeTxIds) {
    try {
      await raw.execute({ sql: 'DELETE FROM transactions WHERE id = ?', args: [id] });
    } catch {
      cleanupFailed = true;
    }
  }
  for (const hash of madeHashes) {
    try {
      await raw.execute({ sql: 'DELETE FROM processed_webhooks WHERE event_hash = ?', args: [hash] });
    } catch {
      cleanupFailed = true;
    }
  }
  console.log(`Cleanup attempted for ${madeTxIds.length} transaction(s) and ${madeHashes.length} webhook row(s).`);
  if (cleanupFailed) throw new Error('Targeted cleanup failed');
}

async function main() {
  // dotenv and the database module are intentionally loaded only after opt-in.
  require('dotenv').config();
  const { streamer } = getLiveTestConfig();
  const db = require('./src/database');
  let raw;

  try {
    await db.ensureConnected();
    raw = db.getDB();
    const mkPending = async (id, amount) => {
      madeTxIds.push(id);
      await db.saveTransaction({
        id, amount, donor: 'MPT', message: '', status: 'pending',
        streamer_username: streamer, payment_method: 'truemoney_webhook', createdAt: iso()
      });
    };

    // Q1: concurrent confirmations must allow exactly one pending -> successful CAS.
    const raceId = 'donate-' + Date.now() + '-race';
    await mkPending(raceId, 55);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => db.confirmTransactionPaid({ id: raceId, paidAt: iso() }))
    );
    const wins = results.filter(result => result && result.rowsAffected > 0).length;
    check(wins === 1, `Q1 race: exactly 1 confirm wins (got ${wins})`);
    const finalTx = await db.getTransactionById(raceId);
    check(finalTx && finalTx.status === 'successful', 'Q1 race: final transaction status is successful');

    // Q2: integer-satang lookup must survive decimal floating-point traps.
    const traps = [0.10, 0.29, 0.37, 0.57, 0.83, 0.99];
    let q2ok = true;
    for (const fraction of traps) {
      const amount = 100 + fraction;
      const id = 'donate-' + Date.now() + '-q2-' + Math.round(fraction * 100);
      await mkPending(id, amount);
      const found = await db.getPendingWebhookTxByAmount(streamer, Math.round(amount * 100));
      if (!found.some(transaction => transaction.id === id)) q2ok = false;
    }
    check(q2ok, `Q2 satang: all ${traps.length} decimal-trap amounts matched`);

    // Idempotency: a duplicate event hash must be reported rather than inserted twice.
    const hash = 'mpt-hash-' + Date.now();
    madeHashes.push(hash);
    const first = await db.insertProcessedWebhook({ streamer_username: streamer, event_hash: hash, amount_satang: 10037, event_type: 'PROMPTPAY_IN', received_time: 't', matched: 0 });
    const replay = await db.insertProcessedWebhook({ streamer_username: streamer, event_hash: hash, amount_satang: 10037, event_type: 'PROMPTPAY_IN', received_time: 't', matched: 0 });
    check(first && !first.duplicate, 'Idempotency: first insert accepted');
    check(replay && replay.duplicate === true, 'Idempotency: replay is rejected as duplicate');

    if (failures) throw new Error(`${failures} money-path check(s) failed`);
  } finally {
    await cleanup(raw);
  }
}

if (require.main === module) {
  if (process.env[LIVE_OPT_IN] !== '1') {
    console.log(`SKIP live money-path test; set ${LIVE_OPT_IN}=1 with a disposable database to run it.`);
  } else {
    main().catch(() => {
      // Do not print raw database errors or URLs from a live-test command.
      console.error('Live money-path test failed. Verify the disposable test configuration and local logs.');
      process.exitCode = 1;
    });
  }
}

module.exports = { getLiveTestConfig };
