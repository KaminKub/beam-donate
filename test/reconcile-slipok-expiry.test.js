process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'test-master-key-for-slipok-reconcile-test';
process.env.ENCRYPTION_SALT = process.env.ENCRYPTION_SALT || 'test-salt-slipok-reconcile';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encrypt } = require('../src/encryption');
const {
  parseArgs,
  sanitizeUsername,
  inventoryActions,
  buildReconciliationPlan,
  applyReconciliationPlan,
  verifyReconciliationPlan,
  main
} = require('../scripts/reconcile-slipok-expiry');

const URL = 'https://api.slipok.com/api/line/apikey/RECONCILE';
const KEY = 'RECONCILE-TEST-KEY';

function row(overrides = {}) {
  return {
    id: 77,
    username: 'reconcile_fixture_user',
    slipok_api_encrypted: encrypt(URL),
    slipok_api_key_encrypted: encrypt(KEY),
    slipok_connected: 1,
    slipok_last_check: '2026-08-20T00:00:00.000Z',
    truemoney_slipok_api_encrypted: encrypt(URL),
    truemoney_slipok_api_key_encrypted: encrypt(KEY),
    truemoney_slipok_connected: 0,
    truemoney_slipok_last_check: '2026-08-20T01:00:00.000Z',
    ...overrides
  };
}

function fakeAxios(handler) {
  const calls = [];
  return {
    calls,
    get(url, config) {
      calls.push({ url, config });
      return handler(url, config);
    }
  };
}

test('default mode is inventory-only and conflicting modes are rejected', () => {
  assert.deepEqual(parseArgs([]), { mode: 'inventory' });
  assert.deepEqual(parseArgs(['--probe']), { mode: 'probe' });
  assert.deepEqual(parseArgs(['--execute']), { mode: 'execute' });
  assert.deepEqual(parseArgs(['--probe', '--execute']), { error: 'CONFLICTING_MODE' });
});

test('inventory is exact by opaque user/scope and contains no credential material', () => {
  const fixture = row();
  const actions = inventoryActions([fixture]);
  assert.deepEqual(actions.map(action => action.scope), ['promptpay', 'truemoney']);
  const serialized = JSON.stringify(actions);
  for (const secret of [URL, KEY, fixture.slipok_api_encrypted, fixture.slipok_api_key_encrypted, 'reconcile_fixture_user']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(actions[0].user, /^re\*\*\*r#[a-f0-9]{12}$/);
  assert.equal(actions[0].user, sanitizeUsername('reconcile_fixture_user'));
});

test('probe deduplicates pairs and plans only authoritative disconnects', async () => {
  const axiosClient = fakeAxios(() => Promise.resolve({
    data: { success: true, data: { quota: 90, endDate: '2026-08-22' } }
  }));
  const plan = await buildReconciliationPlan([row()], {
    axiosClient,
    nowMs: Date.parse('2026-08-22T17:00:00.000Z')
  });

  assert.equal(axiosClient.calls.length, 1);
  assert.equal(plan.counts.expired, 2);
  assert.equal(plan.counts.disconnectCandidates, 1);
  assert.equal(plan.counts.alreadyDisconnected, 1);
  assert.equal(plan.actions[0].outcome.expired, true);
});

test('execute is disconnect-only, race-safe, and verifies the authoritative target', async () => {
  const axiosClient = fakeAxios(() => Promise.resolve({
    data: { success: true, data: { quota: 90, endDate: '2026-08-22' } }
  }));
  const initial = row();
  const plan = await buildReconciliationPlan([initial], {
    axiosClient,
    nowMs: Date.parse('2026-08-22T17:00:00.000Z')
  });
  const writes = [];
  const result = await applyReconciliationPlan(plan, {
    checkedAt: '2026-08-23T00:00:00.000Z',
    disconnectScope: async (streamer, scope, checkedAt) => {
      writes.push({ id: streamer.id, scope, checkedAt });
      return { rowsAffected: 1 };
    }
  });

  assert.deepEqual(writes, [{ id: 77, scope: 'promptpay', checkedAt: '2026-08-23T00:00:00.000Z' }]);
  assert.deepEqual(result, { disconnected: 1, alreadyDisconnected: 1, stale: 0, writeFailures: 0 });

  const verifiedRow = { ...initial, slipok_connected: 0, slipok_last_check: '2026-08-23T00:00:00.000Z' };
  const verification = verifyReconciliationPlan(plan, [verifiedRow]);
  assert.deepEqual(verification, { verifiedDisconnected: 2, removed: 0, stale: 0 });
});

test('unknown provider outcomes are left untouched and make a probe partial', async () => {
  const axiosClient = fakeAxios(() => Promise.reject(Object.assign(new Error(`timeout ${URL}`), { code: 'ETIMEDOUT' })));
  const plan = await buildReconciliationPlan([row({ truemoney_slipok_api_encrypted: null, truemoney_slipok_api_key_encrypted: null })], { axiosClient });
  assert.equal(plan.counts.unknown, 1);
  const writes = await applyReconciliationPlan(plan, { disconnectScope: async () => { throw new Error('must not write'); } });
  assert.deepEqual(writes, { disconnected: 0, alreadyDisconnected: 0, stale: 0, writeFailures: 0 });
});

test('incomplete or unreadable stored scopes remain in the inventory as unknown, never silently skipped', async () => {
  const incomplete = row({ truemoney_slipok_api_key_encrypted: null });
  const inventory = inventoryActions([incomplete]);
  assert.deepEqual(inventory.map(action => action.scope), ['promptpay', 'truemoney']);

  const axiosClient = fakeAxios(() => Promise.resolve({
    data: { success: true, data: { quota: 10, endDate: '2099-12-31' } }
  }));
  const plan = await buildReconciliationPlan([incomplete], { axiosClient });
  assert.equal(axiosClient.calls.length, 1);
  assert.equal(plan.counts.usable, 1);
  assert.equal(plan.counts.unknown, 1);
  assert.equal(plan.actions.find(action => action.scope === 'truemoney').outcome.authoritative, false);
});

test('main default mode performs only the sanitized inventory query', async () => {
  const fixture = row();
  let initCalls = 0;
  let queryCalls = 0;
  const fakeDb = {
    async initDB() { initCalls++; },
    getDB() {
      return {
        async execute() {
          queryCalls++;
          return { rows: [fixture] };
        }
      };
    }
  };
  const lines = [];
  const originalLog = console.log;
  console.log = line => lines.push(String(line));
  try {
    const code = await main({ argv: [], database: fakeDb });
    assert.equal(code, 0);
  } finally {
    console.log = originalLog;
  }
  assert.equal(initCalls, 1);
  assert.equal(queryCalls, 1);
  const output = lines.join('\n');
  assert.equal(output.includes(URL), false);
  assert.equal(output.includes(KEY), false);
  assert.match(output, /configuredScopes=2 providerCalls=0 writes=0/);
});
