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
        ttsEnabled INTEGER DEFAULT 0,
        ttsReadDonor INTEGER DEFAULT 1,
        ttsVolume REAL DEFAULT 0.8,
        ttsRate REAL DEFAULT 1.0,
        ttsLanguage TEXT DEFAULT 'th-TH',
        ttsVoice TEXT,

        profanityFilterEnabled INTEGER DEFAULT 1,
        profanityWords TEXT,
        profanityReplaceStyle TEXT DEFAULT 'asterisks',
        messageTemplate TEXT DEFAULT '{donor} ได้บริจาค {amount} บาท! 🎉',
        amountSuffix TEXT DEFAULT 'บาท',
        showLabel INTEGER DEFAULT 1,
        showDonorMessage INTEGER DEFAULT 1,
        minAmount REAL DEFAULT 1,
        theme TEXT DEFAULT 'glassmorphism',
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
        profile_glow_color TEXT DEFAULT '#005704'
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
        streamer_username TEXT REFERENCES streamers(username)
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

    // C. Ensure new overlay settings columns exist
    const streamerColumnsRes = await db.execute('PRAGMA table_info(streamers)');
    const streamerCols = streamerColumnsRes.rows.map(r => r.name);
    
    const requiredCols = [
      { name: 'twitch_id', type: 'TEXT' },
      { name: 'streamlabs_id', type: 'TEXT' },
      { name: 'streamlabs_username', type: 'TEXT' },
      { name: 'ttsReadDonor', type: 'INTEGER DEFAULT 1' },
      { name: 'ttsVoice', type: 'TEXT' },
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
      { name: 'customSoundUrl', type: 'TEXT' }
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
  
  const now = new Date().toISOString();
  const rawResponse = data.raw_response ? (typeof data.raw_response === 'string' ? data.raw_response : JSON.stringify(data.raw_response)) : null;
  const rawWebhook = data.raw_webhook ? (typeof data.raw_webhook === 'string' ? data.raw_webhook : JSON.stringify(data.raw_webhook)) : null;

  await db.execute({
    sql: `INSERT INTO transactions (id, amount, donor, message, status, paymentUrl, raw_response, raw_webhook, createdAt, updatedAt, paidAt, streamer_username)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            amount = excluded.amount,
            donor = excluded.donor,
            message = excluded.message,
            status = excluded.status,
            paymentUrl = excluded.paymentUrl,
            raw_response = excluded.raw_response,
            raw_webhook = excluded.raw_webhook,
            updatedAt = excluded.updatedAt,
            paidAt = excluded.paidAt,
            streamer_username = excluded.streamer_username`,
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
      data.streamer_username || null
    ]
  });
  
  return data;
}

async function getStreamerByToken(token) {
  await ensureConnected();
  if (isFallback) return null;
  if (!db) return null;
  const result = await db.execute({
    sql: 'SELECT * FROM streamers WHERE overlay_token = ?',
    args: [token]
  });
  return result.rows[0] || null;
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
  
   const existing = await getStreamerByTwitchId(data.twitch_id);
   const overlayToken = data.overlay_token || (existing ? existing.overlay_token : require('crypto').randomBytes(16).toString('hex'));
  
  const finalData = {
    ...existing,
    ...data,
    overlay_token: overlayToken
  };
  
  // Only encrypt if the value is provided in the update data to avoid double encryption
  // (Encryption removed as beam_api_key and beam_merchant_id are no longer used)
  
  if (existing) {
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
              profile_image_source = COALESCE(?, streamers.profile_image_source),
              profile_image_value = COALESCE(?, streamers.profile_image_value),
              profile_glow_color = COALESCE(?, streamers.profile_glow_color)
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
          finalData.profile_image_source !== undefined ? finalData.profile_image_source : null,
          finalData.profile_image_value !== undefined ? finalData.profile_image_value : null,
          finalData.profile_glow_color !== undefined ? finalData.profile_glow_color : null,
          finalData.twitch_id || null
        ]
      });
  } else {
     await db.execute({
       sql: `INSERT INTO streamers (twitch_id, streamlabs_id, streamlabs_username, username, discord_webhook_url, overlay_token, is_active, 
             duration, soundEnabled, soundChoice, soundVolume, ttsEnabled, ttsReadDonor, ttsVolume, ttsRate, ttsLanguage, ttsVoice, 
             profanityFilterEnabled, profanityWords, profanityReplaceStyle, messageTemplate, amountSuffix, showLabel, showDonorMessage, minAmount, 
             theme, animation, fontFamily, primaryColor, secondaryColor, backgroundColor, textColor, borderColor, particleCount, fontSize,
             customImageMode, customImageValue, customSoundUrl, alert_sound_url, page_title, page_subtitle, thank_you_header, thank_you_subtitle,
              social_twitch, social_youtube, social_tiktok, social_facebook, social_x, social_discord, social_instagram,
              profile_image_source, profile_image_value, profile_glow_color)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        finalData.ttsEnabled !== undefined ? (finalData.ttsEnabled ? 1 : 0) : 0,
        finalData.ttsReadDonor !== undefined ? (finalData.ttsReadDonor ? 1 : 0) : 1,
        finalData.ttsVolume !== undefined ? finalData.ttsVolume : 0.8,
        finalData.ttsRate !== undefined ? finalData.ttsRate : 1.0,
        finalData.ttsLanguage || 'th-TH',
        finalData.ttsVoice || null,
        finalData.profanityFilterEnabled !== undefined ? (finalData.profanityFilterEnabled ? 1 : 0) : 1,
        finalData.profanityWords || null,
        finalData.profanityReplaceStyle || 'asterisks',
        finalData.messageTemplate || '{donor} ได้บริจาค {amount} บาท! 🎉',
        finalData.amountSuffix || 'บาท',
        finalData.showLabel !== undefined ? (finalData.showLabel ? 1 : 0) : 1,
        finalData.showDonorMessage !== undefined ? (finalData.showDonorMessage ? 1 : 0) : 1,
        finalData.minAmount !== undefined ? finalData.minAmount : 1,
        finalData.theme || 'glassmorphism',
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
        finalData.profile_image_source || 'twitch',
        finalData.profile_image_value || null,
        finalData.profile_glow_color || '#005704'
      ]
    });

  }
  
  return { ...finalData, overlay_token: overlayToken };
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

  // 2. Delete associated transactions
  await db.execute({
    sql: 'DELETE FROM transactions WHERE LOWER(streamer_username) = LOWER(?)',
    args: [username]
  });

  // 3. Delete the streamer record
  await db.execute({
    sql: 'DELETE FROM streamers WHERE id = ?',
    args: [id]
  });

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

  // Merge and filter out null values to ensure defaults are used
  const merged = { ...defaultSettings };
  for (const [key, value] of Object.entries(streamer)) {
    if (value !== null) {
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


module.exports = {
  initDB,
  getDB,
  ensureConnected,
  migrateDB,
  getTransactions,
  getTransactionById,
  saveTransaction,
  getSettings,
  saveSettings,
  getStreamer,
  getStreamerByTwitchId,
  getStreamerByStreamlabsId,
  getStreamerByToken,
  getDecryptedStreamer,
  saveStreamer,
  deleteStreamer,
  resolveProfileImage
};
