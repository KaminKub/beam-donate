require('dotenv').config();
const db = require('../src/database');

async function runMigration() {
  try {
    console.log('🚀 Starting Database Migration Script...');
    await db.initDB();
    await db.migrateDB();
    console.log('✅ Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runMigration();
