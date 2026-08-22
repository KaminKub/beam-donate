'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getAdminSlipOkStatus, projectAdminUserRow } = require('../src/database');

const NOW = Date.parse('2026-08-23T00:00:00.000Z');

function statusRow(overrides = {}) {
  return {
    slipok_configured: 1,
    truemoney_slipok_configured: 0,
    slipok_connected: 1,
    truemoney_slipok_connected: 0,
    slipok_expiry: '2026-08-30',
    truemoney_slipok_expiry: null,
    slipok_last_check: '2026-08-22T10:00:00.000Z',
    truemoney_slipok_last_check: null,
    ...overrides
  };
}

test('admin SlipOK status is primary-first and requires a valid current end date to be connected', () => {
  assert.deepEqual(getAdminSlipOkStatus(statusRow(), NOW), {
    slipok_status: 'connected',
    slipok_status_label: 'เชื่อมต่อแล้ว',
    slipok_scope: 'promptpay',
    slipok_expiry: '2026-08-30',
    slipok_last_check: '2026-08-22T10:00:00.000Z'
  });

  assert.equal(getAdminSlipOkStatus(statusRow({ slipok_expiry: '2026-08-22' }), NOW).slipok_status, 'expired');
  assert.equal(getAdminSlipOkStatus(statusRow({ slipok_connected: 0 }), NOW).slipok_status, 'not-connected');
  assert.equal(getAdminSlipOkStatus(statusRow({ slipok_expiry: null }), NOW).slipok_status, 'not-connected');

  const fallbackCannotMaskPrimary = getAdminSlipOkStatus(statusRow({
    truemoney_slipok_configured: 1,
    truemoney_slipok_connected: 1,
    truemoney_slipok_expiry: '2026-12-31',
    slipok_expiry: '2026-08-22'
  }), NOW);
  assert.equal(fallbackCannotMaskPrimary.slipok_scope, 'promptpay');
  assert.equal(fallbackCannotMaskPrimary.slipok_status, 'expired');

  const fallbackOnly = getAdminSlipOkStatus(statusRow({
    slipok_configured: 0,
    slipok_connected: 0,
    slipok_expiry: null,
    truemoney_slipok_configured: 1,
    truemoney_slipok_connected: 1,
    truemoney_slipok_expiry: '2026-12-31',
    truemoney_slipok_last_check: '2026-08-22T11:00:00.000Z'
  }), NOW);
  assert.deepEqual(fallbackOnly, {
    slipok_status: 'connected',
    slipok_status_label: 'เชื่อมต่อแล้ว',
    slipok_scope: 'truemoney',
    slipok_expiry: '2026-12-31',
    slipok_last_check: '2026-08-22T11:00:00.000Z'
  });
});

test('admin user projection sends only compact, non-secret SlipOK fields', () => {
  const secret = 'encrypted-api-key-must-not-leak';
  const projected = projectAdminUserRow({
    username: 'status_fixture',
    is_active: 1,
    has_twitch: 1,
    has_streamlabs: 0,
    tos_accepted_at: '2026-08-01T00:00:00.000Z',
    promptpay_enabled: 1,
    truemoney_enabled: 0,
    tfp_connected: 0,
    bank_enabled: 0,
    badges: '{"beta_tester":true}',
    slipok_api_encrypted: secret,
    slipok_api_key_encrypted: secret,
    truemoney_slipok_api_encrypted: secret,
    truemoney_slipok_api_key_encrypted: secret,
    ...statusRow()
  }, NOW);

  assert.deepEqual(projected, {
    username: 'status_fixture',
    is_active: true,
    has_twitch: true,
    has_streamlabs: false,
    tos_accepted_at: '2026-08-01T00:00:00.000Z',
    promptpay_enabled: true,
    truemoney_enabled: false,
    tfp_connected: false,
    bank_enabled: false,
    hasBetaBadge: true,
    slipok_status: 'connected',
    slipok_status_label: 'เชื่อมต่อแล้ว',
    slipok_scope: 'promptpay',
    slipok_expiry: '2026-08-30',
    slipok_last_check: '2026-08-22T10:00:00.000Z'
  });
  assert.equal(JSON.stringify(projected).includes(secret), false);
});

test('admin query keeps SlipOK credentials out of the selected fields and response projection', () => {
  const databaseSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'database.js'), 'utf8');
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const queryStart = databaseSource.indexOf('async function getAdminUsers');
  const queryEnd = databaseSource.indexOf('async function getAdminIpEvents', queryStart);
  assert.notEqual(queryStart, -1);
  assert.notEqual(queryEnd, -1);
  const query = databaseSource.slice(queryStart, queryEnd);
  assert.match(query, /slipok_configured/);
  assert.match(query, /truemoney_slipok_configured/);
  assert.match(query, /projectAdminUserRow\(row/);
  assert.doesNotMatch(query, /\bslipok_api_encrypted\s+AS\b/);
  assert.doesNotMatch(query, /\bslipok_api_key_encrypted\s+AS\b/);
  const routeStart = serverSource.indexOf("app.get('/api/admin/users'");
  const routeEnd = serverSource.indexOf("app.get('/api/admin/ip-events'", routeStart);
  assert.doesNotMatch(serverSource.slice(routeStart, routeEnd), /\.\.\.u/);
});
