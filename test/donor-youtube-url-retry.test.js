'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public', 'donate-template', 'app.js'), 'utf8');

test('YouTube modal reset always re-enables ytUrlLoadBtn', () => {
  const reset = appSource.slice(
    appSource.indexOf('function resetYoutubeModalToStep1()'),
    appSource.indexOf('function openYoutubeModal()')
  );
  assert.match(reset, /btn\.disabled = false/);
  assert.match(reset, /btn\.innerHTML = '<i class="fa-solid fa-download"><\/i> โหลดคลิป'/);
});

test('changing away from YouTube resets the load button before donor returns', () => {
  const clear = appSource.slice(
    appSource.indexOf('function clearTierSoundSource()'),
    appSource.indexOf('function resetTierOwnAudioSelection()')
  );
  assert.match(clear, /resetYoutubeModalToStep1\(\)/);
});

test('invalid or live YouTube URLs keep a retry path', () => {
  const loadHandler = appSource.slice(
    appSource.indexOf("document.getElementById('ytUrlLoadBtn')?.addEventListener"),
    appSource.indexOf("document.getElementById('ytPlayTestBtn')?.addEventListener")
  );
  assert.match(loadHandler, /if \(!parsed\) \{[\s\S]{0,220}btn\.disabled = false/);
  const liveHandler = appSource.slice(
    appSource.indexOf('function onYtPlayerReady('),
    appSource.indexOf('function onYtPlayerError(')
  );
  assert.match(liveHandler, /resetYoutubeModalToStep1\(\)/);
});
