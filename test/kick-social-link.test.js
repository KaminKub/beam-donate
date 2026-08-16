const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'public/donate-template/app.js'), 'utf8');

// validateKickUrl อยู่ใน server.js (ไม่ได้ export) — ดึงเฉพาะฟังก์ชันมารันจริง ไม่ต้อง boot server/โหลด secret
const fnSource = serverSource.match(/function validateKickUrl\(url\) \{[\s\S]*?\n\}/);
const validateKickUrl = new Function(`${fnSource[0]}\nreturn validateKickUrl;`)();

const accepted = [
  '',
  null,
  undefined,
  'https://kick.com/username',
  'https://www.kick.com/username',
  'https://KICK.com/User?x=1#y',
];
const rejected = [
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  '//kick.com/username',
  'kick.com/username',
  'not a url',
  'http://kick.com/username',
  'https://user:pass@kick.com/username',
  'https://evil.com/username',
  'https://evilkick.com/username',
  'https://kick.com.evil.com/username',
  'https://kick.com/' + 'a'.repeat(2048),
];

for (const url of accepted) {
  test(`kick URL accepted: ${JSON.stringify(url)}`, () => assert.equal(validateKickUrl(url), true));
}
for (const url of rejected) {
  test(`kick URL rejected: ${JSON.stringify(url).slice(0, 60)}`, () => assert.equal(validateKickUrl(url), false));
}

test('server wires social_kick through allowlist, public map and demo mask', () => {
  assert.match(serverSource, /PAGE_ALLOWED_FIELDS = \[[\s\S]*?'social_kick'[\s\S]*?\];/);
  assert.match(serverSource, /SOCIAL_LINK_FIELDS = new Set\(\[[^\]]*'social_kick'/);
  assert.match(serverSource, /kick: streamer\.social_kick,/);
  assert.match(serverSource, /ALLOWED_DEMO_FIELDS = new Set\(\[[\s\S]*?'social_kick'/);
  assert.match(serverSource, /if \(!validateKickUrl\(safeBody\.social_kick\)\)[\s\S]*?status\(400\)/);
});

test('donate renderer keeps host check, noopener and aria-label for kick', () => {
  assert.match(appSource, /platform === 'kick'[\s\S]*?host !== 'kick\.com' && !host\.endsWith\('\.kick\.com'\)/);
  assert.match(appSource, /a\.rel = 'noopener noreferrer'/);
  assert.match(appSource, /a\.setAttribute\('aria-label', platformNames\[platform\] \|\| platform\)/);
  assert.match(appSource, /kick: 'fa-kick'/);
});

test('donate shows text labels up to 4 links', () => {
  assert.match(appSource, /const showLabels = activeLinks\.length <= 4;/);
});

// Codex adversarial review R1: renderer ต้อง mirror นโยบาย validateKickUrl() ให้ครบ ไม่ใช่แค่ scheme+host
test('donate renderer rejects userinfo (ทุกแพลตฟอร์ม) และ kick url ที่ยาวเกิน 2048', () => {
  assert.match(appSource, /if \(parsed\.username \|\| parsed\.password\) return;/);
  assert.match(appSource, /platform === 'kick'[\s\S]*?url\.length > 2048/);
});

test('static fallback social anchors มี rel=noopener และ aria-label ครบทุกตัว', () => {
  const html = fs.readFileSync(path.join(root, 'public/donate-template/index.html'), 'utf8');
  const block = html.slice(html.indexOf('<div id="socialLinks"'), html.indexOf('</div>', html.indexOf('<div id="socialLinks"')));
  const anchors = block.match(/<a\s[^>]*>/g) || [];
  assert.ok(anchors.length > 0, 'ต้องมี fallback anchor อย่างน้อย 1 ตัว');
  for (const a of anchors) {
    assert.match(a, /rel="noopener noreferrer"/, `anchor ขาด rel: ${a}`);
    assert.match(a, /aria-label="/, `anchor ขาด aria-label: ${a}`);
  }
});

test('kick K mark is styled on the donate page too (Dashboard css ไม่ได้โหลดที่นั่น)', () => {
  const css = fs.readFileSync(path.join(root, 'public/assets/style.css'), 'utf8');
  assert.match(css, /\.social-btn\.kick i::before \{ content: "K"; \}/);
});
