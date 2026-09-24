'use strict';

// Expiry-only SlipOK reconciliation for one stored streamer.
//
//   npm run admin:check-slipok-expiry -- --username <username>
//       probe only; no DB writes
//   npm run admin:check-slipok-expiry -- --username <username> --execute
//       probe, then scoped disconnect for authoritative expired/account-issue only
//
// This command deliberately has no Payment Eligibility guard because it cannot
// reconnect, write credentials, verify an account, or enable a payment method.

require('dotenv').config();
const db = require('../src/database');
const {
  SCOPE_COLUMNS,
  getStoredSlipOkCredentialSets,
  probeQuota
} = require('../src/slipok-connection');

function parseArgs(argv) {
  const args = { username: null, execute: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--execute') args.execute = true;
    else if (value === '--help' || value === '-h') args.help = true;
    else if (value === '--username') args.username = argv[++i] || null;
    else if (value.startsWith('--username=')) args.username = value.slice('--username='.length) || null;
    else return { error: 'INVALID_ARGUMENT' };
  }
  return args;
}

function usage() {
  return [
    'usage: check-slipok-expiry --username <username> [--execute]',
    'default: probe stored scopes without writing the database',
    '--execute: disconnect only authoritative expired/account-issue scopes'
  ].join('\n');
}

function hasStoredValue(streamer, column) {
  return streamer?.[column] !== null && streamer?.[column] !== undefined && streamer[column] !== '';
}

function safeProviderOutcome(outcome) {
  return {
    status: outcome.authoritative
      ? (outcome.expired ? 'expired' : 'account-issue')
      : (outcome.success && outcome.endDateValid && !outcome.expired ? 'renewed' : 'unknown'),
    authoritative: !!outcome.authoritative,
    endDate: outcome.endDateValid ? outcome.endDate : null,
    errorCode: outcome.errorCode || null
  };
}

function notConfiguredResult(scope) {
  return { scope, status: 'not-configured', authoritative: false, endDate: null, errorCode: null };
}

function unknownCredentialResult(scope) {
  return { scope, status: 'unknown', authoritative: false, endDate: null, errorCode: 'UNREADABLE_CREDENTIAL' };
}

/**
 * Probe every SlipOK scope independently. Results contain status metadata only;
 * decrypted credentials remain inside probeQuota and are never returned.
 */
async function checkStoredSlipOkExpiry({ streamer, axiosClient, nowMs = Date.now() } = {}) {
  const storedSets = new Map(getStoredSlipOkCredentialSets(streamer).map(set => [set.scope, set]));
  const pairResults = new Map();
  const results = [];

  for (const [scope, columns] of Object.entries(SCOPE_COLUMNS)) {
    const hasUrl = hasStoredValue(streamer, columns.urlColumn);
    const hasKey = hasStoredValue(streamer, columns.keyColumn);
    if (!hasUrl && !hasKey) {
      results.push(notConfiguredResult(scope));
      continue;
    }

    const storedSet = storedSets.get(scope);
    if (!storedSet) {
      results.push(unknownCredentialResult(scope));
      continue;
    }

    // Identical scope credentials share one provider call, but each scope still
    // receives its own result and any later write remains scope-specific.
    const pairKey = `${storedSet.url}\u0000${storedSet.key}`;
    if (!pairResults.has(pairKey)) {
      pairResults.set(pairKey, await probeQuota(storedSet, axiosClient, { nowMs }));
    }
    results.push({ scope, ...safeProviderOutcome(pairResults.get(pairKey)) });
  }

  return results;
}

async function applyExpiryOnlyDisconnects(streamer, results, {
  database = db,
  checkedAt = new Date().toISOString()
} = {}) {
  const counts = { disconnected: 0, alreadyDisconnected: 0, stale: 0, writeFailures: 0 };

  for (const result of results) {
    if (!result.authoritative) continue;
    const columns = SCOPE_COLUMNS[result.scope];
    if (!columns) continue;

    if (Number(streamer[columns.connected]) !== 1) {
      counts.alreadyDisconnected++;
      continue;
    }

    try {
      const persisted = await database.disconnectSlipOkScopeIfUnchanged(
        streamer,
        result.scope,
        checkedAt,
        result.endDate
      );
      if (persisted?.rowsAffected === 1) counts.disconnected++;
      else if (persisted?.skipped) counts.writeFailures++;
      else counts.stale++;
    } catch (_) {
      counts.writeFailures++;
    }
  }

  return counts;
}

async function initializeDatabaseQuietly(database) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    await database.initDB();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

function printResults(username, results) {
  console.log(`user=${username}`);
  for (const result of results) {
    const code = result.errorCode ? ` code=${result.errorCode}` : '';
    console.log(`scope=${result.scope} status=${result.status}${code}`);
  }
}

async function main({
  argv = process.argv.slice(2),
  database = db,
  axiosClient,
  nowMs = Date.now(),
  checkedAt = new Date().toISOString()
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.error || !args.username || !/^[A-Za-z0-9_]{1,50}$/.test(args.username)) {
    console.error(usage());
    return 1;
  }

  await initializeDatabaseQuietly(database);
  const streamer = await database.getStreamer(args.username);
  if (!streamer) {
    console.error('user-not-found');
    return 1;
  }

  const results = await checkStoredSlipOkExpiry({ streamer, axiosClient, nowMs });
  printResults(streamer.username, results);
  const hasUnknown = results.some(result => result.status === 'unknown');

  if (!args.execute) {
    console.log('mode=probe writes=0');
    return hasUnknown ? 2 : 0;
  }

  const writes = await applyExpiryOnlyDisconnects(streamer, results, { database, checkedAt });
  console.log(`mode=execute disconnected=${writes.disconnected} alreadyDisconnected=${writes.alreadyDisconnected} stale=${writes.stale} writeFailures=${writes.writeFailures}`);
  return hasUnknown || writes.stale || writes.writeFailures ? 2 : 0;
}

if (require.main === module) {
  main()
    .then(code => process.exit(code))
    .catch(err => {
      // Provider/DB clients may embed URLs or headers in exception text.
      console.error(`check-slipok-expiry failed: ${err?.code || err?.name || 'UNKNOWN'}`);
      process.exit(2);
    });
}

module.exports = {
  parseArgs,
  safeProviderOutcome,
  checkStoredSlipOkExpiry,
  applyExpiryOnlyDisconnects,
  initializeDatabaseQuietly,
  main
};
