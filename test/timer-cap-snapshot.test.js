// Regression for Audit Round 3 (TIMER_CAP_WIDGET_AND_DOCK) Findings #1 + #2.
//
// #1 cap snapshot ล่าสุดต้อง supersede pendingCap เก่าเสมอ — reset / reset-cap / settings_update
//    ที่มาถึงระหว่าง animation ห้ามถูกค่าเก่าย้อนทับตอน finishAnimation()
// #2 resyncState() ที่เจอ queue busy ต้องยิงใหม่หลัง queue ระบายหมด (in-flight guard กัน response เก่าทับ)
//
// รัน timer.js ตัวจริงใน vm บน DOM/timer/rAF ปลอม — ไม่ stub ตรรกะที่กำลังทดสอบ
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const timerSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'timer', 'timer.js'), 'utf8');

const OPEN = '(function() {';
const CLOSE = '})();';
assert.ok(timerSource.startsWith(OPEN), 'timer.js must still be a bare IIFE');
assert.ok(timerSource.trimEnd().endsWith(CLOSE), 'timer.js must still close with })();');
// ถอดเปลือก IIFE ออกแล้วต่อท้ายด้วย export ในสโคปเดียวกัน ⇒ อ่าน state ภายในได้โดยไม่ต้องใส่ hook ใน production code
const timerBody = timerSource.trimEnd().slice(OPEN.length, -CLOSE.length);

function makeEl(id) {
  const cls = new Set();
  return {
    id,
    textContent: '',
    className: '',
    nodeValue: '',
    children: [],
    style: { setProperty() {}, removeProperty() {} },
    offsetWidth: 1,
    classList: {
      add(...c) { c.forEach((x) => cls.add(x)); },
      remove(...c) { c.forEach((x) => cls.delete(x)); },
      contains(c) { return cls.has(c); },
      toggle(c, f) { const on = f === undefined ? !cls.has(c) : !!f; if (on) cls.add(c); else cls.delete(c); return on; },
    },
    replaceChildren(...nodes) {
      this.children = nodes;
      this.textContent = nodes.map((n) => n.textContent || n.nodeValue || '').join('');
    },
    appendChild(n) { this.children.push(n); this.textContent += (n.textContent || n.nodeValue || ''); },
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 20 }; },
    animate() { return { playState: 'idle', cancel() {} }; },
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {},
  };
}

function createHarness(serverState) {
  const els = new Map(['timerWrapper', 'timerDigits', 'timerRules', 'timerCapLine', 'timerDeltaEl']
    .map((id) => [id, makeEl(id)]));

  const timeouts = new Map();
  const rafQueue = [];
  let timeoutSeq = 1;
  let now = 0;
  const fetchCalls = [];
  let fetchGate = null;         // ตั้งไว้เพื่อหน่วง response ของ resync แล้วปล่อยเองในเทสต์

  const sse = { onopen: null, onmessage: null, onerror: null, closed: false };

  const ctx = {
    console,
    Date,
    Math,
    JSON,
    Number,
    String,
    Object,
    Array,
    URLSearchParams,
    isNaN,
    performance: { now: () => now },
    location: { search: '', origin: 'http://localhost' },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn, ms) => { const id = timeoutSeq++; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timeouts.delete(id); },
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    EventSource: function () { return sse; },
    Audio: function () { return { play: () => Promise.resolve(), volume: 0 }; },
    fetch: async (url) => {
      fetchCalls.push(url);
      if (fetchGate) await fetchGate;
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(serverState)) };
    },
    document: {
      getElementById: (id) => els.get(id) || null,
      createElement: (tag) => makeEl(tag),
      createTextNode: (t) => ({ nodeValue: t, textContent: t }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
  };
  ctx.window = ctx;
  ctx.window.addEventListener = () => {};
  vm.createContext(ctx);

  const script = timerBody + `
;__hook = {
  handleEvent,
  resyncState,
  getCap: () => ({ ...capState }),
  getPendingCap: () => (pendingCap ? { ...pendingCap } : null),
  isAnimating: () => animInProgress,
  capText: () => capLineEl.textContent,
  capHidden: () => capLineEl.style.display === 'none',
};`;
  vm.runInContext('var __hook;\n' + script, ctx);

  return {
    ctx,
    sse,
    fetchCalls,
    hook: () => ctx.__hook,
    setFetchGate: (p) => { fetchGate = p; },
    flushTimeouts() {
      const due = [...timeouts.entries()];
      timeouts.clear();
      due.forEach(([, t]) => t.fn());
    },
    // เดินแอนิเมชันจนจบด้วย timestamp ที่เลย duration แน่ๆ — frame() จะเข้า branch t>=1 → finishAnimation()
    finishAnimationNow() {
      assert.ok(rafQueue.length > 0, 'expected a queued animation frame');
      const frame = rafQueue.pop();
      rafQueue.length = 0;
      now += 60000;
      frame(now);
    },
    hasQueuedFrame: () => rafQueue.length > 0,
  };
}

