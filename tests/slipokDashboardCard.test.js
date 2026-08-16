const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const dashboardPath = require('node:path').join(__dirname, '..', 'public', 'dashboard', 'dashboard.js');
const dashboardSource = fs.readFileSync(dashboardPath, 'utf8');
const quotaStart = dashboardSource.indexOf('async function fetchSlipokDashQuota');
const quotaEnd = dashboardSource.indexOf('// ========== SlipOK Quota Mini-Card', quotaStart);
assert.ok(quotaStart >= 0 && quotaEnd > quotaStart, 'quota function boundary must exist');
const quotaFunctionSource = dashboardSource.slice(quotaStart, quotaEnd);

function createQuotaHarness(responses, methodOrder = ['promptpay', 'truemoney']) {
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

test('dashboard card keeps connected state when fallback method succeeds', async () => {
  const harness = createQuotaHarness([
    { status: 401, ok: false },
    { status: 200, ok: true, body: successBody }
  ]);

  const result = await harness.run(null, true);

  assert.equal(result, true);
  assert.deepEqual(harness.calls, [
    '/api/payment/slipok-quota?method=promptpay',
    '/api/payment/slipok-quota?method=truemoney'
  ]);
  assert.deepEqual(harness.cardRenders, [[true]]);
  assert.deepEqual(harness.statusUpdates, []);
  assert.equal(harness.elements.get('slipokDashUsed').textContent, 20);
});

test('dashboard card coalesces initial load and one click into one quota request', async () => {
  const harness = createQuotaHarness([
    { status: 200, ok: true, body: successBody, delay: 5 }
  ]);

  const results = await Promise.all([harness.run(null), harness.run(null, true)]);

  assert.deepEqual(results, [true, true]);
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
