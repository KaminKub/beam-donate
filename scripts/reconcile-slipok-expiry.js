'use strict';

// Production pre-deploy reconciliation for already-stored SlipOK credentials.
//
//   npm run admin:reconcile-slipok-expiry                 # inventory only; no provider/DB writes
//   npm run admin:reconcile-slipok-expiry -- --probe       # provider probes; no writes
//   npm run admin:reconcile-slipok-expiry -- --execute     # probes, scoped atomic disconnects, verify
//
// This command is intentionally disconnect-only. Explicit user/admin retests own
// reconnects; a bulk expiry scan must never make an account connected again.

require('dotenv').config();
const crypto = require('crypto');
const db = require('../src/database');
const {
  SCOPE_COLUMNS,
  getStoredSlipOkCredentialSets,
  probeQuota
} = require('../src/slipok-connection');

function parseArgs(argv) {
  let mode = null;
  for (const value of argv) {
    let requestedMode = null;
    if (value === '--inventory') requestedMode = 'inventory';
    else if (value === '--probe') requestedMode = 'probe';
    else if (value === '--execute') requestedMode = 'execute';
    else if (value === '--help' || value === '-h') requestedMode = 'help';
    else return { error: 'INVALID_ARGUMENT' };
    if (mode && requestedMode !== mode) return { error: 'CONFLICTING_MODE' };
    mode = requestedMode;
  }
  return { mode: mode || 'inventory' };
}

function usage() {
  return [
    'usage: reconcile-slipok-expiry [--inventory | --probe | --execute]',
    'default/--inventory: list the exact sanitized stored scopes; no provider calls or writes',
    '--probe: classify stored scopes without writing',
    '--execute: probe, atomically disconnect only authoritative expired/account-issue scopes, then verify'
  ].join('\n');
}

// A deterministic opaque suffix makes an inventory auditable without exposing a
// complete username. It is not a credential and is never sent upstream.
function sanitizeUsername(username) {
  const value = String(username || 'unknown');
  const prefix = value.slice(0, 2) || '__';
  const suffix = value.length > 2 ? value.slice(-1) : '_';
  const fingerprint = crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `${prefix}***${suffix}#${fingerprint}`;
}

function pairFingerprint(set) {
  return crypto.createHash('sha256').update(JSON.stringify([set.url, set.key])).digest('hex');
}

function isConnected(streamer, scope) {
  const columns = SCOPE_COLUMNS[scope];
  return !!columns && Number(streamer?.[columns.connected]) === 1;
}

function safeOutcomeLabel(outcome) {
  if (outcome?.authoritative) return outcome.expired ? 'expired' : 'account-issue';
  if (outcome?.success) return 'usable';
  return 'unknown';
}

function storedScopeDescriptors(streamer) {
  const completeSets = new Map(getStoredSlipOkCredentialSets(streamer).map(set => [set.scope, set]));
  const descriptors = [];
  for (const [scope, columns] of Object.entries(SCOPE_COLUMNS)) {
    const hasAnyStoredValue = streamer?.[columns.urlColumn] != null || streamer?.[columns.keyColumn] != null;
    if (!hasAnyStoredValue) continue;
    descriptors.push({ scope, set: completeSets.get(scope) || null });
  }
  return descriptors;
}

function unknownCredentialOutcome() {
  return {
    success: false,
    authoritative: false,
    expired: false,
    reason: null,
    errorCode: 'UNREADABLE_CREDENTIAL'
  };
}

function inventoryActions(rows) {
  const actions = [];
  for (const streamer of rows) {
    for (const descriptor of storedScopeDescriptors(streamer)) {
      actions.push({
        id: Number(streamer.id),
        user: sanitizeUsername(streamer.username),
        scope: descriptor.scope,
        outcome: 'inventory',
        connected: isConnected(streamer, descriptor.scope)
      });
    }
  }
  return actions;
}

