require('dotenv').config();
const db = require('./src/database');
async function run() {
  try {
    await db.initDB();
    const user = await db.saveStreamer({
      username: "kaminkub",
      beam_api_key: "dummy_api_key",
      beam_merchant_id: "dummy_merchant_id"
      // omit overlay_token to test auto-generation
    });
    console.log("✅ User KaminKub updated!");
    console.log("🔑 Generated Token:", user.overlay_token);
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }
}
run();