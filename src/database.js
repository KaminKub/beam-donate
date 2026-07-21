const path = require('path');
const fs = require('fs');
const { encrypt, decrypt } = require('./encryption');

let db = null;
let isFallback = false;
let memoryTransactions = [];
let memorySettings = null;
let initPromise = null;
let isInitialized = false;

/**
 * Initialize Connection to Turso database using @libsql/client,
 * and handle legacy migrations. Fallback to in-memory on error.
 */
async function initDB() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (!url) {
      useInMemoryFallback('TURSO_DATABASE_URL is not configured in environment variables');
      return;
    }

    console.log(`🔌 Connecting to Turso Database at ${url}...`);

    try {
      const { createClient } = require('@libsql/client');
      db = createClient({
        url,
        authToken
      });

      // Turso ใช้ HTTP ต่อ query — network สะดุดชั่วคราวทำ query fail; retry เดียวก็รอด
      const _rawExecute = db.execute.bind(db);
      db.execute = async (...args) => {
        try { return await _rawExecute(...args); }
        catch (e) {
          if (/fetch failed|ECONNRESET|socket hang up|UND_ERR/i.test(e.message || '')) {
            await new Promise(r => setTimeout(r, 300));
            return _rawExecute(...args);
          }
          throw e;
        }
      };

      // Critical check: Ensure main table exists to prevent 503 on first deploy
      try {
        await db.execute('SELECT 1 FROM streamers LIMIT 1');
      } catch (e) {
        console.error('🚨 CRITICAL: Database tables are missing!');
        console.error('👉 Please run "npm run migrate" to set up your database schema.');
      }

      console.log('✅ Turso Database client initialized.');
    } catch (err) {
      console.warn('⚠️ Warning: Cannot connect to Turso database. Falling back to in-memory database.');
      console.warn('Error details:', err.message);
      useInMemoryFallback(err.message);
    }
    isInitialized = true;
  })();

  return initPromise;
}

function getDB() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

/**
 * Database Migration Logic

 * This should be run once during deployment or manually, NOT on every request.
 */