// Sequential by design: this is an operator CLI, not a high-throughput task. The
// Map deduplicates identical credential pairs without retaining/logging their values.
async function buildReconciliationPlan(rows, { axiosClient, nowMs = Date.now() } = {}) {
  const outcomesByPair = new Map();
  const actions = [];

  for (const streamer of rows) {
    for (const descriptor of storedScopeDescriptors(streamer)) {
      const set = descriptor.set;
      if (!set) {
        actions.push({
          streamer,
          scope: descriptor.scope,
          fingerprint: null,
          outcome: unknownCredentialOutcome(),
          user: sanitizeUsername(streamer.username),
          wasConnected: isConnected(streamer, descriptor.scope),
          writeOutcome: null
        });
        continue;
      }
      const fingerprint = pairFingerprint(set);
      if (!outcomesByPair.has(fingerprint)) {
        outcomesByPair.set(fingerprint, await probeQuota(set, axiosClient, { nowMs }));
      }
      const outcome = outcomesByPair.get(fingerprint);
      actions.push({
        // Keep the DB row internal only so the CAS helper can compare encrypted
        // credential values. Reporting functions below never serialize it.
        streamer,
        scope: set.scope,
        fingerprint,
        outcome,
        user: sanitizeUsername(streamer.username),
        wasConnected: isConnected(streamer, set.scope),
        writeOutcome: null
      });
    }
  }

  return {
    actions,
    counts: summarizePlan(actions)
  };
}

function summarizePlan(actions) {
  const counts = {
    scopes: actions.length,
    expired: 0,
    accountIssue: 0,
    usable: 0,
    unknown: 0,
    disconnectCandidates: 0,
    alreadyDisconnected: 0
  };
  for (const action of actions) {
    const label = safeOutcomeLabel(action.outcome);
    if (label === 'expired') counts.expired++;
    else if (label === 'account-issue') counts.accountIssue++;
    else if (label === 'usable') counts.usable++;
    else counts.unknown++;
    if (action.outcome.authoritative) {
      if (action.wasConnected) counts.disconnectCandidates++;
      else counts.alreadyDisconnected++;
    }
  }
  return counts;
}

async function applyReconciliationPlan(plan, { disconnectScope, checkedAt = new Date().toISOString() } = {}) {
  if (typeof disconnectScope !== 'function') throw new Error('Missing scoped disconnect writer');
  const counts = { disconnected: 0, alreadyDisconnected: 0, stale: 0, writeFailures: 0 };

  for (const action of plan.actions) {
    if (!action.outcome.authoritative) continue;
    if (!action.wasConnected) {
      action.writeOutcome = 'already-disconnected';
      counts.alreadyDisconnected++;
      continue;
    }
    try {
      const result = await disconnectScope(action.streamer, action.scope, checkedAt, action.outcome.endDate);
      if (result?.rowsAffected === 1) {
        action.writeOutcome = 'disconnected';
        counts.disconnected++;
      } else {
        // A zero-row CAS means the stored credential/status changed while the
        // provider call was in flight. Never overwrite it; make the run partial.
        action.writeOutcome = 'stale';
        counts.stale++;
      }
    } catch (_) {
      action.writeOutcome = 'write-failed';
      counts.writeFailures++;
    }
  }
  return counts;
}

function verifyReconciliationPlan(plan, currentRows) {
  const byId = new Map(currentRows.map(row => [Number(row.id), row]));
  const counts = { verifiedDisconnected: 0, removed: 0, stale: 0 };

  for (const action of plan.actions) {
    if (!action.outcome.authoritative) continue;
    const columns = SCOPE_COLUMNS[action.scope];
    const current = byId.get(Number(action.streamer.id));
    if (!current) {
      action.verifyOutcome = 'removed';
      counts.removed++;
      continue;
    }
    const credentialsUnchanged = current[columns.urlColumn] === action.streamer[columns.urlColumn]
      && current[columns.keyColumn] === action.streamer[columns.keyColumn];
    if (credentialsUnchanged && Number(current[columns.connected]) === 0) {
      action.verifyOutcome = 'verified-disconnected';
      counts.verifiedDisconnected++;
    } else {
      action.verifyOutcome = 'stale';
      counts.stale++;
    }
  }
  return counts;
}

