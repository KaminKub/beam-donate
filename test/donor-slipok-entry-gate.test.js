'use strict';

// SLIPOK_DONOR_ENTRY_GATE: SlipOK-backed methods (PromptPay/Bank) ต้องหายไปจากหน้าเลือกวิธีชำระเงิน
// เมื่อ SlipOK ยังไม่ตั้งค่า/เชื่อมต่อไม่ได้ ส่วน TrueMoney Webhook ต้องไม่ถูกซ่อนตาม

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public', 'donate-template', 'app.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');

function loadPureFunction(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function: ${name}`);
  const end = appSource.indexOf('\n}', start); // top-level close (body braces are indented)
  assert.notEqual(end, -1, `missing function end: ${name}`);
  return vm.runInNewContext(`${appSource.slice(start, end + 2)}; ${name};`, {});
}

const getUsablePaymentMethods = loadPureFunction('getUsablePaymentMethods');

const SLIPOK_OK = { slipok_configured: true, slipok_connected: true };

test('PromptPay/Bank ถูกซ่อนเมื่อยังไม่ได้ตั้งค่า SlipOK', () => {
  const usable = getUsablePaymentMethods({ promptpay: true, bank: true, slipok_configured: false, slipok_connected: true });
  assert.equal(usable.promptpay, false);
  assert.equal(usable.bank, false);
  assert.equal(usable.any, false);
});

test('PromptPay/Bank ถูกซ่อนเมื่อ SlipOK ตั้งค่าแล้วแต่เชื่อมต่อไม่ได้', () => {
  const usable = getUsablePaymentMethods({ promptpay: true, bank: true, slipok_configured: true, slipok_connected: false });
  assert.equal(usable.promptpay, false);
  assert.equal(usable.bank, false);
  assert.equal(usable.any, false);
});

test('PromptPay/Bank แสดงตามปกติเมื่อ SlipOK พร้อม', () => {
  const usable = getUsablePaymentMethods({ promptpay: true, bank: true, ...SLIPOK_OK });
  assert.equal(usable.promptpay, true);
  assert.equal(usable.bank, true);
  assert.equal(usable.any, true);
});

test('TrueMoney Webhook ไม่ผูกกับ SlipOK — ต้องยังเข้าโดเนทได้', () => {
  const usable = getUsablePaymentMethods({ truemoney_webhook: true, slipok_configured: false, slipok_connected: false });
  assert.equal(usable.truemoney, true);
  assert.equal(usable.any, true, 'user ที่ใช้ TrueMoney Webhook อย่างเดียวห้ามถูกบล็อก');
});

test('PromptPay + Webhook เมื่อ SlipOK ล่ม: ซ่อนเฉพาะ PromptPay แล้ว auto-select TrueMoney', () => {
  const usable = getUsablePaymentMethods({ promptpay: true, truemoney_webhook: true, slipok_configured: true, slipok_connected: false });
  assert.deepEqual(
    { promptpay: usable.promptpay, truemoney: usable.truemoney, any: usable.any },
    { promptpay: false, truemoney: true, any: true }
  );

  const autoSelect = appSource.slice(appSource.indexOf('function hydratePaymentMethodStep('));
  assert.match(autoSelect, /if \(usable\.promptpay\) \{\s*selectPaymentMethod\('promptpay'\)/);
  assert.match(autoSelect, /else if \(usable\.truemoney\) \{\s*selectPaymentMethod\('truemoney'\)/);
});

test('ไม่มีวิธีชำระเงินเลย → any=false เพื่อกลับไปใช้ noPaymentMethodMsg เดิม', () => {
  assert.equal(getUsablePaymentMethods({}).any, false);
  assert.equal(getUsablePaymentMethods(null).any, false);
  assert.equal(getUsablePaymentMethods({ promptpay: false, bank: false, truemoney_webhook: false, ffp: false }).any, false);
});

test('btnDonate ใช้ตัวตรวจเดียวกันและไม่ยิง request ใหม่ไปหา SlipOK', () => {
  const handler = appSource.slice(
    appSource.indexOf("btnDonate.addEventListener('click'"),
    appSource.indexOf("document.querySelectorAll('.payment-method-option')")
  );
  assert.match(handler, /const hasAnyMethod = getUsablePaymentMethods\(methods\)\.any;/);
  assert.match(handler, /msg\.textContent = 'เจ้าของหน้าโดเนทยังไม่ตั้งวิธีชำระเงิน';/);
  assert.equal(handler.match(/fetch\(/g).length, 1, 'donor click ต้องมี request เดียวคือ payment-methods เดิม');
  assert.match(handler, /fetch\(`\/api\/page\/\$\{username\}\/payment-methods`\)/);
  assert.doesNotMatch(handler, /\/api\/[a-z/-]*(slipok|quota)/i, 'ห้ามเรียก SlipOK/quota endpoint จาก donor click');
});

test('เข้าหน้าถัดไปได้แล้ว error เดิมต้องถูกล้าง ไม่ค้างตอน Back', () => {
  const handler = appSource.slice(
    appSource.indexOf("btnDonate.addEventListener('click'"),
    appSource.indexOf("document.querySelectorAll('.payment-method-option')")
  );
  const cleanup = handler.indexOf("btnDonate.classList.remove('btn-shake', 'btn-glow-red')");
  assert.notEqual(cleanup, -1);
  assert.match(handler, /document\.getElementById\('noPaymentMethodMsg'\)\?\.remove\(\)/);
  assert.ok(cleanup < handler.indexOf("stepPaymentMethod.classList.add('active')"), 'ต้องล้างก่อนเปลี่ยน step');
});

test('การ์ดที่ใช้ไม่ได้ถูกซ่อนด้วยกลไก display เดิม ไม่เพิ่ม class/animation ใหม่', () => {
  const hydrate = appSource.slice(
    appSource.indexOf('function hydratePaymentMethodStep('),
    appSource.indexOf("btnDonate.addEventListener('click'")
  );
  assert.match(hydrate, /optionPromptPay\.style\.display = usable\.promptpay \? '' : 'none'/);
  assert.match(hydrate, /optionBank\.style\.display = usable\.bank \? '' : 'none'/);
  assert.match(hydrate, /optionTrueMoney\.style\.display = usable\.truemoney \? '' : 'none'/);
});

test('public payment-methods ส่ง slipok_configured เป็น boolean ไม่รั่ว credential', () => {
  const endpoint = serverSource.slice(
    serverSource.indexOf("app.get('/api/page/:username/payment-methods'"),
    serverSource.indexOf('const UPLOAD_MAX_SIZES')
  );
  assert.match(endpoint, /const slipOkConfigured = !!\(\(decrypted\.slipok_api && decrypted\.slipok_api_key\) \|\|\s*\(decrypted\.truemoney_slipok_api && decrypted\.truemoney_slipok_api_key\)\)/);
  assert.match(endpoint, /slipok_configured: slipOkConfigured,/);
  for (const secret of ['slipok_api:', 'slipok_api_key:', 'truemoney_slipok_api:', 'tfp_api_key', 'tfp_api_secret', 'promptpay_value']) {
    assert.doesNotMatch(endpoint.slice(endpoint.indexOf('res.json({')), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('TrueMoney = webhook อย่างเดียว: ปุ่ม fallback อัปโหลดสลิปต้องไม่โผล่ทุกกรณี', () => {
  const fn = appSource.slice(
    appSource.indexOf('function setTrueMoneyQrSlipFallbackVisible('),
    appSource.indexOf('// Copy phone number button')
  );
  assert.match(fn, /visible = false;/);
  assert.ok(
    fn.indexOf('visible = false;') < fn.indexOf("classList.toggle('visible', visible)"),
    'ต้องบังคับ false ก่อน toggle class'
  );
  // call site ของ timer 90 วิ และตอน QR หมดอายุยังอยู่ครบ — ปิดที่จุดเดียว ไม่ลบโค้ด
  assert.match(appSource, /setTrueMoneyQrSlipFallbackVisible\(true\)/);
});

test('TrueMoney manual step ไม่ถูก restore กลับมา (หน้านั้นไม่มี SSE รอ webhook)', () => {
  const anchor = appSource.indexOf('const pendingManualPayment = getManualPaymentStep();');
  assert.notEqual(anchor, -1);
  const restore = appSource.slice(anchor, anchor + 600);
  assert.match(restore, /pendingManualPayment\.method === 'truemoney'[\s\S]{0,120}clearManualPaymentStep\(\)/);
});

test('หน้า TrueMoney manual ซ่อน UI สลิปครบและ instructions ไม่สั่งอัพสลิป', () => {
  const htmlSource = fs.readFileSync(path.join(root, 'public', 'donate-template', 'index.html'), 'utf8');
  const step = htmlSource.slice(
    htmlSource.indexOf('<div id="step-truemoney" class="step">'),
    htmlSource.indexOf('<!-- end step-truemoney -->')
  );
  assert.match(step, /id="trueMoneySlipUploadContainer" style="display: none;"/);
  assert.match(step, /id="btnMobileSlipUploadTrueMoney"[^>]*style="display: none;"/);
  assert.match(step, /id="btnVerifyTrueMoney"[^>]*style="display: none;"/);
  assert.match(step, /ระบบจะตรวจสอบและยืนยันให้อัตโนมัติ ไม่ต้องอัพโหลดสลิป/);
  assert.doesNotMatch(step, /<p><span>4<\/span>[^<]*อัพโหลดสลิปด้านล่าง/);
});

test('เส้นทาง webhook ยืนยันเองแล้วพาไป thank-you โดยไม่ต้องกดปุ่ม', () => {
  assert.match(appSource, /data\.type === 'donate_status' && data\.status === 'confirmed'[\s\S]{0,80}handleTrueMoneyConfirmed\(\)/);
  assert.match(appSource, /function handleTrueMoneyConfirmed\(\)[\s\S]{0,600}window\.location\.href = `\/\$\{window\.location\.pathname\.split\('\/'\)\[1\]\}\/thank-you`/);
  assert.match(serverSource, /broadcastDonateStatus\(tx\.id, \{ status: 'confirmed' \}\)/);
});

test('updateSlipOkWarning ยังอยู่เป็น late fallback หลังเข้า payment step', () => {
  assert.match(appSource, /function updateSlipOkWarning\(method\)/);
  assert.match(appSource, /updateSlipOkWarning\('bank'\)/);
  assert.match(appSource, /updateSlipOkWarning\('truemoney'\)/);
});
