'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'database', 'control.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');

const now = () => new Date().toISOString();

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));

  if (!applied.has(1)) {
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE admins (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password_hash TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          exhausted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          revoked_at TEXT,
          quota_bytes INTEGER NOT NULL DEFAULT 0,
          used_upload INTEGER NOT NULL DEFAULT 0,
          used_download INTEGER NOT NULL DEFAULT 0,
          last_connection TEXT,
          last_seen TEXT
        );
        CREATE TABLE vpn_clients (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          uuid TEXT NOT NULL UNIQUE,
          transport TEXT NOT NULL DEFAULT 'ws',
          created_at TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE TABLE subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          token TEXT NOT NULL UNIQUE,
          path TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE TABLE traffic_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          ts TEXT NOT NULL,
          upload_bytes INTEGER NOT NULL,
          download_bytes INTEGER NOT NULL,
          total_bytes INTEGER NOT NULL,
          source TEXT NOT NULL
        );
        CREATE TABLE quota_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          ts TEXT NOT NULL,
          action TEXT NOT NULL,
          delta_bytes INTEGER NOT NULL DEFAULT 0,
          quota_before INTEGER NOT NULL,
          quota_after INTEGER NOT NULL,
          actor TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE connection_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          ts_start TEXT NOT NULL,
          ts_end TEXT,
          upload_bytes INTEGER NOT NULL DEFAULT 0,
          download_bytes INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'open',
          remote TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE server_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          cpu_pct REAL NOT NULL,
          ram_used_kb INTEGER NOT NULL,
          ram_total_kb INTEGER NOT NULL,
          net_rx_bytes INTEGER NOT NULL,
          net_tx_bytes INTEGER NOT NULL,
          active_vpn INTEGER NOT NULL,
          api_latency_ms REAL NOT NULL
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          target TEXT NOT NULL DEFAULT '',
          detail TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          csrf TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_traffic_user_ts ON traffic_usage(user_id, ts);
        CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
        CREATE INDEX idx_audit_ts ON audit_logs(ts);
        CREATE INDEX idx_metrics_ts ON server_metrics(ts);
      `);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(1, now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return applied;
}
migrate();

function audit(actor, action, target = '', detail = '') {
  db.prepare('INSERT INTO audit_logs (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .run(now(), String(actor), String(action), String(target), String(detail));
}

function getSetting(key, fallback = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

function adminExists() {
  return !!db.prepare('SELECT 1 FROM admins LIMIT 1').get();
}
function createAdmin(username, hash) {
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO admins (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(username, hash, now(), now());
    setSetting('admin_setup_complete', '1');
    audit('system', 'admin_created', username);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function seedAdminFromEnv(username, hash) {
  const existing = getAdmin();
  if (!existing) {
    createAdmin(username, hash);
    return;
  }
  db.prepare('UPDATE admins SET username = ?, password_hash = ?, updated_at = ? WHERE id = ?')
    .run(username, hash, now(), existing.id);
  setSetting('admin_setup_complete', '1');
  audit('system', 'admin_synced_from_env', 'admin');
}

function getAdmin() {
  return db.prepare('SELECT * FROM admins ORDER BY id LIMIT 1').get();
}
function updateAdminHash(hash) {
  const a = getAdmin();
  db.prepare('UPDATE admins SET password_hash=?, updated_at=? WHERE id=?').run(hash, now(), a.id);
  audit('admin', 'admin_password_changed', a.username);
}

function friendCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM users WHERE revoked_at IS NULL').get().c;
}
function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY id').all();
}
function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}
function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username=?').get(username);
}
function getUserByToken(token) {
  return db.prepare('SELECT u.* FROM users u JOIN subscriptions s ON s.user_id=u.id WHERE s.token=?').get(token);
}
function getVpnClient(userId) {
  return db.prepare('SELECT * FROM vpn_clients WHERE user_id=?').get(userId);
}
function getSubscription(userId) {
  return db.prepare('SELECT * FROM subscriptions WHERE user_id=?').get(userId);
}

function createFriend({ username, displayName, passwordHash, quotaBytes, expiresAt, uuid, token }) {
  const id = crypto.randomUUID();
  db.exec('BEGIN');
  try {
    const r = db.prepare(`INSERT INTO users
      (username, display_name, password_hash, enabled, exhausted, created_at, expires_at, quota_bytes)
      VALUES (?, ?, ?, 1, 0, ?, ?, ?)`).run(username, displayName, passwordHash, now(), expiresAt || null, quotaBytes || 0);
    const uid = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO vpn_clients (user_id, uuid, transport, created_at) VALUES (?, ?, ?, ?)')
      .run(uid, uuid || crypto.randomUUID(), 'ws', now());
    const subToken = token || crypto.randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO subscriptions (user_id, token, path, created_at) VALUES (?, ?, ?, ?)')
      .run(uid, subToken, `/vpn/${subToken}`, now());
    audit('admin', 'friend_created', username, 'quota=' + (quotaBytes || 0));
    db.exec('COMMIT');
    return getUser(uid);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function setFriendPassword(id, hash) {
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, id);
  audit('admin', 'friend_password_reset', String(id));
}

function changeQuota(id, action, deltaBytes, quotaBytes, actor) {
  const u = getUser(id);
  if (!u) return null;
  const before = u.quota_bytes;
  const after = action === 'set' ? quotaBytes : Math.max(0, before + deltaBytes);
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET quota_bytes=?, exhausted=CASE WHEN ? > 0 AND ? >= ? THEN 1 ELSE exhausted END WHERE id=?')
      .run(after, after, u.used_upload + u.used_download, after, id);
    db.prepare('INSERT INTO quota_history (user_id, ts, action, delta_bytes, quota_before, quota_after, actor) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, now(), action, after - before, before, after, actor);
    audit(actor, 'quota_' + action, String(id), `delta=${after - before}`);
    db.exec('COMMIT');
    return getUser(id);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function setUserState(id, patch, actor) {
  const u = getUser(id);
  if (!u) return null;
  const fields = [];
  const vals = [];
  for (const k of ['enabled', 'exhausted', 'expires_at', 'display_name', 'uuid']) {
    if (patch[k] !== undefined) { fields.push(`${k}=?`); vals.push(patch[k]); }
  }
  if (fields.length) {
    db.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).run(...vals, id);
  }
  if (patch.uuid !== undefined) {
    db.prepare('UPDATE vpn_clients SET uuid=? WHERE user_id=?').run(patch.uuid, id);
  }
  audit(actor, 'user_updated', String(id), Object.keys(patch).join(','));
  return getUser(id);
}

function revokeFriend(id, actor) {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET enabled=0, revoked_at=? WHERE id=?').run(now(), id);
    db.prepare('UPDATE subscriptions SET revoked_at=? WHERE user_id=?').run(now(), id);
    db.prepare('UPDATE vpn_clients SET revoked_at=? WHERE user_id=?').run(now(), id);
    audit(actor, 'friend_revoked', String(id));
    db.exec('COMMIT');
    return getUser(id);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function recordTraffic(userId, up, down, source = 'ws-proxy', ts = now()) {
  if (!up && !down) return;
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO traffic_usage (user_id, ts, upload_bytes, download_bytes, total_bytes, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, ts, up, down, up + down, source);
    db.prepare('UPDATE users SET used_upload=used_upload+?, used_download=used_download+?, last_seen=? WHERE id=?')
      .run(up, down, ts, userId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function trafficHistory(userId, limit = 100) {
  return db.prepare('SELECT ts, upload_bytes, download_bytes, total_bytes FROM traffic_usage WHERE user_id=? ORDER BY id DESC LIMIT ?').all(userId, limit);
}

function openSession(userId, role) {
  const id = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + (role === 'admin' ? 2 * 3600e3 : 12 * 3600e3)).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, role, csrf, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, userId, role, csrf, expiresAt, now());
  return { id, csrf, expiresAt };
}
function getSession(id) {
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
  if (!s) return null;
  if (Date.parse(s.expires_at) <= Date.now()) { db.prepare('DELETE FROM sessions WHERE id=?').run(id); return null; }
  return s;
}
function deleteSession(id) { db.prepare('DELETE FROM sessions WHERE id=?').run(id); }
function purgeSessions() { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()); }

function addMetric(m) {
  db.prepare('INSERT INTO server_metrics (ts, cpu_pct, ram_used_kb, ram_total_kb, net_rx_bytes, net_tx_bytes, active_vpn, api_latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(now(), m.cpu_pct, m.ram_used_kb, m.ram_total_kb, m.net_rx_bytes, m.net_tx_bytes, m.active_vpn, m.api_latency_ms);
}
function metrics(limit = 60) {
  return db.prepare('SELECT * FROM server_metrics ORDER BY id DESC LIMIT ?').all(limit);
}

function activeVpnUsers() {
  return db.prepare(`SELECT u.id, u.username, u.exhausted, u.enabled, u.quota_bytes, u.used_upload, u.used_download,
    c.uuid, s.token, s.path FROM users u JOIN vpn_clients c ON c.user_id=u.id JOIN subscriptions s ON s.user_id=u.id
    WHERE u.revoked_at IS NULL AND u.enabled=1 AND u.exhausted=0`).all();
}

function auditLogs(limit = 50) {
  return db.prepare('SELECT ts, actor, action, target, detail FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = {
  ROOT, DB_PATH, db, now, audit, getSetting, setSetting,
  adminExists, createAdmin, seedAdminFromEnv, getAdmin, updateAdminHash,
  friendCount, listUsers, getUser, getUserByUsername, getUserByToken, getVpnClient, getSubscription,
  createFriend, setFriendPassword, changeQuota, setUserState, revokeFriend,
  recordTraffic, trafficHistory, openSession, getSession, deleteSession, purgeSessions,
  addMetric, metrics, activeVpnUsers, auditLogs
};