async function loadRelevantStreamers(database) {
  const result = await database.execute({
    sql: `SELECT id, username,
                 slipok_api_encrypted, slipok_api_key_encrypted,
                 slipok_connected, slipok_last_check,
                 truemoney_slipok_api_encrypted, truemoney_slipok_api_key_encrypted,
                 truemoney_slipok_connected, truemoney_slipok_last_check
          FROM streamers
          WHERE slipok_api_encrypted IS NOT NULL
             OR slipok_api_key_encrypted IS NOT NULL
             OR truemoney_slipok_api_encrypted IS NOT NULL
             OR truemoney_slipok_api_key_encrypted IS NOT NULL
          ORDER BY id ASC`
  });
  return result.rows || [];
}

function printAction(action, phase) {
  const outcome = phase === 'inventory'
    ? 'inventory'
    : phase === 'verify'
      ? (action.verifyOutcome || 'not-applicable')
      : (action.writeOutcome || safeOutcomeLabel(action.outcome));
  console.log(`user=${action.user} scope=${action.scope} outcome=${outcome}`);
}

function printCounts(counts) {
  const safe = Object.entries(counts).map(([key, value]) => `${key}=${Number(value) || 0}`).join(' ');
  console.log(`counts ${safe}`);
}

async function initializeDatabaseQuietly(database) {
  // database.initDB() normally prints the configured DB URL. This operator tool
  // promises sanitized output only, so suppress initialization diagnostics and
  // surface just a stable error code through main's outer handler if it fails.
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

async function main({ argv = process.argv.slice(2), database = db, axiosClient } = {}) {
  const args = parseArgs(argv);
  if (args.error || args.mode === 'help') {
    console.error(usage());
    return args.mode === 'help' ? 0 : 1;
  }

  await initializeDatabaseQuietly(database);
  const rows = await loadRelevantStreamers(database.getDB());
  const inventory = inventoryActions(rows);
  if (args.mode === 'inventory') {
    for (const action of inventory) printAction(action, 'inventory');
    printCounts({ configuredScopes: inventory.length, providerCalls: 0, writes: 0 });
    return 0;
  }

  const plan = await buildReconciliationPlan(rows, { axiosClient });
  for (const action of plan.actions) printAction(action, 'probe');
  printCounts(plan.counts);

  // Unknown outcomes include timeout, DNS, 429, 5xx, malformed responses, and
  // invalid/null endDate. They are deliberately left untouched and make the run
  // partial so an operator cannot mistake it for a complete reconciliation.
  const hasUnknown = plan.counts.unknown > 0;
  if (args.mode === 'probe') return hasUnknown ? 2 : 0;

  const writes = await applyReconciliationPlan(plan, {
    disconnectScope: database.disconnectSlipOkScopeIfUnchanged.bind(database)
  });
  for (const action of plan.actions) {
    if (action.outcome.authoritative) printAction(action, 'write');
  }
  printCounts(writes);

  const currentRows = await loadRelevantStreamers(database.getDB());
  const verification = verifyReconciliationPlan(plan, currentRows);
  for (const action of plan.actions) {
    if (action.outcome.authoritative) printAction(action, 'verify');
  }
  printCounts(verification);

  return hasUnknown || writes.stale || writes.writeFailures || verification.stale ? 2 : 0;
}

if (require.main === module) {
  main()
    .then(code => process.exit(code))
    .catch(err => {
      // Never print err.message: provider/DB clients can embed URLs or headers.
      console.error(`reconcile failed: ${err?.code || err?.name || 'UNKNOWN'}`);
      process.exit(2);
    });
}

module.exports = {
  parseArgs,
  sanitizeUsername,
  safeOutcomeLabel,
  inventoryActions,
  storedScopeDescriptors,
  buildReconciliationPlan,
  summarizePlan,
  applyReconciliationPlan,
  verifyReconciliationPlan,
  loadRelevantStreamers,
  initializeDatabaseQuietly,
  main
};
