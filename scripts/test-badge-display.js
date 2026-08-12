// self-check สำหรับ resolveBadgeDisplay (auto-show / auto-switch / optout / dev entitlement)
// run: node scripts/test-badge-display.js
const assert = require('assert');
const db = require('../src/database');

const monthsAgo = (n) => { const d = new Date(); d.setMonth(d.getMonth() - n); return d.toISOString(); };
const S = (o) => ({ badges: '{}', badge_display: null, badge_display_top: null, badge_optout: null, tos_accepted_at: null, ...o });

// 1. NULL prefs → auto-show beta + top tier
assert.deepStrictEqual(
  db.resolveBadgeDisplay(S({ badges: '{"beta_tester":true}', tos_accepted_at: monthsAgo(7) })).sort(),
  ['beta_tester', 'member_6m']
);

// 2. dev entitlement — non-admin ไม่โชว์ dev, admin โชว์
assert.deepStrictEqual(db.resolveBadgeDisplay(S({ badges: '{"dev":true}' })), []);
assert.deepStrictEqual(db.resolveBadgeDisplay(S({ badges: '{"dev":true}' }), { isAdmin: true }), ['dev']);

// 3. auto-switch ทุก transition (comparator: curIdx < storedIdx)
const cases = [[3, 'member_1m', 'member_3m'], [7, 'member_3m', 'member_6m'], [13, 'member_6m', 'member_1y'], [25, 'member_1y', 'member_2y']];
for (const [months, stored, expected] of cases) {
  assert.deepStrictEqual(
    db.resolveBadgeDisplay(S({ tos_accepted_at: monthsAgo(months), badge_display: JSON.stringify([stored]), badge_display_top: stored })),
    [expected], `auto-switch ${stored} → ${expected}`
  );
}

// 4. stored top เท่าปัจจุบัน → respect การเลือก tier ต่ำของ user
assert.deepStrictEqual(
  db.resolveBadgeDisplay(S({ tos_accepted_at: monthsAgo(7), badge_display: '["member_1m"]', badge_display_top: 'member_6m' })),
  ['member_1m']
);

// 5. badge_display_top NULL (user เดิม) → one-time reset เป็น top tier
assert.deepStrictEqual(
  db.resolveBadgeDisplay(S({ tos_accepted_at: monthsAgo(7), badge_display: '["member_1m"]' })),
  ['member_6m']
);

// 6. optout membership → ไม่ auto-switch / ไม่ auto-show
assert.deepStrictEqual(
  db.resolveBadgeDisplay(S({ tos_accepted_at: monthsAgo(7), badge_display: '[]', badge_optout: '["membership"]' })),
  []
);
assert.deepStrictEqual(
  db.resolveBadgeDisplay(S({ tos_accepted_at: monthsAgo(7), badge_optout: '["membership"]' })),
  []
);

// 7. non-NULL + เลือก member tier ต่ำ → beta_tester ใหม่ยัง auto-show (Codex finding #2)
assert.deepStrictEqual(
  db.resolveBadgeDisplay(S({ badges: '{"beta_tester":true}', tos_accepted_at: monthsAgo(2), badge_display: '["member_1m"]', badge_display_top: 'member_1m' })).sort(),
  ['beta_tester', 'member_1m']
);

// 8. optout beta_tester → ไม่ auto-show อีก
assert.deepStrictEqual(
  db.resolveBadgeDisplay(S({ badges: '{"beta_tester":true}', badge_display: '[]', badge_optout: '["beta_tester"]' })),
  []
);

// 9. guard: badge ที่ไม่ได้จริง ถูกตัดทิ้ง + JSON เพี้ยนไม่พัง
assert.deepStrictEqual(db.resolveBadgeDisplay(S({ badge_display: '["member_2y"]' })), []);
assert.deepStrictEqual(db.resolveBadgeDisplay(S({ badge_display: 'not-json', badge_optout: 'not-json' })), []);

// 10. legacy "ปิดทั้งหมด" (badge_display='[]') หลัง backfill migration → ไม่โชว์อะไรเลย
//     (migration ตั้ง badge_optout = ทุก key ให้แถวที่ badge_display='[]' และ badge_optout ยัง NULL)
assert.deepStrictEqual(
  db.resolveBadgeDisplay(
    S({ badges: '{"dev":true,"beta_tester":true}', tos_accepted_at: monthsAgo(13), badge_display: '[]', badge_optout: '["dev","beta_tester","membership"]' }),
    { isAdmin: true }
  ),
  []
);

// 11. getTopMembershipTier
assert.strictEqual(db.getTopMembershipTier(S({ tos_accepted_at: monthsAgo(13) })), 'member_1y');
assert.strictEqual(db.getTopMembershipTier(S({})), null);

console.log('✅ badge display self-check passed');