// vm สร้าง object คนละ realm ⇒ deepStrictEqual เทียบ prototype ไม่ผ่าน — คัดเป็น plain object ฝั่ง host ก่อน
function cap(o) { return o && { capType: o.capType, capValue: o.capValue, capCurrent: o.capCurrent }; }

const BASE_SETTINGS = {
  enabled: 1,
  show_cap: 1,
  show_rules: 0,
  cap_type: 'money',
  cap_value: 100,
  timer_anim_enabled: 1,
  timer_anim_sound_enabled: 0,
  time_unit: 'seconds',
};

function serverState(overrides = {}, settingsOverrides = {}) {
  return {
    timer_settings: JSON.stringify({ ...BASE_SETTINGS, ...settingsOverrides }),
    timer_cap_current: 0,
    timer_remaining_seconds: 600,
    timer_running: 0,
    timer_last_update: null,
    amountSuffix: 'บาท',
    duration: 8,
    goal_anim_enabled: 0,
    ...overrides,
  };
}

async function boot(state) {
  const h = createHarness(state);
  await new Promise((r) => setImmediate(r));   // ปล่อยให้ init() ที่ await fetch เดินจนจบ
  return h;
}

// donation ที่ทำให้เกิด animation — immediate ตัด alert/goalbar delay ออกเพื่อให้ animation เริ่มทันที
function donationEvent(capCurrent, delta = 60) {
  return {
    type: 'timer_update',
    delta,
    remaining: 600 + delta,
    running: true,
    lastUpdate: new Date().toISOString(),
    immediate: true,
    capType: 'money',
    capValue: 100,
    capCurrent,
  };
}

test('F1: reset-cap ระหว่าง animation ต้องไม่ถูกยอดเก่าย้อนทับหลัง animation จบ', async () => {
  const h = await boot(serverState());
  const hook = h.hook();

  assert.equal(hook.getCap().capCurrent, 0);

  hook.handleEvent(donationEvent(50));              // โดเนท 50 → cap ค้างคิวรอ animation
  assert.ok(hook.isAnimating(), 'animation should be running');
  assert.deepEqual(cap(hook.getPendingCap()), { capType: 'money', capValue: 100, capCurrent: 50 });
  assert.equal(hook.getCap().capCurrent, 0, 'cap ต้องยังไม่ขยับระหว่าง animation');

  // reset-cap: ยอดกลับเป็น 0 = เท่ากับ capState ที่กำลังแสดง (จุดที่ของเดิมพัง)
  hook.handleEvent({
    type: 'timer_update', delta: 0, remaining: 660, running: true,
    lastUpdate: new Date().toISOString(),
    capType: 'money', capValue: 100, capCurrent: 0,
  });
  assert.deepEqual(cap(hook.getPendingCap()), { capType: 'money', capValue: 100, capCurrent: 0 },
    'snapshot ล่าสุดต้อง supersede pendingCap เก่า แม้ค่าจะเท่ากับ capState');

  h.finishAnimationNow();
  assert.equal(hook.isAnimating(), false);
  assert.equal(hook.getCap().capCurrent, 0, 'หลัง animation ต้องเป็นยอดหลัง reset-cap ไม่ใช่ 50');
  assert.equal(cap(hook.getPendingCap()), null);
  assert.match(hook.capText(), /100/, 'widget ต้องแสดงโควตาเต็ม 100');
});

