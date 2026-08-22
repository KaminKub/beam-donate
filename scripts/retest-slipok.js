'use strict';

// Admin support CLI: explicitly retest stored SlipOK credentials for one streamer.
//
//   npm run admin:retest-slipok -- --username <username>            # dry run
//   npm run admin:retest-slipok -- --username <username> --execute  # probe + scoped CAS
//
// This remains the explicit reconnect path. Every post-provider state change is a
// scope-allowlisted compare-and-set; it never uses saveStreamer after a probe.

require('dotenv').config();
const db = require('../src/database');
const {
  retestStoredSlipOk,
  getStoredSlipOkCredentialSets,
  inferSlipOkBasePlan
} = require('../src/slipok-connection');
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

function printableStatus(streamer) {
  return {
    promptpay: streamer.slipok_connected ? 1 : 0,
    truemoney: streamer.truemoney_slipok_connected ? 1 : 0
  };
}

async function applyScopedResults(streamer, results) {
  const after = printableStatus(streamer);
  let stateSyncFailed = false;

  for (const result of results) {
    let persisted = null;
    try {
      if (result.authoritative) {
        persisted = await db.disconnectSlipOkScopeIfUnchanged(
          streamer,
          result.scope,
          new Date().toISOString()
        );
        if (persisted.rowsAffected === 1 || persisted.skipped) after[result.scope] = 0;
      } else if (result.success && result.endDateValid && !result.expired) {
        persisted = await db.reconnectSlipOkScopeIfUnchanged(
          streamer,
          result.scope,
          new Date().toISOString(),
          inferSlipOkBasePlan(result.quota || 0)
        );
        if (persisted.rowsAffected === 1 || persisted.skipped) after[result.scope] = 1;
      } else {
        // Timeout/DNS/429/5xx/malformed/null-date outcomes are read-only.
        continue;
      }

      if (persisted.rowsAffected === 0 && !persisted.skipped) {
        stateSyncFailed = true;
        after[result.scope] = '?';
        console.error(`⚠️  สถานะเปลี่ยนระหว่างตรวจสอบ: scope=${result.scope}`);
      }
    } catch (err) {
      stateSyncFailed = true;
      after[result.scope] = '?';
      console.error(`❌ บันทึกสถานะไม่สำเร็จ: scope=${result.scope} code=${err.code || err.name || 'DB_ERROR'}`);
    }
  }

  return { after, stateSyncFailed };
}

async function main() {
  const { username, execute } = parseArgs(process.argv.slice(2));

  // Same shape db.getStreamer() matches on (LOWER(username)); anything else is
  // rejected rather than normalized, so a Twitch ID or SQL fragment cannot reach it.
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

  const scopes = getStoredSlipOkCredentialSets(streamer).map(set => set.scope);
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

  const { ok, results } = await retestStoredSlipOk({ streamer });

  console.log('');
  for (const result of results) {
    console.log(result.success
      ? `✅ ${result.scope}: connected · quota=${result.quota}`
      : `❌ ${result.scope}: ${result.authoritative ? result.reason : 'unknown'} · code=${result.errorCode}`);
  }

  const { after, stateSyncFailed } = await applyScopedResults(streamer, results);
  console.log(`after:   promptpay=${after.promptpay} · truemoney=${after.truemoney}`);

  for (const result of results) {
    await db.logIpEvent('admin_slipok_retest', '127.0.0.1', streamer.username, {
      source: 'cli',
      scope: result.scope,
      success: result.success,
      errorCode: result.errorCode
    });
  }

  return ok && !stateSyncFailed ? 0 : 2;
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    // Never print err.message: provider/DB clients can embed URLs or headers.
    console.error(`❌ retest ล้มเหลว: ${err.code || err.name || 'UNKNOWN'}`);
    process.exit(2);
  });
