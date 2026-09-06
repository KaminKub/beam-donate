'use strict';

// §9 notice window: the server accepts the announced version early so nobody is prompted twice.
// Before this test the UI still sent the enforced (old) version, so that promise never held.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const { announcedLegalVersion, acceptableLegalVersions, hasAcceptedLegal } = require('../src/legal-helpers');
const dashboardSource = fs.readFileSync(path.join(root, 'public', 'dashboard', 'dashboard.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');

const announced = {
  current: '2026-08-19',
  upcoming: '2026-09-13',
  effectiveAt: '2026-09-13T23:59:59+07:00'
};
const quiet = { current: '2026-08-19', upcoming: null, effectiveAt: null };
const duringWindow = Date.parse('2026-09-06T12:00:00+07:00');
const afterEffective = Date.parse('2026-09-14T00:00:00+07:00');

test('announcedLegalVersion exposes the pending version only while it is pending', () => {
  assert.equal(announcedLegalVersion(duringWindow, announced), '2026-09-13');
  assert.equal(announcedLegalVersion(afterEffective, announced), null);
  assert.equal(announcedLegalVersion(duringWindow, quiet), null);
});

test('the version the modal offers is accepted by the server and survives the flip', () => {
  const offered = announcedLegalVersion(duringWindow, announced);
  assert.ok(acceptableLegalVersions(duringWindow, announced).includes(offered));
  assert.equal(hasAcceptedLegal(offered, duringWindow, announced), true);
  // the whole point: still valid once the date passes, so no second prompt
  assert.equal(hasAcceptedLegal(offered, afterEffective, announced), true);
  assert.equal(hasAcceptedLegal('2026-08-19', afterEffective, announced), false);
});

test('dashboard prefers the announced version over the enforced one', () => {
  const start = dashboardSource.indexOf('function legalVersionToAccept(');
  assert.ok(start >= 0, 'legalVersionToAccept() must exist in dashboard.js');
  const end = dashboardSource.indexOf('function syncLegalAcceptanceVersionDate(', start);
  const context = vm.createContext({});
  vm.runInContext(dashboardSource.slice(start, end) + '\nthis.fn = legalVersionToAccept;', context);

  assert.equal(context.fn({ currentVersion: '2026-08-19', upcomingVersion: '2026-09-13' }), '2026-09-13');
  assert.equal(context.fn({ currentVersion: '2026-08-19', upcomingVersion: null }), '2026-08-19');
  assert.equal(context.fn({ currentVersion: '2026-08-19' }), '2026-08-19');
  assert.equal(context.fn(null), null);
});

test('the accept button sends that version instead of reading currentVersion directly', () => {
  const start = dashboardSource.indexOf("button.addEventListener('click'");
  const end = dashboardSource.indexOf('async function initializeLegalAcceptance', start);
  assert.ok(start >= 0 && end > start, 'acceptance click handler not found');
  const handler = dashboardSource.slice(start, end);

  assert.match(handler, /legalVersionToAccept\(legalAcceptanceModalState\.status\)/);
  assert.doesNotMatch(handler, /status\?\.currentVersion/);
  assert.match(handler, /'\/api\/user\/accept-legal'/);
});

test('both server payloads that open the modal carry upcomingVersion', () => {
  for (const marker of ['legalAcceptance: {', "code: 'LEGAL_ACCEPTANCE_REQUIRED',"]) {
    const at = serverSource.indexOf(marker);
    assert.ok(at >= 0, `${marker} not found in server.js`);
    const block = serverSource.slice(at, serverSource.indexOf('}', serverSource.indexOf('currentVersion', at)));
    assert.match(block, /upcomingVersion: announcedLegalVersion\(\)/);
  }
});