test('F1: settings_update ที่เปลี่ยน cap config ระหว่าง animation ต้องอยู่รอดหลัง animation จบ', async () => {
  const h = await boot(serverState());
  const hook = h.hook();

  hook.handleEvent(donationEvent(50));
  assert.ok(hook.isAnimating());

  hook.handleEvent({
    type: 'settings_update',
    settings: {
      timer_settings: JSON.stringify({ ...BASE_SETTINGS, cap_value: 500 }),
      timer_cap_current: 50,
      amountSuffix: 'บาท',
      duration: 8,
      goal_anim_enabled: 0,
    },
  });
  assert.deepEqual(cap(hook.getPendingCap()), { capType: 'money', capValue: 500, capCurrent: 50 },
    'config ใหม่ต้องเข้าไปแทน pendingCap ทั้งก้อน');

  h.finishAnimationNow();
  assert.deepEqual(cap(hook.getCap()), { capType: 'money', capValue: 500, capCurrent: 50 },
    'cap_value ใหม่ต้องไม่ถูก snapshot เก่า (capValue 100) ย้อนทับ');
  assert.match(hook.capText(), /450/, 'เหลือ 500-50 = 450');
});

test('F1: authoritative event ที่ยกเลิก animation ที่ค้างคิว ต้อง apply cap snapshot ไม่ใช่ทิ้ง', async () => {
  // overlayOnline → มี delay ⇒ animation ถูกจัดคิวไว้ ยังไม่เริ่ม
  const h = await boot(serverState());
  const hook = h.hook();

  hook.handleEvent({
    type: 'timer_update', delta: 60, remaining: 660, running: true,
    lastUpdate: new Date().toISOString(), overlayOnline: true,
    capType: 'money', capValue: 100, capCurrent: 50,
  });
  assert.equal(hook.isAnimating(), false, 'ยังไม่เริ่ม animation — รอ alert delay');
  assert.deepEqual(cap(hook.getPendingCap()), { capType: 'money', capValue: 100, capCurrent: 50 });

  // authoritative event ที่ไม่มีฟิลด์ cap เลย (server.js:1740 broadcast แบบนี้จริง) มาก่อน delay หมด
  // → ยกเลิก animation ที่ค้างคิว · ยอด 50 ที่ server นับไปแล้วต้องขึ้นจอ ไม่ใช่ถูกทิ้ง
  hook.handleEvent({
    type: 'timer_update', delta: 0, remaining: 660, running: true,
    lastUpdate: new Date().toISOString(),
  });
  assert.equal(cap(hook.getPendingCap()), null, 'ห้ามค้าง (C10: resyncState จะตายถาวร)');
  assert.equal(hook.getCap().capCurrent, 50, 'ยอด cap ที่ค้างคิวต้องถูก apply ไม่ใช่ถูกทิ้ง');
  assert.match(hook.capText(), /50/, 'เหลือ 100-50 = 50');
});

test('F2: resync ที่ชน queue busy ต้องยิงใหม่หลัง animation จบ', async () => {
  const state = serverState();
  const h = await boot(state);
  const hook = h.hook();
  const fetchesAfterInit = h.fetchCalls.length;

  hook.handleEvent(donationEvent(50));
  assert.ok(hook.isAnimating());

  // SSE reconnect ระหว่าง animation: onopen ครั้งแรกคือ connect แรก (init) — ครั้งที่สองคือ reconnect
  h.sse.onopen();
  h.sse.onopen();
  assert.equal(h.fetchCalls.length, fetchesAfterInit, 'busy → ต้องไม่ fetch ทันที');

  state.timer_cap_current = 80;   // event ที่หายไประหว่าง SSE หลุด
  h.finishAnimationNow();
  await new Promise((r) => setImmediate(r));

  assert.equal(h.fetchCalls.length, fetchesAfterInit + 1, 'queue ว่างแล้วต้อง resync ซ้ำเอง');
  assert.equal(hook.getCap().capCurrent, 80, 'ต้องได้ snapshot authoritative ที่เคยถูกทิ้ง');
});

test('F2: in-flight guard — resync ซ้อนกันต้องไม่ยิง fetch พร้อมกันสองรอบ', async () => {
  const state = serverState();
  const h = await boot(state);
  const before = h.fetchCalls.length;

  let release;
  h.setFetchGate(new Promise((r) => { release = r; }));

  h.hook().resyncState();
  h.hook().resyncState();
  h.hook().resyncState();
  assert.equal(h.fetchCalls.length, before + 1, 'ต้องมี fetch ค้างได้ทีละ 1 รอบเท่านั้น');

  h.setFetchGate(null);
  release();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});
