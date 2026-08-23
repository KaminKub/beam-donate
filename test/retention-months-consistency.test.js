'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dbSource = fs.readFileSync(path.join(root, 'src', 'database.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');

// มติ retention = 6 เดือน — เคยเพี้ยนมาแล้ว 3 ที่ (crontab, clamp, comment)
// ถ้านโยบายเปลี่ยน ต้องแก้ทุกจุดในนี้พร้อมกัน ไม่งั้น leaderboard คืนช่วง 91-180 วันไม่ครบเงียบ ๆ
test('retention 6 เดือน ตรงกันทุกจุดใน database.js/server.js', () => {
  const fn = dbSource.slice(
    dbSource.indexOf('async function hardDeleteOldTransactions('),
    dbSource.indexOf('* Get transactions for a specific user')
  );

  assert.match(fn, /hardDeleteOldTransactions\(months = 6\)/);
  assert.match(fn, /parseInt\(months, 10\) \|\| 6/);

  // clamp ต้องอยู่ก่อนแยก branch — memory path ใช้ months ดิบไม่ได้ (NaN → toISOString() throw)
  assert.ok(
    fn.indexOf('const safeMonths =') < fn.indexOf('if (isFallback)'),
    'safeMonths ต้องคำนวณก่อน if (isFallback)'
  );
  assert.doesNotMatch(fn.slice(fn.indexOf('if (isFallback)')), /[^e]months \* 30/);

  assert.match(serverSource, /const months = parseInt\(req\.body\?\.months, 10\) \|\| 6;/);
  assert.match(serverSource, /const LEADERBOARD_MAX_LOOKBACK_DAYS = 180;/);
});
