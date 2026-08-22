// Shared SlipOK connection logic.
//
// Used by the streamer-facing routes in src/server.js and support/pre-deploy CLIs.
// Stored credentials are decrypted inside this module only. Values that cross back to
// callers are non-secret status data; callers must never put stored credential sets in
// a response, log entry, or audit event.

const axios = require('axios');
const { decrypt } = require('./encryption');

const SLIPOK_TIMEOUT_MS = 10000;
const SLIPOK_BANGKOK_TIME_ZONE = 'Asia/Bangkok';
const SLIPOK_ACCOUNT_ISSUE_CODES = new Set([1002, 1003, 1004, 1015]);

// Which DB columns each scope owns. A scope that is not explicitly selected must not
// be touched by an authoritative provider outcome.
const SCOPE_COLUMNS = {
  promptpay: {
    connected: 'slipok_connected',
    lastCheck: 'slipok_last_check',
    expiry: 'slipok_expiry',
    quotaTotal: 'slipok_quota_total',
    urlColumn: 'slipok_api_encrypted',
    keyColumn: 'slipok_api_key_encrypted',
    urlField: 'slipok_api',
    keyField: 'slipok_api_key'
  },
  truemoney: {
    connected: 'truemoney_slipok_connected',
    lastCheck: 'truemoney_slipok_last_check',
    expiry: 'truemoney_slipok_expiry',
    quotaTotal: 'truemoney_slipok_quota_total',
    urlColumn: 'truemoney_slipok_api_encrypted',
    keyColumn: 'truemoney_slipok_api_key_encrypted',
    urlField: 'truemoney_slipok_api',
    keyField: 'truemoney_slipok_api_key'
  }
};

// SEC-003: Allowlist-based SSRF protection for SlipOK API URLs.
function validateSlipOkUrl(url) {
  if (!url) throw new Error('SlipOK API URL is required');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('SlipOK API URL is not a valid URL'); }
  if (parsed.protocol !== 'https:') throw new Error('SlipOK API URL must use HTTPS');
  const allowed = ['api.slipok.com'];
  if (!allowed.includes(parsed.hostname)) {
    throw new Error(`SlipOK API hostname not allowed: ${parsed.hostname}`);
  }
}

// SlipOK exposes remaining quota but not the purchased package size, so the smallest
// package that could still hold the remainder is used as the snapshot total.
function inferSlipOkBasePlan(quota) {
  const plans = [100, 500, 1000, 2000, 5000, 10000];
  for (const plan of plans) {
    if (quota <= plan) return plan;
  }
  return Math.max(100, quota);
}

function getBangkokDateKey(nowMs = Date.now()) {
  const numericNow = nowMs instanceof Date ? nowMs.getTime() : Number(nowMs);
  if (!Number.isFinite(numericNow)) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SLIPOK_BANGKOK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(numericNow));
  const values = Object.fromEntries(parts
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
  if (!/^\d{4}$/.test(values.year || '') || !/^\d{2}$/.test(values.month || '') || !/^\d{2}$/.test(values.day || '')) {
    return null;
  }
  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * SlipOK quota endDate is documented as a date-only yyyy-MM-dd value. It remains
 * usable through that whole calendar day in Asia/Bangkok, and becomes expired only
 * once Bangkok has advanced to the following date. Timestamps and invalid dates are
 * deliberately unknown rather than interpreted as expiry evidence.
 */
function classifySlipOkEndDate(endDate, nowMs = Date.now()) {
  if (typeof endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return { valid: false, endDate: null, expired: false };
  }

  const [year, month, day] = endDate.split('-').map(Number);
  const calendarCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month - 1 ||
    calendarCheck.getUTCDate() !== day
  ) {
    return { valid: false, endDate: null, expired: false };
  }

  const bangkokToday = getBangkokDateKey(nowMs);
  if (!bangkokToday) return { valid: false, endDate: null, expired: false };
  return { valid: true, endDate, expired: bangkokToday > endDate };
}

function hasCredentialPair(source, scope) {
  const columns = SCOPE_COLUMNS[scope];
  return !!(columns && source && source[columns.urlField] && source[columns.keyField]);
}

// Keep the primary-first policy usable by server paths that intentionally receive
// only safe configuration booleans, never a credential value.
function resolveSlipOkLaneFromState({
  promptpayConfigured = false,
  truemoneyConfigured = false,
  promptpayConnected = false,
  truemoneyConnected = false
} = {}) {
  const effectiveScope = promptpayConfigured ? 'promptpay' : (truemoneyConfigured ? 'truemoney' : null);
  const ready = effectiveScope === 'promptpay'
    ? promptpayConnected
    : effectiveScope === 'truemoney'
      ? truemoneyConnected
      : false;

  return {
    configured: !!effectiveScope,
    effectiveScope,
    ready: !!ready,
    promptpayConfigured: !!promptpayConfigured,
    truemoneyConfigured: !!truemoneyConfigured,
    promptpayConnected: !!promptpayConnected,
    truemoneyConnected: !!truemoneyConnected
  };
}

