'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public', 'donate-template', 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'public', 'donate-template', 'index.html'), 'utf8');

test('TrueMoney QR method toggle requests only a changed method', () => {
  const toggle = appSource.slice(
    appSource.indexOf('// TrueMoney webhook QR method toggle'),
    appSource.indexOf('function getTrueMoneyPendingKey(')
  );

  assert.match(toggle, /const nextMethod = btn\.dataset\.method \|\| 'P2P';[\s\S]*if \(nextMethod === trueMoneyQrMethod\) return;/);
  assert.match(toggle, /trueMoneyQrMethod = nextMethod;\s*void createTrueMoneyQR\(\);/);
});

test('TrueMoney badges separate P2P from PromptPay availability', () => {
  const hydrate = appSource.slice(
    appSource.indexOf('const trueMoneyP2PBadge ='),
    appSource.indexOf('if (usable.promptpay)')
  );

  assert.match(hydrate, /const methodList = \(methods\.truemoney_webhook_methods \|\| 'P2P'\)\.split\(','\)\.filter\(Boolean\);/);
  assert.match(hydrate, /const hasP2P = methodList\.includes\('P2P'\);/);
  assert.match(hydrate, /const hasPromptPayIn = methodList\.includes\('PROMPTPAY_IN'\);/);
  assert.match(hydrate, /trueMoneyP2PBadge\.style\.display = hasP2P \? '' : 'none';/);
  assert.match(hydrate, /trueMoneyP2PBadge\.textContent = 'P2P';/);
  assert.match(hydrate, /trueMoneyPromptPayBadge\.style\.display = hasPromptPayIn \? '' : 'none';/);
  assert.doesNotMatch(hydrate, /trueMoneyP2PBadge\.textContent[^\n]*พร้อมเพย์/);
});

test('TrueMoney card keeps the optional PromptPay label inline with the title and removes Wallet from it', () => {
  const card = htmlSource.slice(
    htmlSource.indexOf('id="optionTrueMoney"'),
    htmlSource.indexOf('id="optionBank"')
  );

  assert.match(card, /<h3>TrueMoney <span class="truemoney-promptpay-badge" id="trueMoneyPromptPayBadge" style="display: none;">\+ พร้อมเพย์<\/span><\/h3>/);
  assert.doesNotMatch(card, /<h3>TrueMoney Wallet<\/h3>/);
});

test('TrueMoney QR method buttons identify their brands with decorative icons', () => {
  const toggle = htmlSource.slice(
    htmlSource.indexOf('id="trueMoneyQrMethodToggle"'),
    htmlSource.indexOf('<div id="trueMoneyQrDisplayBox"')
  );

  assert.match(toggle, /data-method="P2P"[\s\S]*class="qr-method-icon" src="\/assets\/payment\/TrueWallate\.png" alt="" width="48" height="48"/);
  assert.match(toggle, /data-method="PROMPTPAY_IN"[\s\S]*class="qr-method-icon" src="\/assets\/payment\/icon-thaiqr\.png" alt="" width="48" height="48"/);
  assert.doesNotMatch(toggle, /<small[\s\S]*ผ่าน TrueMoney Wallet[\s\S]*<\/small>/);
  assert.match(toggle, /class="qr-method-icon"/);
});

test('donate template cache-busts the updated app.js', () => {
  assert.match(htmlSource, /\/donate-template\/app\.js\?v=20260906_1/);
});

