'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public', 'donate-template', 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'public', 'donate-template', 'index.html'), 'utf8');

function sourceBetween(start, end) {
  const startIndex = appSource.indexOf(start);
  const endIndex = appSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source anchor: ${start}`);
  assert.notEqual(endIndex, -1, `missing source anchor: ${end}`);
  return appSource.slice(startIndex, endIndex);
}

function loadPureFunctions(names) {
  const source = names.map(name => {
    const start = appSource.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `missing function: ${name}`);
    const end = appSource.indexOf('\n}\n', start);
    assert.notEqual(end, -1, `missing function end: ${name}`);
    return appSource.slice(start, end + 2);
  }).join('\n');
  return vm.runInNewContext(`${source}; ({ ${names.join(', ')} });`, {
    Date,
    EXPIRED_QR_GRACE_MS: 10 * 60 * 1000,
    MANUAL_PAYMENT_TTL_MS: 30 * 60 * 1000
  });
}

const { isPendingRestorable, isManualPaymentStepFresh } = loadPureFunctions([
  'isPendingRestorable',
  'isManualPaymentStepFresh'
]);

test('reload restore activates exactly one payment step', () => {
  const helper = sourceBetween('function showOnlyPaymentStep(', 'function restorePendingPaymentStep(');
  assert.match(helper, /querySelectorAll\('\.step\.active'\)/);
  assert.match(helper, /classList\.remove\('active'\)/);

  const promptPayRestore = sourceBetween('function restoreQRStep(', 'function showQRExpired(');
  assert.match(promptPayRestore, /showOnlyPaymentStep\(stepQR\)/);

  const trueMoneyRestore = sourceBetween('function restoreTrueMoneyQrStep(', 'if (btnBackTrueMoneyQr)');
  assert.match(trueMoneyRestore, /showOnlyPaymentStep\(stepTrueMoneyQr\)/);
});

test('expired QR records use the bounded restore grace window', () => {
  const promptPayRead = sourceBetween('function getPendingQR(', 'function clearPendingQR(');
  assert.match(promptPayRead, /includeExpired/);
  assert.doesNotMatch(promptPayRead, /localStorage\.removeItem/);

  const trueMoneyRead = sourceBetween('function getTrueMoneyPendingQR(', 'function clearTrueMoneyPendingQR(');
  assert.match(trueMoneyRead, /includeExpired/);
  assert.doesNotMatch(trueMoneyRead, /localStorage\.removeItem/);

  const startupRestore = sourceBetween('function restorePendingPaymentStep(', '// Report modal');
  assert.match(startupRestore, /getPendingQR\(true\)/);
  assert.match(startupRestore, /getTrueMoneyPendingQR\(true\)/);
  assert.match(startupRestore, /isPendingRestorable/);
  assert.match(appSource, /const EXPIRED_QR_GRACE_MS = 10 \* 60 \* 1000/);

  const promptPayCountdown = sourceBetween('function updateCountdown(', 'function startPromptPayPolling(');
  assert.doesNotMatch(promptPayCountdown, /clearPendingQR\(\)/);
});

test('isPendingRestorable accepts active and recent QR records only', () => {
  const now = Date.parse('2026-08-12T12:00:00Z');
  assert.equal(isPendingRestorable({ expiresAt: '2026-08-12T12:05:00Z' }, now), true);
  assert.equal(isPendingRestorable({ expiresAt: '2026-08-12T11:51:00Z' }, now), true);
  assert.equal(isPendingRestorable({ expiresAt: '2026-08-12T11:49:59Z' }, now), false);
  assert.equal(isPendingRestorable({ expiresAt: '2026-08-12T11:59:00Z', backedOutAt: now - 1000 }, now), false);
});

test('isManualPaymentStepFresh enforces the 30-minute TTL', () => {
  const now = Date.parse('2026-08-12T12:00:00Z');
  assert.equal(isManualPaymentStepFresh({ savedAt: now - (29 * 60 * 1000) }, now), true);
  assert.equal(isManualPaymentStepFresh({ savedAt: now - (30 * 60 * 1000) }, now), false);
  assert.equal(isManualPaymentStepFresh({ savedAt: now - (31 * 60 * 1000) }, now), false);
  assert.equal(isManualPaymentStepFresh({}, now), false);
});

test('manual slip-upload steps persist and restore', () => {
  assert.match(appSource, /function saveManualPaymentStep\(/);
  assert.match(appSource, /function restoreManualPaymentStep\(/);
  assert.match(appSource, /saveManualPaymentStep\('truemoney'/);
  assert.match(appSource, /saveManualPaymentStep\('bank'/);
  assert.match(appSource, /savedAt: Date\.now\(\)/);
  assert.match(appSource, /tierImageUrl: selectedTierImageUrl/);
  assert.match(appSource, /tierYoutubeId: pending\.tierYoutubeId/);
  assert.match(appSource, /hasRestoredTimerAction/);
});

test('restore hydrates the payment-method step for all pending branches', () => {
  const restore = sourceBetween('async function restorePendingPaymentStep(', '// Report modal');
  assert.equal((restore.match(/hydratePaymentMethodsForRestore\(\)/g) || []).length, 3);
  assert.match(appSource, /function hydratePaymentMethodStep\(methods\)/);
  assert.match(appSource, /btnProceedPayment\.disabled = false/);
});

test('SlipOK warning defaults to visible until methods are confirmed connected', () => {
  const warning = sourceBetween('function updateSlipOkWarning(', '// Widget Status Check');
  assert.doesNotMatch(warning, /!methodsLoaded \|\|/);
  assert.match(warning, /methodsLoaded && streamerPaymentMethods\.slipok_connected/);
});

test('backed-out QR records are flagged and skipped by startup restore', () => {
  assert.match(appSource, /function markPendingBackedOut\(/);
  assert.match(appSource, /markPendingBackedOut\(getPendingKey\(\)\)/);
  assert.match(appSource, /markPendingBackedOut\(getTrueMoneyPendingKey\(\)\)/);
  assert.match(appSource, /if \(!pending \|\| pending\.backedOutAt\) return false/);
});

test('TrueMoney QR has a real slip fallback control', () => {
  assert.match(htmlSource, /id="btnTrueMoneyQrSlipFallback"/);
});

test('pending state has a history fallback when localStorage is unavailable', () => {
  assert.match(appSource, /function writePendingState\(/);
  assert.match(appSource, /history\.replaceState/);
  assert.match(appSource, /function readPendingState\(/);
});

test('startup restores payment state before waiting for page content', () => {
  const startup = sourceBetween("document.addEventListener('DOMContentLoaded'", 'function showOnlyPaymentStep(');
  assert.match(startup, /restorePendingPaymentStep\(\);[\s\S]*await loadPageContent\(\);/);
});

test('saving one payment path clears stale state from the others', () => {
  const promptPaySave = sourceBetween('function savePendingQR(', 'function getPendingQR(');
  assert.match(promptPaySave, /clearManualPaymentStep\(\)/);
  assert.match(promptPaySave, /clearTrueMoneyPendingQR\(\)/);

  const trueMoneySave = sourceBetween('function saveTrueMoneyPendingQR(', 'function getTrueMoneyPendingQR(');
  assert.match(trueMoneySave, /clearManualPaymentStep\(\)/);
  assert.match(trueMoneySave, /clearPendingQR\(\)/);
});