async function migrateDB() {
  await ensureConnected();
  if (isFallback) {
    console.warn('⚠️ migrateDB called in Fallback mode. Skipping migrations.');
    return;
  }
  if (!db) throw new Error('Database not initialized');

  console.log('🛠️ Starting Database Migration...');

  try {
    // Helper to prevent SQL injection for identifiers
    const validateIdentifier = (name) => {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        throw new Error(`Invalid identifier name: ${name}`);
      }
      return name;
    };

    // 1. Create/Update streamers table (Consolidated settings)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS streamers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        twitch_id TEXT UNIQUE,
        streamlabs_id TEXT UNIQUE,
        streamlabs_username TEXT,
        username TEXT UNIQUE NOT NULL,
        discord_webhook_url TEXT,
        overlay_token TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        
        -- Overlay Settings (Flattened)
        duration INTEGER DEFAULT 8,
        soundEnabled INTEGER DEFAULT 1,
        soundChoice TEXT DEFAULT 'chime',
        soundVolume REAL DEFAULT 0.5,
        ttsEnabled INTEGER DEFAULT 1,
        ttsReadDonor INTEGER DEFAULT 1,
        ttsVolume REAL DEFAULT 0.8,
        ttsRate REAL DEFAULT 1.3,
        ttsLanguage TEXT DEFAULT 'th-TH',
        ttsVoice TEXT,
        ttsPrefixEnabled INTEGER DEFAULT 1,

        profanityFilterEnabled INTEGER DEFAULT 1,
        profanityWords TEXT,
        profanityReplaceStyle TEXT DEFAULT 'asterisks',
        messageTemplate TEXT DEFAULT '{ผู้โดเนท} ได้บริจาค {amount} บาท! 🎉',
        amountSuffix TEXT DEFAULT 'บาท',
        showLabel INTEGER DEFAULT 0,
        showDonorMessage INTEGER DEFAULT 1,
        minAmount REAL DEFAULT 1,
        theme TEXT DEFAULT 'text-only',
        animation TEXT DEFAULT 'slide-down',
        fontFamily TEXT DEFAULT 'Noto Sans Thai',
        primaryColor TEXT DEFAULT '#667eea',
        secondaryColor TEXT DEFAULT '#764ba2',
        backgroundColor TEXT DEFAULT 'rgba(15, 15, 25, 0.88)',
        textColor TEXT DEFAULT '#ffffff',
        borderColor TEXT DEFAULT 'rgba(255, 255, 255, 0.05)',
        theme_colors TEXT,
        alert_font_sizes TEXT,
        alert_outline TEXT,
        template_line1 TEXT,
        template_line2 TEXT,
         particleCount INTEGER DEFAULT 15,
         fontSize INTEGER DEFAULT 48,
         customImageMode TEXT DEFAULT 'emoji',
         customImageValue TEXT DEFAULT '💝',
         customSoundUrl TEXT,
         alert_sound_url TEXT,

        -- Page Customization
        page_title TEXT,
        page_subtitle TEXT,
        thank_you_header TEXT,
        thank_you_subtitle TEXT,

        -- Social Links
        social_twitch TEXT,
        social_youtube TEXT,
        social_tiktok TEXT,
        social_facebook TEXT,
        social_x TEXT,
        social_discord TEXT,
        social_instagram TEXT,
        
        -- Streamlabs OAuth Tokens
        streamlabs_access_token TEXT,
        streamlabs_refresh_token TEXT,
        
        -- Profile System
        profile_image_source TEXT DEFAULT 'twitch',
        profile_image_value TEXT,
        profile_glow_color TEXT DEFAULT '#005704',

         -- Payment Settings (Legacy)
        payment_method TEXT DEFAULT 'ffp',
        promptpay_phone TEXT,
        promptpay_name TEXT,
        promptpay_enabled INTEGER DEFAULT 0,
        tfp_api_key TEXT,
        tfp_api_secret TEXT,
        tfp_connected INTEGER DEFAULT 0,
        tfp_last_check TEXT,
        -- PromptPay (New)
        promptpay_type TEXT DEFAULT 'phone',
        promptpay_value_encrypted TEXT,
        slipok_api_encrypted TEXT,
        slipok_api_key_encrypted TEXT,
        slipok_connected INTEGER DEFAULT 0,
        slipok_last_check TEXT,
        promptpay_account_verified INTEGER DEFAULT 0,
        promptpay_account_verified_at TEXT,
        -- TrueMoney Wallet
        truemoney_enabled INTEGER DEFAULT 0,
        truemoney_phone_encrypted TEXT,
        truemoney_slipok_api_encrypted TEXT,
        truemoney_slipok_api_key_encrypted TEXT,
        truemoney_slipok_connected INTEGER DEFAULT 0,
        truemoney_slipok_last_check TEXT,
        truemoney_account_verified INTEGER DEFAULT 0,
        truemoney_account_verified_at TEXT,
        slipok_quota_total INTEGER,
        truemoney_slipok_quota_total INTEGER,
        bank_enabled INTEGER DEFAULT 0,
        bank_name TEXT,
        bank_account_number_encrypted TEXT,
        bank_account_name TEXT,
        bank_account_verified INTEGER DEFAULT 0,
        bank_account_verified_at TEXT,
        header_bg_url TEXT,
        page_bg_url TEXT,
        header_bg_y INTEGER DEFAULT 50,
        header_bg_zoom INTEGER DEFAULT 100,
        goal_enabled INTEGER DEFAULT 0,
        goal_amount REAL DEFAULT 5000,
        goal_current REAL DEFAULT 0,
        goal_label TEXT DEFAULT 'ค่ากาแฟ',
        goal_bar_color TEXT DEFAULT '#4ade80',
        goal_show_on_donate INTEGER DEFAULT 1,
        goal_end_date TEXT DEFAULT NULL,
        goal_bar_text TEXT DEFAULT '{เปอร์เซนต์}',
        goal_subtitle1 TEXT DEFAULT '{ยอดปัจจุบัน}  /  {ยอดเป้าหมาย}฿',
        goal_subtitle2 TEXT DEFAULT 'ปิดหลอดใน  {วันคงเหลือ}  วัน',
        goal_anim_sound INTEGER DEFAULT 1,
        goal_anim_enabled INTEGER DEFAULT 1,
        goal_anim_sound_volume REAL DEFAULT 1,
        goal_bar_position TEXT DEFAULT 'top',
        goal_bar_width TEXT DEFAULT '600',
        goal_bar_layout TEXT DEFAULT 'horizontal',
        goal_bar_thickness TEXT DEFAULT '45',
        goal_pointer_enabled INTEGER DEFAULT 0,
        goal_bar_width_auto INTEGER DEFAULT 0,
        goal_pointer_side TEXT DEFAULT 'right',
        goal_pointer_content TEXT DEFAULT 'both',
        tos_accepted_at TEXT DEFAULT NULL,
        primary_auth_provider TEXT DEFAULT NULL,
        timer_settings TEXT DEFAULT NULL,
        timer_remaining_seconds INTEGER DEFAULT 600,
        timer_last_update TEXT DEFAULT NULL,
        timer_running INTEGER DEFAULT 0,
        timer_cap_current INTEGER DEFAULT 0,
        -- TrueMoney Webhook
        truemoney_webhook_secret_encrypted TEXT,
        truemoney_webhook_enabled INTEGER DEFAULT 0,
        truemoney_webhook_kyc_confirmed INTEGER DEFAULT 0,
        truemoney_webhook_expiry TEXT,
        truemoney_webhook_methods TEXT DEFAULT 'P2P',
        truemoney_promptpay_id_encrypted TEXT,
        badges TEXT DEFAULT '{}',
        badge_display TEXT DEFAULT NULL,
        leaderboard_settings TEXT DEFAULT NULL,
        recentdonate_settings TEXT DEFAULT NULL,
        goal_text_settings TEXT DEFAULT NULL,
        tier_donate_settings TEXT DEFAULT NULL,
        sound_library TEXT DEFAULT NULL
      )
    `);

    // 2. Create/Update transactions table (Original Structure)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        amount REAL NOT NULL,
        donor TEXT DEFAULT 'Anonymous',
        message TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        paymentUrl TEXT,
        raw_response TEXT,
        raw_webhook TEXT,
        createdAt TEXT,
        updatedAt TEXT,
        paidAt TEXT,
        streamer_username TEXT REFERENCES streamers(username),
        payment_method TEXT DEFAULT 'ffp',
        promptpay_slip_id TEXT,
        promptpay_verified INTEGER DEFAULT 0,
        promptpay_verified_at TEXT,
        timer_action TEXT DEFAULT NULL,
        tier_level INTEGER DEFAULT NULL,
        tier_image_url TEXT DEFAULT NULL,
        tier_sound_url TEXT DEFAULT NULL,
        tier_sound_is_temp INTEGER DEFAULT 0,
        tier_sound_youtube_id TEXT DEFAULT NULL,
        tier_sound_youtube_start REAL DEFAULT NULL,
        tier_sound_youtube_end REAL DEFAULT NULL
      )
     `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        session TEXT,
        expires INTEGER
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS ip_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        ip TEXT NOT NULL,
        streamer_username TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS processed_webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        streamer_username TEXT NOT NULL,
        event_hash TEXT NOT NULL UNIQUE,
        ref_id TEXT,
        amount_satang INTEGER NOT NULL,
        sender_mobile_masked TEXT,
        event_type TEXT,
        received_time TEXT,
        matched INTEGER DEFAULT 0,
        processed_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.execute('CREATE INDEX IF NOT EXISTS idx_processed_webhooks_streamer ON processed_webhooks(streamer_username, processed_at);');

    // [Requirement #9] All-time leaderboard aggregate — permanent, not subject to the 6-month transaction purge
    await db.execute(`
      CREATE TABLE IF NOT EXISTS leaderboard_alltime (
        streamer_username TEXT NOT NULL,
        donor TEXT NOT NULL,
        total_amount REAL NOT NULL DEFAULT 0,
        donation_count INTEGER NOT NULL DEFAULT 0,
        first_donation_at TEXT,
        last_donation_at TEXT,
        top_amount REAL DEFAULT 0,
        avg_amount REAL DEFAULT 0,
        updated_at TEXT,
        PRIMARY KEY (streamer_username, donor)
      )
    `);
    await db.execute('CREATE INDEX IF NOT EXISTS idx_leaderboard_alltime_streamer ON leaderboard_alltime(streamer_username, total_amount DESC);');

    // A. Fix transaction column names

    const txColumns = await db.execute('PRAGMA table_info(transactions)');
    const columns = txColumns.rows.map(r => r.name);
    
    if (columns.includes('created_at')) {
      console.log('🛠️ Migrating transactions: renaming created_at -> createdAt');
      await db.execute('ALTER TABLE transactions RENAME COLUMN created_at TO createdAt');
    }
    if (columns.includes('donor_name')) {
      console.log('🛠️ Migrating transactions: renaming donor_name -> donor');
      await db.execute('ALTER TABLE transactions RENAME COLUMN donor_name TO donor');
    }

    const requiredTxCols = [
      { name: 'status', type: "TEXT DEFAULT 'pending'" },
      { name: 'paymentUrl', type: 'TEXT' },
      { name: 'raw_response', type: 'TEXT' },
      { name: 'raw_webhook', type: 'TEXT' },
      { name: 'createdAt', type: 'TEXT' },
      { name: 'updatedAt', type: 'TEXT' },
      { name: 'paidAt', type: 'TEXT' },
      { name: 'streamer_username', type: 'TEXT' },
      { name: 'payment_method', type: "TEXT DEFAULT 'ffp'" },
      { name: 'promptpay_slip_id', type: 'TEXT' },
      { name: 'promptpay_verified', type: 'INTEGER DEFAULT 0' },
      { name: 'promptpay_verified_at', type: 'TEXT' },
      { name: 'timer_action', type: 'TEXT DEFAULT NULL' },
      { name: 'tier_level', type: 'INTEGER DEFAULT NULL' },
      { name: 'tier_image_url', type: 'TEXT DEFAULT NULL' },
      { name: 'tier_sound_url', type: 'TEXT DEFAULT NULL' },
      { name: 'tier_sound_is_temp', type: 'INTEGER DEFAULT 0' },
      { name: 'tier_sound_youtube_id', type: 'TEXT DEFAULT NULL' },
      { name: 'tier_sound_youtube_start', type: 'REAL DEFAULT NULL' },
      { name: 'tier_sound_youtube_end', type: 'REAL DEFAULT NULL' }
    ];

    for (const col of requiredTxCols) {
      if (!columns.includes(col.name)) {
        const safeName = validateIdentifier(col.name);
        console.log(`🛠️ Migrating transactions: adding column ${safeName}`);
        await db.execute(`ALTER TABLE transactions ADD COLUMN ${safeName} ${col.type}`);
      }
    }

    // C. Ensure new overlay settings columns exist
    const streamerColumnsRes = await db.execute('PRAGMA table_info(streamers)');
    const streamerCols = streamerColumnsRes.rows.map(r => r.name);
    // One-time signal for the account-verified backfill below — must be read BEFORE the ALTER
    // loop adds the column, and must not be re-derived from enabled/verified state afterwards
    // (reset-on-account-change legitimately zeroes verified flags later; re-running this backfill
    // on a later deploy would silently re-flip those flags back to 1 without real re-verification).
    const needsAccountVerifiedBackfill = !streamerCols.includes('promptpay_account_verified');

    const requiredCols = [
      { name: 'twitch_id', type: 'TEXT' },
      { name: 'streamlabs_id', type: 'TEXT' },
      { name: 'streamlabs_username', type: 'TEXT' },
      { name: 'ttsReadDonor', type: 'INTEGER DEFAULT 1' },
      { name: 'ttsVoice', type: 'TEXT' },
      { name: 'ttsPrefixEnabled', type: 'INTEGER DEFAULT 1' },
      { name: 'amountSuffix', type: "TEXT DEFAULT 'บาท'" },
      { name: 'showLabel', type: 'INTEGER DEFAULT 1' },
      { name: 'page_title', type: 'TEXT' },
      { name: 'page_subtitle', type: 'TEXT' },
      { name: 'thank_you_header', type: 'TEXT' },
      { name: 'thank_you_subtitle', type: 'TEXT' },
      { name: 'social_twitch', type: 'TEXT' },
      { name: 'social_youtube', type: 'TEXT' },
      { name: 'social_tiktok', type: 'TEXT' },
      { name: 'social_facebook', type: 'TEXT' },
      { name: 'social_x', type: 'TEXT' },
      { name: 'social_discord', type: 'TEXT' },
      { name: 'social_instagram', type: 'TEXT' },
      { name: 'profile_image_source', type: "TEXT DEFAULT 'twitch'" },
      { name: 'profile_image_value', type: 'TEXT' },
       { name: 'profile_glow_color', type: "TEXT DEFAULT '#005704'" },
       { name: 'streamlabs_access_token', type: 'TEXT' },
       { name: 'streamlabs_refresh_token', type: 'TEXT' },
      { name: 'customImageMode', type: "TEXT DEFAULT 'emoji'" },
      { name: 'customImageValue', type: 'TEXT' },
      { name: 'customSoundUrl', type: 'TEXT' },
      { name: 'payment_method', type: "TEXT DEFAULT 'ffp'" },
      { name: 'promptpay_phone', type: 'TEXT' },
      { name: 'promptpay_name', type: 'TEXT' },
      { name: 'promptpay_enabled', type: 'INTEGER DEFAULT 0' },
      { name: 'tfp_api_key', type: 'TEXT' },
      { name: 'tfp_api_secret', type: 'TEXT' },
      { name: 'tfp_connected', type: 'INTEGER DEFAULT 0' },
      { name: 'tfp_last_check', type: 'TEXT' },
      { name: 'promptpay_type', type: "TEXT DEFAULT 'phone'" },
      { name: 'promptpay_value_encrypted', type: 'TEXT' },
      { name: 'slipok_api_encrypted', type: 'TEXT' },
      { name: 'slipok_api_key_encrypted', type: 'TEXT' },
      { name: 'slipok_connected', type: 'INTEGER DEFAULT 0' },
      { name: 'slipok_last_check', type: 'TEXT' },
      { name: 'promptpay_account_verified', type: 'INTEGER DEFAULT 0' },
      { name: 'promptpay_account_verified_at', type: 'TEXT' },
      { name: 'truemoney_enabled', type: 'INTEGER DEFAULT 0' },
      { name: 'truemoney_phone_encrypted', type: 'TEXT' },
      { name: 'truemoney_slipok_api_encrypted', type: 'TEXT' },
      { name: 'truemoney_slipok_api_key_encrypted', type: 'TEXT' },
      { name: 'truemoney_slipok_connected', type: 'INTEGER DEFAULT 0' },
      { name: 'truemoney_slipok_last_check', type: 'TEXT' },
      { name: 'truemoney_account_verified', type: 'INTEGER DEFAULT 0' },
      { name: 'truemoney_account_verified_at', type: 'TEXT' },
      { name: 'slipok_quota_total', type: 'INTEGER' },
      { name: 'truemoney_slipok_quota_total', type: 'INTEGER' },
      { name: 'bank_enabled', type: 'INTEGER DEFAULT 0' },
      { name: 'bank_name', type: 'TEXT' },
      { name: 'bank_account_number_encrypted', type: 'TEXT' },
      { name: 'bank_account_name', type: 'TEXT' },
      { name: 'bank_account_verified', type: 'INTEGER DEFAULT 0' },
      { name: 'bank_account_verified_at', type: 'TEXT' },
      { name: 'header_bg_url', type: 'TEXT' },
      { name: 'page_bg_url', type: 'TEXT' },
      { name: 'header_bg_y', type: 'INTEGER DEFAULT 50' },
      { name: 'header_bg_zoom', type: 'INTEGER DEFAULT 100' },
      { name: 'goal_enabled', type: 'INTEGER DEFAULT 0' },
      { name: 'goal_amount', type: 'REAL DEFAULT 5000' },
      { name: 'goal_current', type: 'REAL DEFAULT 0' },
      { name: 'goal_label', type: "TEXT DEFAULT 'เป้าหมายโดเนท'" },
      { name: 'goal_bar_color', type: "TEXT DEFAULT '#4ade80'" },
      { name: 'goal_show_on_donate', type: 'INTEGER DEFAULT 1' },
      { name: 'goal_end_date', type: 'TEXT DEFAULT NULL' },
      { name: 'goal_bar_text', type: "TEXT DEFAULT '{เปอร์เซนต์}'" },
      { name: 'goal_subtitle1', type: "TEXT DEFAULT '{ยอดปัจจุบัน}  /  {ยอดเป้าหมาย}฿'" },
      { name: 'goal_subtitle2', type: "TEXT DEFAULT 'ปิดหลอดใน  {วันคงเหลือ}  วัน'" },
      { name: 'goal_anim_sound', type: 'INTEGER DEFAULT 1' },
      { name: 'goal_anim_enabled', type: 'INTEGER DEFAULT 1' },
      { name: 'goal_anim_sound_volume', type: 'REAL DEFAULT 1' },
      { name: 'goal_bar_position', type: "TEXT DEFAULT 'top'" },
      { name: 'goal_bar_width', type: "TEXT DEFAULT '600'" },
      { name: 'goal_bar_layout', type: "TEXT DEFAULT 'horizontal'" },
      { name: 'goal_bar_thickness', type: "TEXT DEFAULT '45'" },
      { name: 'goal_pointer_enabled', type: 'INTEGER DEFAULT 0' },
      { name: 'goal_bar_width_auto', type: 'INTEGER DEFAULT 0' },
      { name: 'goal_pointer_side', type: "TEXT DEFAULT 'right'" },
      { name: 'goal_pointer_content', type: "TEXT DEFAULT 'both'" },
      { name: 'tos_accepted_at', type: 'TEXT DEFAULT NULL' },
      { name: 'primary_auth_provider', type: 'TEXT' },
      { name: 'timer_settings', type: 'TEXT DEFAULT NULL' },
      { name: 'timer_remaining_seconds', type: 'INTEGER DEFAULT 600' },
      { name: 'timer_last_update', type: 'TEXT DEFAULT NULL' },
      { name: 'timer_running', type: 'INTEGER DEFAULT 0' },
      { name: 'timer_cap_current', type: 'INTEGER DEFAULT 0' },
      { name: 'truemoney_webhook_secret_encrypted', type: 'TEXT' },
      { name: 'truemoney_webhook_enabled', type: 'INTEGER DEFAULT 0' },
      { name: 'truemoney_webhook_kyc_confirmed', type: 'INTEGER DEFAULT 0' },
      { name: 'truemoney_webhook_expiry', type: 'TEXT' },
      { name: 'truemoney_webhook_methods', type: "TEXT DEFAULT 'P2P'" },
      { name: 'truemoney_promptpay_id_encrypted', type: 'TEXT' },
      { name: 'theme_colors', type: 'TEXT' },
      { name: 'alert_font_sizes', type: 'TEXT' },
      { name: 'alert_outline', type: 'TEXT' },
      { name: 'template_line1', type: 'TEXT' },
      { name: 'template_line2', type: 'TEXT' },
      { name: 'badges', type: "TEXT DEFAULT '{}'" },
      { name: 'badge_display', type: 'TEXT DEFAULT NULL' },
      { name: 'leaderboard_settings', type: 'TEXT DEFAULT NULL' },
      { name: 'recentdonate_settings', type: 'TEXT DEFAULT NULL' },
      { name: 'goal_text_settings', type: 'TEXT DEFAULT NULL' },
      { name: 'tier_donate_settings', type: 'TEXT DEFAULT NULL' },
      { name: 'sound_library', type: 'TEXT DEFAULT NULL' }
    ];

    for (const col of requiredCols) {
      if (!streamerCols.includes(col.name)) {
        const safeName = validateIdentifier(col.name);
        // We can't parameterize column names, but we've validated it's just alphanumeric
        console.log(`🛠️ Migrating streamers: adding column ${safeName}`);
        await db.execute(`ALTER TABLE streamers ADD COLUMN ${safeName} ${col.type}`);
      }
    }

    // Backfill NULL is_active → 1 (Number(null) === 0 would false-ban legacy rows)
    await db.execute("UPDATE streamers SET is_active = 1 WHERE is_active IS NULL");

    // Grandfather streamers already enabled before the account-verification gate existed —
    // they've received real donations already, so treat them as verified. One-time only
    // (see needsAccountVerifiedBackfill comment above) — never re-run on later deploys.
    if (needsAccountVerifiedBackfill) {
      await db.execute("UPDATE streamers SET promptpay_account_verified = 1, promptpay_account_verified_at = datetime('now') WHERE promptpay_enabled = 1 AND promptpay_account_verified = 0");
      await db.execute("UPDATE streamers SET bank_account_verified = 1, bank_account_verified_at = datetime('now') WHERE bank_enabled = 1 AND bank_account_verified = 0");
      await db.execute("UPDATE streamers SET truemoney_account_verified = 1, truemoney_account_verified_at = datetime('now') WHERE truemoney_enabled = 1 AND truemoney_account_verified = 0");
      console.log('✅ Backfilled account_verified flags for pre-existing enabled payment methods.');
    }

    // B. Migrate legacy global settings
    try {
      const settingsCheck = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'");
      if (settingsCheck.rows.length > 0) {
        console.log('📦 Found legacy settings table. Migrating to streamers...');
        const settingsRes = await db.execute("SELECT value FROM settings WHERE key = 'overlay_settings'");
        if (settingsRes.rows.length > 0) {
          const globalSettings = JSON.parse(settingsRes.rows[0].value);
          const streamers = await db.execute('SELECT username FROM streamers');
          for (const streamer of streamers.rows) {
            const username = streamer.username;
            const updates = [];
            const args = [];
            const streamerColumns = await db.execute('PRAGMA table_info(streamers)');
            const existingCols = streamerColumns.rows.map(r => r.name);
            Object.entries(globalSettings).forEach(([key, value]) => {
              if (existingCols.includes(key)) {
                updates.push(`${key} = ?`);
                args.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
              }
            });
            if (updates.length > 0) {
              args.push(username);
              await db.execute({
                sql: `UPDATE streamers SET ${updates.join(', ')} WHERE username = ?`,
                args: args
              });
            }
          }
          console.log('✅ Global settings migrated to streamers.');
        }
        await db.execute('DROP TABLE settings');
        console.log('🗑️ Legacy settings table removed.');
      }
    } catch (e) {
      console.warn('⚠️ Settings migration failed or not needed:', e.message);
    }

    // M1 — Encrypt any plaintext Streamlabs OAuth tokens already in DB
    try {
      const tokRows = await db.execute("SELECT twitch_id, streamlabs_access_token, streamlabs_refresh_token FROM streamers WHERE streamlabs_access_token IS NOT NULL OR streamlabs_refresh_token IS NOT NULL");
      let encCount = 0;
      const isEnc = (t) => t && typeof t === 'string' && t.split(':').length === 3 && t.split(':').every(p => p.length > 8);
      for (const row of tokRows.rows) {
        const sets = [];
        const args = [];
        if (row.streamlabs_access_token && !isEnc(row.streamlabs_access_token)) {
          try { sets.push('streamlabs_access_token = ?'); args.push(encrypt(row.streamlabs_access_token)); } catch (e) {}
        }
        if (row.streamlabs_refresh_token && !isEnc(row.streamlabs_refresh_token)) {
          try { sets.push('streamlabs_refresh_token = ?'); args.push(encrypt(row.streamlabs_refresh_token)); } catch (e) {}
        }
        if (sets.length > 0) {
          args.push(row.twitch_id);
          await db.execute({ sql: `UPDATE streamers SET ${sets.join(', ')} WHERE twitch_id = ?`, args });
          encCount++;
        }
      }
      if (encCount > 0) console.log(`🔐 Encrypted Streamlabs tokens for ${encCount} streamer(s) at rest.`);
    } catch (e) {
      console.warn('⚠️ Streamlabs token encryption migration skipped:', e.message);
    }

    // M2 — Bump ttsRate 1.0 → 1.3 (display offset baseline change)
    try {
      const r = await db.execute({ sql: 'UPDATE streamers SET ttsRate = 1.3 WHERE ttsRate = 1.0 OR ttsRate IS NULL' });
      if (r.rowsAffected > 0) console.log(`🔊 ttsRate bumped to 1.3 for ${r.rowsAffected} streamer(s).`);
    } catch (e) {
      console.warn('⚠️ ttsRate migration skipped:', e.message);
    }

    // [Requirement #9] Backfill leaderboard_alltime once — guarded by row count, no-op on every subsequent deploy
    try {
      const cnt = await db.execute('SELECT COUNT(*) as c FROM leaderboard_alltime');
      if ((cnt.rows[0]?.c || 0) === 0) await backfillLeaderboardAlltime();
    } catch (e) {
      console.warn('⚠️ leaderboard_alltime backfill skipped:', e.message);
    }

    console.log('✅ Turso Database schema verified and migrated.');
  } catch (err) {
    console.error('💥 Migration failed:', err);
    throw err;
  }
}

/**
 * Wait until database initialization finishes.
 */
async function ensureConnected() {
  if (!isInitialized) {
    if (initPromise) {
      await initPromise;
    } else {
      await initDB();
    }
  }
}

/**
 * Fallback to in-memory storage.
 */
function useInMemoryFallback(reason) {
  isFallback = true;
  isInitialized = true;
  console.log(`💡 Switched to In-Memory Fallback storage. Reason: ${reason}`);

  const DB_DIR = path.join(__dirname, '../data');
  const filesToTryTx = [
    path.join(DB_DIR, 'transactions.json'),
    path.join(DB_DIR, 'transactions.json.bak')
  ];
  const filesToTrySettings = [
    path.join(DB_DIR, 'overlay-settings.json'),
    path.join(DB_DIR, 'overlay-settings.json.bak')
  ];

  for (const file of filesToTryTx) {
    try {
      if (fs.existsSync(file)) {
        memoryTransactions = JSON.parse(fs.readFileSync(file, 'utf8'));
        console.log(`📦 Loaded ${memoryTransactions.length} transactions into memory from ${path.basename(file)}`);
        break;
      }
    } catch (e) {}
  }

  for (const file of filesToTrySettings) {
    try {
      if (fs.existsSync(file)) {
        memorySettings = JSON.parse(fs.readFileSync(file, 'utf8'));
        console.log(`📦 Loaded settings into memory from ${path.basename(file)}`);
        break;
      }
    } catch (e) {}
  }
}