/**
 * Returns only non-secret effective-lane metadata. This is the shared policy for
 * /api/verify-slip, Dashboard status, settings, and the public donor gate:
 * primary PromptPay/Bank credentials win whenever their pair is complete; the
 * TrueMoney pair is a fallback only when no complete primary pair exists.
 */
function resolveSlipOkLane(source) {
  return resolveSlipOkLaneFromState({
    promptpayConfigured: hasCredentialPair(source, 'promptpay'),
    truemoneyConfigured: hasCredentialPair(source, 'truemoney'),
    promptpayConnected: !!source?.slipok_connected,
    truemoneyConnected: !!source?.truemoney_slipok_connected
  });
}

// This returns plaintext only for server-process callers that immediately make the
// upstream request. Never put the return value into a response or log.
function getEffectiveSlipOkCredentialSet(source) {
  const { effectiveScope } = resolveSlipOkLane(source);
  if (!effectiveScope) return null;
  const columns = SCOPE_COLUMNS[effectiveScope];
  return {
    scope: effectiveScope,
    url: source[columns.urlField],
    key: source[columns.keyField]
  };
}

function buildSlipOkDisconnectPatch(scope, now) {
  const columns = SCOPE_COLUMNS[scope];
  if (!columns) return null;
  return {
    [columns.connected]: 0,
    [columns.lastCheck]: now
  };
}

function decryptStored(value) {
  if (!value || !value.includes(':')) return '';
  try { return decrypt(value) || ''; } catch { return ''; }
}

// Returns complete stored credential pairs only. Caller-visible only inside the server
// process; do not serialize or log this return value.
function getStoredSlipOkCredentialSets(streamer) {
  if (!streamer) return [];
  return Object.entries(SCOPE_COLUMNS)
    .map(([scope, columns]) => ({
      scope,
      url: decryptStored(streamer[columns.urlColumn]),
      key: decryptStored(streamer[columns.keyColumn])
    }))
    .filter(set => set.url && set.key);
}

// Upstream failure becomes a safe code, never a provider message/body.
function sanitizedErrorCode(err) {
  const slipCode = err?.response?.data?.code;
  if (slipCode !== undefined && slipCode !== null && /^\d{1,8}$/.test(String(slipCode))) return String(slipCode);
  if (Number.isInteger(err?.response?.status)) return `HTTP_${err.response.status}`;
  const transportCode = typeof err?.code === 'string' ? err.code : '';
  return /^[A-Z0-9_-]{1,64}$/.test(transportCode) ? transportCode : 'UNKNOWN';
}

function classifySlipOkErrorCode(errorCode) {
  const numericCode = /^\d+$/.test(String(errorCode || '')) ? Number(errorCode) : null;
  if (numericCode === 1003) {
    return { authoritative: true, expired: true, reason: 'expired' };
  }
  if (numericCode !== null && SLIPOK_ACCOUNT_ISSUE_CODES.has(numericCode)) {
    return { authoritative: true, expired: false, reason: 'account-issue' };
  }
  return { authoritative: false, expired: false, reason: null };
}

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function unknownQuotaOutcome(data, errorCode = 'MALFORMED_RESPONSE') {
  return {
    success: false,
    quota: finiteNumber(data?.quota, 0),
    overQuota: finiteNumber(data?.overQuota, 0),
    specialQuota: finiteNumber(data?.specialQuota, 0),
    endDate: null,
    endDateValid: false,
    expired: false,
    authoritative: false,
    reason: null,
    errorCode
  };
}

// Classifies the full quota response without exposing the raw upstream body. A 200
// alone is not evidence that the account is usable: the provider must explicitly
// report success and a strict, currently-usable date-only endDate. This prevents a
// malformed/partial response from either reconnecting or disconnecting an account.
function classifySlipOkQuotaResponse(payload, nowMs = Date.now()) {
  if (!payload || typeof payload !== 'object') return unknownQuotaOutcome();

  if (payload.success !== true) {
    const errorCode = payload.code !== undefined && /^\d{1,8}$/.test(String(payload.code))
      ? String(payload.code)
      : 'MALFORMED_RESPONSE';
    const classification = classifySlipOkErrorCode(errorCode);
    return {
      ...unknownQuotaOutcome(null, errorCode),
      expired: classification.expired,
      authoritative: classification.authoritative,
      reason: classification.reason
    };
  }

  const data = payload.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return unknownQuotaOutcome();

  const expiry = classifySlipOkEndDate(data.endDate, nowMs);
  if (!expiry.valid) return unknownQuotaOutcome(data, 'INVALID_END_DATE');

  return {
    success: !expiry.expired,
    quota: finiteNumber(data.quota, 0),
    overQuota: finiteNumber(data.overQuota, 0),
    specialQuota: finiteNumber(data.specialQuota, 0),
    endDate: expiry.endDate,
    endDateValid: true,
    expired: expiry.expired,
    authoritative: expiry.expired,
    reason: expiry.expired ? 'expired' : null,
    errorCode: null
  };
}

