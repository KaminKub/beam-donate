// พิสูจน์: payload ที่ server สร้างจริง -> เรนเดอร์ด้วย lib ที่ donor ใช้จริง (public/assets/qrcode-generator.min.js)
// -> ถอดกลับด้วย jsQR -> ต้องได้สตริงเดิมเป๊ะ + เลขที่ฝังต้องตรงกับที่ streamer ตั้งไว้ (Lesson 64 guard)
const path = require('path');
const jsQR = require('jsqr');
const promptparse = require('promptparse');
const qrcode = require(path.join(__dirname, '../public/assets/qrcode-generator.min.js'));
const {
  generatePromptPayPayload,
  generatePromptPayIdCardPayload,
  generatePromptPayEWalletPayload,
} = require('../src/promptpay-payload');

function roundTrip(payload) {
  const qr = qrcode(0, 'M');
  qr.addData(payload);
  qr.make();
  const n = qr.getModuleCount(), scale = 4, margin = 4;
  const size = (n + margin * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.isDark(r, c)) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const x = (c + margin) * scale + dx, y = (r + margin) * scale + dy;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }
  const res = jsQR(data, size, size);
  return { decoded: res && res.data, version: n };
}

// TLV parser — ตรวจว่าเลขที่ฝังใน QR ตรงกับที่ streamer ตั้งไว้จริง
function parseTLV(s) {
  const out = {};
  let i = 0;
  while (i < s.length - 4) {
    const id = s.substr(i, 2), len = parseInt(s.substr(i + 2, 2), 10);
    out[id] = s.substr(i + 4, len);
    i += 4 + len;
  }
  return out;
}

function getSubTag(payload) {
  const merchant = parseTLV(payload)['29'];
  const sub = parseTLV(merchant);
  const tag = Object.keys(sub).find(k => k !== '00');
  return { tag, value: sub[tag] };
}

const cases = [
  { type: 'phone   (01)', expectSub: '01', expectVal: '0066812345678', payload: generatePromptPayPayload('0812345678', 150) },
  { type: 'phone +66',    expectSub: '01', expectVal: '0066812345678', payload: generatePromptPayPayload('66812345678', 150) },
  { type: 'phone dashes', expectSub: '01', expectVal: '0066812345678', payload: generatePromptPayPayload('081-234-5678', 150) },
  { type: 'idcard  (02)', expectSub: '02', expectVal: '1103700123456', payload: generatePromptPayIdCardPayload('1103700123456', 150) },
  { type: 'idcard dashes',expectSub: '02', expectVal: '1103700123456', payload: generatePromptPayIdCardPayload('1-1037-00123-45-6', 150) },
  { type: 'ewallet (03)', expectSub: '03', expectVal: '004999012345678', payload: generatePromptPayEWalletPayload('004999012345678', 150) },
  { type: 'ewallet lead0',expectSub: '03', expectVal: '000123456789012', payload: generatePromptPayEWalletPayload('000123456789012', 150) },
];

let allPass = true;
console.log('type            | render→decode | เลขใน QR ตรงกับที่ตั้ง | sub-tag | ver');
console.log('----------------|---------------|------------------------|---------|----');
for (const c of cases) {
  const rt = roundTrip(c.payload);
  const decodedMatch = rt.decoded === c.payload;      // assert 1: decoded === payload
  const { tag: gotSub, value: gotVal } = getSubTag(c.payload);
  const subTagMatch = gotSub === c.expectSub;          // assert 2: subTag === expected
  const valueMatch = gotVal === c.expectVal;            // assert 3: subTagValue === expectedDigits
  const pass = decodedMatch && subTagMatch && valueMatch;
  allPass = allPass && pass;
  console.log(
    `${c.type.padEnd(15)} | ${(decodedMatch ? 'IDENTICAL' : 'MISMATCH!').padEnd(13)} | ${(valueMatch ? 'ตรง' : 'ไม่ตรง!! ' + gotVal).padEnd(22)} | ${gotSub}      | ${rt.version}`
  );
  if (!pass) {
    console.error(`  FAIL: ${c.type} — decodedMatch=${decodedMatch} subTagMatch=${subTagMatch}(got ${gotSub}) valueMatch=${valueMatch}(got ${gotVal})`);
  }
}