/**
 * Fetch transactions ordered by creation date descending.
 */
async function getTransactions(username = null) {
  await ensureConnected();
  if (isFallback) {
    let txs = [...memoryTransactions];
    if (username) {
      txs = txs.filter(t => t.streamer_username === username);
    }
    return txs.sort((a, b) => new Date(b.createdAt || b.created_at) - new Date(a.createdAt || a.created_at));
  }
  if (!db) return [];
  
  let sql = 'SELECT * FROM transactions';
  let args = [];
  
  if (username) {
    sql += ' WHERE LOWER(streamer_username) = LOWER(?)';
    args.push(username);
  }
  
  sql += ' ORDER BY createdAt DESC';
  
  const result = await db.execute({ sql, args });
  return result.rows.map(row => {
    let rawResponse = null;
    let rawWebhook = null;
    try {
      if (row.raw_response) rawResponse = JSON.parse(row.raw_response);
    } catch (e) { console.error(`Failed to parse raw_response for tx ${row.id}:`, e); }
    try {
      if (row.raw_webhook) rawWebhook = JSON.parse(row.raw_webhook);
    } catch (e) { console.error(`Failed to parse raw_webhook for tx ${row.id}:`, e); }
    return {
      ...row,
      raw_response: rawResponse,
      raw_webhook: rawWebhook
    };
  });
}

/**
 * Find a transaction by ID.
 */
async function getTransactionById(id) {
  await ensureConnected();
  if (isFallback) {
    return memoryTransactions.find(t => t.id === id) || null;
  }
  if (!db) return null;
  const result = await db.execute({
    sql: 'SELECT * FROM transactions WHERE id = ?',
    args: [id]
  });
  const row = result.rows[0];
  if (!row) return null;
  
  let rawResponse = null;
  let rawWebhook = null;
  try {
    if (row.raw_response) rawResponse = JSON.parse(row.raw_response);
  } catch (e) { console.error(`Failed to parse raw_response for tx ${row.id}:`, e); }
  try {
    if (row.raw_webhook) rawWebhook = JSON.parse(row.raw_webhook);
  } catch (e) { console.error(`Failed to parse raw_webhook for tx ${row.id}:`, e); }

  return {
    ...row,
    raw_response: rawResponse,
    raw_webhook: rawWebhook
  };
}

/**
 * Merge and save/update a transaction.
 */
async function saveTransaction(data) {

  await ensureConnected();
  if (isFallback) {
    const existingIndex = memoryTransactions.findIndex(t => t.id === data.id);
    const now = new Date().toISOString();
    let updatedTx;

    if (existingIndex >= 0) {
      updatedTx = {
        ...memoryTransactions[existingIndex],
        ...data,
        updatedAt: now
      };
      memoryTransactions[existingIndex] = updatedTx;
    } else {
      updatedTx = {
        id: data.id,
        streamer_username: data.streamer_username,
        donor: data.donor || data.donor_name || 'Anonymous',
        amount: data.amount || 0,
        message: data.message || '',
        createdAt: data.createdAt || data.created_at || now,
        timer_action: data.timer_action ?? null
      };

      memoryTransactions.push(updatedTx);
    }
  
    try {
      const DB_DIR = path.join(__dirname, '../data');
      fs.writeFileSync(path.join(DB_DIR, 'transactions.json'), JSON.stringify(memoryTransactions, null, 2));
    } catch (e) {}
  
    return updatedTx;
  }

  if (!db) throw new Error('Database not initialized');

  if (data.id) {
    try {
      const existing = await db.execute({
        sql: 'SELECT streamer_username, amount, donor, message, payment_method, timer_action FROM transactions WHERE id = ?',
        args: [data.id]
      });
      if (existing.rows[0]) {
        const ex = existing.rows[0];
        if (!data.streamer_username) data.streamer_username = ex.streamer_username;
        if (data.amount === undefined) data.amount = ex.amount;
        if (data.donor === undefined) data.donor = ex.donor;
        if (data.message === undefined) data.message = ex.message;
        if (data.payment_method === undefined) data.payment_method = ex.payment_method;
        if (data.timer_action === undefined) data.timer_action = ex.timer_action;
      }
    } catch (e) {}
  }

  const now = new Date().toISOString();
  const rawResponse = data.raw_response ? (typeof data.raw_response === 'string' ? data.raw_response : JSON.stringify(data.raw_response)) : null;
  const rawWebhook = data.raw_webhook ? (typeof data.raw_webhook === 'string' ? data.raw_webhook : JSON.stringify(data.raw_webhook)) : null;

  await db.execute({
    sql: `INSERT INTO transactions (id, amount, donor, message, status, paymentUrl, raw_response, raw_webhook, createdAt, updatedAt, paidAt, streamer_username, payment_method, promptpay_slip_id, promptpay_verified, promptpay_verified_at, timer_action, tier_level, tier_image_url, tier_sound_url, tier_sound_is_temp, tier_sound_youtube_id, tier_sound_youtube_start, tier_sound_youtube_end)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            amount = COALESCE(excluded.amount, transactions.amount),
            donor = COALESCE(excluded.donor, transactions.donor),
            message = COALESCE(excluded.message, transactions.message),
            status = excluded.status,
            paymentUrl = excluded.paymentUrl,
            raw_response = excluded.raw_response,
            raw_webhook = excluded.raw_webhook,
            updatedAt = excluded.updatedAt,
            paidAt = excluded.paidAt,
            streamer_username = COALESCE(excluded.streamer_username, transactions.streamer_username),
            payment_method = COALESCE(excluded.payment_method, transactions.payment_method),
            promptpay_slip_id = excluded.promptpay_slip_id,
            promptpay_verified = excluded.promptpay_verified,
            promptpay_verified_at = excluded.promptpay_verified_at,
            timer_action = COALESCE(excluded.timer_action, transactions.timer_action),
            tier_level = COALESCE(excluded.tier_level, transactions.tier_level),
            tier_image_url = COALESCE(excluded.tier_image_url, transactions.tier_image_url),
            tier_sound_url = COALESCE(excluded.tier_sound_url, transactions.tier_sound_url),
            tier_sound_is_temp = COALESCE(excluded.tier_sound_is_temp, transactions.tier_sound_is_temp),
            tier_sound_youtube_id = COALESCE(excluded.tier_sound_youtube_id, transactions.tier_sound_youtube_id),
            tier_sound_youtube_start = COALESCE(excluded.tier_sound_youtube_start, transactions.tier_sound_youtube_start),
            tier_sound_youtube_end = COALESCE(excluded.tier_sound_youtube_end, transactions.tier_sound_youtube_end)`,
    args: [
      data.id,
      data.amount || 0,
      data.donor || data.donor_name || 'Anonymous',
      data.message || '',
      data.status || 'pending',
      data.paymentUrl || null,
      rawResponse,
      rawWebhook,
      data.createdAt || now,
      now,
      data.paidAt || null,
      data.streamer_username || null,
      data.payment_method || 'ffp',
      data.promptpay_slip_id || null,
      data.promptpay_verified !== undefined ? (data.promptpay_verified ? 1 : 0) : 0,
      data.promptpay_verified_at || null,
      data.timer_action ?? null,
      data.tier_level ?? null,
      data.tier_image_url ?? null,
      data.tier_sound_url ?? null,
      data.tier_sound_is_temp !== undefined ? (data.tier_sound_is_temp ? 1 : 0) : 0,
      data.tier_sound_youtube_id ?? null,
      data.tier_sound_youtube_start ?? null,
      data.tier_sound_youtube_end ?? null
    ]
  });
  
  return data;
}

// Atomically confirm a transaction (pending -> successful) exactly once.
// New id: inserts a successful row. Existing pending: flips to successful. Already successful: no-op.
// Returns { rowsAffected } — 1 when this call performed the confirm, 0 when another path already did.
// Callers use rowsAffected to gate one-time side-effects (goal/alert/timer). See server confirmDonationSideEffects.
async function confirmTransactionPaid(data) {
  await ensureConnected();
  const now = new Date().toISOString();

  if (isFallback) {
    const idx = memoryTransactions.findIndex(t => t.id === data.id);
    if (idx >= 0) {
      if (!['pending', 'failed'].includes(memoryTransactions[idx].status)) return { rowsAffected: 0 };
      memoryTransactions[idx] = { ...memoryTransactions[idx], ...data, status: 'successful', paidAt: data.paidAt || now, updatedAt: now };
    } else {
      memoryTransactions.push({ id: data.id, status: 'successful', paidAt: data.paidAt || now, createdAt: now, updatedAt: now, donor: data.donor || 'Anonymous', amount: data.amount || 0, message: data.message || '', streamer_username: data.streamer_username || null, payment_method: data.payment_method || 'ffp', timer_action: data.timer_action ?? null });
    }
    try {
      const DB_DIR = path.join(__dirname, '../data');
      fs.writeFileSync(path.join(DB_DIR, 'transactions.json'), JSON.stringify(memoryTransactions, null, 2));
    } catch (e) {}
    return { rowsAffected: 1 };
  }

  if (!db) throw new Error('Database not initialized');

  // Backfill NOT NULL columns (streamer_username, amount) from the existing pending row.
  // SQLite validates NOT NULL on the INSERT arm of an upsert BEFORE resolving ON CONFLICT DO UPDATE,
  // so a partial confirm ({id, amount?, paidAt}) would otherwise throw. Mirrors saveTransaction backfill.
  if (data.id) {
    try {
      const existing = await db.execute({
        sql: 'SELECT streamer_username, amount, donor, message, payment_method, timer_action FROM transactions WHERE id = ?',
        args: [data.id]
      });
      if (existing.rows[0]) {
        const ex = existing.rows[0];
        if (data.streamer_username == null) data.streamer_username = ex.streamer_username;
        if (data.amount == null) data.amount = ex.amount;
        if (data.donor == null) data.donor = ex.donor;
        if (data.message == null) data.message = ex.message;
        if (data.payment_method == null) data.payment_method = ex.payment_method;
        if (data.timer_action === undefined) data.timer_action = ex.timer_action;
      }
    } catch (e) {}
  }

  const rawWebhook = data.raw_webhook ? (typeof data.raw_webhook === 'string' ? data.raw_webhook : JSON.stringify(data.raw_webhook)) : null;
  const result = await db.execute({
    sql: `INSERT INTO transactions (id, amount, donor, message, status, raw_webhook, createdAt, updatedAt, paidAt, streamer_username, payment_method, promptpay_slip_id, promptpay_verified, promptpay_verified_at, timer_action)
          VALUES (?, ?, ?, ?, 'successful', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = 'successful',
            paidAt = excluded.paidAt,
            updatedAt = excluded.updatedAt,
            amount = COALESCE(excluded.amount, transactions.amount),
            raw_webhook = COALESCE(excluded.raw_webhook, transactions.raw_webhook),
            streamer_username = COALESCE(excluded.streamer_username, transactions.streamer_username),
            promptpay_slip_id = COALESCE(excluded.promptpay_slip_id, transactions.promptpay_slip_id),
            promptpay_verified = COALESCE(excluded.promptpay_verified, transactions.promptpay_verified),
            promptpay_verified_at = COALESCE(excluded.promptpay_verified_at, transactions.promptpay_verified_at)
          WHERE transactions.status IN ('pending', 'failed')`,
    args: [
      data.id,
      data.amount != null ? data.amount : null,
      data.donor || 'Anonymous',
      data.message || '',
      rawWebhook,
      now,
      now,
      data.paidAt || now,
      data.streamer_username || null,
      data.payment_method || 'ffp',
      data.promptpay_slip_id || null,
      data.promptpay_verified !== undefined ? (data.promptpay_verified ? 1 : 0) : null,
      data.promptpay_verified_at || null,
      data.timer_action ?? null
    ]
  });
  return { rowsAffected: result.rowsAffected || 0 };
}

async function getStreamerByToken(token) {
  await ensureConnected();
  if (isFallback) return null;
  if (!db) return null;
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM streamers WHERE overlay_token = ?',
      args: [token]
    });
    return result.rows[0] ?? null;
  } catch (err) {
    console.error('❌ getStreamerByToken failed:', err.message);
    return null;
  }
}

async function getStreamerByTwitchId(twitchId) {
  if (!twitchId) return null;
  await ensureConnected();
  if (isFallback) return null;
  if (!db) return null;
  const result = await db.execute({
    sql: 'SELECT * FROM streamers WHERE twitch_id = ?',
    args: [twitchId]
  });
  return result.rows[0] || null;
}

async function getStreamerByStreamlabsId(streamlabsId) {
  if (!streamlabsId) return null;
  await ensureConnected();
  if (isFallback) return null;
  if (!db) return null;
  const result = await db.execute({
    sql: 'SELECT * FROM streamers WHERE streamlabs_id = ?',
    args: [streamlabsId]
  });
  return result.rows[0] || null;
}

async function getStreamerById(userId) {
  if (!userId) return null;
  const byTwitch = await getStreamerByTwitchId(userId);
  if (byTwitch) return byTwitch;
  return await getStreamerByStreamlabsId(userId);
}

/**
 * Fetch streamer details by username.

 */
async function getStreamer(username) {
  if (!username) return null;
  await ensureConnected();
  if (isFallback) {
    // If we have memorySettings, we might find the user there, 
    // but usually streamers are the core users. 
    // In current fallback, we don't have a memoryStreamers list.
    // Let's implement a basic fallback for streamers if needed or return null.
    return null; 
  }
  if (!db) return null;
  const result = await db.execute({
    sql: 'SELECT * FROM streamers WHERE LOWER(username) = LOWER(?)',
    args: [username]
  });
  return result.rows[0] || null;
}

async function getDecryptedStreamer(username) {
  const streamer = await getStreamer(username);
  return streamer;
}

const PAYMENT_ENCRYPT_FIELDS = [
  'promptpay_value', 'slipok_api', 'slipok_api_key',
  'truemoney_phone', 'truemoney_slipok_api', 'truemoney_slipok_api_key',
  'truemoney_webhook_secret', 'truemoney_promptpay_id',
  'bank_account_number'
];

function isEncrypted(text) {
  if (!text) return false;
  const parts = text.split(':');
  return parts.length === 3 && parts.every(p => p.length > 8);
}

/**
 * Migrate legacy timer_settings keys inside a JSON blob.
 * Currently maps the renamed shane_enabled -> shine_enabled so existing
 * streamer configs keep their original shine toggle state.
 * Accepts and returns a JSON string (or undefined/null as-is).
 */
