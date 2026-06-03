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

      // 1. Create/Update streamers table (Consolidated settings)
      await db.execute(`
        CREATE TABLE IF NOT EXISTS streamers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          twitch_id TEXT UNIQUE NOT NULL,
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
          ttsVoice TEXT DEFAULT 'default',
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

           -- Profile System
           profile_image_source TEXT DEFAULT 'twitch',
           profile_image_value TEXT,
           profile_glow_color TEXT DEFAULT '#00ff0e'
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

      // --- Migration Phase ---
      
      // A. Fix transaction column names if they are in snake_case (legacy from some versions)
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

       // C. Ensure new overlay settings columns exist in streamers table
       const streamerColumnsRes = await db.execute('PRAGMA table_info(streamers)');
       const streamerCols = streamerColumnsRes.rows.map(r => r.name);
       
        const requiredCols = [
          { name: 'twitch_id', type: 'TEXT' },
          { name: 'ttsReadDonor', type: 'INTEGER DEFAULT 1' },
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
          { name: 'profile_glow_color', type: "TEXT DEFAULT '#00ff0e'" }
        ];

       for (const col of requiredCols) {
         if (!streamerCols.includes(col.name)) {
           console.log(`🛠️ Migrating streamers: adding column ${col.name}`);
           await db.execute(`ALTER TABLE streamers ADD COLUMN ${col.name} ${col.type}`);
         }
       }


      // B. Migrate legacy global settings to streamers (if settings table exists)
      try {
        const settingsCheck = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'");
        if (settingsCheck.rows.length > 0) {
          console.log('📦 Found legacy settings table. Migrating to streamers...');
          const settingsRes = await db.execute("SELECT value FROM settings WHERE key = 'overlay_settings'");
          if (settingsRes.rows.length > 0) {
            const globalSettings = JSON.parse(settingsRes.rows[0].value);
            
            // Update all existing streamers with these global settings as a base
            const streamers = await db.execute('SELECT username FROM streamers');
            for (const streamer of streamers.rows) {
              const username = streamer.username;
              
              // We only update if the value is provided in globalSettings
              const updates = [];
              const args = [];
              
              // Only update columns that actually exist in the streamers table
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
          // Optionally drop the settings table now that it's migrated
          // await db.execute('DROP TABLE settings'); 
          // We keep it for a while or just ignore it. To be clean, let's drop it.
          await db.execute('DROP TABLE settings');
          console.log('🗑️ Legacy settings table removed.');
        }
      } catch (e) {
        console.warn('⚠️ Settings migration failed or not needed:', e.message);
      }

      console.log('✅ Turso Database schema verified and migrated.');

    } catch (err) {
      console.warn('⚠️ Warning: Cannot connect to Turso database. Falling back to in-memory database.');
      console.warn('Error details:', err.message);
      useInMemoryFallback(err.message);
    }
    isInitialized = true;
  })();

  return initPromise;
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
    sql += ' WHERE streamer_username = ?';
    args.push(username);
  }
  
  sql += ' ORDER BY createdAt DESC';
  
  const result = await db.execute({ sql, args });
  return result.rows.map(row => ({
    ...row,
    raw_response: row.raw_response ? JSON.parse(row.raw_response) : null,
    raw_webhook: row.raw_webhook ? JSON.parse(row.raw_webhook) : null
  }));
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
  await ensureConnected();
  if (isFallback) return null;
  if (!db) return null;
  const result = await db.execute({
    sql: 'SELECT * FROM streamers WHERE twitch_id = ?',
    args: [twitchId]
  });
  return result.rows[0] || null;
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
  
  const existing = await getStreamer(data.username);
  const overlayToken = data.overlay_token || (existing ? existing.overlay_token : `ready1`);
  
  const finalData = {
    ...existing,
    ...data,
    overlay_token: overlayToken
  };
  
  // Only encrypt if the value is provided in the update data to avoid double encryption
  // (Encryption removed as beam_api_key and beam_merchant_id are no longer used)
  
    await db.execute({
      sql: `INSERT INTO streamers (twitch_id, username, discord_webhook_url, overlay_token, is_active, 
            duration, soundEnabled, soundChoice, soundVolume, ttsEnabled, ttsReadDonor, ttsVolume, ttsRate, ttsLanguage, ttsVoice, 
            profanityFilterEnabled, profanityWords, profanityReplaceStyle, messageTemplate, amountSuffix, showLabel, showDonorMessage, minAmount, 
            theme, animation, fontFamily, primaryColor, secondaryColor, backgroundColor, textColor, borderColor, particleCount, fontSize,
            alert_sound_url, page_title, page_subtitle, thank_you_header, thank_you_subtitle,
             social_twitch, social_youtube, social_tiktok, social_facebook, social_x, social_discord, social_instagram,
             profile_image_source, profile_image_value, profile_glow_color)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(username) DO UPDATE SET
                twitch_id = excluded.twitch_id,
               discord_webhook_url = COALESCE(excluded.discord_webhook_url, streamers.discord_webhook_url),
               overlay_token = excluded.overlay_token,
               is_active = COALESCE(excluded.is_active, streamers.is_active),

               duration = COALESCE(excluded.duration, streamers.duration),
               soundEnabled = COALESCE(excluded.soundEnabled, streamers.soundEnabled),
               soundChoice = COALESCE(excluded.soundChoice, streamers.soundChoice),
               soundVolume = COALESCE(excluded.soundVolume, streamers.soundVolume),
               ttsEnabled = COALESCE(excluded.ttsEnabled, streamers.ttsEnabled),
               ttsReadDonor = COALESCE(excluded.ttsReadDonor, streamers.ttsReadDonor),
               ttsVolume = COALESCE(excluded.ttsVolume, streamers.ttsVolume),
               ttsRate = COALESCE(excluded.ttsRate, streamers.ttsRate),
               ttsLanguage = COALESCE(excluded.ttsLanguage, streamers.ttsLanguage),
               ttsVoice = COALESCE(excluded.ttsVoice, streamers.ttsVoice),
               profanityFilterEnabled = COALESCE(excluded.profanityFilterEnabled, streamers.profanityFilterEnabled),
               profanityWords = COALESCE(excluded.profanityWords, streamers.profanityWords),
               profanityReplaceStyle = COALESCE(excluded.profanityReplaceStyle, streamers.profanityReplaceStyle),
               messageTemplate = COALESCE(excluded.messageTemplate, streamers.messageTemplate),
               amountSuffix = COALESCE(excluded.amountSuffix, streamers.amountSuffix),
               showLabel = COALESCE(excluded.showLabel, streamers.showLabel),
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
               alert_sound_url = COALESCE(excluded.alert_sound_url, streamers.alert_sound_url),
               page_title = COALESCE(excluded.page_title, streamers.page_title),
               page_subtitle = COALESCE(excluded.page_subtitle, streamers.page_subtitle),
               thank_you_header = COALESCE(excluded.thank_you_header, streamers.thank_you_header),
               thank_you_subtitle = COALESCE(excluded.thank_you_subtitle, streamers.thank_you_subtitle),
               social_twitch = excluded.social_twitch,
               social_youtube = excluded.social_youtube,
               social_tiktok = excluded.social_tiktok,
               social_facebook = excluded.social_facebook,
               social_x = excluded.social_x,
               social_discord = excluded.social_discord,
               social_instagram = excluded.social_instagram,
               profile_image_source = COALESCE(excluded.profile_image_source, streamers.profile_image_source),
               profile_image_value = COALESCE(excluded.profile_image_value, streamers.profile_image_value),
               profile_glow_color = COALESCE(excluded.profile_glow_color, streamers.profile_glow_color)`,
            args: [
             finalData.twitch_id || null,
             finalData.username || null,
             finalData.discord_webhook_url || null,
             overlayToken || null,
             finalData.is_active !== undefined ? (finalData.is_active ? 1 : 0) : null,
             finalData.duration !== undefined ? finalData.duration : null,
             finalData.soundEnabled !== undefined ? (finalData.soundEnabled ? 1 : 0) : null,
             finalData.soundChoice || null,
             finalData.soundVolume !== undefined ? finalData.soundVolume : null,
             finalData.ttsEnabled !== undefined ? (finalData.ttsEnabled ? 1 : 0) : null,
             finalData.ttsReadDonor !== undefined ? (finalData.ttsReadDonor ? 1 : 0) : null,
             finalData.ttsVolume !== undefined ? finalData.ttsVolume : null,
             finalData.ttsRate !== undefined ? finalData.ttsRate : null,
             finalData.ttsLanguage || null,
             finalData.ttsVoice || null,
             finalData.profanityFilterEnabled !== undefined ? (finalData.profanityFilterEnabled ? 1 : 0) : null,
             finalData.profanityWords || null,
             finalData.profanityReplaceStyle || null,
             finalData.messageTemplate || null,
             finalData.amountSuffix || null,
             finalData.showLabel !== undefined ? (finalData.showLabel ? 1 : 0) : null,
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
             finalData.alert_sound_url || null,
             finalData.page_title !== undefined ? finalData.page_title : null,
             finalData.page_subtitle !== undefined ? finalData.page_subtitle : null,
             finalData.thank_you_header !== undefined ? finalData.thank_you_header : null,
             finalData.thank_you_subtitle !== undefined ? finalData.thank_you_subtitle : null,
             finalData.social_twitch || null,
             finalData.social_youtube || null,
             finalData.social_tiktok || null,
             finalData.social_facebook || null,
             finalData.social_x || null,
             finalData.social_discord || null,
             finalData.social_instagram || null,
             finalData.profile_image_source || 'twitch',
             finalData.profile_image_value !== undefined ? finalData.profile_image_value : null,
             finalData.profile_glow_color || '#00ff0e'
           ]
        });
  
  return { ...finalData, overlay_token: overlayToken };
}

const axios = require('axios'); // Use axios for simpler API calls

let profileImageCache = {};

/**
 * Fetches a Twitch App Access Token using Client Credentials flow.
 */
async function getTwitchAccessToken() {
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
    return response.data.access_token;
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
  getTransactions,
  getTransactionById,
  saveTransaction,
  getSettings,
  saveSettings,
  getStreamer,
  getStreamerByTwitchId,
  getStreamerByToken,
  getDecryptedStreamer,
  saveStreamer,
  resolveProfileImage
};
