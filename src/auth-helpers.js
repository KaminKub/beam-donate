function determinePrimaryAuth(streamerRow) {
  if (streamerRow.primary_auth_provider) return streamerRow.primary_auth_provider;
  const hasTwitch = !!streamerRow.twitch_id;
  const hasStreamlabs = !!streamerRow.streamlabs_id;
  if (hasTwitch && !hasStreamlabs) return 'twitch';
  if (!hasTwitch && hasStreamlabs) return 'streamlabs';
  if (hasTwitch && hasStreamlabs && streamerRow.twitch_id === streamerRow.streamlabs_id) return 'streamlabs';
  return 'twitch';
}

// Post-login destination. returnTo ถูกเก็บตอน redirect ไป /login (ดู saveReturnTo ใน server.js)
const RETURN_TO_PATTERN = /^\/(?:[a-z0-9_]{3,30}\/(?:dashboard|dona-monitor|timer-dock)|admin)$/;

function isSafeReturnTo(url) {
  return typeof url === 'string' && RETURN_TO_PATTERN.test(url);
}

// เจ้าของเท่านั้น: /admin ปล่อยผ่าน (route /admin กรอง ADMIN_TWITCH_ID เองอยู่แล้ว),
// path ที่มี username ต้องตรงกับ user ที่เพิ่งล็อกอิน ไม่งั้นเด้ง /forbidden เปล่าๆ
function loginDest(returnTo, username) {
  const u = String(username || '').toLowerCase();
  if (!u) return '/login';
  if (isSafeReturnTo(returnTo) && (returnTo === '/admin' || returnTo.startsWith(`/${u}/`))) return returnTo;
  return `/${u}/dashboard`;
}

module.exports = { determinePrimaryAuth, isSafeReturnTo, loginDest };
