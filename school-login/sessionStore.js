const session = require("express-session");

function getExpiry(sess) {
  if (sess?.cookie?.expires) return new Date(sess.cookie.expires);
  if (typeof sess?.cookie?.maxAge === "number") {
    return new Date(Date.now() + sess.cookie.maxAge);
  }
  return new Date(Date.now() + 1000 * 60 * 60);
}

class InMemorySessionStore extends session.Store {
  constructor() {
    super();
    this.sessions = new Map();
  }

  get(sid, cb) {
    const entry = this.sessions.get(sid);
    if (!entry) return cb(null, null);
    if (entry.expire <= Date.now()) {
      this.sessions.delete(sid);
      return cb(null, null);
    }
    return cb(null, entry.sess);
  }

  set(sid, sess, cb) {
    const expire = getExpiry(sess).getTime();
    this.sessions.set(sid, { sess, expire });
    if (typeof cb === "function") cb(null);
  }

  destroy(sid, cb) {
    this.sessions.delete(sid);
    if (typeof cb === "function") cb(null);
  }

  touch(sid, sess, cb) {
    const entry = this.sessions.get(sid);
    if (entry) {
      entry.expire = getExpiry(sess).getTime();
      entry.sess = sess;
    }
    if (typeof cb === "function") cb(null);
  }
}

class PgSessionStore extends session.Store {
  constructor(pool, options = {}) {
    super();
    this.pool = pool;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60 * 60 * 1000;
    if (this.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => this.prune(), this.cleanupIntervalMs);
      if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }
  }

  get(sid, cb) {
    this.pool
      .query("SELECT sess, expire FROM sessions WHERE sid = $1", [sid])
      .then((result) => {
        const row = result.rows[0];
        if (!row) return cb(null, null);
        const expiresAt = new Date(row.expire);
        if (expiresAt <= new Date()) {
          return this.destroy(sid, () => cb(null, null));
        }
        const sess = typeof row.sess === "string" ? JSON.parse(row.sess) : row.sess;
        return cb(null, sess);
      })
      .catch((err) => cb(err));
  }

  set(sid, sess, cb) {
    const expire = getExpiry(sess);
    const payload = JSON.stringify(sess);
    this.pool
      .query(
        "INSERT INTO sessions (sid, sess, expire) VALUES ($1, $2::jsonb, $3) ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire",
        [sid, payload, expire]
      )
      .then(() => cb && cb(null))
      .catch((err) => cb && cb(err));
  }

  destroy(sid, cb) {
    this.pool
      .query("DELETE FROM sessions WHERE sid = $1", [sid])
      .then(() => cb && cb(null))
      .catch((err) => cb && cb(err));
  }

  touch(sid, sess, cb) {
    const expire = getExpiry(sess);
    this.pool
      .query("UPDATE sessions SET expire = $2 WHERE sid = $1", [sid, expire])
      .then(() => cb && cb(null))
      .catch((err) => cb && cb(err));
  }

  prune() {
    return this.pool
      .query("DELETE FROM sessions WHERE expire < NOW()")
      .catch((err) => console.error("Session cleanup error:", err));
  }
}

function buildSessionStore({ pool, isFakeDb, cleanupIntervalMs } = {}) {
  if (pool) return new PgSessionStore(pool, { cleanupIntervalMs });
  if (isFakeDb) return new InMemorySessionStore();
  throw new Error("Session store requires a database pool.");
}

module.exports = { buildSessionStore };
