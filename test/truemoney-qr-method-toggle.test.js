'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public', 'donate-template', 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'public', 'donate-template', 'index.html'), 'utf8');

test('TrueMoney QR method toggle regenerates the selected method QR', () => {
  const toggle = appSource.slice(
    appSource.indexOf('// TrueMoney webhook QR method toggle'),
    appSource.indexOf('function getTrueMoneyPendingKey(')
  );

  assert.match(toggle, /trueMoneyQrMethod = btn\.dataset\.method \|\| 'P2P';\s*createTrueMoneyQR\(\);/);
});

test('TrueMoney P2P badge stays visible for P2P and explains PromptPay availability when both methods are enabled', () => {
  const hydrate = appSource.slice(
    appSource.indexOf('const trueMoneyP2PBadge ='),
    appSource.indexOf('if (usable.promptpay)')
  );

  assert.match(hydrate, /const methodList = \(methods\.truemoney_webhook_methods \|\| 'P2P'\)\.split\(','\)\.filter\(Boolean\);/);
  assert.match(hydrate, /const hasP2P = methodList\.includes\('P2P'\);/);
  assert.match(hydrate, /const hasPromptPayIn = methodList\.includes\('PROMPTPAY_IN'\);/);
  assert.match(hydrate, /trueMoneyP2PBadge\.style\.display = hasP2P \? '' : 'none';/);
  assert.match(hydrate, /trueMoneyP2PBadge\.textContent = hasPromptPayIn \? 'P2P \+ พร้อมเพย์' : 'P2P';/);
});

test('TrueMoney QR method buttons identify their brands with decorative icons', () => {
  const toggle = htmlSource.slice(
    htmlSource.indexOf('id="trueMoneyQrMethodToggle"'),
    htmlSource.indexOf('<div id="trueMoneyQrDisplayBox"')
  );

  assert.match(toggle, /data-method="P2P"[\s\S]*class="qr-method-icon" src="\/assets\/payment\/TrueWallate\.png" alt="" width="28" height="28"/);
  assert.match(toggle, /data-method="PROMPTPAY_IN"[\s\S]*class="qr-method-icon" src="\/assets\/payment\/icon-thaiqr\.png" alt="" width="28" height="28"/);
  assert.doesNotMatch(toggle, /<small[\s\S]*ผ่าน TrueMoney Wallet[\s\S]*<\/small>/);
  assert.match(toggle, /class="qr-method-icon"/);
});

test('donate template cache-busts the updated app.js', () => {
  assert.match(htmlSource, /\/donate-template\/app\.js\?v=20260823_4/);
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
  assert.match(htmlSource, /\.qr-method-icon[\s\S]*width: 28px;[\s\S]*height: 28px;/);
  assert.match(appSource, /\.amount-btn, \.tier-image-choice, \.tier-subtab-btn, \.tier-eq-btn, #tierRecordBtn, #trueMoneyQrMethodToggle \.qr-method-btn/);
});