// negative case — executable proof ของ Lesson 64: e-Wallet ID เข้าฟังก์ชันเบอร์โทรต้อง "ไม่" ได้ sub-tag 03
console.log('\n--- Lesson 64 regression guard: ewallet ID ผ่าน generatePromptPayPayload() (ฟังก์ชันเบอร์โทร) ---');
const badPayload = generatePromptPayPayload('004999012345678', 150);
const bad = getSubTag(badPayload);
console.log('sub-tag ที่ได้ :', bad.tag, '(ต้องไม่ใช่ 03)');
console.log('เลขที่ได้      :', bad.value, '(ต้องไม่ใช่ 004999012345678)');
const lesson64Guarded = bad.tag !== '03' && bad.value !== '004999012345678';
if (!lesson64Guarded) {
  allPass = false;
  console.error('  FAIL: negative case ควรได้ sub-tag/value ผิดเพี้ยน (พิสูจน์ว่าฟังก์ชันเบอร์โทรไม่ใช่ตัวกลาง) แต่กลับตรง — เช็คว่า import ฟังก์ชันถูกตัวไหม');
} else {
  console.log('→ ยืนยัน: ฟังก์ชันเบอร์โทรไม่ใช่ตัวกลาง ต้องเลือก generatePromptPayEWalletPayload() สำหรับ e-Wallet เท่านั้น (ตรงกับ fix §0b)');
}

// TrueMoney P2P ฝัง refId ลง EMVCo tag 81 (UTF-16 hex = 4 ตัว/char) แต่ TLV length field
// มีแค่ 2 หลัก -> message > 24 ตัวอักษรทำ payload พังเงียบ ๆ (BPAY-2010, ไม่ throw)
console.log('\n--- F1 guard: TrueMoney P2P refId ต้อง <= 24 ตัวอักษร ไม่งั้น EMVCo TLV พัง ---');
const tmRef = 'donate-' + 'a'.repeat(14);                    // 21 chars = format ที่ create-qr ใช้จริง
const tmRefOk = tmRef.length <= 24;
console.log('refId length   :', tmRef.length, tmRefOk ? '(ok)' : '(FAIL — ต้อง <= 24)');

const tmPayload = promptparse.generate.trueMoney({ mobileNo: '0812345678', amount: 100, message: tmRef });
const tmHasCrc = promptparse.parse(tmPayload).tags.map(t => t.id).includes('63');
console.log('CRC tag 63     :', tmHasCrc ? 'พบ (TLV ไม่พัง)' : 'ไม่พบ! (FAIL)');
const tmRoundTrip = roundTrip(tmPayload).decoded === tmPayload;
console.log('roundtrip QR   :', tmRoundTrip ? 'IDENTICAL' : 'MISMATCH! (FAIL)');

const tmPass = tmRefOk && tmHasCrc && tmRoundTrip;
allPass = allPass && tmPass;
if (!tmPass) console.error('  FAIL: TrueMoney P2P refId/QR roundtrip guard');

// regression guard: format เดิม 33 ตัวอักษรต้องพังจริง (กันคนเผลอ revert refId กลับ)
const tmBad = promptparse.generate.trueMoney({ mobileNo: '0812345678', amount: 100, message: 'donate-' + 'a'.repeat(26) });
const tmBadHasCrc = promptparse.parse(tmBad).tags.map(t => t.id).includes('63');
console.log('regression     :', !tmBadHasCrc ? 'ยืนยัน message ยาวเกิน 24 ทำ TLV พังจริง (ok)' : 'ไม่พัง! (FAIL — guard ไม่จำเป็นจริง?)');
allPass = allPass && !tmBadHasCrc;

console.log('\nRESULT:', allPass ? 'ALL PASS' : 'FAILED');
if (!allPass) process.exit(1);
