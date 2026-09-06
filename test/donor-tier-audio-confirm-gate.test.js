'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public', 'donate-template', 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'public', 'donate-template', 'index.html'), 'utf8');

test('shared own-audio status is outside upload-only pane and record change button sits by record status', () => {
  const subtabsAt = htmlSource.indexOf('id="tierOwnAudioSubtabs"');
  const statusAt = htmlSource.indexOf('id="tierOwnAudioStatusRow"');
  const uploadPaneAt = htmlSource.indexOf('id="tierUploadPane"');
  const recordStatusAt = htmlSource.indexOf('id="tierRecordStatus"');
  assert.ok(subtabsAt < statusAt && statusAt < uploadPaneAt, 'status row must be shared before upload/record panes');
  assert.match(htmlSource.slice(recordStatusAt, recordStatusAt + 260), /id="btnChangeTierRecordSound"/);
});

test('record confirmation gate blocks btnDonate before payment-method fetch', () => {
  assert.match(appSource, /let tierRecordUploadInFlight = false;/);
  assert.match(appSource, /function isTierRecordAwaitingConfirmation\(\)/);
  const handler = appSource.slice(
    appSource.indexOf("btnDonate.addEventListener('click'"),
    appSource.indexOf("document.querySelectorAll('.payment-method-option')")
  );
  const gateAt = handler.indexOf('isTierRecordAwaitingConfirmation()');
  const fetchAt = handler.indexOf('fetch(`/api/page/${username}/payment-methods`)');
  assert.ok(gateAt >= 0 && gateAt < fetchAt, 'record gate must run before payment-method request');
  assert.match(handler, /showTierRecordConfirmationGate\(\)/);
});

test('YouTube selection renders a change action and uses the common reset path', () => {
  const youtubeHandler = appSource.slice(
    appSource.indexOf("document.getElementById('ytUseClipBtn')?.addEventListener"),
    appSource.indexOf("document.getElementById('btnPickTierYoutube')?.addEventListener")
  );
  assert.match(youtubeHandler, /renderTierOwnAudioStatus\('youtube'\)/);
  assert.match(appSource, /btnChangeTierRecordSound.*addEventListener/);
  assert.match(appSource, /btnChangeTierOwnAudioSound.*resetTierOwnAudioSelection/);
  assert.match(appSource, /btnChangeTierYoutubeSound/);
});

test('record confirm keeps the upload gate active until async upload completes', () => {
  const confirmHandler = appSource.slice(
    appSource.indexOf("document.getElementById('tierRecordConfirmBtn')?.addEventListener"),
    appSource.indexOf('// Own-audio: mic recording flow')
  );
  assert.match(confirmHandler, /uploadTierRecordedAudio\(tierRecordPendingBlob\)/);
  assert.doesNotMatch(confirmHandler, /hideTierRecordReview\(\)/, 'confirm handler must not clear the pending review before upload resolves');
  const uploadFn = appSource.slice(appSource.indexOf('async function uploadTierRecordedAudio('));
  assert.match(uploadFn, /tierRecordUploadInFlight = true/);
  assert.match(uploadFn, /tierRecordUploadInFlight = false/);
});

test('isTierRecordAwaitingConfirmation truth table — pure predicate, no string match', () => {
  const src = appSource.slice(
    appSource.indexOf('function computeTierRecordAwaitingConfirmation'),
    appSource.indexOf('function isTierRecordAwaitingConfirmation')
  );
  // eslint-disable-next-line no-new-func
  const computeTierRecordAwaitingConfirmation = new Function(`return (${src.trim()});`)();

  const cases = [
    [{ pendingBlob: null, reviewVisible: false, uploadInFlight: false }, false],
    [{ pendingBlob: {}, reviewVisible: false, uploadInFlight: false }, true],
    [{ pendingBlob: null, reviewVisible: true, uploadInFlight: false }, true],
    [{ pendingBlob: null, reviewVisible: false, uploadInFlight: true }, true],
    [{ pendingBlob: {}, reviewVisible: true, uploadInFlight: false }, true],
    [{ pendingBlob: {}, reviewVisible: false, uploadInFlight: true }, true],
    [{ pendingBlob: null, reviewVisible: true, uploadInFlight: true }, true],
    [{ pendingBlob: {}, reviewVisible: true, uploadInFlight: true }, true]
  ];
  for (const [input, expected] of cases) {
    assert.equal(computeTierRecordAwaitingConfirmation(input), expected, JSON.stringify(input));
  }
});
