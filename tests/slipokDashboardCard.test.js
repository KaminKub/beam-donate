const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const dashboardPath = require('node:path').join(__dirname, '..', 'public', 'dashboard', 'dashboard.js');
const dashboardSource = fs.readFileSync(dashboardPath, 'utf8');
const quotaStart = dashboardSource.indexOf('async function fetchSlipokDashQuota');
const quotaEnd = dashboardSource.indexOf('// ========== SlipOK Quota Mini-Card', quotaStart);
assert.ok(quotaStart >= 0 && quotaEnd > quotaStart, 'quota function boundary must exist');
// The date helpers are sliced in too, so the harness exercises the real strict
// date-only parsing/formatting instead of a stub that could hide a regression.
const helpersStart = dashboardSource.indexOf('function slipokBangkokDateKey');
const helpersEnd = dashboardSource.indexOf('function renderSlipokDashExpiry', helpersStart);
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, 'date helper boundary must exist');
const quotaFunctionSource = dashboardSource.slice(helpersStart, helpersEnd)
  + dashboardSource.slice(quotaStart, quotaEnd);

function createQuotaHarness(
  responses,
  methodOrder = ['promptpay', 'truemoney'],
  effectiveScope = 'promptpay',
  effectiveReady = true
) {
  const elements = new Map();
  const makeElement = (id, textContent = '—') => {
    const element = {
      id,
      textContent,
      innerHTML: '',
      style: { width: '', opacity: '' },
      parentElement: null,
      classList: { add() {}, remove() {} }
    };
    elements.set(id, element);
    return element;
  };

  for (const id of ['slipokDashUsed', 'slipokDashTotal', 'slipokDashBar', 'slipokDashMeta']) {
    makeElement(id);
  }
  const affordParent = { innerHTML: '<i class="fa-rotate"></i> คลิกเพื่อรีเฟรช', style: { opacity: '' } };
  const afford = { classList: { add() {}, remove() {} }, parentElement: affordParent };
  const calls = [];
  const cardRenders = [];
  const statusUpdates = [];
  let responseIndex = 0;

  const context = {
    console,
    Date,
    Math,
    slipokDashQuotaInFlight: null,
    slipokDashMethodOrder: methodOrder,
    slipokDashEffectiveScope: effectiveScope,
    slipokDashEffectiveReady: effectiveReady,
    document: {
      getElementById: (id) => elements.get(id) || null,
      querySelector: () => afford
    },
    setTimeout: (fn, delay) => setTimeout(fn, delay > 10 ? 0 : delay),
    showSlipokDashRefreshFeedback: () => {},
    renderSlipokDashCard: (...args) => cardRenders.push(args),
    updateSlipOkStatus: (...args) => statusUpdates.push(args),
    renderSlipokDashExpiry: () => {},
    fetch: async (url) => {
      calls.push(url);
      const response = responses[responseIndex++];
      if (!response) throw new Error('unexpected fetch');
      if (response.delay) await new Promise(resolve => setTimeout(resolve, response.delay));
      if (response.throw) throw new Error(response.throw);
      return {
        status: response.status,
        ok: response.ok,
        json: async () => response.body
      };
    }
  };

  vm.runInNewContext(`${quotaFunctionSource}\nthis.run = fetchSlipokDashQuota;`, context);
  return { context, run: context.run, calls, cardRenders, statusUpdates, elements };
}

const successBody = {
  success: true,
  data: { quota: 80, overQuota: 0, specialQuota: 0, endDate: null, snapshotTotal: 100 }
};

test('dashboard keeps the effective primary lane disconnected when its successful quota response is expired', async () => {
  const expiredPrimary = {
    success: true,
    data: {
      quota: 80,
      overQuota: 0,
      specialQuota: 0,
      endDate: '2026-08-21',
      expired: true,
      method: 'promptpay',
      snapshotTotal: 100
    }
  };
  const harness = createQuotaHarness([
    { status: 200, ok: true, body: expiredPrimary },
    { status: 200, ok: true, body: successBody }
  ]);

  const result = await harness.run(null, true);

  assert.equal(result.ok, false);
  assert.equal(result.expired, true);
  assert.deepEqual(harness.calls, [
    '/api/payment/slipok-quota?method=promptpay',
    '/api/payment/slipok-quota?method=truemoney'
  ]);
  assert.deepEqual(harness.statusUpdates.at(-1).slice(0, 1), [false]);
  assert.equal(harness.statusUpdates.at(-1)[2], 'expired');
  assert.deepEqual(harness.cardRenders.at(-1), [false, 'expired']);
});

