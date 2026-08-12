const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  LEGAL_SCHEDULE,
  LEGAL_NOTICE_DAYS,
  enforcedLegalVersion,
  acceptableLegalVersions,
  hasAcceptedLegal,
  noticeWindowIsSufficient
} = require('../src/legal-helpers');

const day = 24 * 60 * 60 * 1000;
const announced = Date.parse('2026-09-01T00:00:00+07:00');
const pending = {
  current: '2026-08-12',
  upcoming: '2026-09-08',
  effectiveAt: '2026-09-08T00:00:00+07:00'
};

test('an announced version does not take effect until its date', () => {
  const effective = Date.parse(pending.effectiveAt);

  assert.equal(enforcedLegalVersion(announced, pending), '2026-08-12');
  assert.equal(enforcedLegalVersion(effective - 1, pending), '2026-08-12');
  assert.equal(enforcedLegalVersion(effective, pending), '2026-09-08');

  // holding only the old version is still fine throughout the notice window
  assert.equal(hasAcceptedLegal('2026-08-12', effective - 1, pending), true);
  assert.equal(hasAcceptedLegal('2026-08-12', effective, pending), false);
});

test('accepting early during the notice window counts after the date arrives', () => {
  const effective = Date.parse(pending.effectiveAt);
  assert.deepEqual(acceptableLegalVersions(announced, pending), ['2026-08-12', '2026-09-08']);
  assert.equal(hasAcceptedLegal('2026-09-08', announced, pending), true);
  assert.equal(hasAcceptedLegal('2026-09-08', effective, pending), true);
});

test('a half-declared or unannounced schedule enforces the current version only', () => {
  const none = { current: '2026-08-12', upcoming: null, effectiveAt: null };
  const halfA = { current: '2026-08-12', upcoming: '2026-09-08', effectiveAt: null };
  const halfB = { current: '2026-08-12', upcoming: null, effectiveAt: '2026-09-08T00:00:00+07:00' };
  const bogus = { current: '2026-08-12', upcoming: '2026-09-08', effectiveAt: 'not-a-date' };

  for (const s of [none, halfA, halfB, bogus]) {
    assert.deepEqual(acceptableLegalVersions(announced, s), ['2026-08-12']);
  }
});

test('the notice window must be at least as long as ToS section 9 promises', () => {
  assert.equal(noticeWindowIsSufficient(announced, pending), true);
  assert.equal(
    noticeWindowIsSufficient(Date.parse(pending.effectiveAt) - 2 * day, pending),
    false,
    'a 2-day notice must be rejected'
  );
  assert.equal(noticeWindowIsSufficient(Date.now(), LEGAL_SCHEDULE), true);
});

test('the shipped schedule is coherent and matches the published documents', () => {
  const root = path.join(__dirname, '..');
  const tos = fs.readFileSync(path.join(root, 'public/pages/terms-of-services.html'), 'utf8');
  const privacy = fs.readFileSync(path.join(root, 'public/pages/privacy.html'), 'utf8');

  assert.equal(LEGAL_NOTICE_DAYS, 7);
  assert.match(tos, new RegExp(`แจ้งให้ทราบล่วงหน้าอย่างน้อย</strong>|แจ้งให้ทราบล่วงหน้าอย่างน้อย ${LEGAL_NOTICE_DAYS} วัน|อย่างน้อย ${LEGAL_NOTICE_DAYS} วัน`));

  // LEGAL_SCHEDULE.current is a date string; the documents must carry that same date in Thai.
  const [y, m, d] = LEGAL_SCHEDULE.current.split('-').map(Number);
  const thaiMonths = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
    'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  const thaiDate = `${d} ${thaiMonths[m - 1]} ${y + 543}`;
  assert.match(tos, new RegExp(`อัปเดตล่าสุด: ${thaiDate}`));
  assert.match(privacy, new RegExp(`อัปเดตล่าสุด: ${thaiDate}`));

  if (LEGAL_SCHEDULE.upcoming && LEGAL_SCHEDULE.effectiveAt) {
    const effectiveDate = new Date(LEGAL_SCHEDULE.effectiveAt);
    const effectiveThaiDate = `${effectiveDate.getUTCDate()} ${thaiMonths[effectiveDate.getUTCMonth()]} ${effectiveDate.getUTCFullYear() + 543}`;
    assert.match(tos, new RegExp(`มีผลบังคับใช้ตั้งแต่วันที่: ${effectiveThaiDate}`));
    assert.match(privacy, new RegExp(`มีผลบังคับใช้ตั้งแต่วันที่: ${effectiveThaiDate}`));
    assert.equal(noticeWindowIsSufficient(Date.parse('2026-08-12T20:00:00+07:00'), LEGAL_SCHEDULE), true);
  }

  // Both upcoming fields are set together or not at all.
  assert.equal(
    (LEGAL_SCHEDULE.upcoming === null) === (LEGAL_SCHEDULE.effectiveAt === null),
    true,
    'upcoming and effectiveAt must be declared as a pair'
  );
});
