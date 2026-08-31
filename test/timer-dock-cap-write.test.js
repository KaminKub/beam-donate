// Regression for Audit Round 3 (TIMER_CAP_WIDGET_AND_DOCK) Findings #4 + #5.
//
// #4 saveTimerPatch() ต้องรับ error ทุก path (GET/parse/POST/parse) — toast + ดึงค่า authoritative กลับ
//    ห้ามปล่อยให้ caller ที่ใช้ .then() โดยไม่มี .catch() เจอ unhandled rejection
// #5 cap_value ต้อง finite/in-range ก่อน POST — `1e309` → Infinity → JSON กลายเป็น null
//
// ตัดโค้ดจริงจาก timer-dock.html มารันใน vm (ไม่ก็อปตรรกะมาเขียนซ้ำในเทสต์)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dockSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'dashboard', 'timer-dock.html'), 'utf8');

function slice(startMarker, endMarker) {
  const start = dockSource.indexOf(startMarker);
  assert.ok(start >= 0, 'missing marker: ' + startMarker);
  const end = dockSource.indexOf(endMarker, start);
  assert.ok(end > start, 'missing end marker: ' + endMarker);
  return dockSource.slice(start, end);
}

// --- Finding #5 -------------------------------------------------------------

function capHarness(timerCfg) {
  const src = slice('var CAP_INPUT_MAX', 'function renderCap()');
  const ctx = { Number, Math, timerCfg };
  vm.createContext(ctx);
  vm.runInContext(src + '\n;__api = { capValueToSave, toSeconds, CAP_INPUT_MAX };', ctx);
  return ctx.__api;
}

test('F5: ค่าที่ไม่ finite / นอกช่วง ต้องถูกปฏิเสธก่อน POST', () => {
  const { capValueToSave, CAP_INPUT_MAX } = capHarness({ cap_type: 'money', time_unit: 'seconds' });

  // จุดที่ Audit reproduce ได้จริง: Infinity รอด JSON.stringify ออกมาเป็น null
  assert.equal(JSON.stringify({ cap_value: Number('1e309') }), '{"cap_value":null}');
  assert.equal(capValueToSave('1e309'), null, '1e309 ต้องไม่ผ่าน');

  assert.equal(capValueToSave('abc'), null, 'NaN ต้องไม่ผ่าน');
  assert.equal(capValueToSave(''), null, 'ค่าว่างต้องไม่ผ่าน');
  assert.equal(capValueToSave('0'), null, '0 ต้องไม่ผ่าน (cap ต้อง >= 1)');
  assert.equal(capValueToSave('-5'), null, 'ค่าติดลบต้องไม่ผ่าน');
  assert.equal(capValueToSave(String(CAP_INPUT_MAX + 1)), null, 'เกินเพดานต้องไม่ผ่าน');
});

test('F5: ค่าปกติยังผ่านและแปลงหน่วยเหมือนเดิม', () => {
  const money = capHarness({ cap_type: 'money', time_unit: 'seconds' });
  assert.equal(money.capValueToSave('1000'), 1000);
  assert.equal(money.capValueToSave('1'), 1, 'ขอบล่างต้องยังใช้ได้');
  assert.equal(money.capValueToSave(String(money.CAP_INPUT_MAX)), money.CAP_INPUT_MAX);

  const timeMinutes = capHarness({ cap_type: 'time', time_unit: 'minutes' });
  assert.equal(timeMinutes.capValueToSave('30'), 1800, 'นาที → วินาที');
  // เพดานสูงสุดในหน่วยนาที ยังต้องได้ค่า finite หลังคูณ 60
  assert.equal(timeMinutes.capValueToSave(String(timeMinutes.CAP_INPUT_MAX)),
    timeMinutes.CAP_INPUT_MAX * 60);

  // ทศนิยมถูกปัดเป็นจำนวนเต็มวินาที — ห้ามส่ง float เข้า config
  assert.equal(timeMinutes.capValueToSave('1.5'), 90);
});

// --- Finding #4 -------------------------------------------------------------

function saveHarness(steps) {
  const src = slice('async function saveTimerPatch', 'async function withBusy');
  const calls = { toasts: [], loadState: 0, syncSwitches: 0 };
  const ctx = {
    JSON, Object, Number, Math, console,
    DEMO: false,
    setTimeout: () => 0,
    location: { reload() {} },
    toast: (msg, type) => calls.toasts.push({ msg, type }),
    syncSwitches: () => { calls.syncSwitches++; },
    loadState: async () => { calls.loadState++; },
    timerCfg: {},
    fetch: steps.get,
    fetchWithCsrf: steps.post || (async () => { throw new Error('post not expected'); }),
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\n;__save = saveTimerPatch;', ctx);
  return { save: ctx.__save, calls };
}

const okGet = async () => ({
  ok: true, status: 200,
  json: async () => ({ timer_settings: JSON.stringify({ enabled: 1 }) }),
});

test('F4: GET สำเร็จแต่ res.json() พัง → toast + rollback ไม่ใช่ unhandled rejection', async () => {
  const h = saveHarness({
    get: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }),
  });
  const result = await h.save({ show_cap: 1 }, null);
  assert.equal(result, false);
  assert.equal(h.calls.toasts.length, 1);
  assert.equal(h.calls.toasts[0].type, 'error');
  assert.equal(h.calls.loadState, 1, 'ต้องดึงค่า authoritative กลับมา');
});

test('F4: POST ล้ม (network) → toast + rollback', async () => {
  const h = saveHarness({
    get: okGet,
    post: async () => { throw new TypeError('Failed to fetch'); },
  });
  const result = await h.save({ show_cap: 1 }, null);
  assert.equal(result, false);
  assert.equal(h.calls.toasts.at(-1).type, 'error');
  assert.equal(h.calls.loadState, 1);
});

test('F4: busy class ถูกล้างเสมอแม้โยน exception', async () => {
  const cls = new Set();
  const btn = { classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) } };
  const h = saveHarness({ get: async () => { throw new TypeError('Failed to fetch'); } });
  await h.save({ show_cap: 1 }, btn);
  assert.equal(cls.has('busy'), false, 'ปุ่มต้องไม่ค้างสถานะ busy');
});

test('F4: path ปกติยังบันทึกได้และ merge ของเดิมไว้ครบ', async () => {
  let posted = null;
  const h = saveHarness({
    get: async () => ({
      ok: true, status: 200,
      json: async () => ({ timer_settings: JSON.stringify({ enabled: 1, rules: [{ amount: 10 }] }) }),
    }),
    post: async (url, opts) => {
      posted = JSON.parse(JSON.parse(opts.body).timer_settings);
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    },
  });
  const result = await h.save({ show_cap: 1 }, null);
  assert.equal(result, true);
  assert.deepEqual(posted.rules, [{ amount: 10 }], 'กฏเดิมต้องไม่หาย (T14 blocker)');
  assert.equal(posted.show_cap, 1);
  assert.equal(h.calls.toasts.length, 0, 'path สำเร็จต้องไม่มี error toast');
});
