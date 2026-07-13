// Live money-path test — TrueMoney webhook fixes Q1 (race) / Q2 (satang) / idempotency.
// Runs the REAL db module against Turso dev. Uses an existing streamer (FK), cleans up its own rows.
// ponytail: single-file smoke check, no framework.
require('dotenv').config();
const db = require('./src/database');

const STREAMER = process.env.MPT_STREAMER || 'aricano66'; // must exist (FK transactions.streamer_username)
let failures = 0;
const madeTxIds = [];
const madeHashes = [];
function check(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; }
const iso = () => new Date().toISOString();

async function mkPending(id, amount) {
  madeTxIds.push(id);
  await db.saveTransaction({
    id, amount, donor: 'MPT', message: '', status: 'pending',
    streamer_username: STREAMER, payment_method: 'truemoney_webhook', createdAt: iso()
  });
}

async function main() {
  await db.ensureConnected();

  // --- Q1: cross-path double-confirm race ---------------------------------
  // webhook + slip + manual read pending then confirm concurrently.
  // Atomic CAS (confirmTransactionPaid ... WHERE status='pending') must let ONE win.
  const raceId = 'donate-' + Date.now() + '-race';
  await mkPending(raceId, 55);
  const N = 8;
  const results = await Promise.all(
    Array.from({ length: N }, () => db.confirmTransactionPaid({ id: raceId, paidAt: iso() }))
  );
  const wins = results.filter(r => (r && r.rowsAffected) > 0).length;
  check(wins === 1, `Q1 race: exactly 1 confirm wins out of ${N} concurrent (got ${wins})`);
  const finalTx = await db.getTransactionById(raceId);
  check(finalTx && finalTx.status === 'successful', 'Q1 race: final tx status = successful');

  // --- Q2: PROMPTPAY_IN integer-satang match (no float-equality miss) -------
  const traps = [0.10, 0.29, 0.37, 0.57, 0.83, 0.99];
  let q2ok = true;
  for (const frac of traps) {
    const amt = 100 + frac;                       // stored baht, e.g. 100.37
    const tid = 'donate-' + Date.now() + '-q2-' + Math.round(frac * 100);
    await mkPending(tid, amt);
    const found = await db.getPendingWebhookTxByAmount(STREAMER, Math.round(amt * 100)); // decoded.amount satang
    if (!found.some(t => t.id === tid)) { q2ok = false; console.log('   miss at frac', frac); }
  }
  check(q2ok, `Q2 satang: all ${traps.length} float-trap amounts matched by integer satang`);

  // --- Idempotency: replay same event_hash → duplicate:true ----------------
  const hash = 'mpt-hash-' + Date.now();
  madeHashes.push(hash);
  const r1 = await db.insertProcessedWebhook({ streamer_username: STREAMER, event_hash: hash, amount_satang: 10037, event_type: 'PROMPTPAY_IN', received_time: 't', matched: 0 });
  const r2 = await db.insertProcessedWebhook({ streamer_username: STREAMER, event_hash: hash, amount_satang: 10037, event_type: 'PROMPTPAY_IN', received_time: 't', matched: 0 });
  check(r1 && !r1.duplicate, 'Idempotency: first insert accepted');
  check(r2 && r2.duplicate === true, 'Idempotency: replay returns duplicate:true');

  // --- cleanup (only rows this test created) -------------------------------
  const raw = db.getDB();
  for (const id of madeTxIds) await raw.execute({ sql: 'DELETE FROM transactions WHERE id = ?', args: [id] });
  for (const h of madeHashes) await raw.execute({ sql: 'DELETE FROM processed_webhooks WHERE event_hash = ?', args: [h] });
  console.log(`\ncleaned ${madeTxIds.length} tx + ${madeHashes.length} webhook rows`);
  console.log(failures ? `❌ ${failures} check(s) FAILED` : '✅ all money-path checks passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch(e => { console.error('test crashed:', e); process.exitCode = 1; });
