require("dotenv").config();
const db = require("./src/database");

async function migrate() {
  try {
    await db.initDB();
    // Access the internal db client from database.js via a hack or by modifying database.js
    // Since db is not exported, I will use a script that can access it or just run a raw SQL.
    // Actually, I can modify database.js temporarily to export the client or just use a separate client.
    
    const { createClient } = require("@libsql/client");
    const client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN
    });

    console.log("🗑️ Dropping old tables...");
    await client.execute("DROP TABLE IF EXISTS settings");
    await client.execute("DROP TABLE IF EXISTS transactions");
    await client.execute("DROP TABLE IF EXISTS streamers");
    console.log("✅ Old tables dropped.");

    console.log("🛠️ Re-initializing database with new structure...");
    await db.initDB(); 
    // Note: initDB is called once and stored in initPromise. 
    // Since it was already called at the top of the script, I might need to force it.
    // But the easiest way is to just execute the CREATE TABLE statements again.
    
    // Let us just use the logic inside initDB by calling the create statements manually here.
    await client.execute(`
        CREATE TABLE IF NOT EXISTS streamers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          beam_api_key TEXT NOT NULL,
          beam_merchant_id TEXT NOT NULL,
          discord_webhook_url TEXT,
          overlay_token TEXT NOT NULL,
          is_active INTEGER DEFAULT 1,
          duration INTEGER DEFAULT 8,
          soundEnabled INTEGER DEFAULT 1,
          soundChoice TEXT DEFAULT "chime",
          soundVolume REAL DEFAULT 0.5,
          ttsEnabled INTEGER DEFAULT 0,
          ttsVolume REAL DEFAULT 0.8,
          ttsRate REAL DEFAULT 1.0,
          ttsLanguage TEXT DEFAULT "th-TH",
          ttsVoice TEXT DEFAULT "default",
          profanityFilterEnabled INTEGER DEFAULT 1,
          profanityWords TEXT,
          profanityReplaceStyle TEXT DEFAULT "asterisks",
          messageTemplate TEXT DEFAULT "{donor} ได้บริจาค {amount} บาท! 🎉",
          showDonorMessage INTEGER DEFAULT 1,
          minAmount REAL DEFAULT 1,
          theme TEXT DEFAULT "glassmorphism",
          animation TEXT DEFAULT "slide-down",
          fontFamily TEXT DEFAULT "Noto Sans Thai",
          primaryColor TEXT DEFAULT "#667eea",
          secondaryColor TEXT DEFAULT "#764ba2",
          backgroundColor TEXT DEFAULT "rgba(255, 255, 255, 0.1)",
          textColor TEXT DEFAULT "#ffffff",
          borderColor TEXT DEFAULT "rgba(255, 255, 255, 0.25)",
          particleCount INTEGER DEFAULT 15,
          fontSize INTEGER DEFAULT 32,
          alert_sound_url TEXT
        )
    `);

    await client.execute(`
        CREATE TABLE IF NOT EXISTS transactions (
          id TEXT PRIMARY KEY,
          streamer_username TEXT NOT NULL,
          donor_name TEXT DEFAULT "Anonymous",
          amount REAL NOT NULL,
          message TEXT DEFAULT "",
          created_at TEXT NOT NULL,
          FOREIGN KEY (streamer_username) REFERENCES streamers(username)
        )
    `);

    console.log("✅ New structure applied to Turso.");

    console.log("👤 Adding test user KaminKub...");
    await db.saveStreamer({
      username: "kaminkub",
      beam_api_key: "test_key",
      beam_merchant_id: "test_merchant"
    });
    console.log("✅ User KaminKub added.");

    process.exit(0);
  } catch (err) {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  }
}
migrate();