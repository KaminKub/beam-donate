const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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

      // 1. Create streamers table (Consolidated settings)
      await db.execute(`
        CREATE TABLE IF NOT EXISTS streamers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          beam_api_key TEXT NOT NULL,
          beam_merchant_id TEXT NOT NULL,
          discord_webhook_url TEXT,
          overlay_token TEXT NOT NULL,
          is_active INTEGER DEFAULT 1,
          
          -- Overlay Settings
          duration INTEGER DEFAULT 8,
          soundEnabled INTEGER DEFAULT 1,
          soundChoice TEXT DEFAULT 'chime',
          soundVolume REAL DEFAULT 0.5,
          ttsEnabled INTEGER DEFAULT 0,
          ttsVolume REAL DEFAULT 0.8,
          ttsRate REAL DEFAULT 1.0,
          ttsLanguage TEXT DEFAULT 'th-TH',
          ttsVoice TEXT DEFAULT 'default',
          profanityFilterEnabled INTEGER DEFAULT 1,
          profanityWords TEXT,
          profanityReplaceStyle TEXT DEFAULT 'asterisks',
          messageTemplate TEXT DEFAULT '{donor} ได้บริจาค {amount} บาท! 🎉',
          showDonorMessage INTEGER DEFAULT 1,
          minAmount REAL DEFAULT 1,
          theme TEXT DEFAULT 'glassmorphism',
          animation TEXT DEFAULT 'slide-down',
          fontFamily TEXT DEFAULT 'Noto Sans Thai',
          primaryColor TEXT DEFAULT '#667eea',
          secondaryColor TEXT DEFAULT '#764ba2',
          backgroundColor TEXT DEFAULT 'rgba(255, 255, 255, 0.1)',
          textColor TEXT DEFAULT '#ffffff',
          borderColor TEXT DEFAULT 'rgba(255, 255, 255, 0.25)',
          particleCount INTEGER DEFAULT 15,
          fontSize INTEGER DEFAULT 32,
          
          -- Custom assets
          alert_sound_url TEXT
        )
      `);

      // 2. Create transactions table (Simplified)
      await db.execute(`
        CREATE TABLE IF NOT EXISTS transactions (
          id TEXT PRIMARY KEY,
          streamer_username TEXT NOT NULL,
          donor_name TEXT DEFAULT 'Anonymous',
          amount REAL NOT NULL,
          message TEXT DEFAULT '',
          created_at TEXT NOT NULL,
          FOREIGN KEY (streamer_username) REFERENCES streamers(username)
        )
      `);

      console.log('✅ Turso Database tables verified (New Structure).');
    } catch (err) {
      console.warn('⚠️ Warning: Cannot connect to Turso database. Falling back to in-memory database.');
      console.warn('Error details:', err.message);
      useInMemoryFallback(err.message);
    }
  })();

  return initPromise;
}

/**
 * Wait until database initialization finishes to avoid query race conditions during hot-reload.
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
 * Fallback to in-memory lists when Turso DB is offline or environment variables are missing.
 */
