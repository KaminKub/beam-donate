const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loginDest, isSafeReturnTo } = require('../src/auth-helpers');

const cases = [
  ['/kaminkub/timer-dock', 'kaminkub', '/kaminkub/timer-dock', 'dock ของตัวเอง'],
  ['/kaminkub/dona-monitor', 'KaminKub', '/kaminkub/dona-monitor', 'username ต่าง case'],
  ['/admin', 'kaminkub', '/admin', 'admin ผ่าน'],
  ['/otheruser/timer-dock', 'kaminkub', '/kaminkub/dashboard', 'dock คนอื่น → dashboard ตัวเอง'],
  ['//evil.com/x', 'kaminkub', '/kaminkub/dashboard', 'protocol-relative open redirect'],
  ['https://evil.com', 'kaminkub', '/kaminkub/dashboard', 'absolute URL'],
  ['/kaminkub/timer-dock?x=1', 'kaminkub', '/kaminkub/dashboard', 'มี query = ไม่อยู่ใน whitelist'],
  [null, 'kaminkub', '/kaminkub/dashboard', 'ไม่มี returnTo'],
  ['/kaminkub/dashboard', '', '/login', 'username ว่าง → กัน //dashboard'],
];
for (const [input, user, expected, label] of cases) {
  test(label, () => assert.equal(loginDest(input, user), expected));
}
test('isSafeReturnTo ปฏิเสธ path นอก whitelist', () => {
  assert.equal(isSafeReturnTo('/kaminkub/payment'), false);
});
