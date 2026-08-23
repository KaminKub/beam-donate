'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('migration creates the pending payable amount lookup index', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tipkub-reservation-migration-'));
  const databasePath = path.join(tempDir, 'migration.db').replace(/\\/g, '/');
  const childScript = `
    (async () => {
      const database = require('./src/database');
      await database.initDB();
      await database.migrateDB();
      const result = await database.getDB().execute(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_transactions_pending_payable_amount'"
      );
      if (result.rows.length !== 1) throw new Error('reservation index missing');
      const plan = await database.getDB().execute({
        sql: "EXPLAIN QUERY PLAN SELECT 1 FROM transactions WHERE LOWER(streamer_username) = LOWER(?) AND status = 'pending' AND CAST(ROUND(amount * 100) AS INTEGER) = ? LIMIT 1",
        args: ['streamer', 4999]
      });
      if (!plan.rows.some(row => String(row.detail || '').includes('idx_transactions_pending_payable_amount'))) {
        throw new Error('reservation query does not use its index');
      }
      database.getDB().close();
    })().catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  `;

  const child = spawnSync(process.execPath, ['-e', childScript], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      TURSO_DATABASE_URL: `file:${databasePath}`,
      TURSO_AUTH_TOKEN: ''
    },
    encoding: 'utf8',
    timeout: 30000
  });

  try {
    assert.equal(child.status, 0, child.stderr || child.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});
