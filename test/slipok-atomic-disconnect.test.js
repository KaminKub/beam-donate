const test = require('node:test');
const assert = require('node:assert/strict');

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'slipok-atomic-test-master-key';
process.env.ENCRYPTION_SALT = process.env.ENCRYPTION_SALT || 'slipok-atomic-test-salt';

const {
  buildScopedSlipOkDisconnectStatement,
  buildScopedSlipOkReconnectStatement,
  buildScopedSlipOkQuotaSnapshotStatement,
  buildScopedSlipOkExplicitRetestStatement
} = require('../src/database');
const { encrypt, decrypt } = require('../src/encryption');

function snapshot(overrides = {}) {
  return {
    id: 42,
    slipok_api_encrypted: 'cipher-primary-api',
    slipok_api_key_encrypted: 'cipher-primary-key',
    slipok_connected: 1,
    slipok_last_check: '2026-08-20T00:00:00.000Z',
    slipok_expiry: null,
    truemoney_slipok_api_encrypted: 'cipher-wallet-api',
    truemoney_slipok_api_key_encrypted: 'cipher-wallet-key',
    truemoney_slipok_connected: 1,
    truemoney_slipok_last_check: '2026-08-20T01:00:00.000Z',
    truemoney_slipok_expiry: null,
    ...overrides
  };
}

function assertBoundStatement(statement) {
  assert.equal((statement.sql.match(/\?/g) || []).length, statement.args.length, statement.sql);
}

test('authoritative disconnect is an allowlisted atomic compare-and-set for only its scope', () => {
  const statement = buildScopedSlipOkDisconnectStatement(
    snapshot(),
    'promptpay',
    '2026-08-22T00:00:00.000Z'
  );

  assert.match(statement.sql, /SET slipok_connected = 0, slipok_last_check = \?/);
  assert.doesNotMatch(statement.sql, /truemoney_slipok_connected/);
  assert.match(statement.sql, /slipok_api_encrypted IS \?/);
  assert.match(statement.sql, /slipok_api_key_encrypted IS \?/);
  assert.match(statement.sql, /COALESCE\(slipok_connected, 0\) = 1/);
  assert.match(statement.sql, /slipok_last_check IS \?/);
  assert.deepEqual(statement.args, [
    '2026-08-22T00:00:00.000Z',
    42,
    'cipher-primary-api',
    'cipher-primary-key',
    '2026-08-20T00:00:00.000Z',
    null
  ]);
  assertBoundStatement(statement);
});

test('an already-disconnected snapshot does not rewrite its last-check timestamp', () => {
  assert.equal(
    buildScopedSlipOkDisconnectStatement(snapshot({ truemoney_slipok_connected: 0 }), 'truemoney', 'NOW'),
    null
  );
});

test('the atomic helper rejects incomplete snapshots and unknown scopes', () => {
  assert.throws(
    () => buildScopedSlipOkDisconnectStatement(snapshot({ slipok_api_key_encrypted: null }), 'promptpay', 'NOW'),
    /incomplete/
  );
  assert.throws(
    () => buildScopedSlipOkDisconnectStatement(snapshot(), 'all-scopes', 'NOW'),
    /Invalid SlipOK scope/
  );
});

test('explicit reconnect and quota snapshot writes use the same scoped stale guard', () => {
  const reconnect = buildScopedSlipOkReconnectStatement(
    snapshot({ slipok_connected: 0, slipok_quota_total: 100 }),
    'promptpay',
    '2026-08-22T00:00:00.000Z',
    500,
    '2026-08-30'
  );
  assert.match(reconnect.sql, /SET slipok_connected = 1,\s+slipok_last_check = \?/);
  assert.match(reconnect.sql, /slipok_quota_total = CASE/);
  assert.match(reconnect.sql, /slipok_api_encrypted IS \?/);
  assert.match(reconnect.sql, /COALESCE\(slipok_connected, 0\) = 0/);
  assert.match(reconnect.sql, /slipok_last_check IS \?/);
  assert.match(reconnect.sql, /COALESCE\(slipok_quota_total, 0\) = \?/);
  assert.doesNotMatch(reconnect.sql, /truemoney_slipok_connected/);
  assertBoundStatement(reconnect);

  const quota = buildScopedSlipOkQuotaSnapshotStatement(
    snapshot({ truemoney_slipok_quota_total: 0 }),
    'truemoney',
    100,
    '2026-08-30'
  );
  assert.match(quota.sql, /SET truemoney_slipok_quota_total = \?/);
  assert.match(quota.sql, /truemoney_slipok_api_encrypted IS \?/);
  assert.match(quota.sql, /COALESCE\(truemoney_slipok_quota_total, 0\) = \?/);
  assert.doesNotMatch(quota.sql, /slipok_connected =/);
  assertBoundStatement(quota);
});

test('explicit retest can save only its requested scope through a guarded atomic statement', () => {
  const statement = buildScopedSlipOkExplicitRetestStatement(snapshot({
    slipok_api_encrypted: encrypt('https://api.slipok.com/api/line/apikey/old'),
    slipok_api_key_encrypted: encrypt('old-key'),
    promptpay_value_encrypted: encrypt('0811111111'),
    bank_account_number_encrypted: encrypt('1234567890'),
    truemoney_phone_encrypted: encrypt('0822222222'),
    slipok_connected: 0,
    slipok_quota_total: 100
  }), 'promptpay', {
    checkedAt: '2026-08-22T00:00:00.000Z',
    quotaTotal: 500,
    url: 'https://api.slipok.com/api/line/apikey/new',
    key: 'new-key',
    promptpayType: 'phone',
    promptpayValue: '0833333333',
    endDate: '2026-08-30'
  });

  assert.match(statement.sql, /SET slipok_api_encrypted = \?,\s+slipok_api_key_encrypted = \?/);
  assert.match(statement.sql, /SET[\s\S]*slipok_connected = 1/);
  assert.match(statement.sql, /promptpay_value_encrypted IS \?/);
  assert.match(statement.sql, /bank_account_number_encrypted IS \?/);
  assert.match(statement.sql, /truemoney_phone_encrypted IS \?/);
  assert.doesNotMatch(statement.sql, /truemoney_slipok_connected = 1/);
  assert.equal(decrypt(statement.args[0]), 'https://api.slipok.com/api/line/apikey/new');
  assert.equal(decrypt(statement.args[1]), 'new-key');
  assert.equal(statement.args.includes('new-key'), false);
  assertBoundStatement(statement);
});
