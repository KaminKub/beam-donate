'use strict';

// A per-streamer queue closes the SELECT-then-INSERT race while the process
// allocates a TrueMoney PROMPTPAY_IN satang slot (fallback path only — the DB
// statement below is the correctness boundary).
const reservationQueues = new Map();

async function acquirePaymentReservationLock(streamerUsername) {
  const key = String(streamerUsername || '').toLowerCase();
  const previous = reservationQueues.get(key) || Promise.resolve();
  let releaseCurrent;
  const current = new Promise(resolve => { releaseCurrent = resolve; });
  const queued = previous.then(() => current);
  reservationQueues.set(key, queued);
  await previous;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    if (reservationQueues.get(key) === queued) reservationQueues.delete(key);
  };
}

// Work in integer satang so IEEE-754 float equality cannot create a duplicate.
function buildDescendingSatangAmounts(baseAmount, maxExtraSatang = 99) {
  const baseSatang = Math.round(Number(baseAmount) * 100);
  if (!Number.isFinite(baseSatang) || baseSatang <= maxExtraSatang) return [];
  return Array.from(
    { length: maxExtraSatang },
    (_, index) => (baseSatang - index - 1) / 100
  );
}

function normalizeCandidateAmounts(candidateAmounts) {
  const seen = new Set();
  const normalized = [];
  for (const amount of candidateAmounts || []) {
    const satang = Math.round(Number(amount) * 100);
    if (!Number.isSafeInteger(satang) || satang <= 0 || seen.has(satang)) continue;
    seen.add(satang);
    normalized.push({ satang, amount: satang / 100 });
  }
  return normalized;
}

function pendingTransactionReservationStatement(data, candidates, now) {
  const candidateValues = candidates.map(() => '(?, ?, ?)').join(', ');
  const candidateArgs = candidates.flatMap((candidate, priority) => [priority, candidate.satang, candidate.amount]);
  return {
    sql: `WITH candidates(priority, amount_satang, amount) AS (VALUES ${candidateValues})
          INSERT INTO transactions (id, amount, donor, message, status, paymentUrl, raw_response, raw_webhook, createdAt, updatedAt, paidAt, streamer_username, payment_method, promptpay_slip_id, promptpay_verified, promptpay_verified_at, timer_action, tier_level, tier_image_url, tier_sound_url, tier_sound_is_temp, tier_sound_youtube_id, tier_sound_youtube_start, tier_sound_youtube_end, intended_amount)
          SELECT ?, candidates.amount, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          FROM candidates
          WHERE NOT EXISTS (
            SELECT 1 FROM transactions
            WHERE LOWER(streamer_username) = LOWER(?)
              AND status = 'pending'
              AND CAST(ROUND(amount * 100) AS INTEGER) = candidates.amount_satang
          )
          AND NOT EXISTS (SELECT 1 FROM transactions WHERE id = ?)
          ORDER BY candidates.priority
          LIMIT 1
          RETURNING amount`,
    args: [
      ...candidateArgs,
      data.id,
      data.donor || data.donor_name || 'Anonymous',
      data.message || '',
      data.paymentUrl || null,
      data.raw_response ? (typeof data.raw_response === 'string' ? data.raw_response : JSON.stringify(data.raw_response)) : null,
      data.raw_webhook ? (typeof data.raw_webhook === 'string' ? data.raw_webhook : JSON.stringify(data.raw_webhook)) : null,
      data.createdAt || now,
      now,
      data.streamer_username,
      data.payment_method || 'ffp',
      data.promptpay_slip_id || null,
      data.promptpay_verified !== undefined ? (data.promptpay_verified ? 1 : 0) : 0,
      data.promptpay_verified_at || null,
      data.timer_action ?? null,
      data.tier_level ?? null,
      data.tier_image_url ?? null,
      data.tier_sound_url ?? null,
      data.tier_sound_is_temp !== undefined ? (data.tier_sound_is_temp ? 1 : 0) : 0,
      data.tier_sound_youtube_id ?? null,
      data.tier_sound_youtube_start ?? null,
      data.tier_sound_youtube_end ?? null,
      data.intended_amount ?? null,
      data.streamer_username,
      data.id
    ]
  };
}

function isBusyError(error) {
  return /SQLITE_BUSY|database is locked|TRANSACTION_BUSY/i.test(String(error?.message || error || ''));
}

// The pending transaction row is the durable reservation. One parameterized
// INSERT...SELECT statement chooses and inserts the first free candidate
// atomically across Node/PM2 processes and database clients.
async function reservePendingTransactionWithClient(client, data, candidateAmounts, maxBusyRetries = 4) {
  if (!client || typeof client.execute !== 'function') throw new TypeError('A database client is required');
  if (!data?.id || !data?.streamer_username) throw new TypeError('Transaction id and streamer_username are required');

  const candidates = normalizeCandidateAmounts(candidateAmounts);
  if (candidates.length === 0) return null;
  if (candidates.length > 99) throw new RangeError('At most 99 payable amount candidates are allowed');

  for (let attempt = 0; attempt <= maxBusyRetries; attempt++) {
    try {
      const now = new Date().toISOString();
      const result = await client.execute(pendingTransactionReservationStatement(data, candidates, now));
      if (!result.rows[0]) return null;
      return { ...data, amount: Number(result.rows[0].amount), status: 'pending' };
    } catch (error) {
      if (!isBusyError(error) || attempt === maxBusyRetries) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }

  return null;
}

module.exports = {
  acquirePaymentReservationLock,
  buildDescendingSatangAmounts,
  normalizeCandidateAmounts,
  reservePendingTransactionWithClient
};
