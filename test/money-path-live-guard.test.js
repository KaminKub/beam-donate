'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { getLiveTestConfig } = require('../test-money-path');

test('money-path live test is inert without explicit opt-in', () => {
  const { RUN_LIVE_MONEY_TEST, ...safeEnv } = process.env;
  const result = spawnSync(process.execPath, ['test-money-path.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: safeEnv,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /SKIP live money-path test/);
  assert.doesNotMatch(result.stdout + result.stderr, /Connecting to Turso Database/);
});

test('money-path live test refuses a non-disposable database before loading the db module', () => {
  assert.throws(
    () => getLiveTestConfig({
      RUN_LIVE_MONEY_TEST: '1',
      TURSO_DATABASE_URL: 'libsql://production.turso.io',
      MPT_DISPOSABLE_DB_URL: 'libsql://production.turso.io',
      MPT_STREAMER: 'qa-fixture'
    }),
    /disposable dev, test, or sandbox/
  );
});

test('money-path live test requires an exact disposable database declaration', () => {
  assert.throws(
    () => getLiveTestConfig({
      RUN_LIVE_MONEY_TEST: '1',
      TURSO_DATABASE_URL: 'libsql://tipkub-test.turso.io',
      MPT_DISPOSABLE_DB_URL: 'libsql://other-test.turso.io',
      MPT_STREAMER: 'qa-fixture'
    }),
    /must exactly match/
  );
});

test('money-path live test accepts only an explicitly declared disposable target', () => {
  assert.deepEqual(
    getLiveTestConfig({
      RUN_LIVE_MONEY_TEST: '1',
      TURSO_DATABASE_URL: 'libsql://tipkub-test.turso.io',
      MPT_DISPOSABLE_DB_URL: 'libsql://tipkub-test.turso.io',
      MPT_STREAMER: 'qa-fixture'
    }),
    { streamer: 'qa-fixture' }
  );
});
