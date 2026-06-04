const session = require('express-session');
const { getDB, ensureConnected } = require('./database');

class TursoStore extends session.Store {
  constructor() {
    super();
  }

  async get(sid, callback) {
    try {
      await ensureConnected();
      const db = getDB();
      const result = await db.execute({
        sql: 'SELECT session FROM sessions WHERE sid = ?',
        args: [sid]
      });
      if (result.rows.length === 0) {
        return callback(null, null);
      }
      const sessionData = JSON.parse(result.rows[0].session);
      callback(null, sessionData);
    } catch (err) {
      callback(err);
    }
  }

  async set(sid, sessionData, callback) {
    try {
      await ensureConnected();
      const db = getDB();
      const expires = this.ttl ? Date.now() + this.ttl : null;
      await db.execute({
        sql: 'INSERT INTO sessions (sid, session, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET session = excluded.session, expires = excluded.expires',
        args: [sid, JSON.stringify(sessionData), expires]
      });
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  async destroy(sid, callback) {
    try {
      await ensureConnected();
      const db = getDB();
      await db.execute({
        sql: 'DELETE FROM sessions WHERE sid = ?',
        args: [sid]
      });
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

module.exports = TursoStore;
