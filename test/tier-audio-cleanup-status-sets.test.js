'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dbSource = fs.readFileSync(path.join(root, 'src', 'database.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');

function sliceFn(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `ไม่พบฟังก์ชัน ${name}() ใน source`);
  const next = source.indexOf('\nasync function ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

// A-1/A-2 — อ่าน url ก่อน แล้วค่อย DELETE ด้วย WHERE เดียวกัน
// ถ้า status set ไม่ตรงกัน = ลบ row ทิ้งก่อนอ่าน url = orphan ถาวรบน R2
test('getHardDeletableTierAudioUrls และ hardDeleteExpiredTransactions ใช้ status set เดียวกัน', () => {
  const reader = sliceFn(dbSource, 'getHardDeletableTierAudioUrls');
  const deleter = sliceFn(dbSource, 'hardDeleteExpiredTransactions');

  assert.match(reader, /status IN \('expired','failed'\)/);
  assert.match(deleter, /DELETE FROM transactions WHERE status IN \('expired','failed'\)/);

  // ทั้งคู่ต้องใช้ cutoff 7 วันเหมือนกัน
  assert.match(reader, /datetime\('now', '-7 days'\)/);
  assert.match(deleter, /datetime\('now', '-7 days'\)/);
});

test('fallback branch ของ hardDeleteExpiredTransactions ครอบทั้ง expired และ failed', () => {
  const deleter = sliceFn(dbSource, 'hardDeleteExpiredTransactions');
  const fallback = deleter.slice(deleter.indexOf('if (isFallback)'), deleter.indexOf('if (!db)'));

  assert.match(fallback, /t\.status === 'expired'/);
  assert.match(fallback, /t\.status === 'failed'/);
  assert.match(fallback, /t\.updatedAt && t\.updatedAt < cutoff/);
});

// A-3 — sweeper ห้ามลบไฟล์ที่ยังมีสิทธิ์ใช้ (pending รอจ่าย / failed ยัง retry ได้)
// แต่ห้ามป้องกัน successful/expired เพราะสองสถานะนั้นมี deterministic delete อยู่แล้ว
test('getAllR2Refs ป้องกันเฉพาะ pending/failed', () => {
  const refs = sliceFn(dbSource, 'getAllR2Refs');
  const txQuery = refs.slice(refs.indexOf('FROM transactions'));

  assert.match(refs, /tier_sound_is_temp = 1 AND tier_sound_url IS NOT NULL AND status IN \('pending','failed'\)/);
  assert.doesNotMatch(txQuery, /'successful'/);
  assert.doesNotMatch(txQuery, /'expired'/);
});

test('A-3 ใช้ addRef เดิม ไม่เขียน normalizer ใหม่', () => {
  const refs = sliceFn(dbSource, 'getAllR2Refs');
  assert.match(refs, /for \(const row of txRefs\.rows\) addRef\(row\.tier_sound_url\);/);
  assert.equal((refs.match(/const addRef = /g) || []).length, 1);
});

// ทุก status ที่ระบบเขียนจริงต้องมีทางลบไฟล์ donor-temp อย่างน้อย 1 ทาง
test('ทุก transaction status มี deterministic delete path หรือถูก sweeper รับ', () => {
  const coverage = [
    { status: 'pending', by: () => sliceFn(dbSource, 'getExpiringTierAudioUrls'), expect: /status = 'pending'/ },
    { status: 'expired', by: () => sliceFn(dbSource, 'getHardDeletableTierAudioUrls'), expect: /'expired'/ },
    { status: 'failed', by: () => sliceFn(dbSource, 'getHardDeletableTierAudioUrls'), expect: /'failed'/ },
    { status: 'successful', by: () => serverSource, expect: /confirmDonationSideEffects/ }
  ];

  for (const { status, by, expect } of coverage) {
    assert.match(by(), expect, `status '${status}' ไม่มี deterministic delete path`);
  }

  // net สุดท้าย: sweeper ต้องยังอยู่
  assert.match(serverSource, /cleanup-r2-orphans/);
});

// ห้ามลบไฟล์ทันทีตอนเขียน failed — retry ของ BANK_UNAVAILABLE ใช้ tx เดิม
test('จุดที่เขียน status failed ต้องไม่ลบไฟล์ R2 ทันที', () => {
  const failedWrites = [...serverSource.matchAll(/status:\s*'failed'/g)];
  assert.ok(failedWrites.length > 0, 'ไม่พบจุดเขียน status failed — grep เปลี่ยนไปแล้ว ให้ทวน blueprint');

  for (const m of failedWrites) {
    const window = serverSource.slice(Math.max(0, m.index - 800), m.index + 800);
    assert.doesNotMatch(window, /deleteFromR2ByUrl/, 'พบการลบไฟล์ R2 ใกล้จุดเขียน failed — ตัดสิทธิ์ retry');
  }
});
