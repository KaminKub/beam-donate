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
        ttsRate REAL DEFAULT 1.0,
        ttsLanguage TEXT DEFAULT 'th-TH',
        ttsVoice TEXT,
        ttsPrefixEnabled INTEGER DEFAULT 1,

        profanityFilterEnabled INTEGER DEFAULT 1,
        profanityWords TEXT,
        profanityReplaceStyle TEXT DEFAULT 'asterisks',
        messageTemplate TEXT DEFAULT '{donor} ได้บริจาค {amount} บาท! 🎉',
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
        -- TrueMoney Wallet
        truemoney_enabled INTEGER DEFAULT 0,
        truemoney_phone_encrypted TEXT,
        truemoney_slipok_api_encrypted TEXT,
        truemoney_slipok_api_key_encrypted TEXT,
        truemoney_slipok_connected INTEGER DEFAULT 0,
        truemoney_slipok_last_check TEXT,
        slipok_quota_total INTEGER,
        truemoney_slipok_quota_total INTEGER,
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
        goal_subtitle1 TEXT DEFAULT '{ยอดปัจจุบัน}/{ยอดเป้าหมาย}฿',
        goal_subtitle2 TEXT DEFAULT 'ปิดหลอดใน {วันคงเหลือ} วัน',
        goal_anim_sound INTEGER DEFAULT 1,
        goal_bar_position TEXT DEFAULT 'top'
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
        promptpay_verified_at TEXT
      )
     `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        session TEXT,
        expires INTEGER
      )
    `);

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
      { name: 'promptpay_verified_at', type: 'TEXT' }
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
      { name: 'truemoney_enabled', type: 'INTEGER DEFAULT 0' },
      { name: 'truemoney_phone_encrypted', type: 'TEXT' },
      { name: 'truemoney_slipok_api_encrypted', type: 'TEXT' },
      { name: 'truemoney_slipok_api_key_encrypted', type: 'TEXT' },
      { name: 'truemoney_slipok_connected', type: 'INTEGER DEFAULT 0' },
      { name: 'truemoney_slipok_last_check', type: 'TEXT' },
      { name: 'slipok_quota_total', type: 'INTEGER' },
      { name: 'truemoney_slipok_quota_total', type: 'INTEGER' },
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
      { name: 'goal_subtitle1', type: "TEXT DEFAULT '{ยอดปัจจุบัน}/{ยอดเป้าหมาย}฿'" },
      { name: 'goal_subtitle2', type: "TEXT DEFAULT 'ปิดหลอดใน {วันคงเหลือ} วัน'" },
      { name: 'goal_anim_sound', type: 'INTEGER DEFAULT 1' },
      { name: 'goal_bar_position', type: "TEXT DEFAULT 'top'" }
    ];

    for (const col of requiredCols) {
      if (!streamerCols.includes(col.name)) {
        const safeName = validateIdentifier(col.name);
        // We can't parameterize column names, but we've validated it's just alphanumeric
        console.log(`🛠️ Migrating streamers: adding column ${safeName}`);
        await db.execute(`ALTER TABLE streamers ADD COLUMN ${safeName} ${col.type}`);
      }
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
        createdAt: data.createdAt || data.created_at || now
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
        sql: 'SELECT streamer_username, amount, donor, message, payment_method FROM transactions WHERE id = ?',
        args: [data.id]
      });
      if (existing.rows[0]) {
        const ex = existing.rows[0];
        if (!data.streamer_username) data.streamer_username = ex.streamer_username;
        if (data.amount === undefined) data.amount = ex.amount;
        if (data.donor === undefined) data.donor = ex.donor;
        if (data.message === undefined) data.message = ex.message;
        if (data.payment_method === undefined) data.payment_method = ex.payment_method;
      }
    } catch (e) {}
  }

  const now = new Date().toISOString();
  const rawResponse = data.raw_response ? (typeof data.raw_response === 'string' ? data.raw_response : JSON.stringify(data.raw_response)) : null;
  const rawWebhook = data.raw_webhook ? (typeof data.raw_webhook === 'string' ? data.raw_webhook : JSON.stringify(data.raw_webhook)) : null;

  await db.execute({
    sql: `INSERT INTO transactions (id, amount, donor, message, status, paymentUrl, raw_response, raw_webhook, createdAt, updatedAt, paidAt, streamer_username, payment_method, promptpay_slip_id, promptpay_verified, promptpay_verified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            promptpay_verified_at = excluded.promptpay_verified_at`,
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
      data.promptpay_verified_at || null
    ]
  });
  
  return data;
}