test('TrueMoney QR requests capture the method and ignore stale responses', () => {
  const create = appSource.slice(
    appSource.indexOf('async function createTrueMoneyQR()'),
    appSource.indexOf('function showTrueMoneyQrStep(')
  );

  assert.match(create, /const requestId = \+\+trueMoneyQrRequestSeq;\s*const requestedMethod = trueMoneyQrMethod;/);
  assert.match(create, /method: requestedMethod,/);
  assert.match(create, /if \(!isCurrentTrueMoneyQrRequest\(requestId, requestedMethod\)\) return;/);
  assert.match(create, /if \(!isCurrentTrueMoneyQrRequest\(requestId, requestedMethod\)\) return;[\s\S]*saveTrueMoneyPendingQR\(data\);/);
  assert.match(create, /catch \(error\) \{\s*if \(!isCurrentTrueMoneyQrRequest\(requestId, requestedMethod\)\) return;/);
  assert.match(create, /const currentTimerAction = getTimerActionForSubmit\(\) \?\? null;/);
  assert.match(create, /\(pending\.timerAction \?\? null\) === currentTimerAction/);
});

test('TrueMoney method switching deduplicates same-method in-flight QR requests', () => {
  const toggle = appSource.slice(
    appSource.indexOf('// TrueMoney webhook QR method toggle'),
    appSource.indexOf('function normalizeTrueMoneyQrMethod(')
  );
  const create = appSource.slice(
    appSource.indexOf('async function createTrueMoneyQR()'),
    appSource.indexOf('function showTrueMoneyQrStep(')
  );

  assert.match(toggle, /const nextMethod = btn\.dataset\.method \|\| 'P2P';/);
  assert.match(toggle, /if \(nextMethod === trueMoneyQrMethod\) return;/);
  assert.match(appSource, /const trueMoneyQrInFlight = new Map\(\);/);
  assert.match(create, /const requestKey = getTrueMoneyQrRequestKey\(requestedMethod\);/);
  assert.match(create, /const inFlight = trueMoneyQrInFlight\.get\(requestKey\);/);
  assert.match(create, /let requestPromise = inFlight;/);
  assert.match(create, /await requestPromise/);
  assert.match(create, /trueMoneyQrInFlight\.set\(requestKey, requestPromise\);/);
  assert.match(create, /trueMoneyQrInFlight\.delete\(requestKey\);/);
});

test('TrueMoney method toggle keeps a distinct cached QR for each method and restores the active method after refresh', () => {
  const cache = appSource.slice(
    appSource.indexOf('function getTrueMoneyPendingKey('),
    appSource.indexOf('function generateTrueMoneyQRImage(')
  );
  const create = appSource.slice(
    appSource.indexOf('async function createTrueMoneyQR()'),
    appSource.indexOf('function showTrueMoneyQrStep(')
  );
  const restore = appSource.slice(
    appSource.indexOf('async function restorePendingPaymentStep('),
    appSource.indexOf('// Report modal')
  );

  assert.match(cache, /function getTrueMoneyPendingKey\(method = trueMoneyQrMethod\)/);
  assert.match(cache, /writePendingState\(getTrueMoneyPendingKey\(method\), pending\);/);
  assert.match(cache, /function getTrueMoneyQrActiveMethod\(\)/);
  assert.match(cache, /function getTrueMoneyPendingRestoreCandidate\(\)/);
  assert.doesNotMatch(cache.slice(cache.indexOf('function saveTrueMoneyPendingQR('), cache.indexOf('function getTrueMoneyPendingQR(')), /clearTrueMoneyPendingQR\(\)/);
  assert.match(create, /getTrueMoneyPendingQR\(false, requestedMethod\)/);
  assert.match(create, /clearTrueMoneyPendingQR\(requestedMethod\);/);
  assert.match(restore, /getTrueMoneyPendingRestoreCandidate\(\)/);
});

test('TrueMoney toggle buttons use the donate pulse interaction and balanced larger icons', () => {
  assert.match(appSource, /#trueMoneyQrMethodToggle \.qr-method-btn/);
  // tile design ตาม .payment-method-icon (48px + radius + object-fit:cover) — commit ed70970
  assert.match(htmlSource, /\.qr-method-icon[\s\S]*width: 48px;[\s\S]*height: 48px;[\s\S]*object-fit: cover;/);
  assert.match(appSource, /\.amount-btn, \.tier-image-choice, \.tier-subtab-btn, \.tier-eq-btn, #tierRecordBtn, #trueMoneyQrMethodToggle \.qr-method-btn/);
});
