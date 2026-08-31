// Regression: `saveTimerSettings()` ต้องไม่ POST cap_value ที่ไม่ finite
// ช่องเดียวกับ Audit Round 3 Finding #5 ของ Dock — `parseFloat('1e309')` → Infinity
// → JSON.stringify กลายเป็น {"cap_value":null} → server เก็บ config เสีย
//
// ตัด saveTimerSettings() ตัวจริงจาก dashboard.js มารันใน vm (ไม่ก็อปตรรกะมาเขียนซ้ำ)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'dashboard', 'dashboard.js'), 'utf8');

const start = source.indexOf('const TIMER_CAP_INPUT_MAX');
assert.ok(start >= 0, 'missing TIMER_CAP_INPUT_MAX — cap guard หายไปแล้ว?');
const end = source.indexOf('async function timerControl', start);
assert.ok(end > start, 'missing saveTimerSettings end boundary');
const saveSource = source.slice(start, end);

// ค่าในฟอร์ม: ใส่เท่าที่ saveTimerSettings อ่านจริง ที่เหลือปล่อยให้ default ของมันทำงาน
function harness(fields) {
  const calls = { notifications: [], posts: [], reloads: 0 };
  const ctx = {
    JSON, Number, Math, parseInt, parseFloat, isNaN, console,
    timerRules: [],
    showNotification: (msg, type) => calls.notifications.push({ msg, type }),
    loadTimerSettings: async () => { calls.reloads++; },
    fetchWithCsrf: async (url, opts) => {
      calls.posts.push({ url, body: JSON.parse(opts.body) });
      return { json: async () => ({ success: true }) };
    },
    document: {
      getElementById: (id) => (id in fields
        ? { value: fields[id], checked: !!fields[id] }
        : null),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(saveSource + '\n;__save = saveTimerSettings; __max = TIMER_CAP_INPUT_MAX;', ctx);
  return { save: ctx.__save, max: ctx.__max, calls };
}

const withCap = (capValue, extra = {}) => ({
  timerCapTypeSelect: 'money',
  inputTimerCapValue: capValue,
  timerTimeUnit: 'seconds',
  ...extra,
});

test('cap_value ที่ไม่ finite ต้องไม่ถูก POST', async () => {
  // ยืนยันช่องโหว่ที่กำลังกันอยู่ยังเป็นจริงในภาษา
  assert.equal(parseFloat('1e309'), Infinity);
  assert.equal(JSON.stringify({ cap_value: Infinity }), '{"cap_value":null}');

  const h = harness(withCap('1e309'));
  await h.save();
  assert.equal(h.calls.posts.length, 0, 'ห้ามยิง POST');
  assert.equal(h.calls.notifications.at(-1).type, 'error');
});

test('cap_value ที่เกินเพดานต้องไม่ถูก POST', async () => {
  const h = harness(withCap(String(1000001)));
  await h.save();
  assert.equal(h.calls.posts.length, 0);
  assert.equal(h.calls.notifications.at(-1).type, 'error');
});

test('นาที × 60 ที่ทำให้ล้นก็ต้องถูกจับ', async () => {
  const h = harness(withCap('1e308', { timerCapTypeSelect: 'time', timerTimeUnit: 'minutes' }));
  await h.save();
  assert.equal(h.calls.posts.length, 0, '1e308 × 60 = Infinity ต้องไม่รอด');
});

test('ค่าปกติยังบันทึกได้และแปลงหน่วยเหมือนเดิม', async () => {
  const money = harness(withCap('1000'));
  await money.save();
  assert.equal(money.calls.posts.length, 1);
  assert.equal(JSON.parse(money.calls.posts[0].body.timer_settings).cap_value, 1000);

  const minutes = harness(withCap('30', { timerCapTypeSelect: 'time', timerTimeUnit: 'minutes' }));
  await minutes.save();
  assert.equal(JSON.parse(minutes.calls.posts[0].body.timer_settings).cap_value, 1800, 'นาที → วินาที');
});

// 0/ว่าง เป็น state ที่ใช้งานอยู่จริง และที่นี่ abort = ทิ้งทั้งฟอร์ม (สี/กฏ/เสียง) ไม่ใช่แค่ค่า cap
// จึงตั้งใจ "ไม่" บล็อก — ต่างจาก Dock ที่ input นั้นคือ action ทั้งหมด
test('cap ว่าง/0 ยังบันทึกได้เหมือนเดิม (ไม่ทำให้ save ทั้งฟอร์มพัง)', async () => {
  const empty = harness(withCap(''));
  await empty.save();
  assert.equal(empty.calls.posts.length, 1, 'ต้องยังบันทึกได้');
  assert.equal(JSON.parse(empty.calls.posts[0].body.timer_settings).cap_value, 0);

  const zero = harness(withCap('0'));
  await zero.save();
  assert.equal(zero.calls.posts.length, 1);
});

test('ไม่ตั้ง cap (ไม่จำกัด) → ค่าขยะในช่องที่ซ่อนอยู่ต้องไม่บล็อกการบันทึก', async () => {
  const h = harness({ timerCapTypeSelect: '', inputTimerCapValue: '1e309', timerTimeUnit: 'seconds' });
  await h.save();
  assert.equal(h.calls.posts.length, 1, 'cap ปิดอยู่ ⇒ ห้ามบล็อกทั้งฟอร์ม');
});