test('dashboard card presents connected state when its effective TrueMoney lane succeeds', async () => {
  const harness = createQuotaHarness([
    { status: 200, ok: true, body: successBody }
  ], ['truemoney', 'promptpay'], 'truemoney');

  const result = await harness.run(null, true);

  assert.equal(result.ok, true);
  assert.deepEqual(harness.calls, [
    '/api/payment/slipok-quota?method=truemoney'
  ]);
  assert.deepEqual(harness.cardRenders, [[true]]);
  assert.deepEqual(harness.statusUpdates, []);
  assert.equal(harness.elements.get('slipokDashUsed').textContent, 20);
});

test('a transient effective primary plus fallback success preserves the primary top-card state', async () => {
  const harness = createQuotaHarness([
    { status: 429, ok: false, body: { success: false } },
    { status: 200, ok: true, body: successBody }
  ], ['promptpay', 'truemoney'], 'promptpay', false);

  const result = await harness.run(null, true);

  assert.equal(result.ok, false, 'non-effective fallback success must not present the top card as reconnected');
  assert.deepEqual(harness.calls, [
    '/api/payment/slipok-quota?method=promptpay',
    '/api/payment/slipok-quota?method=truemoney'
  ]);
  assert.deepEqual(harness.statusUpdates, []);
  assert.deepEqual(harness.cardRenders, []);
});

test('a valid quota refresh never visually reconnects an already-disconnected effective lane', async () => {
  const harness = createQuotaHarness([
    { status: 200, ok: true, body: successBody }
  ], ['promptpay', 'truemoney'], 'promptpay', false);

  const result = await harness.run(null, true);

  assert.equal(result.ok, false);
  assert.deepEqual(harness.statusUpdates, []);
  assert.deepEqual(harness.cardRenders, []);
});

test('dashboard card coalesces initial load and one click into one quota request', async () => {
  const harness = createQuotaHarness([
    { status: 200, ok: true, body: successBody, delay: 5 }
  ]);

  const results = await Promise.all([harness.run(null), harness.run(null, true)]);

  assert.deepEqual(results.map(result => result.ok), [true, true]);
  assert.deepEqual(harness.calls, ['/api/payment/slipok-quota?method=promptpay']);
});

test('dashboard card prefers the connected TrueMoney method', async () => {
  const harness = createQuotaHarness(
    [{ status: 200, ok: true, body: successBody }],
    ['truemoney', 'promptpay']
  );

  await harness.run(null);

  assert.deepEqual(harness.calls, ['/api/payment/slipok-quota?method=truemoney']);
});

test('dashboard does not persist a disconnected presentation for transient quota failures', async () => {
  const harness = createQuotaHarness([
    { status: 429, ok: false, body: { success: false } },
    { throw: 'DNS failure' }
  ]);

  const result = await harness.run(null, true);

  assert.equal(result.ok, false);
  assert.equal(result.authoritative, false);
  assert.deepEqual(harness.statusUpdates, []);
  assert.deepEqual(harness.cardRenders, []);
});

test('dashboard uses the server expired flag for the disconnected status and never parses date-only expiry as UTC', () => {
  const statusStart = dashboardSource.indexOf('function updateSlipOkStatus(');
  const statusEnd = dashboardSource.indexOf('\n\nasync function testSlipOkConnection', statusStart);
  const expiryStart = dashboardSource.indexOf('function renderSlipokDashExpiry(');
  const expiryEnd = dashboardSource.indexOf('\n\nfunction showSlipokDashRefreshFeedback', expiryStart);
  const status = dashboardSource.slice(statusStart, statusEnd);
  const expiry = dashboardSource.slice(expiryStart, expiryEnd);

  assert.match(status, /status\.className = 'tfp-status disconnected';/);
  assert.match(status, /reason === 'expired'/);
  assert.match(expiry, /expired === true/);
  assert.doesNotMatch(expiry, /Date\.parse\(/);
  assert.doesNotMatch(expiry, /new Date\(endDate\)/);
});
