// Admin support CLI — retest the SlipOK credentials a streamer already stored.
//
//   npm run admin:retest-slipok -- --username <username>            (dry run, exit 1)
//   npm run admin:retest-slipok -- --username <username> --execute
//
// Deliberately narrow: it can only ask SlipOK whether the stored credentials still answer
// /quota, and can only write the connected / last-check / quota-snapshot columns of the
// scopes it tested. It cannot read, enter or change a Branch URL, API key, account number,
// phone, payment method or any *_account_verified flag — those stay the streamer's own act.
//
// Exit codes: 0 all configured scopes connected · 1 refused before calling SlipOK · 2 upstream/DB failure.

require('dotenv').config();
const db = require('../src/database');
const { retestStoredSlipOk, getStoredSlipOkCredentialSets } = require('../src/slipok-connection');
const { PAYMENT_ELIGIBILITY_VERSION } = require('../src/legal-helpers');

function parseArgs(argv) {
  const args = { username: null, execute: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--execute') args.execute = true;
    else if (argv[i] === '--username') args.username = argv[++i];
    else if (argv[i].startsWith('--username=')) args.username = argv[i].slice('--username='.length);
  }
  return args;
}

function refuse(message, hint) {
  console.error(`❌ ${message}`);
  if (hint) console.error(`   → ${hint}`);
  return 1;
}

async function main() {
  const { username, execute } = parseArgs(process.argv.slice(2));

  // Same shape db.getStreamer() matches on (LOWER(username)); anything else is rejected rather
  // than normalised, so a Twitch ID or a SQL fragment can never reach the query.
  if (!username || !/^[A-Za-z0-9_]{1,50}$/.test(username)) {
    return refuse('ต้องระบุ --username <username>', 'ตัวอักษร/ตัวเลข/_ เท่านั้น');
  }

  await db.initDB();
  const streamer = await db.getStreamer(username);
  if (!streamer) return refuse(`ไม่พบผู้ใช้ ${username}`);
  if (!streamer.is_active) return refuse(`ผู้ใช้ ${streamer.username} ถูกระงับอยู่`, 'ปลดระงับก่อนจึงจะทดสอบได้');
  if (streamer.payment_eligibility_version !== PAYMENT_ELIGIBILITY_VERSION) {
    return refuse(
      `ผู้ใช้ ${streamer.username} ยังไม่ได้ยืนยันคุณสมบัติผู้เชื่อมต่อระบบรับเงินรุ่นปัจจุบัน`,
      'ให้ user ยืนยันใน Dashboard ก่อน'
    );
  }

  const scopes = getStoredSlipOkCredentialSets(streamer).map(s => s.scope);
  if (!scopes.length) {
    return refuse(`USER_ACTION_REQUIRED — ${streamer.username} ไม่มี SlipOK credential ครบคู่ในระบบ`,
      'ให้ user กรอก Branch URL + API Key ใหม่เองใน Dashboard');
  }

  console.log(`user:    ${streamer.username}`);
  console.log(`scopes:  ${scopes.join(', ')}`);
  console.log(`before:  promptpay=${streamer.slipok_connected ? 1 : 0} (${streamer.slipok_last_check || '-'}) · truemoney=${streamer.truemoney_slipok_connected ? 1 : 0} (${streamer.truemoney_slipok_last_check || '-'})`);

  if (!execute) {
    console.error('\n⚠️  dry-run — ไม่ได้เรียก SlipOK และไม่ได้เขียน DB; ใส่ --execute เพื่อทดสอบจริง');
    return 1;
  }

  const { ok, results, patch } = await retestStoredSlipOk({ streamer });

  console.log('');
  for (const r of results) {
    console.log(r.success
      ? `✅ ${r.scope}: connected · quota=${r.quota}`
      : `❌ ${r.scope}: failed · code=${r.errorCode}`);
  }

  try {
    await db.saveStreamer({
      twitch_id: streamer.twitch_id || null,
      streamlabs_id: streamer.streamlabs_id || null,
      username: streamer.username,
      ...patch
    });
  } catch (err) {
    console.error(`❌ บันทึกผลลงฐานข้อมูลไม่สำเร็จ: ${err.code || 'DB_ERROR'}`);
    return 2;
  }

  console.log(`after:   promptpay=${patch.slipok_connected ?? (streamer.slipok_connected ? 1 : 0)} · truemoney=${patch.truemoney_slipok_connected ?? (streamer.truemoney_slipok_connected ? 1 : 0)}`);

  for (const r of results) {
    await db.logIpEvent('admin_slipok_retest', '127.0.0.1', streamer.username, {
      source: 'cli',
      scope: r.scope,
      success: r.success,
      errorCode: r.errorCode
    });
  }

  return ok ? 0 : 2;
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    // No err.message: an axios/libsql error can carry the URL or the API key in it.
    console.error(`❌ retest ล้มเหลว: ${err.code || err.name || 'UNKNOWN'}`);
    process.exit(2);
  });
