// Money-path helpers extracted for unit testing (same pattern as auth-helpers.js).

// Donor-side app.js keeps EXPIRED_QR_GRACE_MS in sync with this value.
const SLIP_UPLOAD_GRACE_MS = 10 * 60 * 1000;

const QR_LIFETIME_MS = {
  truemoney_webhook: 30 * 60 * 1000,
  default: 10 * 60 * 1000
};

// True when a slip upload for this transaction must be rejected before it ever reaches SlipOK.
//
// The cutoff is lifetime + grace, not lifetime alone: isPendingRestorable() in app.js
// deliberately restores the payment step for 10 minutes AFTER the countdown hits zero, because
// a donor who transferred at 9:50 and only then reloaded still has to be able to upload their
// slip. Cutting at the bare lifetime would 410 someone whose money has already left their
// account, with no in-app way back.
//
// Fails closed: an unparseable createdAt counts as closed.
function isSlipUploadWindowClosed(tx, now = Date.now()) {
  if (!tx) return false; // no referenceId → direct bank/TrueMoney upload, existing flow
  if (tx.status === 'expired') return true;
  const createdAtMs = Date.parse(tx.createdAt || '');
  if (!Number.isFinite(createdAtMs)) return true;
  const lifetimeMs = QR_LIFETIME_MS[tx.payment_method] || QR_LIFETIME_MS.default;
  return now >= createdAtMs + lifetimeMs + SLIP_UPLOAD_GRACE_MS;
}

module.exports = { isSlipUploadWindowClosed, SLIP_UPLOAD_GRACE_MS, QR_LIFETIME_MS };