async function probeQuota({ url, key }, axiosClient = axios, { nowMs = Date.now() } = {}) {
  try { validateSlipOkUrl(url); } catch { return { success: false, quota: null, endDate: null, endDateValid: false, expired: false, authoritative: false, reason: null, errorCode: 'INVALID_URL' }; }
  const branchUrl = url.replace(/\/quota$/, '');
  try {
    const response = await axiosClient.get(`${branchUrl}/quota`, {
      headers: { 'x-authorization': key },
      timeout: SLIPOK_TIMEOUT_MS
    });
    return classifySlipOkQuotaResponse(response.data, nowMs);
  } catch (err) {
    const errorCode = sanitizedErrorCode(err);
    const classification = classifySlipOkErrorCode(errorCode);
    return {
      success: false,
      quota: null,
      endDate: null,
      endDateValid: false,
      expired: classification.expired,
      authoritative: classification.authoritative,
      reason: classification.reason,
      errorCode
    };
  }
}

// Only scoped connection/last-check/quota-snapshot columns are included. Authoritative
// failures disconnect their own scope; transport/unknown outcomes leave DB state intact.
function buildPatch(results, streamer, now) {
  const patch = {};
  for (const result of results) {
    const columns = SCOPE_COLUMNS[result.scope];
    if (!columns) continue;

    if (result.authoritative) {
      Object.assign(patch, buildSlipOkDisconnectPatch(result.scope, now));
      if (result.endDateValid && result.endDate) patch[columns.expiry] = result.endDate;
      continue;
    }
    // An explicit retest can reconnect only on a complete, valid, currently-usable
    // quota response. Unknown/malformed endDate values deliberately leave state
    // untouched, even when the HTTP request itself returned 200.
    if (!result.success || !result.endDateValid || result.expired) continue;

    // This helper serves the explicit support retest flow. It may reconnect only after
    // an explicit successful retest; ordinary Dashboard quota refreshes never use it.
    patch[columns.connected] = 1;
    patch[columns.lastCheck] = now;
    patch[columns.expiry] = result.endDate;
    const existingTotal = streamer[columns.quotaTotal] || 0;
    const candidate = inferSlipOkBasePlan(result.quota || 0);
    patch[columns.quotaTotal] = (!existingTotal || candidate > existingTotal) ? candidate : existingTotal;
  }
  return patch;
}

/**
 * Retest every stored SlipOK credential pair for a streamer. Does not write the DB.
 * Each outcome is safe to display in a controlled CLI (scope/status/code only).
 */
async function retestStoredSlipOk({ streamer, axiosClient = axios, now = new Date().toISOString(), nowMs = Date.now() }) {
  const sets = getStoredSlipOkCredentialSets(streamer);
  if (!sets.length) {
    return { ok: false, errorCode: 'USER_ACTION_REQUIRED', results: [], patch: null };
  }

  // PromptPay and TrueMoney often use the same branch/key. Probe a pair once without
  // retaining a plaintext delimiter or ever serializing its cache key.
  const seen = new Map();
  const results = [];
  for (const set of sets) {
    const pairKey = JSON.stringify([set.url, set.key]);
    if (!seen.has(pairKey)) seen.set(pairKey, await probeQuota(set, axiosClient, { nowMs }));
    results.push({ scope: set.scope, ...seen.get(pairKey) });
  }

  return {
    ok: results.every(result => result.success && result.endDateValid && !result.expired),
    errorCode: null,
    results,
    patch: buildPatch(results, streamer, now)
  };
}

module.exports = {
  SLIPOK_TIMEOUT_MS,
  SLIPOK_ACCOUNT_ISSUE_CODES,
  SCOPE_COLUMNS,
  validateSlipOkUrl,
  inferSlipOkBasePlan,
  classifySlipOkEndDate,
  resolveSlipOkLaneFromState,
  resolveSlipOkLane,
  getEffectiveSlipOkCredentialSet,
  buildSlipOkDisconnectPatch,
  getStoredSlipOkCredentialSets,
  sanitizedErrorCode,
  classifySlipOkErrorCode,
  classifySlipOkQuotaResponse,
  probeQuota,
  retestStoredSlipOk
};