async function getStreamerByToken(token) {
  await ensureConnected();
  if (isFallback) return null;
  if (!db) return null;
  
  // Retry up to 2 times for transient DB issues (e.g., cold start, network hiccup)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await db.execute({
        sql: 'SELECT * FROM streamers WHERE overlay_token = ?',
        args: [token]
      });
      if (result.rows.length > 0) return result.rows[0];
      if (attempt < 2) await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      if (attempt === 2) {
        console.error(`❌ getStreamerByToken failed after 3 attempts:`, err.message);
        return null;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return null;
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
  
   // Helper: true if text is already encrypted (3 colon-separated base64 parts)
   function isEncrypted(text) {
     if (!text) return false;
     const parts = text.split(':');
     return parts.length === 3 && parts.every(p => p.length > 8);
   }

   // Encrypt sensitive payment fields BEFORE building finalData
   // Skip if already encrypted or already censored (contains '*')
   if (data.promptpay_value && data.promptpay_value.length > 0 && !isEncrypted(data.promptpay_value) && !data.promptpay_value.includes('*')) {
     try { data.promptpay_value_encrypted = encrypt(data.promptpay_value); } catch (e) { console.warn('Failed to encrypt promptpay_value:', e.message); }
   }
   if (data.slipok_api && data.slipok_api.length > 0 && !isEncrypted(data.slipok_api) && !data.slipok_api.includes('*')) {
     try { data.slipok_api_encrypted = encrypt(data.slipok_api); } catch (e) { console.warn('Failed to encrypt slipok_api:', e.message); }
   }
   if (data.slipok_api_key && data.slipok_api_key.length > 0 && !isEncrypted(data.slipok_api_key) && !data.slipok_api_key.includes('*')) {
     try { data.slipok_api_key_encrypted = encrypt(data.slipok_api_key); } catch (e) { console.warn('Failed to encrypt slipok_api_key:', e.message); }
   }
   if (data.truemoney_phone && data.truemoney_phone.length > 0 && !isEncrypted(data.truemoney_phone) && !data.truemoney_phone.includes('*')) {
     try { data.truemoney_phone_encrypted = encrypt(data.truemoney_phone); } catch (e) { console.warn('Failed to encrypt truemoney_phone:', e.message); }
   }
   if (data.truemoney_slipok_api && data.truemoney_slipok_api.length > 0 && !isEncrypted(data.truemoney_slipok_api) && !data.truemoney_slipok_api.includes('*')) {
     try { data.truemoney_slipok_api_encrypted = encrypt(data.truemoney_slipok_api); } catch (e) { console.warn('Failed to encrypt truemoney_slipok_api:', e.message); }
   }
    if (data.truemoney_slipok_api_key && data.truemoney_slipok_api_key.length > 0 && !isEncrypted(data.truemoney_slipok_api_key) && !data.truemoney_slipok_api_key.includes('*')) {
      try { data.truemoney_slipok_api_key_encrypted = encrypt(data.truemoney_slipok_api_key); } catch (e) { console.warn('Failed to encrypt truemoney_slipok_api_key:', e.message); }
    }
    // Encrypt Streamlabs OAuth tokens at rest (M1)
    if (data.streamlabs_access_token && data.streamlabs_access_token.length > 0 && !isEncrypted(data.streamlabs_access_token)) {
      try { data.streamlabs_access_token = encrypt(data.streamlabs_access_token); } catch (e) { console.warn('Failed to encrypt streamlabs_access_token:', e.message); }
    }
    if (data.streamlabs_refresh_token && data.streamlabs_refresh_token.length > 0 && !isEncrypted(data.streamlabs_refresh_token)) {
      try { data.streamlabs_refresh_token = encrypt(data.streamlabs_refresh_token); } catch (e) { console.warn('Failed to encrypt streamlabs_refresh_token:', e.message); }
    }

   const finalData = {
     ...existing,
     ...data,
     overlay_token: overlayToken
   };
  
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
               truemoney_enabled = COALESCE(?, streamers.truemoney_enabled),
               truemoney_phone_encrypted = COALESCE(?, streamers.truemoney_phone_encrypted),
               truemoney_slipok_api_encrypted = COALESCE(?, streamers.truemoney_slipok_api_encrypted),
               truemoney_slipok_api_key_encrypted = COALESCE(?, streamers.truemoney_slipok_api_key_encrypted),
               truemoney_slipok_connected = COALESCE(?, streamers.truemoney_slipok_connected),
               truemoney_slipok_last_check = COALESCE(?, streamers.truemoney_slipok_last_check),
               slipok_quota_total = COALESCE(?, streamers.slipok_quota_total),
               truemoney_slipok_quota_total = COALESCE(?, streamers.truemoney_slipok_quota_total),
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
               goal_bar_position = COALESCE(?, streamers.goal_bar_position)
               WHERE twitch_id = ?`,
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
          finalData.truemoney_enabled !== undefined ? (finalData.truemoney_enabled ? 1 : 0) : null,
          finalData.truemoney_phone_encrypted !== undefined ? finalData.truemoney_phone_encrypted : null,
          finalData.truemoney_slipok_api_encrypted !== undefined ? finalData.truemoney_slipok_api_encrypted : null,
          finalData.truemoney_slipok_api_key_encrypted !== undefined ? finalData.truemoney_slipok_api_key_encrypted : null,
          finalData.truemoney_slipok_connected !== undefined ? (finalData.truemoney_slipok_connected ? 1 : 0) : null,
          finalData.truemoney_slipok_last_check !== undefined ? finalData.truemoney_slipok_last_check : null,
          finalData.slipok_quota_total !== undefined ? finalData.slipok_quota_total : null,
          finalData.truemoney_slipok_quota_total !== undefined ? finalData.truemoney_slipok_quota_total : null,
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
          finalData.goal_bar_position !== undefined ? finalData.goal_bar_position : null,
          finalData.twitch_id || null
        ]
      });
  } else {
     const _insertResult = await db.execute({
       sql: `INSERT INTO streamers (twitch_id, streamlabs_id, streamlabs_username, username, discord_webhook_url, overlay_token, is_active, 
             duration, soundEnabled, soundChoice, soundVolume, ttsEnabled, ttsReadDonor, ttsVolume, ttsRate, ttsLanguage, ttsVoice, ttsPrefixEnabled,
             profanityFilterEnabled, profanityWords, profanityReplaceStyle, messageTemplate, amountSuffix, showLabel, showDonorMessage, minAmount, 
             theme, animation, fontFamily, primaryColor, secondaryColor, backgroundColor, textColor, borderColor, particleCount, fontSize,
             customImageMode, customImageValue, customSoundUrl, alert_sound_url, page_title, page_subtitle, thank_you_header, thank_you_subtitle,
              social_twitch, social_youtube, social_tiktok, social_facebook, social_x, social_discord, social_instagram,
               streamlabs_access_token, streamlabs_refresh_token,
               profile_image_source, profile_image_value, profile_glow_color,
              payment_method, promptpay_phone, promptpay_name, promptpay_enabled, tfp_api_key, tfp_api_secret, tfp_connected, tfp_last_check,
              promptpay_type, promptpay_value_encrypted, slipok_api_encrypted, slipok_api_key_encrypted, slipok_connected, slipok_last_check,
              truemoney_enabled, truemoney_phone_encrypted, truemoney_slipok_api_encrypted, truemoney_slipok_api_key_encrypted, truemoney_slipok_connected, truemoney_slipok_last_check, slipok_quota_total, truemoney_slipok_quota_total,
              header_bg_url, page_bg_url, header_bg_y, header_bg_zoom, goal_enabled, goal_amount, goal_current, goal_label, goal_bar_color, goal_show_on_donate, goal_end_date, goal_bar_text, goal_subtitle1, goal_subtitle2, goal_anim_sound, goal_bar_position)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        finalData.ttsRate !== undefined ? finalData.ttsRate : 1.0,
        finalData.ttsLanguage || 'th-TH',
        finalData.ttsVoice || null,
        finalData.ttsPrefixEnabled !== undefined ? (finalData.ttsPrefixEnabled ? 1 : 0) : 1,
        finalData.profanityFilterEnabled !== undefined ? (finalData.profanityFilterEnabled ? 1 : 0) : 1,
        finalData.profanityWords || null,
        finalData.profanityReplaceStyle || 'asterisks',
        finalData.messageTemplate || '{donor} ได้บริจาค {amount} บาท! 🎉',
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
        finalData.truemoney_enabled !== undefined ? (finalData.truemoney_enabled ? 1 : 0) : 0,
        finalData.truemoney_phone_encrypted || null,
        finalData.truemoney_slipok_api_encrypted || null,
        finalData.truemoney_slipok_api_key_encrypted || null,
        finalData.truemoney_slipok_connected !== undefined ? (finalData.truemoney_slipok_connected ? 1 : 0) : 0,
        finalData.truemoney_slipok_last_check || null,
        finalData.slipok_quota_total !== undefined ? finalData.slipok_quota_total : null,
        finalData.truemoney_slipok_quota_total !== undefined ? finalData.truemoney_slipok_quota_total : null,
        finalData.header_bg_url || null,
        finalData.page_bg_url || null,
        finalData.header_bg_y !== undefined ? finalData.header_bg_y : 50,
        finalData.header_bg_zoom !== undefined ? finalData.header_bg_zoom : 100,
        finalData.goal_enabled !== undefined ? (finalData.goal_enabled ? 1 : 0) : 0,
        finalData.goal_amount !== undefined ? finalData.goal_amount : 5000,
        finalData.goal_current !== undefined ? finalData.goal_current : 0,
        finalData.goal_label || 'ค่ากาแฟ',
        finalData.goal_bar_color || '#4ade80',
        finalData.goal_show_on_donate !== undefined ? (finalData.goal_show_on_donate ? 1 : 0) : 1,
        finalData.goal_end_date !== undefined ? finalData.goal_end_date : null,
        finalData.goal_bar_text !== undefined ? finalData.goal_bar_text : '{เปอร์เซนต์}',
        finalData.goal_subtitle1 !== undefined ? finalData.goal_subtitle1 : '{ยอดปัจจุบัน}/{ยอดเป้าหมาย}฿',
        finalData.goal_subtitle2 !== undefined ? finalData.goal_subtitle2 : 'ปิดหลอดใน {วันคงเหลือ} วัน',
        finalData.goal_anim_sound !== undefined ? (finalData.goal_anim_sound ? 1 : 0) : 1,
        finalData.goal_bar_position || 'top'
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
  for (const [key, value] of Object.entries(streamer)) {
    if (Object.prototype.hasOwnProperty.call(defaultSettings, key) && value !== null && value !== '') {
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
 * This is triggered quarterly (every 3 months).
 * Returns number of deleted records.
 */
async function hardDeleteOldTransactions(months = 3) {
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
      page_bg_url
    FROM streamers`
  );
  const refs = new Set();
  for (const row of result.rows) {
    for (const val of Object.values(row)) {
      if (typeof val === 'string' && val.startsWith(r2PublicUrl)) {
        refs.add(val.split('?')[0]);
      }
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

module.exports = {
  initDB,
  getDB,
  ensureConnected,
  migrateDB,
  getTransactions,
  getTransactionById,
  saveTransaction,
  cleanupExpiredTransactions,
  hardDeleteExpiredTransactions,
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
  updateGoalCurrent,
  resetGoalCurrent,
  deleteStreamer,
  resolveProfileImage,
  getAllR2Refs
};
