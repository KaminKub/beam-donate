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

test('ใช้คลิปนี้ ต้องไม่ทำลาย YT player', () => {
  const clear = appSource.slice(
    appSource.indexOf('function clearTierSoundSource()'),
    appSource.indexOf('function resetTierOwnAudioSelection()')
  );
  // Audit R2-F2: slice ที่จบด้วย closeYoutubeModal() กินบรรทัด "หลัง" if-block ไปด้วย
  // ทำให้ assert.match ผ่านทั้งโครงที่ถูกและโครงที่มีบั๊ก — ต้องเทียบตำแหน่งแทน
  const idxIf = clear.indexOf('if (selectedTierYoutube)');
  const idxBlockEnd = clear.indexOf('\n  }', idxIf);
  const idxReset = clear.indexOf('resetYoutubeModalToStep1()', idxIf);
  assert.ok(idxIf >= 0 && idxBlockEnd > idxIf, 'หา if (selectedTierYoutube) block ใน clearTierSoundSource() ไม่เจอ');
  assert.ok(
    idxReset > idxIf && idxReset < idxBlockEnd,
    'resetYoutubeModalToStep1() ต้องอยู่ "ใน" if (selectedTierYoutube) block เท่านั้น — ถ้าหลุดออกมา ytUseClipBtn จะทำลาย player ตัวเอง (Audit R1 F1)'
  );
});

test('เปิดโมดัลซ้ำต้องกลับไป step 2 ตราบใดที่ player ยังมีชีวิต', () => {
  const open = appSource.slice(
    appSource.indexOf('function openYoutubeModal()'),
    appSource.indexOf('function closeYoutubeModal()')
  );
  const cond = open.slice(open.indexOf('if ('), open.indexOf('showYtStep2()'));
  assert.match(cond, /ytPlayer && ytPlayerReady/, 'ต้องเช็ค player จริงก่อนโชว์ step 2 (กัน Audit R1 F1)');
  assert.doesNotMatch(cond, /selectedTierYoutube/,
    'ห้ามผูก step 2 กับ selectedTierYoutube — donor ที่โหลดคลิปแล้วปิดโมดัลก่อนยืนยันจะเสียช่วง trim (Audit R2-F4)');
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
