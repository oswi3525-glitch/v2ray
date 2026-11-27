'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'database', 'tiktunnel.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    uuid        TEXT    NOT NULL UNIQUE,
    sub_token   TEXT    NOT NULL UNIQUE,
    enabled     INTEGER NOT NULL DEFAULT 1,
    expires_at  TEXT,
    created_at  TEXT    NOT NULL,
    revoked_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_users_token ON users(sub_token);

  CREATE TABLE IF NOT EXISTS events (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     TEXT NOT NULL,
    type   TEXT NOT NULL,
    detail TEXT NOT NULL
  );
`);

function now() {
  return new Date().toISOString();
}

function isExpired(row) {
  return !!row.expires_at && Date.parse(row.expires_at) <= Date.now();
}

function active(row) {
  return row && row.revoked_at === null && row.enabled === 1 && !isExpired(row);
}

function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY id').all();
}

function listActiveUsers() {
  return listUsers().filter(active);
}

function countActive() {
  return listActiveUsers().length;
}

function findByToken(token) {
  return db.prepare('SELECT * FROM users WHERE sub_token = ?').get(token) || null;
}

function findById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function createUser({ name, expiresAt }) {
  const stmt = db.prepare(
    'INSERT INTO users (name, uuid, sub_token, enabled, expires_at, created_at, revoked_at) VALUES (?, ?, ?, 1, ?, ?, NULL)'
  );
  const uuid = crypto.randomUUID();
  const subToken = crypto.randomBytes(24).toString('base64url');
  const createdAt = now();
  const info = stmt.run(name, uuid, subToken, expiresAt || null, createdAt);
  audit('user_created', `id=${Number(info.lastInsertRowid)} name=${JSON.stringify(name)}`);
  return findById(Number(info.lastInsertRowid));
}

function revokeUser(id) {
  const row = findById(id);
  if (!row || row.revoked_at) return null;
  db.prepare('UPDATE users SET enabled = 0, revoked_at = ? WHERE id = ?').run(now(), id);
  audit('user_revoked', `id=${id}`);
  return findById(id);
}

function setUser(id, { enabled, expiresAt }) {
  const row = findById(id);
  if (!row || row.revoked_at) return null;
  const nextEnabled = enabled === undefined ? row.enabled : enabled ? 1 : 0;
  const nextExpiry = expiresAt === undefined ? row.expires_at : expiresAt;
  db.prepare('UPDATE users SET enabled = ?, expires_at = ? WHERE id = ?').run(nextEnabled, nextExpiry, id);
  audit('user_updated', `id=${id} enabled=${nextEnabled}`);
  return findById(id);
}

function audit(type, detail) {
  db.prepare('INSERT INTO events (ts, type, detail) VALUES (?, ?, ?)').run(now(), type, detail);
}

function recentEvents(limit = 20) {
  return db.prepare('SELECT ts, type, detail FROM events ORDER BY id DESC LIMIT ?').all(limit);
}

function stats() {
  const rows = listUsers();
  return {
    total: rows.length,
    active: rows.filter(active).length,
    disabled: rows.filter((r) => r.revoked_at === null && r.enabled === 0).length,
    expired: rows.filter((r) => r.revoked_at === null && r.enabled === 1 && isExpired(r)).length,
    revoked: rows.filter((r) => r.revoked_at !== null).length
  };
}

module.exports = {
  ROOT,
  DB_PATH,
  db,
  now,
  active,
  isExpired,
  listUsers,
  listActiveUsers,
  countActive,
  findByToken,
  findById,
  createUser,
  revokeUser,
  setUser,
  stats,
  recentEvents
};
