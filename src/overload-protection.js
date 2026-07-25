// Overload Protection — load shedding / circuit breaker
// Blueprint: .agents/plans/Blueprints/overload_protection_Blueprint.md (Rev 2)
//
// Risk is sampled on a 2s interval and cached in a module-scope variable, so the
// per-request cost of a guard is a single property read (no syscall, no allocation).
const { monitorEventLoopDelay } = require('perf_hooks');

const MB = 1024 * 1024;
const RSS_CEILING_MB = 480;       // soft ceiling under the PM2 512M restart limit
const SSE_CEILING = 500;          // must track MAX_SSE_CLIENTS in server.js
const LOOP_LAG_CEILING_MS = 200;  // mean event-loop lag at which the loop is saturated
const TICK_MS = 2000;

// Hysteresis: rise at ENTER[level], fall only below RELEASE[level].
const ENTER = [0, 0.80, 0.90];
const RELEASE = [0, 0.70, 0.80];

const BUSY_BODY = {
  error: 'SYSTEM_BUSY',
  message: 'ระบบกำลังมีผู้ใช้งานหนาแน่น กรุณารอสักครู่',
};

let state = {
  level: 0,
  risk: 0,
  riskMem: 0,
  riskSse: 0,
  riskLoop: 0,
  armed: process.env.OVERLOAD_PROTECTION === 'on',
  sseBySource: { widget: 0, donor: 0, demo: 0 },
};

let histogram = null;

// sseClients is a single shared bucket for 4 different stream types. Break it down so
// the admin monitor (and QA) can see which group is filling the budget.
// widget + donor + demo must always sum to sseClients.length.
function countBySource(clients) {
  const out = { widget: 0, donor: 0, demo: 0 };
  for (const c of clients) {
    const source = c.source || '';
    if (source.startsWith('demo')) out.demo++;
    else if (source === 'dona-monitor' || source === 'donate-status') out.donor++;
    else out.widget++;
  }
  return out;
}

function nextLevel(current, risk) {
  let level = current;
  if (risk >= ENTER[2]) level = 2;
  else if (level < 1 && risk >= ENTER[1]) level = 1;
  if (level === 2 && risk < RELEASE[2]) level = 1;
  if (level === 1 && risk < RELEASE[1]) level = 0;
  return level;
}

function tick(getSseClients) {
  const clients = getSseClients() || [];
  const rssMB = process.memoryUsage().rss / MB;
  const lagMs = histogram ? histogram.mean / 1e6 : 0;
  if (histogram) histogram.reset();

  const riskMem = rssMB / RSS_CEILING_MB;
  const riskSse = clients.length / SSE_CEILING;
  const riskLoop = Number.isFinite(lagMs) ? lagMs / LOOP_LAG_CEILING_MS : 0;
  const risk = Math.max(riskMem, riskSse, riskLoop);

  const armed = process.env.OVERLOAD_PROTECTION === 'on';
  const level = armed ? nextLevel(state.level, risk) : 0;

  if (level !== state.level) {
    console.warn(`[overload] level ${state.level}→${level} risk=${risk.toFixed(2)} mem=${riskMem.toFixed(2)} sse=${riskSse.toFixed(2)} loop=${riskLoop.toFixed(2)}`);
  }

  state = { level, risk, riskMem, riskSse, riskLoop, armed, sseBySource: countBySource(clients) };
}

// getSseClients must be a getter — server.js reassigns sseClients with .filter() on
// disconnect, so holding the array itself would pin a stale snapshot.
function initOverloadMonitor({ getSseClients }) {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  setInterval(() => tick(getSseClients), TICK_MS).unref();
  console.log(`[overload] monitor started armed=${state.armed}`);
}

function getProtectionState() {
  return state;
}

// Returns true when it has already answered the request with 503.
// Used directly by SSE handlers, which must shed after auth but before res.writeHead().
function shedIfBusy(res, minLevel) {
  if (state.level < minLevel) return false;
  res.status(503).set('Retry-After', '30').json({ ...BUSY_BODY, level: state.level });
  return true;
}

function loadShedGuard(minLevel) {
  return (req, res, next) => {
    if (!shedIfBusy(res, minLevel)) next();
  };
}

module.exports = { initOverloadMonitor, getProtectionState, loadShedGuard, shedIfBusy };

// Self-check: node src/overload-protection.js
if (require.main === module) {
  const assert = require('assert');
  assert.strictEqual(nextLevel(0, 0.79), 0, 'stays NORMAL below 0.80');
  assert.strictEqual(nextLevel(0, 0.80), 1, 'enters GUARDED at 0.80');
  assert.strictEqual(nextLevel(1, 0.75), 1, 'hysteresis: no release until below 0.70');
  assert.strictEqual(nextLevel(1, 0.69), 0, 'releases GUARDED below 0.70');
  assert.strictEqual(nextLevel(1, 0.90), 2, 'enters CRITICAL at 0.90');
  assert.strictEqual(nextLevel(2, 0.85), 2, 'hysteresis: no release until below 0.80');
  assert.strictEqual(nextLevel(2, 0.79), 1, 'steps CRITICAL down to GUARDED below 0.80');
  const counts = countBySource([
    { source: 'overlay' }, { source: 'timer' },
    { source: 'dona-monitor' }, { source: 'donate-status' },
    { source: 'demo-overlay' },
  ]);
  assert.deepStrictEqual(counts, { widget: 2, donor: 2, demo: 1 });
  console.log('overload-protection self-check OK');
}