function useInMemoryFallback(reason) {
  isFallback = true;
  isInitialized = true; // Mark as initialized so fallback operations can execute immediately
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

  // Try to load any readable transactions
  for (const file of filesToTryTx) {
    try {
      if (fs.existsSync(file)) {
        memoryTransactions = JSON.parse(fs.readFileSync(file, 'utf8'));
        console.log(`📦 Loaded ${memoryTransactions.length} transactions into memory from ${path.basename(file)}`);
        break;
      }
    } catch (e) {}
  }

  // Try to load any readable settings
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
 * Optional: filter by streamer_username.
 */
async function getTransactions(username = null) {
  await ensureConnected();
  if (isFallback) {
    let txs = [...memoryTransactions];
    if (username) {
      txs = txs.filter(t => t.streamer_username === username);
    }
    return txs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  if (!db) return [];
  
  let sql = 'SELECT * FROM transactions';
  let args = [];
  
  if (username) {
    sql += ' WHERE streamer_username = ?';
    args.push(username);
  }
  
  sql += ' ORDER BY created_at DESC';
  
  const result = await db.execute({ sql, args });
  return result.rows;
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
  return {
    ...row,
    raw_response: row.raw_response ? JSON.parse(row.raw_response) : null,
    raw_webhook: row.raw_webhook ? JSON.parse(row.raw_webhook) : null
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
        donor_name: data.donor || data.donor_name || 'Anonymous',
        amount: data.amount || 0,
        message: data.message || '',
        created_at: data.created_at || now
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
  await db.execute({
    sql: `INSERT INTO transactions (id, streamer_username, donor_name, amount, message, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            donor_name = excluded.donor_name,
            amount = excluded.amount,
            message = excluded.message,
            created_at = excluded.created_at`,
    args: [
      data.id,
      data.streamer_username,
      data.donor || data.donor_name || 'Anonymous',
      data.amount || 0,
      data.message || '',
      data.created_at || now
    ]
  });
  
  return data;
}

/**
 * Fetch streamer details by username.
 */
async function getStreamer(username) {
  await ensureConnected();
  if (!db) return null;
  const result = await db.execute({
    sql: 'SELECT * FROM streamers WHERE username = ?',
    args: [username]
  });
  return result.rows[0] || null;
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

  // Generate overlay token as requested
  const overlayToken = data.overlay_token || `ready1`;
  
  // 1. Try to get existing streamer to avoid NOT NULL constraints on INSERT
  const existing = await getStreamer(data.username);
  
  const finalData = {
    ...existing,
    ...data,
    overlay_token: overlayToken
  };

  // Ensure required fields are present (especially for new streamers)
  if (!finalData.beam_api_key || !finalData.beam_merchant_id) {
    if (!existing) {
      throw new Error('Missing required credentials (beam_api_key or beam_merchant_id) for new streamer.');
    }
  }

  await db.execute({
    sql: `INSERT INTO streamers (username, beam_api_key, beam_merchant_id, discord_webhook_url, overlay_token, is_active, 
          duration, soundEnabled, soundChoice, soundVolume, ttsEnabled, ttsVolume, ttsRate, ttsLanguage, ttsVoice, 
          profanityFilterEnabled, profanityWords, profanityReplaceStyle, messageTemplate, showDonorMessage, minAmount, 
          theme, animation, fontFamily, primaryColor, secondaryColor, backgroundColor, textColor, borderColor, particleCount, fontSize,
          alert_sound_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(username) DO UPDATE SET
            beam_api_key = COALESCE(excluded.beam_api_key, streamers.beam_api_key),
            beam_merchant_id = COALESCE(excluded.beam_merchant_id, streamers.beam_merchant_id),
            discord_webhook_url = COALESCE(excluded.discord_webhook_url, streamers.discord_webhook_url),
            overlay_token = excluded.overlay_token,
            is_active = COALESCE(excluded.is_active, streamers.is_active),
            duration = COALESCE(excluded.duration, streamers.duration),
            soundEnabled = COALESCE(excluded.soundEnabled, streamers.soundEnabled),
            soundChoice = COALESCE(excluded.soundChoice, streamers.soundChoice),
            soundVolume = COALESCE(excluded.soundVolume, streamers.soundVolume),
            ttsEnabled = COALESCE(excluded.ttsEnabled, streamers.ttsEnabled),
            ttsVolume = COALESCE(excluded.ttsVolume, streamers.ttsVolume),
            ttsRate = COALESCE(excluded.ttsRate, streamers.ttsRate),
            ttsLanguage = COALESCE(excluded.ttsLanguage, streamers.ttsLanguage),
            ttsVoice = COALESCE(excluded.ttsVoice, streamers.ttsVoice),
            profanityFilterEnabled = COALESCE(excluded.profanityFilterEnabled, streamers.profanityFilterEnabled),
            profanityWords = COALESCE(excluded.profanityWords, streamers.profanityWords),
            profanityReplaceStyle = COALESCE(excluded.profanityReplaceStyle, streamers.profanityReplaceStyle),
            messageTemplate = COALESCE(excluded.messageTemplate, streamers.messageTemplate),
            showDonorMessage = COALESCE(excluded.showDonorMessage, streamers.showDonorMessage),
            minAmount = COALESCE(excluded.minAmount, streamers.minAmount),
            theme = COALESCE(excluded.theme, streamers.theme),
            animation = COALESCE(excluded.animation, streamers.animation),
            fontFamily = COALESCE(excluded.fontFamily, streamers.fontFamily),
            primaryColor = COALESCE(excluded.primaryColor, streamers.primaryColor),
            secondaryColor = COALESCE(excluded.secondaryColor, streamers.secondaryColor),
            backgroundColor = COALESCE(excluded.backgroundColor, streamers.backgroundColor),
            textColor = COALESCE(excluded.textColor, streamers.textColor),
            borderColor = COALESCE(excluded.borderColor, streamers.borderColor),
            particleCount = COALESCE(excluded.particleCount, streamers.particleCount),
            fontSize = COALESCE(excluded.fontSize, streamers.fontSize),
            alert_sound_url = COALESCE(excluded.alert_sound_url, streamers.alert_sound_url)`,
    args: [
      finalData.username,
      finalData.beam_api_key || null,
      finalData.beam_merchant_id || null,
      finalData.discord_webhook_url || null,
      overlayToken,
      finalData.is_active !== undefined ? (finalData.is_active ? 1 : 0) : null,
      finalData.duration !== undefined ? finalData.duration : null,
      finalData.soundEnabled !== undefined ? (finalData.soundEnabled ? 1 : 0) : null,
      finalData.soundChoice || null,
      finalData.soundVolume !== undefined ? finalData.soundVolume : null,
      finalData.ttsEnabled !== undefined ? (finalData.ttsEnabled ? 1 : 0) : null,
      finalData.ttsVolume !== undefined ? finalData.ttsVolume : null,
      finalData.ttsRate !== undefined ? finalData.ttsRate : null,
      finalData.ttsLanguage || null,
      finalData.ttsVoice || null,
      finalData.profanityFilterEnabled !== undefined ? (finalData.profanityFilterEnabled ? 1 : 0) : null,
      finalData.profanityWords || null,
      finalData.profanityReplaceStyle || null,
      finalData.messageTemplate || null,
      finalData.showDonorMessage !== undefined ? (finalData.showDonorMessage ? 1 : 0) : null,
      finalData.minAmount !== undefined ? finalData.minAmount : null,
      finalData.theme || null,
      finalData.animation || null,
      finalData.fontFamily || null,
      finalData.primaryColor || null,
      finalData.secondaryColor || null,
      finalData.backgroundColor || null,
      finalData.textColor || null,
      finalData.borderColor || null,
      finalData.particleCount !== undefined ? finalData.particleCount : null,
      finalData.fontSize !== undefined ? finalData.fontSize : null,
      finalData.alert_sound_url || null
    ]
  });
  
  return { ...finalData, overlay_token: overlayToken };
}

/**
 * Fetch overlay settings from database or return default.
 */
async function getSettings(defaultSettings) {
  await ensureConnected();
  if (isFallback) {
    return memorySettings ? { ...defaultSettings, ...memorySettings } : defaultSettings;
  }
  if (!db) return defaultSettings;
  const result = await db.execute({
    sql: 'SELECT value FROM settings WHERE key = ?',
    args: ['overlay_settings']
  });
  const row = result.rows[0];
  if (!row) {
    return defaultSettings;
  }
  try {
    return { ...defaultSettings, ...JSON.parse(row.value) };
  } catch (e) {
    return defaultSettings;
  }
}

/**
 * Save overlay settings.
 */
async function saveSettings(settings) {
  await ensureConnected();
  if (isFallback) {
    memorySettings = settings;
    try {
      const DB_DIR = path.join(__dirname, '../data');
      fs.writeFileSync(path.join(DB_DIR, 'overlay-settings.json'), JSON.stringify(memorySettings, null, 2));
    } catch (e) {}
    return settings;
  }

  if (!db) throw new Error('Database not initialized');
  const valueStr = JSON.stringify(settings);
  const checkResult = await db.execute({
    sql: 'SELECT 1 FROM settings WHERE key = ?',
    args: ['overlay_settings']
  });
  const existing = checkResult.rows[0];
  
  if (existing) {
    await db.execute({
      sql: 'UPDATE settings SET value = ? WHERE key = ?',
      args: [valueStr, 'overlay_settings']
    });
  } else {
    await db.execute({
      sql: 'INSERT INTO settings (key, value) VALUES (?, ?)',
      args: ['overlay_settings', valueStr]
    });
  }
  
  return settings;
}

module.exports = {
  initDB,
  getTransactions,
  getTransactionById,
  saveTransaction,
  getStreamer,
  saveStreamer
};