function migrateTimerSettings(timerSettings) {
  if (!timerSettings) return timerSettings;
  let parsed;
  try {
    parsed = typeof timerSettings === 'string' ? JSON.parse(timerSettings) : { ...timerSettings };
  } catch {
    return timerSettings;
  }
  if (parsed && typeof parsed === 'object' && 'shane_enabled' in parsed) {
    parsed.shine_enabled = parsed.shane_enabled;
    delete parsed.shane_enabled;
  }
  return JSON.stringify(parsed);
}

/**
 * Save or update streamer details.
 */
async function saveStreamer(data) {
  await ensureConnected();
  if (isFallback) {
    console.warn('⚠️ saveStreamer called in Fallback mode. Data is not persisted.');
    return data;
  }
  if (!db) throw new Error('Database not initialized');
  
   const existing = await getStreamerByTwitchId(data.twitch_id)
     || await getStreamerByStreamlabsId(data.streamlabs_id)
     || await getStreamerByStreamlabsId(data.twitch_id)
     || (data.username ? await getStreamer(data.username) : null);
   const overlayToken = data.overlay_token || (existing ? existing.overlay_token : require('crypto').randomBytes(16).toString('hex'));
  
   // Encrypt sensitive payment fields BEFORE building finalData.
   // Values containing '*' are censor placeholders from the dashboard
   // (e.g. "081****89" for truemoney_phone). Delete them so the spread
   // into finalData doesn't overwrite the real DB value with a masked string.
   for (const field of PAYMENT_ENCRYPT_FIELDS) {
     if (data[field]?.length && data[field].includes('*')) {
       delete data[field];
     } else if (data[field]?.length && !isEncrypted(data[field])) {
       try { data[`${field}_encrypted`] = encrypt(data[field]); }
       catch (e) { console.warn(`Failed to encrypt ${field}:`, e.message); }
     }
   }
   // In-place encrypt — overwrite same column (no _encrypted suffix).
   // Same '*' guard: delete masked placeholders so they don't overwrite
   // the real encrypted value stored in the same-named DB column.
   for (const field of ['streamlabs_access_token', 'streamlabs_refresh_token', 'bank_account_name']) {
     if (data[field]?.length && data[field].includes('*')) {
       delete data[field];
     } else if (data[field]?.length && !isEncrypted(data[field])) {
       try { data[field] = encrypt(data[field]); }
       catch (e) { console.warn(`Failed to encrypt ${field}:`, e.message); }
     }
   }

   const finalData = {
     ...existing,
     ...data,
     overlay_token: overlayToken
   };

  // Migrate legacy timer JSON keys before persistence so renamed fields
  // (e.g. shane_enabled -> shine_enabled) keep their original values.
  if (finalData.timer_settings !== undefined) {
    finalData.timer_settings = migrateTimerSettings(finalData.timer_settings);
  }

  let savedId;
  if (existing) {
      savedId = existing.id;
      await db.execute({
        sql: `UPDATE streamers SET
               twitch_id = COALESCE(?, streamers.twitch_id),
               streamlabs_id = COALESCE(?, streamers.streamlabs_id),
               streamlabs_username = COALESCE(?, streamers.streamlabs_username),
               discord_webhook_url = COALESCE(?, streamers.discord_webhook_url),
              overlay_token = ?,
              is_active = COALESCE(?, streamers.is_active),
              duration = COALESCE(?, streamers.duration),
              soundEnabled = COALESCE(?, streamers.soundEnabled),
              soundChoice = COALESCE(?, streamers.soundChoice),
              soundVolume = COALESCE(?, streamers.soundVolume),
              ttsEnabled = COALESCE(?, streamers.ttsEnabled),
              ttsReadDonor = COALESCE(?, streamers.ttsReadDonor),
              ttsVolume = COALESCE(?, streamers.ttsVolume),
              ttsRate = COALESCE(?, streamers.ttsRate),
              ttsLanguage = COALESCE(?, streamers.ttsLanguage),
              ttsVoice = COALESCE(?, streamers.ttsVoice),
              ttsPrefixEnabled = COALESCE(?, streamers.ttsPrefixEnabled),
              profanityFilterEnabled = COALESCE(?, streamers.profanityFilterEnabled),
              profanityWords = COALESCE(?, streamers.profanityWords),
              profanityReplaceStyle = COALESCE(?, streamers.profanityReplaceStyle),
              messageTemplate = COALESCE(?, streamers.messageTemplate),
              amountSuffix = COALESCE(?, streamers.amountSuffix),
              showLabel = COALESCE(?, streamers.showLabel),
              showDonorMessage = COALESCE(?, streamers.showDonorMessage),
              minAmount = COALESCE(?, streamers.minAmount),
              theme = COALESCE(?, streamers.theme),
              animation = COALESCE(?, streamers.animation),
              fontFamily = COALESCE(?, streamers.fontFamily),
              primaryColor = COALESCE(?, streamers.primaryColor),
              secondaryColor = COALESCE(?, streamers.secondaryColor),
              backgroundColor = COALESCE(?, streamers.backgroundColor),
              textColor = COALESCE(?, streamers.textColor),
              borderColor = COALESCE(?, streamers.borderColor),
              theme_colors = COALESCE(?, streamers.theme_colors),
              alert_font_sizes = COALESCE(?, streamers.alert_font_sizes),
              alert_outline = COALESCE(?, streamers.alert_outline),
              template_line1 = COALESCE(?, streamers.template_line1),
              template_line2 = COALESCE(?, streamers.template_line2),
              particleCount = COALESCE(?, streamers.particleCount),
              fontSize = COALESCE(?, streamers.fontSize),
              customImageMode = COALESCE(?, streamers.customImageMode),
              customImageValue = COALESCE(?, streamers.customImageValue),
              customSoundUrl = COALESCE(?, streamers.customSoundUrl),
              alert_sound_url = COALESCE(?, streamers.alert_sound_url),
              page_title = COALESCE(?, streamers.page_title),
              page_subtitle = COALESCE(?, streamers.page_subtitle),
              thank_you_header = COALESCE(?, streamers.thank_you_header),
              thank_you_subtitle = COALESCE(?, streamers.thank_you_subtitle),
              social_twitch = COALESCE(?, streamers.social_twitch),
              social_youtube = COALESCE(?, streamers.social_youtube),
              social_tiktok = COALESCE(?, streamers.social_tiktok),
              social_facebook = COALESCE(?, streamers.social_facebook),
              social_x = COALESCE(?, streamers.social_x),
              social_discord = COALESCE(?, streamers.social_discord),
               social_instagram = COALESCE(?, streamers.social_instagram),
               streamlabs_access_token = COALESCE(?, streamers.streamlabs_access_token),
               streamlabs_refresh_token = COALESCE(?, streamers.streamlabs_refresh_token),
                profile_image_source = COALESCE(?, streamers.profile_image_source),
               profile_image_value = COALESCE(?, streamers.profile_image_value),
               profile_glow_color = COALESCE(?, streamers.profile_glow_color),
               payment_method = COALESCE(?, streamers.payment_method),
               promptpay_phone = COALESCE(?, streamers.promptpay_phone),
               promptpay_name = COALESCE(?, streamers.promptpay_name),
               promptpay_enabled = COALESCE(?, streamers.promptpay_enabled),
               tfp_api_key = COALESCE(?, streamers.tfp_api_key),
               tfp_api_secret = COALESCE(?, streamers.tfp_api_secret),
               tfp_connected = COALESCE(?, streamers.tfp_connected),
               tfp_last_check = COALESCE(?, streamers.tfp_last_check),
               promptpay_type = COALESCE(?, streamers.promptpay_type),
               promptpay_value_encrypted = COALESCE(?, streamers.promptpay_value_encrypted),
               slipok_api_encrypted = COALESCE(?, streamers.slipok_api_encrypted),
               slipok_api_key_encrypted = COALESCE(?, streamers.slipok_api_key_encrypted),
               slipok_connected = COALESCE(?, streamers.slipok_connected),
               slipok_last_check = COALESCE(?, streamers.slipok_last_check),
               promptpay_account_verified = COALESCE(?, streamers.promptpay_account_verified),
               promptpay_account_verified_at = COALESCE(?, streamers.promptpay_account_verified_at),
               truemoney_enabled = COALESCE(?, streamers.truemoney_enabled),
               truemoney_phone_encrypted = COALESCE(?, streamers.truemoney_phone_encrypted),
               truemoney_slipok_api_encrypted = COALESCE(?, streamers.truemoney_slipok_api_encrypted),
               truemoney_slipok_api_key_encrypted = COALESCE(?, streamers.truemoney_slipok_api_key_encrypted),
               truemoney_slipok_connected = COALESCE(?, streamers.truemoney_slipok_connected),
               truemoney_slipok_last_check = COALESCE(?, streamers.truemoney_slipok_last_check),
               truemoney_account_verified = COALESCE(?, streamers.truemoney_account_verified),
               truemoney_account_verified_at = COALESCE(?, streamers.truemoney_account_verified_at),
               slipok_quota_total = COALESCE(?, streamers.slipok_quota_total),
               truemoney_slipok_quota_total = COALESCE(?, streamers.truemoney_slipok_quota_total),
               bank_enabled = COALESCE(?, streamers.bank_enabled),
               bank_name = COALESCE(?, streamers.bank_name),
               bank_account_number_encrypted = COALESCE(?, streamers.bank_account_number_encrypted),
               bank_account_name = COALESCE(?, streamers.bank_account_name),
               bank_account_verified = COALESCE(?, streamers.bank_account_verified),
               bank_account_verified_at = COALESCE(?, streamers.bank_account_verified_at),
               header_bg_url = COALESCE(?, streamers.header_bg_url),
               page_bg_url = COALESCE(?, streamers.page_bg_url),
               header_bg_y = COALESCE(?, streamers.header_bg_y),
               header_bg_zoom = COALESCE(?, streamers.header_bg_zoom),
               goal_enabled = COALESCE(?, streamers.goal_enabled),
               goal_amount = COALESCE(?, streamers.goal_amount),
               goal_current = COALESCE(?, streamers.goal_current),
               goal_label = COALESCE(?, streamers.goal_label),
               goal_bar_color = COALESCE(?, streamers.goal_bar_color),
               goal_show_on_donate = COALESCE(?, streamers.goal_show_on_donate),
               goal_end_date = COALESCE(?, streamers.goal_end_date),
               goal_bar_text = COALESCE(?, streamers.goal_bar_text),
               goal_subtitle1 = COALESCE(?, streamers.goal_subtitle1),
               goal_subtitle2 = COALESCE(?, streamers.goal_subtitle2),
               goal_anim_sound = COALESCE(?, streamers.goal_anim_sound),
               goal_anim_enabled = COALESCE(?, streamers.goal_anim_enabled),
               goal_anim_sound_volume = COALESCE(?, streamers.goal_anim_sound_volume),
               goal_bar_position = COALESCE(?, streamers.goal_bar_position),
               goal_bar_width = COALESCE(?, streamers.goal_bar_width),
               goal_bar_layout = COALESCE(?, streamers.goal_bar_layout),
               goal_bar_thickness = COALESCE(?, streamers.goal_bar_thickness),
               goal_bar_width_auto = COALESCE(?, streamers.goal_bar_width_auto),
               goal_pointer_enabled = COALESCE(?, streamers.goal_pointer_enabled),
               goal_pointer_side = COALESCE(?, streamers.goal_pointer_side),
               goal_pointer_content = COALESCE(?, streamers.goal_pointer_content),
               tos_accepted_at = COALESCE(?, streamers.tos_accepted_at),
               primary_auth_provider = COALESCE(?, streamers.primary_auth_provider),
               timer_settings = COALESCE(?, streamers.timer_settings),
               truemoney_webhook_secret_encrypted = COALESCE(?, streamers.truemoney_webhook_secret_encrypted),
               truemoney_webhook_enabled = COALESCE(?, streamers.truemoney_webhook_enabled),
               truemoney_webhook_kyc_confirmed = COALESCE(?, streamers.truemoney_webhook_kyc_confirmed),
               truemoney_webhook_expiry = COALESCE(?, streamers.truemoney_webhook_expiry),
               truemoney_webhook_methods = COALESCE(?, streamers.truemoney_webhook_methods),
               truemoney_promptpay_id_encrypted = COALESCE(?, streamers.truemoney_promptpay_id_encrypted),
               badges = COALESCE(?, streamers.badges),
               badge_display = COALESCE(?, streamers.badge_display),
               leaderboard_settings = COALESCE(?, streamers.leaderboard_settings),
               recentdonate_settings = COALESCE(?, streamers.recentdonate_settings),
               goal_text_settings = COALESCE(?, streamers.goal_text_settings),
               tier_donate_settings = COALESCE(?, streamers.tier_donate_settings),
               sound_library = COALESCE(?, streamers.sound_library)
               WHERE id = ?`,
       args: [
         finalData.twitch_id || null,
         finalData.streamlabs_id || null,
         finalData.streamlabs_username || null,
         finalData.discord_webhook_url || null,
          overlayToken || null,
          finalData.is_active !== undefined ? (finalData.is_active ? 1 : 0) : null,
          finalData.duration !== undefined ? finalData.duration : null,
          finalData.soundEnabled !== undefined ? (finalData.soundEnabled ? 1 : 0) : null,
          finalData.soundChoice !== undefined ? finalData.soundChoice : null,
          finalData.soundVolume !== undefined ? finalData.soundVolume : null,
          finalData.ttsEnabled !== undefined ? (finalData.ttsEnabled ? 1 : 0) : null,
          finalData.ttsReadDonor !== undefined ? (finalData.ttsReadDonor ? 1 : 0) : null,
          finalData.ttsVolume !== undefined ? finalData.ttsVolume : null,
          finalData.ttsRate !== undefined ? finalData.ttsRate : null,
          finalData.ttsLanguage !== undefined ? finalData.ttsLanguage : null,
          finalData.ttsVoice !== undefined ? finalData.ttsVoice : null,
          finalData.ttsPrefixEnabled !== undefined ? (finalData.ttsPrefixEnabled ? 1 : 0) : null,
          finalData.profanityFilterEnabled !== undefined ? (finalData.profanityFilterEnabled ? 1 : 0) : null,
          finalData.profanityWords !== undefined ? finalData.profanityWords : null,
          finalData.profanityReplaceStyle !== undefined ? finalData.profanityReplaceStyle : null,
          finalData.messageTemplate !== undefined ? finalData.messageTemplate : null,
          finalData.amountSuffix !== undefined ? finalData.amountSuffix : null,
          finalData.showLabel !== undefined ? (finalData.showLabel ? 1 : 0) : null,
          finalData.showDonorMessage !== undefined ? (finalData.showDonorMessage ? 1 : 0) : null,
          finalData.minAmount !== undefined ? finalData.minAmount : null,
          finalData.theme !== undefined ? finalData.theme : null,
          finalData.animation !== undefined ? finalData.animation : null,
          finalData.fontFamily !== undefined ? finalData.fontFamily : null,
          finalData.primaryColor !== undefined ? finalData.primaryColor : null,
          finalData.secondaryColor !== undefined ? finalData.secondaryColor : null,
          finalData.backgroundColor !== undefined ? finalData.backgroundColor : null,
          finalData.textColor !== undefined ? finalData.textColor : null,
          finalData.borderColor !== undefined ? finalData.borderColor : null,
          finalData.theme_colors !== undefined ? finalData.theme_colors : null,
          finalData.alert_font_sizes !== undefined ? finalData.alert_font_sizes : null,
          finalData.alert_outline !== undefined ? finalData.alert_outline : null,
          finalData.template_line1 !== undefined ? finalData.template_line1 : null,
          finalData.template_line2 !== undefined ? finalData.template_line2 : null,
          finalData.particleCount !== undefined ? finalData.particleCount : null,
          finalData.fontSize !== undefined ? finalData.fontSize : null,
          finalData.customImageMode !== undefined ? finalData.customImageMode : null,
          finalData.customImageValue !== undefined ? finalData.customImageValue : null,
          finalData.customSoundUrl !== undefined ? finalData.customSoundUrl : null,
          finalData.alert_sound_url !== undefined ? finalData.alert_sound_url : null,
          finalData.page_title !== undefined ? finalData.page_title : null,
          finalData.page_subtitle !== undefined ? finalData.page_subtitle : null,
          finalData.thank_you_header !== undefined ? finalData.thank_you_header : null,
          finalData.thank_you_subtitle !== undefined ? finalData.thank_you_subtitle : null,
          finalData.social_twitch !== undefined ? finalData.social_twitch : null,
          finalData.social_youtube !== undefined ? finalData.social_youtube : null,
          finalData.social_tiktok !== undefined ? finalData.social_tiktok : null,
          finalData.social_facebook !== undefined ? finalData.social_facebook : null,
          finalData.social_x !== undefined ? finalData.social_x : null,
          finalData.social_discord !== undefined ? finalData.social_discord : null,
           finalData.social_instagram !== undefined ? finalData.social_instagram : null,
           finalData.streamlabs_access_token !== undefined ? finalData.streamlabs_access_token : null,
           finalData.streamlabs_refresh_token !== undefined ? finalData.streamlabs_refresh_token : null,
           finalData.profile_image_source !== undefined ? finalData.profile_image_source : null,
          finalData.profile_image_value !== undefined ? finalData.profile_image_value : null,
          finalData.profile_glow_color !== undefined ? finalData.profile_glow_color : null,
          finalData.payment_method !== undefined ? finalData.payment_method : null,
          finalData.promptpay_phone !== undefined ? finalData.promptpay_phone : null,
          finalData.promptpay_name !== undefined ? finalData.promptpay_name : null,
          finalData.promptpay_enabled !== undefined ? (finalData.promptpay_enabled ? 1 : 0) : null,
          finalData.tfp_api_key !== undefined ? finalData.tfp_api_key : null,
          finalData.tfp_api_secret !== undefined ? finalData.tfp_api_secret : null,
          finalData.tfp_connected !== undefined ? (finalData.tfp_connected ? 1 : 0) : null,
          finalData.tfp_last_check !== undefined ? finalData.tfp_last_check : null,
          finalData.promptpay_type !== undefined ? finalData.promptpay_type : null,
          finalData.promptpay_value_encrypted !== undefined ? finalData.promptpay_value_encrypted : null,
          finalData.slipok_api_encrypted !== undefined ? finalData.slipok_api_encrypted : null,
          finalData.slipok_api_key_encrypted !== undefined ? finalData.slipok_api_key_encrypted : null,
          finalData.slipok_connected !== undefined ? (finalData.slipok_connected ? 1 : 0) : null,
          finalData.slipok_last_check !== undefined ? finalData.slipok_last_check : null,
          finalData.promptpay_account_verified !== undefined ? (finalData.promptpay_account_verified ? 1 : 0) : null,
          finalData.promptpay_account_verified_at !== undefined ? finalData.promptpay_account_verified_at : null,
          finalData.truemoney_enabled !== undefined ? (finalData.truemoney_enabled ? 1 : 0) : null,
          finalData.truemoney_phone_encrypted !== undefined ? finalData.truemoney_phone_encrypted : null,
          finalData.truemoney_slipok_api_encrypted !== undefined ? finalData.truemoney_slipok_api_encrypted : null,
          finalData.truemoney_slipok_api_key_encrypted !== undefined ? finalData.truemoney_slipok_api_key_encrypted : null,
          finalData.truemoney_slipok_connected !== undefined ? (finalData.truemoney_slipok_connected ? 1 : 0) : null,
          finalData.truemoney_slipok_last_check !== undefined ? finalData.truemoney_slipok_last_check : null,
          finalData.truemoney_account_verified !== undefined ? (finalData.truemoney_account_verified ? 1 : 0) : null,
          finalData.truemoney_account_verified_at !== undefined ? finalData.truemoney_account_verified_at : null,
          finalData.slipok_quota_total !== undefined ? finalData.slipok_quota_total : null,
          finalData.truemoney_slipok_quota_total !== undefined ? finalData.truemoney_slipok_quota_total : null,
          finalData.bank_enabled !== undefined ? (finalData.bank_enabled ? 1 : 0) : null,
          finalData.bank_name || null,
          finalData.bank_account_number_encrypted || null,
          finalData.bank_account_name || null,
          finalData.bank_account_verified !== undefined ? (finalData.bank_account_verified ? 1 : 0) : null,
          finalData.bank_account_verified_at !== undefined ? finalData.bank_account_verified_at : null,
          finalData.header_bg_url !== undefined ? finalData.header_bg_url : null,
          finalData.page_bg_url !== undefined ? finalData.page_bg_url : null,
          finalData.header_bg_y !== undefined ? finalData.header_bg_y : null,
          finalData.header_bg_zoom !== undefined ? finalData.header_bg_zoom : null,
          finalData.goal_enabled !== undefined ? (finalData.goal_enabled ? 1 : 0) : null,
          finalData.goal_amount !== undefined ? finalData.goal_amount : null,
          finalData.goal_current !== undefined ? finalData.goal_current : null,
          finalData.goal_label !== undefined ? finalData.goal_label : null,
          finalData.goal_bar_color !== undefined ? finalData.goal_bar_color : null,
          finalData.goal_show_on_donate !== undefined ? (finalData.goal_show_on_donate ? 1 : 0) : null,
          finalData.goal_end_date !== undefined ? finalData.goal_end_date : null,
          finalData.goal_bar_text !== undefined ? finalData.goal_bar_text : null,
          finalData.goal_subtitle1 !== undefined ? finalData.goal_subtitle1 : null,
          finalData.goal_subtitle2 !== undefined ? finalData.goal_subtitle2 : null,
          finalData.goal_anim_sound !== undefined ? (finalData.goal_anim_sound ? 1 : 0) : null,
          finalData.goal_anim_enabled !== undefined ? (finalData.goal_anim_enabled ? 1 : 0) : null,
          finalData.goal_anim_sound_volume !== undefined ? finalData.goal_anim_sound_volume : null,
          finalData.goal_bar_position !== undefined ? finalData.goal_bar_position : null,
          finalData.goal_bar_width !== undefined ? finalData.goal_bar_width : null,
          finalData.goal_bar_layout !== undefined ? finalData.goal_bar_layout : null,
          finalData.goal_bar_thickness !== undefined ? finalData.goal_bar_thickness : null,
          finalData.goal_bar_width_auto !== undefined ? (finalData.goal_bar_width_auto ? 1 : 0) : null,
          finalData.goal_pointer_enabled !== undefined ? (finalData.goal_pointer_enabled ? 1 : 0) : null,
          finalData.goal_pointer_side !== undefined ? finalData.goal_pointer_side : null,
          finalData.goal_pointer_content !== undefined ? finalData.goal_pointer_content : null,
          finalData.tos_accepted_at !== undefined ? finalData.tos_accepted_at : null,
          finalData.primary_auth_provider !== undefined ? finalData.primary_auth_provider : null,
          finalData.timer_settings !== undefined ? finalData.timer_settings : null,
          finalData.truemoney_webhook_secret_encrypted !== undefined ? finalData.truemoney_webhook_secret_encrypted : null,
          finalData.truemoney_webhook_enabled !== undefined ? (finalData.truemoney_webhook_enabled ? 1 : 0) : null,
          finalData.truemoney_webhook_kyc_confirmed !== undefined ? (finalData.truemoney_webhook_kyc_confirmed ? 1 : 0) : null,
          finalData.truemoney_webhook_expiry !== undefined ? finalData.truemoney_webhook_expiry : null,
          finalData.truemoney_webhook_methods !== undefined ? finalData.truemoney_webhook_methods : null,
          finalData.truemoney_promptpay_id_encrypted !== undefined ? finalData.truemoney_promptpay_id_encrypted : null,
          finalData.badges !== undefined ? finalData.badges : null,
          finalData.badge_display !== undefined ? finalData.badge_display : null,
          finalData.leaderboard_settings !== undefined ? finalData.leaderboard_settings : null,
          finalData.recentdonate_settings !== undefined ? finalData.recentdonate_settings : null,
          finalData.goal_text_settings !== undefined ? finalData.goal_text_settings : null,
          finalData.tier_donate_settings !== undefined ? finalData.tier_donate_settings : null,
          finalData.sound_library !== undefined ? finalData.sound_library : null,
          existing.id
        ]
      });
  } else {
     const _insertResult = await db.execute({
       sql: `INSERT INTO streamers (twitch_id, streamlabs_id, streamlabs_username, username, discord_webhook_url, overlay_token, is_active, 
             duration, soundEnabled, soundChoice, soundVolume, ttsEnabled, ttsReadDonor, ttsVolume, ttsRate, ttsLanguage, ttsVoice, ttsPrefixEnabled,
             profanityFilterEnabled, profanityWords, profanityReplaceStyle, messageTemplate, amountSuffix, showLabel, showDonorMessage, minAmount, 
             theme, animation, fontFamily, primaryColor, secondaryColor, backgroundColor, textColor, borderColor, particleCount, fontSize,
             theme_colors, alert_font_sizes, alert_outline, template_line1, template_line2,
             customImageMode, customImageValue, customSoundUrl, alert_sound_url, page_title, page_subtitle, thank_you_header, thank_you_subtitle,
              social_twitch, social_youtube, social_tiktok, social_facebook, social_x, social_discord, social_instagram,
               streamlabs_access_token, streamlabs_refresh_token,
               profile_image_source, profile_image_value, profile_glow_color,
              payment_method, promptpay_phone, promptpay_name, promptpay_enabled, tfp_api_key, tfp_api_secret, tfp_connected, tfp_last_check,
              promptpay_type, promptpay_value_encrypted, slipok_api_encrypted, slipok_api_key_encrypted, slipok_connected, slipok_last_check,
              promptpay_account_verified, promptpay_account_verified_at,
              truemoney_enabled, truemoney_phone_encrypted, truemoney_slipok_api_encrypted, truemoney_slipok_api_key_encrypted, truemoney_slipok_connected, truemoney_slipok_last_check,
              truemoney_account_verified, truemoney_account_verified_at, slipok_quota_total, truemoney_slipok_quota_total,
              bank_enabled, bank_name, bank_account_number_encrypted, bank_account_name, bank_account_verified, bank_account_verified_at,
              header_bg_url, page_bg_url, header_bg_y, header_bg_zoom, goal_enabled, goal_amount, goal_current, goal_label, goal_bar_color, goal_show_on_donate, goal_end_date, goal_bar_text, goal_subtitle1, goal_subtitle2, goal_anim_sound, goal_anim_enabled, goal_anim_sound_volume, goal_bar_position, goal_bar_width, goal_bar_layout, goal_bar_thickness, goal_pointer_enabled, goal_pointer_side, goal_pointer_content, tos_accepted_at, primary_auth_provider, timer_settings,
              truemoney_webhook_secret_encrypted, truemoney_webhook_enabled, truemoney_webhook_kyc_confirmed, truemoney_webhook_expiry, truemoney_webhook_methods, truemoney_promptpay_id_encrypted, badges, badge_display, leaderboard_settings, recentdonate_settings, goal_text_settings, tier_donate_settings, sound_library, goal_bar_width_auto)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
       
       args: [
         finalData.twitch_id || null,
         finalData.streamlabs_id || null,
         finalData.streamlabs_username || null,
         finalData.username || null,
        finalData.discord_webhook_url || null,
        overlayToken || null,
        finalData.is_active !== undefined ? (finalData.is_active ? 1 : 0) : 1,
        finalData.duration !== undefined ? finalData.duration : 8,
        finalData.soundEnabled !== undefined ? (finalData.soundEnabled ? 1 : 0) : 1,
        finalData.soundChoice || 'chime',
        finalData.soundVolume !== undefined ? finalData.soundVolume : 0.5,
        finalData.ttsEnabled !== undefined ? (finalData.ttsEnabled ? 1 : 0) : 1,
        finalData.ttsReadDonor !== undefined ? (finalData.ttsReadDonor ? 1 : 0) : 1,
        finalData.ttsVolume !== undefined ? finalData.ttsVolume : 0.8,
        finalData.ttsRate !== undefined ? finalData.ttsRate : 1.3,
        finalData.ttsLanguage || 'th-TH',
        finalData.ttsVoice || null,
        finalData.ttsPrefixEnabled !== undefined ? (finalData.ttsPrefixEnabled ? 1 : 0) : 1,
        finalData.profanityFilterEnabled !== undefined ? (finalData.profanityFilterEnabled ? 1 : 0) : 1,
        finalData.profanityWords || null,
        finalData.profanityReplaceStyle || 'asterisks',
        finalData.messageTemplate || '{ผู้โดเนท} ได้บริจาค {amount} บาท! 🎉',
        finalData.amountSuffix || 'บาท',
        finalData.showLabel !== undefined ? (finalData.showLabel ? 1 : 0) : 0,
        finalData.showDonorMessage !== undefined ? (finalData.showDonorMessage ? 1 : 0) : 1,
        finalData.minAmount !== undefined ? finalData.minAmount : 1,
        finalData.theme || 'text-only',
        finalData.animation || 'slide-down',
        finalData.fontFamily || 'Noto Sans Thai',
        finalData.primaryColor || '#667eea',
        finalData.secondaryColor || '#764ba2',
        finalData.backgroundColor || 'rgba(15, 15, 25, 0.88)',
        finalData.textColor || '#ffffff',
        finalData.borderColor || 'rgba(255, 255, 255, 0.05)',
        finalData.particleCount !== undefined ? finalData.particleCount : 15,
        finalData.fontSize !== undefined ? finalData.fontSize : 48,
        finalData.theme_colors !== undefined ? finalData.theme_colors : null,
        finalData.alert_font_sizes !== undefined ? finalData.alert_font_sizes : null,
        finalData.alert_outline !== undefined ? finalData.alert_outline : null,
        finalData.template_line1 !== undefined ? finalData.template_line1 : null,
        finalData.template_line2 !== undefined ? finalData.template_line2 : null,
        finalData.customImageMode || 'emoji',
        finalData.customImageValue || '💝',
        finalData.customSoundUrl || null,
        finalData.alert_sound_url || null,
        finalData.page_title || null,
        finalData.page_subtitle || null,
        finalData.thank_you_header || null,
        finalData.thank_you_subtitle || null,
        finalData.social_twitch || null,
        finalData.social_youtube || null,
        finalData.social_tiktok || null,
        finalData.social_facebook || null,
        finalData.social_x || null,
        finalData.social_discord || null,
         finalData.social_instagram || null,
         finalData.streamlabs_access_token || null,
         finalData.streamlabs_refresh_token || null,
         finalData.profile_image_source || 'twitch',
        finalData.profile_image_value || null,
        finalData.profile_glow_color || '#005704',
        finalData.payment_method || 'ffp',
        finalData.promptpay_phone || null,
        finalData.promptpay_name || null,
        finalData.promptpay_enabled !== undefined ? (finalData.promptpay_enabled ? 1 : 0) : 0,
        finalData.tfp_api_key || null,
        finalData.tfp_api_secret || null,
        finalData.tfp_connected !== undefined ? (finalData.tfp_connected ? 1 : 0) : 0,
        finalData.tfp_last_check || null,
        finalData.promptpay_type || 'phone',
        finalData.promptpay_value_encrypted || null,
        finalData.slipok_api_encrypted || null,
        finalData.slipok_api_key_encrypted || null,
        finalData.slipok_connected !== undefined ? (finalData.slipok_connected ? 1 : 0) : 0,
        finalData.slipok_last_check || null,
        finalData.promptpay_account_verified !== undefined ? (finalData.promptpay_account_verified ? 1 : 0) : 0,
        finalData.promptpay_account_verified_at || null,
        finalData.truemoney_enabled !== undefined ? (finalData.truemoney_enabled ? 1 : 0) : 0,
        finalData.truemoney_phone_encrypted || null,
        finalData.truemoney_slipok_api_encrypted || null,
        finalData.truemoney_slipok_api_key_encrypted || null,
        finalData.truemoney_slipok_connected !== undefined ? (finalData.truemoney_slipok_connected ? 1 : 0) : 0,
        finalData.truemoney_slipok_last_check || null,
        finalData.truemoney_account_verified !== undefined ? (finalData.truemoney_account_verified ? 1 : 0) : 0,
        finalData.truemoney_account_verified_at || null,
        finalData.slipok_quota_total !== undefined ? finalData.slipok_quota_total : null,
        finalData.truemoney_slipok_quota_total !== undefined ? finalData.truemoney_slipok_quota_total : null,
        finalData.bank_enabled !== undefined ? (finalData.bank_enabled ? 1 : 0) : 0,
        finalData.bank_name || null,
        finalData.bank_account_number_encrypted || null,
        finalData.bank_account_name || null,
        finalData.bank_account_verified !== undefined ? (finalData.bank_account_verified ? 1 : 0) : 0,
        finalData.bank_account_verified_at || null,
        finalData.header_bg_url || null,
        finalData.page_bg_url || null,
        finalData.header_bg_y !== undefined ? finalData.header_bg_y : 50,
        finalData.header_bg_zoom !== undefined ? finalData.header_bg_zoom : 100,
        finalData.goal_enabled !== undefined ? (finalData.goal_enabled ? 1 : 0) : 0,
        finalData.goal_amount !== undefined ? finalData.goal_amount : 5000,
        finalData.goal_current !== undefined ? finalData.goal_current : 0,
        finalData.goal_label !== undefined ? finalData.goal_label : 'ค่ากาแฟ',
        finalData.goal_bar_color || '#4ade80',
        finalData.goal_show_on_donate !== undefined ? (finalData.goal_show_on_donate ? 1 : 0) : 1,
        finalData.goal_end_date !== undefined ? finalData.goal_end_date : null,
        finalData.goal_bar_text !== undefined ? finalData.goal_bar_text : '{เปอร์เซนต์}',
        finalData.goal_subtitle1 !== undefined ? finalData.goal_subtitle1 : '{ยอดปัจจุบัน}  /  {ยอดเป้าหมาย}฿',
        finalData.goal_subtitle2 !== undefined ? finalData.goal_subtitle2 : '',
        finalData.goal_anim_sound !== undefined ? (finalData.goal_anim_sound ? 1 : 0) : 1,
        finalData.goal_anim_enabled !== undefined ? (finalData.goal_anim_enabled ? 1 : 0) : 1,
        finalData.goal_anim_sound_volume !== undefined ? finalData.goal_anim_sound_volume : 1,
        finalData.goal_bar_position || 'bottom',
        finalData.goal_bar_width || '600',
        finalData.goal_bar_layout || 'horizontal',
        finalData.goal_bar_thickness || '45',
        finalData.goal_pointer_enabled !== undefined ? (finalData.goal_pointer_enabled ? 1 : 0) : 0,
        finalData.goal_pointer_side || 'right',
        finalData.goal_pointer_content || 'both',
        finalData.tos_accepted_at || null,
        finalData.primary_auth_provider || null,
        finalData.timer_settings !== undefined ? finalData.timer_settings : null,
        finalData.truemoney_webhook_secret_encrypted || null,
        finalData.truemoney_webhook_enabled !== undefined ? (finalData.truemoney_webhook_enabled ? 1 : 0) : 0,
        finalData.truemoney_webhook_kyc_confirmed !== undefined ? (finalData.truemoney_webhook_kyc_confirmed ? 1 : 0) : 0,
        finalData.truemoney_webhook_expiry || null,
        finalData.truemoney_webhook_methods || 'P2P',
        finalData.truemoney_promptpay_id_encrypted || null,
        finalData.badges || '{}',
        finalData.badge_display !== undefined ? finalData.badge_display : null,
        finalData.leaderboard_settings !== undefined ? finalData.leaderboard_settings : null,
        finalData.recentdonate_settings !== undefined ? finalData.recentdonate_settings : null,
        finalData.goal_text_settings !== undefined ? finalData.goal_text_settings : null,
        finalData.tier_donate_settings !== undefined ? finalData.tier_donate_settings : null,
        finalData.sound_library !== undefined ? finalData.sound_library : null,
        finalData.goal_bar_width_auto !== undefined ? (finalData.goal_bar_width_auto ? 1 : 0) : 0
      ]
    });
    savedId = _insertResult.lastInsertRowid ? Number(_insertResult.lastInsertRowid) : undefined;

  }

  // Never expose OAuth tokens (now encrypted at rest) back to callers
  const returned = { ...finalData, overlay_token: overlayToken, id: savedId };
  delete returned.streamlabs_access_token;
  delete returned.streamlabs_refresh_token;
  return returned;
}

const axios = require('axios'); // Use axios for simpler API calls

let twitchTokenCache = {
  token: null,
  expiresAt: 0
};

/**
 * Fetch a Twitch App Access Token using Client Credentials flow.
 * Implements caching to avoid rate limits.
 */
async function getTwitchAccessToken() {
  const now = Date.now();
  if (twitchTokenCache.token && twitchTokenCache.expiresAt > now) {
    return twitchTokenCache.token;
  }

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials'
      }
    });
    
    const token = response.data.access_token;
    const expiresIn = response.data.expires_in || 3600;
    
    twitchTokenCache = {
      token: token,
      expiresAt: now + (expiresIn * 1000) - 60000 // Buffer of 1 minute
    };
    
    return token;
  } catch (err) {
    console.error('❌ Error fetching Twitch access token:', err.message);
    return null;
  }
}

/**
 * Resolves the profile image URL based on the streamer's configuration.
 */
async function resolveProfileImage(streamer) {
  if (!streamer) return '/avatar.jpg';

  const value = streamer.profile_image_value;
  if (value) {
    return value;
  }

  return '/avatar.jpg';
}

// ========== Badges ==========

function parseBadges(badgesStr) {
  try { return JSON.parse(badgesStr || '{}'); } catch (e) { return {}; }
}

/**
 * Compute membership badges based on join date (tos_accepted_at).
 * Returns updated badges JSON string. Does NOT save — caller persists.
 */
function computeMemberBadges(streamer) {
  const badges = parseBadges(streamer.badges);
  const joinedAt = streamer.tos_accepted_at;
  if (!joinedAt) return JSON.stringify(badges); // no join date → skip auto

  const now = new Date();
  const joined = new Date(joinedAt);
  if (isNaN(joined.getTime())) return JSON.stringify(badges); // guard: date string เพี้ยน
  let monthsDiff = (now.getFullYear() - joined.getFullYear()) * 12
                 + (now.getMonth() - joined.getMonth());
  if (now.getDate() < joined.getDate()) monthsDiff--; // ยังไม่ถึงวันครบรอบเดือน — กันได้ badge ก่อนเวลา

  // ponytail: simple threshold chain, no cron needed for this
  if (monthsDiff >= 24) badges.member_2y = true;
  if (monthsDiff >= 12) badges.member_1y = true;
  if (monthsDiff >= 6)  badges.member_6m = true;
  if (monthsDiff >= 3)  badges.member_3m = true;
  if (monthsDiff >= 1)  badges.member_1m = true;

  return JSON.stringify(badges);
}

const MEMBERSHIP_KEYS = ['member_2y', 'member_1y', 'member_6m', 'member_3m', 'member_1m']; // สูง→ต่ำ

/**
 * คืน array ของ badge key ที่ควรโชว์บนหน้าโดเนท
 * - guard: คืนเฉพาะ badge ที่ "ได้จริง" (intersect กับ earned) เสมอ
 * - NULL prefs → default = [] (opt-in: ไม่โชว์จนกว่า user เลือกเอง)
 */
function resolveBadgeDisplay(streamer) {
  const earned = parseBadges(streamer.badges);
  let selected;

  if (streamer.badge_display == null) {
    // default = ไม่โชว์ badge จนกว่า user จะเลือกเองในหน้า dashboard (opt-in)
    selected = [];
  } else {
    try { selected = JSON.parse(streamer.badge_display); } catch (e) { selected = []; }
    if (!Array.isArray(selected)) selected = [];
  }

  // guard: เฉพาะ earned + clamp membership เหลือ tier สูงสุด 1 อัน
  selected = selected.filter(k => earned[k]);
  const members = selected.filter(k => MEMBERSHIP_KEYS.includes(k));
  if (members.length > 1) {
    const keep = MEMBERSHIP_KEYS.find(k => members.includes(k)); // สูงสุด
    selected = selected.filter(k => !MEMBERSHIP_KEYS.includes(k) || k === keep);
  }
  return selected;
}

// ponytail: rename split into 2 statements (streamers + transactions FK string)
// for atomic safety, use libsql batch() if available — otherwise manual rollback
async function renameStreamerUsername(streamerId, oldUsername, newUsername) {
  await ensureConnected();
  if (isFallback || !db) return null;

  if (typeof db.batch === 'function') {
    // Atomic path — libsql batch() runs both updates in one transaction
    await db.batch([
      { sql: 'UPDATE streamers SET username = ? WHERE id = ?', args: [newUsername, streamerId] },
      { sql: 'UPDATE transactions SET streamer_username = ? WHERE LOWER(streamer_username) = LOWER(?)', args: [newUsername, oldUsername] }
    ], 'write');
  } else {
    // Manual rollback path — if transactions update fails, revert streamers.username
    try {
      await db.execute({
        sql: 'UPDATE streamers SET username = ? WHERE id = ?',
        args: [newUsername, streamerId]
      });
      await db.execute({
        sql: 'UPDATE transactions SET streamer_username = ? WHERE LOWER(streamer_username) = LOWER(?)',
        args: [newUsername, oldUsername]
      });
    } catch (err) {
      // rollback: best-effort revert (may also fail — rethrow original)
      try {
        await db.execute({
          sql: 'UPDATE streamers SET username = ? WHERE id = ?',
          args: [oldUsername, streamerId]
        });
      } catch (rollbackErr) {
        console.error('[renameStreamerUsername] rollback failed:', rollbackErr.message);
      }
      throw err;
    }
  }

  return { success: true };
}

async function deleteStreamer(id) {
  await ensureConnected();
  if (isFallback) {
    console.warn('⚠️ deleteStreamer called in Fallback mode. Not implemented for memory storage.');
    return;
  }
  if (!db) throw new Error('Database not initialized');

  // 1. Get username first to clean up transactions
  const streamerRes = await db.execute({
    sql: 'SELECT username FROM streamers WHERE id = ?',
    args: [id]
  });
  const streamer = streamerRes.rows[0];
  if (!streamer) return;

  const username = streamer.username;

  try {
    // Temporarily disable FK to allow direct deletes from DB console too
    await db.execute('PRAGMA foreign_keys = OFF');

    // 2. Delete associated transactions
    await db.execute({
      sql: 'DELETE FROM transactions WHERE LOWER(streamer_username) = LOWER(?)',
      args: [username]
    });

    // 3. Delete session data for this user (SEC-010: escape LIKE wildcards to prevent bulk logout)
    const escapedUsername = username.replace(/%/g, '\\%').replace(/_/g, '\\_');
    await db.execute({
      sql: "DELETE FROM sessions WHERE session LIKE ? ESCAPE '\\'",
      args: [`%${escapedUsername}%`]
    });

    // 4. Delete the streamer record
    await db.execute({
      sql: 'DELETE FROM streamers WHERE id = ?',
      args: [id]
    });

    await db.execute('PRAGMA foreign_keys = ON');
  } catch (err) {
    await db.execute('PRAGMA foreign_keys = ON');
    throw err;
  }

  console.log(`🗑️ Database: Deleted streamer ${username} and their transactions.`);
}

/**
 * Fetch overlay settings for a specific user.
 * If not found or user not in DB, returns defaultSettings.
 */
async function getSettings(username, defaultSettings) {
  await ensureConnected();
  if (isFallback) {
    return memorySettings ? { ...defaultSettings, ...memorySettings } : defaultSettings;
  }
  if (!db || !username) return defaultSettings;

  const streamer = await getStreamer(username);
  if (!streamer) return defaultSettings;

  // SEC-004: Only expose keys that exist in defaultSettings — prevents payment fields,
  // auth tokens, and DB IDs from leaking via the public overlay-token endpoint.
  const merged = { ...defaultSettings };
  const allowEmpty = new Set(['template_line1', 'template_line2', 'goal_label', 'goal_bar_text']);
  for (const [key, value] of Object.entries(streamer)) {
    if (Object.prototype.hasOwnProperty.call(defaultSettings, key) && value !== null && (value !== '' || allowEmpty.has(key))) {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Save overlay settings for a specific user.
 */
async function saveSettings(username, settings) {
  await ensureConnected();
  if (isFallback) {
    memorySettings = settings;
    try {
      const DB_DIR = path.join(__dirname, '../data');
      fs.writeFileSync(path.join(DB_DIR, 'overlay-settings.json'), JSON.stringify(memorySettings, null, 2));
    } catch (e) {}
    return settings;
  }

  if (!db || !username) throw new Error('Database not initialized or username missing');

  const streamer = await getStreamer(username);
  if (!streamer) throw new Error('Streamer not found');

  return await saveStreamer({
    ...streamer,
    ...settings
  });
}

async function cleanupExpiredTransactions() {
  await ensureConnected();
  if (isFallback) {
    const now = Date.now();
    const expired = memoryTransactions.filter(t =>
      t.status === 'pending' &&
      t.createdAt &&
      (now - new Date(t.createdAt).getTime()) > 30 * 60 * 1000
    );
    expired.forEach(t => { t.status = 'expired'; t.updatedAt = new Date().toISOString(); });
    if (expired.length > 0) {
      console.log(`🧹 Fallback: marked ${expired.length} transactions as expired`);
      try {
        const DB_DIR = path.join(__dirname, '../data');
        fs.writeFileSync(path.join(DB_DIR, 'transactions.json'), JSON.stringify(memoryTransactions, null, 2));
      } catch (e) {}
    }
    return expired.length;
  }
  if (!db) return 0;

  const result = await db.execute({
    sql: `UPDATE transactions SET status = 'expired', updatedAt = ? WHERE status = 'pending' AND createdAt IS NOT NULL AND datetime(createdAt) < datetime('now', '-30 minutes')`,
    args: [new Date().toISOString()]
  });
  if (result.rowsAffected > 0) {
    console.log(`🧹 Cleaned up ${result.rowsAffected} expired transactions`);
  }
  return result.rowsAffected;
}

// § 2.7 TIER_DONATE_BLUEPRINT.md — donor-temp R2 audio ต้องลบก่อน transaction ถูก expire/hard-delete
// เรียกก่อน cleanupExpiredTransactions()/hardDeleteExpiredTransactions() เสมอ (WHERE เดียวกัน)
async function getExpiringTierAudioUrls() {
  await ensureConnected();
  if (isFallback || !db) return [];
  const result = await db.execute({
    sql: `SELECT tier_sound_url FROM transactions WHERE status = 'pending' AND tier_sound_is_temp = 1 AND tier_sound_url IS NOT NULL AND createdAt IS NOT NULL AND datetime(createdAt) < datetime('now', '-30 minutes')`
  });
  return result.rows.map(r => r.tier_sound_url);
}

async function getHardDeletableTierAudioUrls() {
  await ensureConnected();
  if (isFallback || !db) return [];
  const result = await db.execute({
    sql: `SELECT tier_sound_url FROM transactions WHERE status = 'expired' AND tier_sound_is_temp = 1 AND tier_sound_url IS NOT NULL AND updatedAt IS NOT NULL AND datetime(updatedAt) < datetime('now', '-7 days')`
  });
  return result.rows.map(r => r.tier_sound_url);
}

async function countPendingTransactions(username) {
  await ensureConnected();
  if (isFallback) {
    return memoryTransactions.filter(t => t.status === 'pending' && t.streamer_username === username).length;
  }
  if (!db) return 0;
  const result = await db.execute({
    sql: 'SELECT COUNT(*) as cnt FROM transactions WHERE status = ? AND LOWER(streamer_username) = LOWER(?)',
    args: ['pending', username]
  });
  return result.rows[0]?.cnt || 0;
}

/**
 * Hard delete transactions marked as expired for more than 7 days.
 * Returns number of deleted records.
 */
async function hardDeleteExpiredTransactions() {
  await ensureConnected();
  if (isFallback) {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const before = memoryTransactions.length;
    memoryTransactions = memoryTransactions.filter(t =>
      !(t.status === 'expired' && t.updatedAt && t.updatedAt < cutoff)
    );
    const deleted = before - memoryTransactions.length;
    if (deleted > 0) {
      console.log(`🗑️ Fallback: hard deleted ${deleted} expired transactions`);
      try {
        const DB_DIR = path.join(__dirname, '../data');
        fs.writeFileSync(path.join(DB_DIR, 'transactions.json'), JSON.stringify(memoryTransactions, null, 2));
      } catch (e) {}
    }
    return deleted;
  }
  if (!db) return 0;

  const result = await db.execute({
    sql: `DELETE FROM transactions WHERE status = 'expired' AND updatedAt IS NOT NULL AND datetime(updatedAt) < datetime('now', '-7 days')`
  });
  if (result.rowsAffected > 0) {
    console.log(`🗑️ Hard deleted ${result.rowsAffected} expired transactions (older than 7 days)`);
  }
  return result.rowsAffected;
}

/**
 * Hard delete all transactions older than specified months.
 * This is triggered every 6 months.
 * Returns number of deleted records.
 */
async function hardDeleteOldTransactions(months = 6) {
  await ensureConnected();
  if (isFallback) {
    const cutoff = new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000).toISOString();
    const before = memoryTransactions.length;
    memoryTransactions = memoryTransactions.filter(t =>
      !(t.createdAt && t.createdAt < cutoff)
    );
    const deleted = before - memoryTransactions.length;
    if (deleted > 0) {
      console.log(`🗑️ Fallback: hard deleted ${deleted} transactions older than ${months} months`);
      try {
        const DB_DIR = path.join(__dirname, '../data');
        fs.writeFileSync(path.join(DB_DIR, 'transactions.json'), JSON.stringify(memoryTransactions, null, 2));
      } catch (e) {}
    }
    return deleted;
  }
  if (!db) return 0;

  const safeMonths = Math.max(1, Math.min(12, parseInt(months, 10) || 3));
  const modifier = `-${safeMonths} months`;
  const result = await db.execute({
    sql: `DELETE FROM transactions WHERE datetime(createdAt) < datetime('now', ?)`,
    args: [modifier]
  });
  if (result.rowsAffected > 0) {
    console.log(`🗑️ Hard deleted ${result.rowsAffected} transactions older than ${safeMonths} months`);
  }
  return result.rowsAffected;
}

/**
 * Get transactions for a specific user within a date range.
 * Used for CSV download.
 */
async function getTransactionsByDateRange(username, fromDate, toDate) {
  await ensureConnected();
  if (isFallback) {
    let txs = memoryTransactions.filter(t =>
      t.streamer_username === username &&
      t.createdAt &&
      t.createdAt >= fromDate &&
      t.createdAt <= toDate
    );
    return txs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  if (!db) return [];

  const result = await db.execute({
    sql: 'SELECT * FROM transactions WHERE LOWER(streamer_username) = LOWER(?) AND createdAt >= ? AND createdAt <= ? ORDER BY createdAt DESC',
    args: [username, fromDate, toDate]
  });
  return result.rows;
}

async function getAllR2Refs(r2PublicUrl) {
  await ensureConnected();
  if (isFallback || !db) return new Set();

  const result = await db.execute(
    `SELECT
      CASE WHEN customImageMode NOT IN ('emoji', 'text') THEN customImageValue ELSE NULL END AS customImageValue,
      customSoundUrl,
      alert_sound_url,
      profile_image_value,
      header_bg_url,
      page_bg_url,
      timer_settings,
      tier_donate_settings,
      sound_library
    FROM streamers`
  );
  const refs = new Set();
  const addRef = (val) => {
    if (typeof val === 'string' && val.startsWith(r2PublicUrl)) {
      refs.add(val.split('?')[0]);
    }
  };
  for (const row of result.rows) {
    for (const [col, val] of Object.entries(row)) {
      if (col === 'timer_settings' || col === 'tier_donate_settings' || col === 'sound_library') continue; // JSON blobs, handled below
      addRef(val);
    }
    // timer_settings is a JSON blob; R2 URLs hidden inside (e.g. sound_url)
    // must be registered too, else cleanup-r2-orphans treats them as orphans and deletes them.
    // NOTE: any future JSON-blob column that stores an R2 URL must be parsed here as well.
    if (typeof row.timer_settings === 'string') {
      try {
        const t = JSON.parse(row.timer_settings);
        addRef(t.sound_url);
      } catch { /* malformed blob → skip */ }
    }
    if (typeof row.tier_donate_settings === 'string') {
      try {
        const t = JSON.parse(row.tier_donate_settings);
        (t.alert_images || []).forEach(img => { if (img?.url) addRef(img.url); });
      } catch { /* malformed blob → skip */ }
    }
    if (typeof row.sound_library === 'string') {
      try {
        const lib = JSON.parse(row.sound_library);
        (Array.isArray(lib) ? lib : []).forEach(s => { if (s?.url) addRef(s.url); });
      } catch { /* malformed blob → skip */ }
    }
  }
  return refs;
}

async function updateGoalCurrent(streamerId, additionalAmount) {
  await ensureConnected();
  if (isFallback || !db) return null;
  await db.execute({
    sql: 'UPDATE streamers SET goal_current = goal_current + ? WHERE id = ?',
    args: [additionalAmount, streamerId]
  });
  const row = await db.execute({
    sql: 'SELECT goal_current, goal_amount, goal_label, goal_bar_color FROM streamers WHERE id = ?',
    args: [streamerId]
  });
  return row.rows[0] || null;
}

async function getLeaderboard(username, limit = 5, periodDays = null) {
  await ensureConnected();
  if (isFallback || !db) return [];
  const periodClause = periodDays ? `AND datetime(paidAt) >= datetime('now', ?)` : '';
  const args = periodDays ? [username, `-${periodDays} days`, limit] : [username, limit];
  const result = await db.execute({
    sql: `SELECT donor, SUM(amount) as total_amount, COUNT(*) as donation_count, MAX(paidAt) as last_donate
          FROM transactions
          WHERE LOWER(streamer_username) = LOWER(?)
            AND status = 'successful'
            AND donor IS NOT NULL
            AND donor != 'Anonymous'
            ${periodClause}
          GROUP BY LOWER(donor)
          ORDER BY total_amount DESC
          LIMIT ?`,
    args
  });
  return result.rows;
}

// [Requirement #9] All-time leaderboard aggregate — separate table from getLeaderboard() (transactions-based, period-filtered)
async function upsertLeaderboard(username, donor, amount) {
  await ensureConnected();
  if (isFallback || !db) return;
  const now = new Date().toISOString();
  await db.execute({
    sql: `
      INSERT INTO leaderboard_alltime
        (streamer_username, donor, total_amount, donation_count, first_donation_at, last_donation_at, top_amount, avg_amount, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(streamer_username, donor) DO UPDATE SET
        total_amount = total_amount + excluded.total_amount,
        donation_count = donation_count + 1,
        last_donation_at = excluded.last_donation_at,
        top_amount = MAX(top_amount, excluded.top_amount),
        avg_amount = (total_amount + excluded.total_amount) / (donation_count + 1),
        updated_at = excluded.updated_at
    `,
    args: [username, donor, amount, now, now, amount, amount, now]
  });
}

async function getLeaderboardAlltime(username, limit = 10) {
  await ensureConnected();
  if (isFallback || !db) return [];
  const result = await db.execute({
    sql: `SELECT donor, total_amount, donation_count, first_donation_at, last_donation_at, top_amount, avg_amount
          FROM leaderboard_alltime
          WHERE streamer_username = ?
          ORDER BY total_amount DESC
          LIMIT ?`,
    args: [username, limit]
  });
  return result.rows;
}

async function backfillLeaderboardAlltime() {
  await ensureConnected();
  if (isFallback || !db) return 0;
  const result = await db.execute(`
    INSERT INTO leaderboard_alltime
      (streamer_username, donor, total_amount, donation_count, first_donation_at, last_donation_at, top_amount, avg_amount, updated_at)
    SELECT streamer_username, donor, SUM(amount), COUNT(*), MIN(paidAt), MAX(paidAt), MAX(amount), AVG(amount), MAX(paidAt)
    FROM transactions
    WHERE status = 'successful' AND donor IS NOT NULL AND donor != 'Anonymous'
    GROUP BY streamer_username, donor
    ON CONFLICT(streamer_username, donor) DO UPDATE SET
      total_amount = excluded.total_amount, donation_count = excluded.donation_count,
      first_donation_at = excluded.first_donation_at, last_donation_at = excluded.last_donation_at,
      top_amount = excluded.top_amount, avg_amount = excluded.avg_amount, updated_at = excluded.updated_at
  `);
  if (result.rowsAffected > 0) console.log(`📊 Backfilled ${result.rowsAffected} leaderboard_alltime rows`);
  return result.rowsAffected;
}

async function getRecentDonations(username, limit = 5, periodDays = null) {
  await ensureConnected();
  if (isFallback || !db) return [];
  const periodClause = periodDays ? `AND datetime(paidAt) >= datetime('now', ?)` : '';
  const args = periodDays ? [username, `-${periodDays} days`, limit] : [username, limit];
  const result = await db.execute({
    sql: `SELECT donor, amount, message, paidAt, payment_method
          FROM transactions
          WHERE LOWER(streamer_username) = LOWER(?)
            AND status = 'successful'
            ${periodClause}
          ORDER BY paidAt DESC
          LIMIT ?`,
    args
  });
  return result.rows;
}

async function disconnectPlatform(streamerId, platform) {
  await ensureConnected();
  if (isFallback || !db) throw new Error('Database not available');
  if (!['twitch', 'streamlabs'].includes(platform)) throw new Error('Invalid platform');
  const sql = platform === 'twitch'
    ? 'UPDATE streamers SET twitch_id = NULL WHERE id = ?'
    : 'UPDATE streamers SET streamlabs_id = NULL, streamlabs_access_token = NULL, streamlabs_refresh_token = NULL, streamlabs_username = NULL WHERE id = ?';
  await db.execute({ sql, args: [streamerId] });
}

async function logIpEvent(eventType, ip, streamerUsername, metadata) {
  await ensureConnected();
  if (isFallback || !db) return;
  try {
    await db.execute({
      sql: 'INSERT INTO ip_events (event_type, ip, streamer_username, metadata, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [
        eventType,
        ip || 'unknown',
        streamerUsername || null,
        metadata ? JSON.stringify(metadata) : null,
        new Date().toISOString()
      ]
    });
  } catch (e) {
    console.warn('⚠️ logIpEvent failed (non-critical):', e.message);
  }
}

async function cleanupOldIpEvents(days = 90) {
  await ensureConnected();
  if (isFallback || !db) return 0;
  const result = await db.execute({
    sql: `DELETE FROM ip_events WHERE datetime(created_at) < datetime('now', ?)`,
    args: [`-${Math.max(1, parseInt(days, 10) || 90)} days`]
  });
  if (result.rowsAffected > 0) {
    console.log(`🗑️ Deleted ${result.rowsAffected} ip_events older than ${days} days`);
  }
  return result.rowsAffected;
}

async function resetGoalCurrent(streamerId) {
  await ensureConnected();
  if (isFallback || !db) return null;
  await db.execute({
    sql: 'UPDATE streamers SET goal_current = 0 WHERE id = ?',
    args: [streamerId]
  });
  const row = await db.execute({
    sql: 'SELECT goal_current, goal_amount, goal_label, goal_bar_color FROM streamers WHERE id = ?',
    args: [streamerId]
  });
  return row.rows[0] || null;
}

// Timer: apply a delta (seconds) to the running countdown. Takes the streamer
// object already fetched at the donation site (never re-read via getStreamerById — C2).
async function updateTimerState(streamer, deltaSeconds) {
  await ensureConnected();
  if (isFallback || !db) return null;
  let t = {};
  try { t = JSON.parse(streamer.timer_settings || '{}'); } catch { t = {}; }
  let remaining = streamer.timer_remaining_seconds ?? (t.initial_seconds || 600);
  if (streamer.timer_last_update && streamer.timer_running) {
    const elapsed = (Date.now() - new Date(streamer.timer_last_update).getTime()) / 1000;
    remaining = Math.max(0, remaining - elapsed);
  }
  const now = new Date().toISOString();
  const newRemaining = Math.round(Math.max(0, remaining + deltaSeconds));
  await db.execute({
    sql: 'UPDATE streamers SET timer_remaining_seconds=?, timer_last_update=? WHERE id=?',
    args: [newRemaining, now, streamer.id]
  });
  // applied_delta = delta ที่เกิดขึ้นจริงหลัง clamp ที่ 0 — ใช้ broadcast แทน delta ดิบ
  // (ลบ 300 ตอนเหลือ 60 → applied -60, ลบตอนเหลือ 0 → applied 0 = ไม่มี animation)
  return { timer_remaining_seconds: newRemaining, timer_last_update: now, applied_delta: newRemaining - Math.round(remaining) };
}

// Timer: accumulate money-cap progress, clamped to capValue (money-cap mode only).
async function addTimerCap(streamerId, amount, capValue) {
  await ensureConnected();
  if (isFallback || !db) return;
  await db.execute({
    sql: 'UPDATE streamers SET timer_cap_current = MAX(0, MIN(timer_cap_current + ?, ?)) WHERE id = ?',
    args: [amount, capValue, streamerId]
  });
}

// Timer control: start | stop | reset | reset-cap. Reads current state by PK,
// freezes elapsed time, then writes the 4 state columns directly.
async function setTimerControl(streamerId, action, delta = 0) {
  await ensureConnected();
  if (isFallback || !db) return null;
  const res = await db.execute({
    sql: 'SELECT timer_settings, timer_remaining_seconds, timer_last_update, timer_running, timer_cap_current FROM streamers WHERE id = ?',
    args: [streamerId]
  });
  const s = res.rows[0];
  if (!s) return null;
  let t = {};
  try { t = JSON.parse(s.timer_settings || '{}'); } catch { t = {}; }
  const now = new Date().toISOString();

  // Freeze remaining, subtracting elapsed if it was running.
  let remaining = s.timer_remaining_seconds ?? (t.initial_seconds || 600);
  if (s.timer_last_update && s.timer_running) {
    const elapsed = (Date.now() - new Date(s.timer_last_update).getTime()) / 1000;
    remaining = Math.max(0, remaining - elapsed);
  }
  remaining = Math.round(remaining);

  let running = s.timer_running;
  let capCurrent = s.timer_cap_current || 0;
  const beforeRemaining = remaining;

  if (action === 'start') running = 1;
  else if (action === 'stop') running = 0;
  else if (action === 'reset') { remaining = Math.round(t.initial_seconds || 600); running = 0; capCurrent = 0; }
  else if (action === 'reset-cap') capCurrent = 0;
  else if (action === 'add') remaining = Math.max(0, remaining + delta);
  else if (action === 'sub') remaining = Math.max(0, remaining - delta);

  await db.execute({
    sql: 'UPDATE streamers SET timer_remaining_seconds=?, timer_last_update=?, timer_running=?, timer_cap_current=? WHERE id=?',
    args: [remaining, now, running, capCurrent, streamerId]
  });
  // applied_delta: delta ที่เกิดจริงหลัง clamp 0 (มีความหมายเฉพาะ add/sub — caller gate เอง)
  return { timer_remaining_seconds: remaining, timer_last_update: now, timer_running: running, timer_cap_current: capCurrent, applied_delta: remaining - beforeRemaining };
}

async function getAdminUserStats() {
  await ensureConnected();
  if (isFallback || !db) return { active: 0, inactive: 0, byProvider: {}, withPayment: 0 };
  const [total, inactive, byProvider, withPayment] = await Promise.all([
    db.execute('SELECT COUNT(*) as n FROM streamers WHERE is_active = 1'),
    db.execute('SELECT COUNT(*) as n FROM streamers WHERE is_active = 0'),
    db.execute(`SELECT CASE WHEN (twitch_id IS NOT NULL AND twitch_id != '') AND (streamlabs_id IS NOT NULL AND streamlabs_id != '') THEN 'Twitch & Streamlabs' WHEN (twitch_id IS NOT NULL AND twitch_id != '') THEN 'Twitch Only' WHEN (streamlabs_id IS NOT NULL AND streamlabs_id != '') THEN 'Streamlabs Only' ELSE 'Unknown' END AS p, COUNT(*) as n FROM streamers GROUP BY p`),
    db.execute('SELECT COUNT(*) as n FROM streamers WHERE promptpay_enabled = 1 OR truemoney_enabled = 1 OR tfp_connected = 1'),
  ]);
  return {
    active: total.rows[0].n,
    inactive: inactive.rows[0].n,
    byProvider: Object.fromEntries(byProvider.rows.map(r => [r.p || 'unknown', r.n])),
    withPayment: withPayment.rows[0].n,
  };
}

async function getAdminTxStats() {
  await ensureConnected();
  if (isFallback || !db) return { total: 0, today: 0, week: 0 };
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const [total, todayCount, weekCount] = await Promise.all([
    db.execute("SELECT COUNT(*) as n FROM transactions WHERE status = 'successful'"),
    db.execute("SELECT COUNT(*) as n FROM transactions WHERE status = 'successful' AND createdAt >= ?", [today]),
    db.execute("SELECT COUNT(*) as n FROM transactions WHERE status = 'successful' AND createdAt >= ?", [weekAgo]),
  ]);
  return { total: total.rows[0].n, today: todayCount.rows[0].n, week: weekCount.rows[0].n };
}

// ponytail: whitelist sort keys — SQL-concat, args-only for WHERE; sort is from fixed map
const ADMIN_USER_SORT_MAP = {
  registered: 'tos_accepted_at',
  username: 'username',
  status: 'is_active',
  auth: '(CASE WHEN twitch_id IS NOT NULL AND twitch_id != \'\' THEN 1 ELSE 0 END + CASE WHEN streamlabs_id IS NOT NULL AND streamlabs_id != \'\' THEN 1 ELSE 0 END)',
  payment: '(promptpay_enabled + truemoney_enabled + tfp_connected + bank_enabled)',
  badge: "(CASE WHEN badges LIKE '%beta_tester%' THEN 1 ELSE 0 END)",
};
async function getAdminUsers({ page = 1, q = '', filter = 'all', sort = 'registered', order = 'desc' } = {}) {
  await ensureConnected();
  if (isFallback || !db) return { users: [], total: 0, page, pageSize: 25 };
  const PAGE_SIZE = 25;
  const offset = (page - 1) * PAGE_SIZE;
  const where = [];
  const args = [];
  if (q) { where.push('LOWER(username) LIKE ?'); args.push(`%${q}%`); }
  if (filter === 'active')   { where.push('is_active = 1'); }
  if (filter === 'inactive') { where.push('is_active = 0'); }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const sortExpr = ADMIN_USER_SORT_MAP[sort] || ADMIN_USER_SORT_MAP.registered;
  const dir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // ponytail: push NULL registered dates to bottom regardless of dir — unknown date = neither oldest nor newest
  const nullGuard = sort === 'registered' ? `CASE WHEN tos_accepted_at IS NULL THEN 1 ELSE 0 END ASC, ` : '';
  const [rows, countRow] = await Promise.all([
    db.execute(
      `SELECT username, is_active, primary_auth_provider,
              (twitch_id IS NOT NULL AND twitch_id != '') AS has_twitch,
              (streamlabs_id IS NOT NULL AND streamlabs_id != '') AS has_streamlabs,
              tos_accepted_at, payment_method, promptpay_enabled, truemoney_enabled, tfp_connected, bank_enabled, badges
       FROM streamers ${whereClause} ORDER BY ${nullGuard}${sortExpr} ${dir}, username ASC LIMIT ? OFFSET ?`,
      [...args, PAGE_SIZE, offset]
    ),
    db.execute(`SELECT COUNT(*) as n FROM streamers ${whereClause}`, args),
  ]);
  return { users: rows.rows, total: countRow.rows[0].n, page, pageSize: PAGE_SIZE };
}

async function getAdminIpEvents({ limit = 100, type = 'all' } = {}) {
  await ensureConnected();
  if (isFallback || !db) return { events: [], summary: [] };
  const args = [];
  let typeFilter = '';
  if (type !== 'all') {
    typeFilter = 'WHERE event_type = ?';
    args.push(type);
  }
  args.push(limit);
  const [rows, summary] = await Promise.all([
    db.execute(
      `SELECT id, event_type, ip, streamer_username, metadata, created_at
       FROM ip_events ${typeFilter} ORDER BY created_at DESC LIMIT ?`,
      args
    ),
    db.execute('SELECT event_type, COUNT(*) as n FROM ip_events GROUP BY event_type ORDER BY n DESC'),
  ]);
  const events = rows.rows.map(r => ({
    id: r.id,
    event_type: r.event_type,
    ip_masked: maskIpLocal(r.ip),
    streamer_username: r.streamer_username,
    metadata: r.metadata,
    created_at: r.created_at,
  }));
  return { events, summary: summary.rows };
}

function maskIpLocal(ip) {
  if (!ip) return '';
  return ip.includes(':')
    ? ip.split(':').slice(0, 2).join(':') + '::x'
    : ip.split('.').slice(0, 2).join('.') + '.x.x';
}

function maskMobile(mobile) {
  if (!mobile) return '';
  const s = String(mobile).replace(/\D/g, '');
  if (s.length < 7) return s;
  return s.slice(0, 2) + 'xxxx' + s.slice(-4);
}

function getMonthStartISO() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1)).toISOString();
}

async function insertProcessedWebhook(data) {
  await ensureConnected();
  if (isFallback) {
    if (!memoryProcessedWebhooks) memoryProcessedWebhooks = [];
    const dup = memoryProcessedWebhooks.find(w => w.event_hash === data.event_hash);
    if (dup) return { duplicate: true };
    memoryProcessedWebhooks.push({ ...data, processed_at: new Date().toISOString() });
    return { duplicate: false };
  }
  if (!db) return { duplicate: false };
  try {
    await db.execute({
      sql: 'INSERT INTO processed_webhooks ' +
        '(streamer_username, event_hash, ref_id, amount_satang, sender_mobile_masked, event_type, received_time, matched) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [
        data.streamer_username,
        data.event_hash,
        data.ref_id || null,
        data.amount_satang != null ? data.amount_satang : 0,
        data.sender_mobile_masked || null,
        data.event_type || null,
        data.received_time || null,
        data.matched ? 1 : 0
      ]
    });
    return { duplicate: false };
  } catch (e) {
    if (e.message && /UNIQUE/i.test(e.message)) return { duplicate: true };
    console.error('insertProcessedWebhook failed:', e.message);
    throw e;
  }
}

// amountSatang: integer satang from the webhook (decoded.amount). Matching on integer satang avoids
// IEEE-754 float-equality misses between stored baht (e.g. 100.37) and decoded.amount/100 (QA Q2 2026-07-13).
async function getPendingWebhookTxByAmount(username, amountSatang) {
  await ensureConnected();
  const satang = Math.round(amountSatang);
  if (isFallback) {
    return memoryTransactions.filter(t =>
      t.streamer_username === username &&
      t.payment_method === 'truemoney_webhook' &&
      t.status === 'pending' &&
      Math.round(t.amount * 100) === satang
    );
  }
  if (!db) return [];
  const result = await db.execute({
    sql: 'SELECT * FROM transactions WHERE streamer_username = ? ' +
        "AND payment_method = 'truemoney_webhook' " +
        "AND status = 'pending' " +
        'AND CAST(ROUND(amount * 100) AS INTEGER) = ?',
    args: [username, satang]
  });
  return result.rows || [];
}

async function getStreamersWithWebhookEnabled() {
  await ensureConnected();
  if (isFallback || !db) return [];
  const result = await db.execute({
    sql: 'SELECT id, username, truemoney_webhook_expiry, twitch_id, streamlabs_id ' +
        'FROM streamers WHERE truemoney_webhook_enabled = 1',
  });
  return result.rows || [];
}

async function countMonthlyWebhookTx(username) {
  await ensureConnected();
  const monthStart = getMonthStartISO();
  if (isFallback) {
    return memoryTransactions.filter(t =>
      t.streamer_username === username &&
      t.payment_method === 'truemoney_webhook' &&
      t.status === 'successful' &&
      t.paidAt && t.paidAt >= monthStart
    ).length;
  }
  if (!db) return 0;
  const result = await db.execute({
    sql: 'SELECT COUNT(*) as cnt FROM transactions WHERE streamer_username = ? ' +
        "AND payment_method = 'truemoney_webhook' " +
        "AND status = 'successful' " +
        'AND paidAt >= ?',
    args: [username, monthStart]
  });
  return result.rows[0]?.cnt || 0;
}

async function cleanupProcessedWebhooks(days = 90) {
  await ensureConnected();
  if (isFallback || !db) return 0;
  const result = await db.execute({
    sql: 'DELETE FROM processed_webhooks WHERE datetime(processed_at) < datetime(\'now\', ?)',
    args: [`-${Math.max(1, parseInt(days, 10) || 90)} days`]
  });
  return result.rowsAffected || 0;
}

let memoryProcessedWebhooks = [];

module.exports = {
  initDB,
  getDB,
  ensureConnected,
  migrateDB,
  getTransactions,
  getTransactionById,
  saveTransaction,
  confirmTransactionPaid,
  cleanupExpiredTransactions,
  hardDeleteExpiredTransactions,
  getExpiringTierAudioUrls,
  getHardDeletableTierAudioUrls,
  hardDeleteOldTransactions,
  getTransactionsByDateRange,
  countPendingTransactions,
  getSettings,
  saveSettings,
  getStreamer,
  getStreamerByTwitchId,
  getStreamerByStreamlabsId,
  getStreamerById,
  getStreamerByToken,
  getDecryptedStreamer,
  saveStreamer,
  getLeaderboard,
  upsertLeaderboard,
  getLeaderboardAlltime,
  backfillLeaderboardAlltime,
  getRecentDonations,
  updateGoalCurrent,
  updateTimerState,
  addTimerCap,
  setTimerControl,
  disconnectPlatform,
  resetGoalCurrent,
  deleteStreamer,
  renameStreamerUsername,
  resolveProfileImage,
  parseBadges,
  computeMemberBadges,
  resolveBadgeDisplay,
  getAllR2Refs,
  logIpEvent,
  cleanupOldIpEvents,
  getAdminUserStats,
  getAdminTxStats,
  getAdminUsers,
  getAdminIpEvents,
  maskMobile,
  insertProcessedWebhook,
  getPendingWebhookTxByAmount,
  getStreamersWithWebhookEnabled,
  countMonthlyWebhookTx,
  cleanupProcessedWebhooks,
};
