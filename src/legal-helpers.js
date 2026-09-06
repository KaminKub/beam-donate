// Legal version scheduling, extracted for unit testing (same pattern as auth-helpers.js).
//
// ToS §9 promises at least 7 days notice on the website before a change takes effect. A bare
// string constant compared against streamers.legal_version cannot keep that promise: the moment
// it changes, every user is gated on the new document immediately. So a new version is declared
// here together with the date it becomes enforceable, and until that date arrives the previous
// version stays valid.
//
// Release procedure for the next ToS/privacy change:
//   1. Edit the documents, then set `upcoming` + `effectiveAt` to a date at least
//      LEGAL_NOTICE_DAYS out. Deploy. Nobody is re-prompted yet.
//   2. Publish the notice on the site during the window — the ToS page must state the new
//      effective date. That is the §9 notice.
//   3. On or after the effective date, promote: `current` = the upcoming version, and set
//      `upcoming`/`effectiveAt` back to null. The gate has already flipped on its own at the
//      date, so this step is bookkeeping and changes nothing for users.
// Accepting early during the window counts, so step 3 never prompts anyone twice.

const LEGAL_NOTICE_DAYS = 7;

const LEGAL_SCHEDULE = Object.freeze({
  current: '2026-08-19',
  // Set both together, or leave both null when no change is pending.
  upcoming: '2026-09-13',
  effectiveAt: '2026-09-13T23:59:59+07:00'
});

function isAnnounced(schedule) {
  return typeof schedule.upcoming === 'string'
    && Number.isFinite(Date.parse(schedule.effectiveAt || ''));
}

// The version a user must hold today. Flips to the upcoming one only once its date has arrived.
function enforcedLegalVersion(now = Date.now(), schedule = LEGAL_SCHEDULE) {
  if (isAnnounced(schedule) && now >= Date.parse(schedule.effectiveAt)) return schedule.upcoming;
  return schedule.current;
}

// During the notice window both the enforced version and the announced one are valid, so a user
// who accepts the new terms early is not prompted again when the date arrives.
function acceptableLegalVersions(now = Date.now(), schedule = LEGAL_SCHEDULE) {
  const enforced = enforcedLegalVersion(now, schedule);
  if (isAnnounced(schedule) && schedule.upcoming !== enforced) return [enforced, schedule.upcoming];
  return [enforced];
}

function hasAcceptedLegal(storedVersion, now = Date.now(), schedule = LEGAL_SCHEDULE) {
  return acceptableLegalVersions(now, schedule).includes(storedVersion);
}

// The announced-but-not-yet-effective version, or null. Offering this one in the acceptance
// modal is what makes the "accept early, never get prompted twice" promise above actually work.
function announcedLegalVersion(now = Date.now(), schedule = LEGAL_SCHEDULE) {
  const enforced = enforcedLegalVersion(now, schedule);
  return isAnnounced(schedule) && schedule.upcoming !== enforced ? schedule.upcoming : null;
}

// True when the declared notice window is shorter than §9 promises — a release-time guard so a
// future bump cannot quietly ship a 2-day notice.
function noticeWindowIsSufficient(announcedAt, schedule = LEGAL_SCHEDULE) {
  if (!isAnnounced(schedule)) return true;
  return Date.parse(schedule.effectiveAt) - announcedAt >= LEGAL_NOTICE_DAYS * 24 * 60 * 60 * 1000;
}

// Self-attestation that the streamer is of legal age and owns the payment credentials being
// connected. Not date-scheduled like the ToS — a bump simply re-prompts. Lives here so the
// admin retest CLI can check a target's eligibility without loading src/server.js.
const PAYMENT_ELIGIBILITY_VERSION = 'v1';

module.exports = {
  LEGAL_SCHEDULE,
  LEGAL_NOTICE_DAYS,
  PAYMENT_ELIGIBILITY_VERSION,
  enforcedLegalVersion,
  acceptableLegalVersions,
  announcedLegalVersion,
  hasAcceptedLegal,
  noticeWindowIsSufficient
};
