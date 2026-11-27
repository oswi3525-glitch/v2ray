'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const bcrypt = require('bcryptjs');
const Fastify = require('fastify');
const { WebSocketServer, WebSocket } = require('ws');

const cdb = require('./db');
const envcfg = require('../config/runtime');
const { runDiagnostics } = require('./diagnostics');
const { ROOT } = cdb;
const control = (() => {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'control.json'), 'utf8'));
  return {
    ...c,
    appHost: '127.0.0.1',
    appPort: Number(c.app_port || 23952),
    internalPort: Number(c.app_internal_port || 23950),
    publicTcpHost: envcfg.serverHost || c.public_tcp_host,
    publicTcpPort: Number(envcfg.serverPort || c.public_tcp_port || 23952),
    publicTransport: c.public_transport || 'ws',
    cookieSecure: c.cookie_secure === true
  };
})();

const app = Fastify({ logger: false, bodyLimit: 16 * 1024, trustProxy: false });
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
const startedAt = Date.now();
const apiTimes = [];
const rateBuckets = new Map();
const activeWs = new Map();
const liveTraffic = new Map();
const speedPrev = new Map();
const deviceLastTraffic = new Map();
const loginFailures = new Map();

function cookieMap(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionFor(req) {
  const id = cookieMap(req).tiktunnel_session;
  return id ? cdb.getSession(id) : null;
}
function guard(req, reply, role) {
  const s = sessionFor(req);
  if (!s || (role === 'admin' && s.role !== 'admin')) {
    reply.code(401).send({ ok: false, error: 'unauthorized' });
    return null;
  }
  if (role === 'friend' && s.role !== 'friend') {
    reply.code(403).send({ ok: false, error: 'forbidden' });
    return null;
  }
  return { session: s, user: cdb.getUser(s.user_id), role: s.role };
}
function csrfOk(req, auth) {
  return req.headers['x-csrf-token'] === auth.session.csrf;
}
function setSessionCookie(reply, s) {
  const parts = [
    `tiktunnel_session=${encodeURIComponent(s.id)}`,
    'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor((Date.parse(s.expiresAt) - Date.now()) / 1000))}`
  ];
  if (control.cookieSecure) parts.push('Secure');
  const csrfParts = [
    `tiktunnel_csrf=${encodeURIComponent(s.csrf)}`,
    'Path=/', 'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor((Date.parse(s.expiresAt) - Date.now()) / 1000))}`
  ];
  if (control.cookieSecure) csrfParts.push('Secure');
  reply.header('Set-Cookie', [parts.join('; '), csrfParts.join('; ')]);
}
function clearSessionCookie(reply) {
  const secure = control.cookieSecure ? '; Secure' : '';
  reply.header('Set-Cookie', [
    `tiktunnel_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
    `tiktunnel_csrf=; Path=/; SameSite=Strict; Max-Age=0${secure}`
  ]);
}
function rateLimited(req, key, limit, windowMs) {
  const k = `${req.ip}|${key}`;
  const now = Date.now();
  let b = rateBuckets.get(k);
  if (!b || now >= b.reset) { b = { n: 0, reset: now + windowMs }; rateBuckets.set(k, b); }
  b.n++;
  if (rateBuckets.size > 2000) for (const [x, v] of rateBuckets) if (v.reset < now) rateBuckets.delete(x);
  return b.n > limit;
}
function validPassword(p) {
  return typeof p === 'string' && p.length >= 8;
}
function validUsername(u) {
  return typeof u === 'string' && /^[A-Za-z0-9_.-]{2,32}$/.test(u.trim());
}
function publicUser(u) {
  const v = u ? cdb.getVpnClient(u.id) : null;
  const s = u ? cdb.getSubscription(u.id) : null;
  return {
    id: u?.id, username: u?.username, display_name: u?.display_name,
    enabled: u?.enabled === 1, exhausted: u?.exhausted === 1,
    created_at: u?.created_at, expires_at: u?.expires_at, revoked_at: u?.revoked_at,
    quota_bytes: u?.quota_bytes, used_upload: u?.used_upload, used_download: u?.used_download,
    remaining_bytes: Math.max(0, (u?.quota_bytes || 0) - (u?.used_upload || 0) - (u?.used_download || 0)),
    last_connection: u?.last_connection, last_seen: u?.last_seen,
    uuid: v?.uuid || null, subscription_token: s?.token || null, subscription_path: s?.path || null,
    vless_uri: u ? vlessUri(u) : null,
    password_set: !!u?.password_hash
  };
}

function publicSelf(u) {
  const p = publicUser(u);
  delete p.subscription_token;
  delete p.subscription_path;
  delete p.uuid;
  return p;
}
function accountReady(u) {
  if (!u || u.revoked_at || u.enabled !== 1 || u.exhausted === 1) return false;
  if ((u.quota_bytes || 0) > 0 && (u.used_upload || 0) + (u.used_download || 0) >= u.quota_bytes) return false;
  if (u.expires_at && Date.parse(u.expires_at) <= Date.now()) return false;
  return true;
}
function sendConfigFile(reply, u, deviceId = null) {
  const uri = vlessUri(u, deviceId);
  if (!uri) return reply.code(404).send({ ok: false, error: 'not_found' });
  const name = String(u.username || 'tiktunnel').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
  reply.header('Content-Disposition', `attachment; filename="tiktunnel-${name}.txt"`);
  reply.header('Cache-Control', 'no-store');
  reply.type('text/plain; charset=utf-8');
  return reply.send(uri + '\n');
}

function vlessUri(u, deviceId = null) {
  const v = cdb.getVpnClient(u.id);
  const s = cdb.getSubscription(u.id);
  if (!v || !s) return null;
  const name = encodeURIComponent(u.display_name);
  if (control.publicTransport === 'tcp' || control.vpn_mode === 'tcp') {
    return `vless://${v.uuid}@${control.publicTcpHost}:${control.publicTcpPort}?encryption=none&type=tcp&security=none#${name}`;
  }
  const pathValue = s.path + (cdb.validDeviceId(deviceId) ? `.${deviceId}` : '');
  const q = [
    'encryption=none',
    'type=ws',
    `path=${pathValue}`,
    `host=${control.public_https_host}`,
    'security=tls',
    `sni=${control.public_https_host}`
  ].join('&');
  return `vless://${v.uuid}@${control.public_https_host}:443?${q}#${name}`;
}

let applyChain = Promise.resolve();
function applyConfig() {
  applyChain = applyChain.then(() => new Promise((resolve, reject) => {
    execFile('bash', [path.join(ROOT, 'scripts', 'apply-control-config.sh')], { cwd: ROOT, timeout: 15000 },
      (err) => (err ? reject(new Error('apply_failed')) : resolve()));
  }));
  return applyChain;
}

app.addHook('onRequest', async (req, reply) => {
  const t = process.hrtime.bigint();
  req._t = t;
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  reply.header('X-Permitted-Cross-Domain-Policies', 'none');
  reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");
  if (req.url.startsWith('/api/') && rateLimited(req, 'api', 180, 60000)) {
    reply.code(429).send({ ok: false, error: 'rate_limited' });
  }
});
app.addHook('onResponse', async (req) => {
  if (!req._t) return;
  apiTimes.push(Number(process.hrtime.bigint() - req._t) / 1e6);
  if (apiTimes.length > 200) apiTimes.shift();
});
app.setErrorHandler((err, _req, reply) => reply.code(400).send({ ok: false, error: 'bad_request' }));

function readStatic(name, type) {
  return (req, reply) => {
    reply.header('Cache-Control', 'no-store, max-age=0');
    let body = fs.readFileSync(path.join(ROOT, 'web', name));
    if (name === 'index.html') {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      body = Buffer.from(body.toString('utf8').replace(/__VER__/g, pkg.version));
    }
    reply.type(type).send(body);
  };
}
for (const p of ['/', '/admin', '/friend', '/setup', '/login']) {
  app.get(p, readStatic('index.html', 'text/html; charset=utf-8'));
}
app.get('/style.css', readStatic('style.css', 'text/css; charset=utf-8'));
app.get('/app.js', readStatic('app.js', 'application/javascript; charset=utf-8'));
app.get('/boot-guard.js', readStatic('boot-guard.js', 'application/javascript; charset=utf-8'));
app.get('/health', async () => ({ ok: true, service: 'tiktunnel-control', uptime_s: Math.floor((Date.now() - startedAt) / 1000) }));

app.post('/api/auth/login', async (req, reply) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const key = `${req.ip}|${username || '-'}`;
  const now = Date.now();
  const failures = loginFailures.get(key);
  if (failures && failures.n >= 5 && failures.until > now) {
    cdb.securityEvent('anonymous', 'login_locked', username, req.ip, `until=${new Date(failures.until).toISOString()}`);
    return reply.code(429).send({ ok: false, error: 'too_many_attempts' });
  }
  if (rateLimited(req, 'login', 10, 300000)) {
    cdb.securityEvent('anonymous', 'rate_limited', 'login', req.ip);
    return reply.code(429).send({ ok: false, error: 'too_many_attempts' });
  }
  if (!username || !password || username.length > 32 || password.length > 200) {
    return reply.code(400).send({ ok: false, error: 'invalid_input' });
  }
  const admin = cdb.getAdmin();
  let user = null, role = null;
  if (admin && admin.username === username) { user = admin; role = 'admin'; }
  else {
    const f = cdb.getUserByUsername(username);
    if (f && f.password_hash && f.enabled === 1 && !f.revoked_at) { user = f; role = 'friend'; }
  }
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    const n = (failures && failures.until <= now ? 0 : (failures?.n || 0)) + 1;
    loginFailures.set(key, { n, until: n >= 5 ? now + 15 * 60e3 : now + 60e3 });
    cdb.audit('anonymous', 'login_failed', username);
    cdb.securityEvent('anonymous', 'login_failed', username, req.ip, `attempt=${n}`);
    return reply.code(401).send({ ok: false, error: 'invalid_credentials' });
  }
  loginFailures.delete(key);
  const oldId = cookieMap(req).tiktunnel_session;
  if (oldId) cdb.deleteSession(oldId);
  const s = cdb.openSession(user.id, role);
  setSessionCookie(reply, s);
  cdb.audit(role, 'login', username);
  cdb.securityEvent(role, 'login', username, req.ip);
  return reply.send({ ok: true, role, csrf: s.csrf });
});

app.post('/api/auth/logout', async (req, reply) => {
  const s = sessionFor(req);
  if (!s || req.headers['x-csrf-token'] !== s.csrf) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  cdb.deleteSession(s.id);
  clearSessionCookie(reply);
  cdb.securityEvent(s.role, 'logout', String(s.user_id), req.ip);
  return reply.send({ ok: true });
});

app.get('/api/auth/me', async (req, reply) => {
  const s = sessionFor(req);
  if (!s) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const u = s.role === 'admin' ? cdb.getAdmin() : cdb.getUser(s.user_id);
  return reply.send({ ok: true, role: s.role, csrf: s.csrf, username: u?.username });
});

app.get('/api/diagnostics/run', async (req, reply) => {
  const s = sessionFor(req);
  if (!s) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  if (rateLimited(req, 'diagnostics', 6, 60000)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
  const u = s.role === 'admin' ? (cdb.listUsers().find((x) => !x.revoked_at) || null) : cdb.getUser(s.user_id);
  const checks = await runDiagnostics({ control, user: u, cdb,
    internalHealthUrl: `http://127.0.0.1:${control.internalPort}/health` });
  cdb.securityEvent(s.role, 'diagnostics_run', String(s.user_id), req.ip);
  return reply.header('Cache-Control', 'no-store').send({ ok: true, checks,
    summary: {
      pass: checks.filter((c) => c.status === 'PASS').length,
      fail: checks.filter((c) => c.status === 'FAIL').length,
      warning: checks.filter((c) => c.status === 'WARNING').length,
      unknown: checks.filter((c) => c.status === 'UNKNOWN').length
    } });
});

app.get('/api/notifications', async (req, reply) => {
  const s = sessionFor(req);
  if (!s) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const p = page(req.query, 20, 50);
  return reply.send({ ok: true, unread: cdb.unreadCount(s.user_id, s.role),
    items: cdb.notifications(s.user_id, s.role, p.limit, p.offset), ...p });
});
app.post('/api/notifications/read', async (req, reply) => {
  const s = sessionFor(req);
  if (!s || req.headers['x-csrf-token'] !== s.csrf) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  cdb.markNotificationsRead(s.user_id, s.role, req.body?.id ?? null);
  return reply.send({ ok: true, unread: cdb.unreadCount(s.user_id, s.role) });
});

app.get('/api/admin/overview', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  const st = systemStats();
  return reply.send({
    ok: true,
    mode: control.publicTransport,
    public_endpoint: `${control.publicTcpHost}:${control.publicTcpPort}`,
    server: { sing_box: processAlive(readPid('sing-box.pid')), api: true, ...st },
    accounts: { friends: cdb.friendCount(), max_friends: envcfg.maxUsers, admin: cdb.adminExists() },
    vpn_users: cdb.activeVpnUsers().length,
    notifications: cdb.db.prepare('SELECT detail FROM audit_logs WHERE action=? ORDER BY id DESC LIMIT 5').all('quota_exhausted').map((x) => x.detail)
  });
});

app.get('/api/admin/users', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  return reply.send({ ok: true, users: cdb.listUsers().map(publicUser) });
});

app.get('/api/admin/users/:id', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  const u = cdb.getUser(Number(req.params.id));
  if (!u) return reply.code(404).send({ ok: false, error: 'not_found' });
  return reply.send({ ok: true, user: publicUser(u), history: cdb.trafficHistory(u.id, 30) });
});
app.get('/api/admin/users/:id/export', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  const u = cdb.getUser(Number(req.params.id));
  if (!u) return reply.code(404).send({ ok: false, error: 'not_found' });
  return sendConfigFile(reply, u);
});

app.post('/api/admin/users', async (req, reply) => {
  const a = guard(req, reply, 'admin'); if (!a || !csrfOk(req, a)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  if (cdb.friendCount() >= envcfg.maxUsers) return reply.code(409).send({ ok: false, error: 'friend_limit_reached' });
  const b = req.body || {};
  const username = typeof b.username === 'string' ? b.username.trim() : '';
  if (!validUsername(username)) return reply.code(400).send({ ok: false, error: 'invalid_username' });
  if (!validPassword(b.password)) return reply.code(400).send({ ok: false, error: 'invalid_password' });
  const displayName = typeof b.display_name === 'string' && b.display_name.trim()
    ? b.display_name.trim().slice(0, 60) : username;
  const rawQuota = typeof b.quota_gb === 'string' ? b.quota_gb.replace(',', '.').trim() : b.quota_gb;
  const gb = rawQuota === '' || rawQuota === null || rawQuota === undefined ? 0 : Number(rawQuota);
  if (!Number.isFinite(gb) || gb < 0 || gb > 10000) return reply.code(400).send({ ok: false, error: 'invalid_quota' });
  let expires = null;
  if (b.expires_at) {
    const t = Date.parse(b.expires_at);
    if (!Number.isFinite(t) || t <= Date.now()) return reply.code(400).send({ ok: false, error: 'invalid_expiry' });
    expires = new Date(t).toISOString();
  }
  let u;
  try {
    u = cdb.createFriend({
      username, displayName,
      passwordHash: bcrypt.hashSync(b.password, 12), quotaBytes: Math.round(gb * 1e9), expiresAt: expires
    });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return reply.code(409).send({ ok: false, error: 'username_taken' });
    return reply.code(500).send({ ok: false, error: 'create_failed' });
  }
  await applyConfig().catch(() => {});
  return reply.code(201).send({ ok: true, user: publicUser(u) });
});

app.patch('/api/admin/users/:id', async (req, reply) => {
  const a = guard(req, reply, 'admin'); if (!a || !csrfOk(req, a)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const id = Number(req.params.id);
  const patch = {};
  const b = req.body || {};
  if (b.display_name !== undefined) patch.display_name = String(b.display_name).slice(0, 60);
  if (b.enabled !== undefined) patch.enabled = b.enabled ? 1 : 0;
  if (b.expires_at !== undefined) patch.expires_at = b.expires_at ? new Date(Date.parse(b.expires_at)).toISOString() : null;
  if (b.uuid !== undefined && /^[0-9a-f-]{36}$/i.test(b.uuid)) patch.uuid = b.uuid;
  const u = cdb.setUserState(id, patch, 'admin');
  if (!u) return reply.code(404).send({ ok: false, error: 'not_found' });
  if (patch.uuid || patch.enabled !== undefined) await applyConfig().catch(() => {});
  return reply.send({ ok: true, user: publicUser(u) });
});

app.delete('/api/admin/users/:id', async (req, reply) => {
  const a = guard(req, reply, 'admin'); if (!a || !csrfOk(req, a)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const u = cdb.revokeFriend(Number(req.params.id), 'admin');
  if (!u) return reply.code(404).send({ ok: false, error: 'not_found' });
  closeUserConnections(u.id);
  await applyConfig().catch(() => {});
  return reply.send({ ok: true });
});

app.post('/api/admin/users/:id/quota', async (req, reply) => {
  const a = guard(req, reply, 'admin'); if (!a || !csrfOk(req, a)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const b = req.body || {};
  const action = b.action;
  if (!['set', 'add', 'reduce', 'reset'].includes(action)) return reply.code(400).send({ ok: false, error: 'invalid_action' });
  const gb = Number(b.gb || 0);
  if (!Number.isFinite(gb) || gb < 0 || gb > 10000) return reply.code(400).send({ ok: false, error: 'invalid_quota' });
  const delta = Math.round(gb * 1e9);
  const u = cdb.changeQuota(Number(req.params.id), action, delta, delta, 'admin');
  if (!u) return reply.code(404).send({ ok: false, error: 'not_found' });
  cdb.notify({ userId: u.id, role: 'friend', type: 'quota', title: 'Quota đã được cập nhật',
    body: `Hạn mức mới: ${u.quota_bytes === 0 ? 'không giới hạn' : (u.quota_bytes / 1e9).toFixed(2) + ' GB'}` });
  return reply.send({ ok: true, user: publicUser(u) });
});

app.post('/api/admin/users/:id/disable', async (req, reply) => {
  const a = guard(req, reply, 'admin'); if (!a || !csrfOk(req, a)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const u = cdb.setUserState(Number(req.params.id), { enabled: 0 }, 'admin');
  if (!u) return reply.code(404).send({ ok: false, error: 'not_found' });
  closeUserConnections(u.id);
  await applyConfig().catch(() => {});
  return reply.send({ ok: true, user: publicUser(u) });
});

app.post('/api/admin/users/:id/enable', async (req, reply) => {
  const a = guard(req, reply, 'admin'); if (!a || !csrfOk(req, a)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const u = cdb.setUserState(Number(req.params.id), { enabled: 1, exhausted: 0 }, 'admin');
  if (!u) return reply.code(404).send({ ok: false, error: 'not_found' });
  await applyConfig().catch(() => {});
  return reply.send({ ok: true, user: publicUser(u) });
});

app.post('/api/admin/users/:id/password', async (req, reply) => {
  const a = guard(req, reply, 'admin'); if (!a || !csrfOk(req, a)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  if (!validPassword(req.body?.password)) return reply.code(400).send({ ok: false, error: 'invalid_password' });
  cdb.setFriendPassword(Number(req.params.id), bcrypt.hashSync(req.body.password, 12));
  cdb.notify({ userId: Number(req.params.id), role: 'friend', type: 'security',
    title: 'Mật khẩu đã được admin đặt lại', body: 'Liên hệ admin nếu bạn không thực hiện thao tác này.' });
  return reply.send({ ok: true });
});

app.post('/api/admin/password', async (req, reply) => {
  const a = guard(req, reply, 'admin'); if (!a || !csrfOk(req, a)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  if (!validPassword(req.body?.password)) return reply.code(400).send({ ok: false, error: 'invalid_password' });
  cdb.updateAdminHash(bcrypt.hashSync(req.body.password, 12));
  return reply.send({ ok: true });
});

app.get('/api/admin/audit', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  return reply.send({ ok: true, events: cdb.auditLogs(100) });
});
app.get('/api/admin/security', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  return reply.send({ ok: true, events: cdb.securityEvents(100),
    policy: { password: 'bcrypt cost 12', session: 'HttpOnly/SameSite=Strict', csrf: true,
      login_lockout: '5 failures / 15 min', rate_limit: '180 req/min/api' } });
});

app.get('/api/friend/me', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  return reply.send({ ok: true, user: publicSelf(cdb.getUser(a.user.id) || a.user) });
});
app.get('/api/friend/usage', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  return reply.send({ ok: true, usage: publicSelf(cdb.getUser(a.user.id) || a.user), history: cdb.trafficHistory(a.user.id, 100) });
});
app.get('/api/friend/vpn', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  return reply.send({     ok: true, uri: vlessUri(a.user, req.query.device), mode: control.publicTransport, active: cdb.activeVpnUsers().some((u) => u.id === a.user.id) });
});
app.get('/api/friend/import', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  const u = cdb.getUser(a.user.id) || a.user;
  const deviceId = cdb.validDeviceId(req.query.device) ? req.query.device : null;
  if (!accountReady(u)) {
    cdb.securityEvent('friend', 'import_denied', String(u.id), req.ip, 'account_not_ready');
    return reply.code(403).send({ ok: false, error: 'account_not_ready' });
  }
  const s = cdb.getSubscription(u.id);
  const uri = vlessUri(u, deviceId);
  if (!s || !uri) return reply.code(409).send({ ok: false, error: 'config_not_ready' });
  const tcpPublic = control.publicTransport === 'tcp';
  const origin = tcpPublic
    ? `http://${control.publicTcpHost}:${control.publicTcpPort}`
    : (control.public_https_host ? `https://${control.public_https_host}` : `${req.protocol}://${req.headers.host}`);
  const subUrl = `${origin}/api/sub/${s.token}${deviceId && !tcpPublic ? `?device=${deviceId}` : ''}`;
  const remark = String(u.display_name || u.username).replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40) || 'TikTunnel';
  const serverReady = processAlive(readPid('sing-box.pid'));
  cdb.securityEvent('friend', 'import_link_issued', String(u.id), req.ip, `mode=${control.vpn_mode}`);
  return reply.header('Cache-Control', 'no-store').send({
    ok: true,
    server_ready: serverReady,
    account_ready: true,
    ready: serverReady && cdb.activeVpnUsers().some((x) => x.id === u.id),
    remaining_bytes: Math.max(0, (u.quota_bytes || 0) - (u.used_upload || 0) - (u.used_download || 0)),
    uri,
    subscription_url: subUrl,
    links: {
      node: `shadowrocket://add/${uri}`,
      subscription: `sub://${Buffer.from(subUrl, 'utf8').toString('base64')}#${encodeURIComponent(remark)}`
    },
    fallback: { copy_uri: true, open_url: subUrl, file_url: `/api/friend/export${deviceId ? `?device=${deviceId}` : ''}` },
    note: 'Chỉ coi là thành công sau khi bạn xác nhận thêm server trong Shadowrocket.'
  });
});
app.get('/api/friend/live', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  const fresh = cdb.getUser(a.user.id) || a.user;
  return reply.send({ ok: true, quota_bytes: fresh.quota_bytes, ...liveStats(fresh) });
});
app.get('/api/friend/subscription', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  const s = cdb.getSubscription(a.user.id);
  return reply.send({
    ok: true,
    url: `/api/sub/${s.token}${cdb.validDeviceId(req.query.device) ? `?device=${req.query.device}` : ''}`,
    uri: vlessUri(a.user, req.query.device)
  });
});
app.get('/api/friend/export', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  return sendConfigFile(reply, cdb.getUser(a.user.id) || a.user, req.query.device);
});

function page(q, def = 20, max = 100) {
  return {
    limit: Math.min(max, Math.max(1, Number.parseInt(q.limit, 10) || def)),
    offset: Math.max(0, Number.parseInt(q.offset, 10) || 0)
  };
}
function deviceStatus(d, nowTs = Date.now()) {
  const last = deviceLastTraffic.get(d.id) || (d.last_traffic_at ? Date.parse(d.last_traffic_at) : 0);
  if (last > 0 && nowTs - last <= 60000) return 'active';
  if (d.open_sessions > 0) return 'idle';
  return d.last_seen ? 'offline' : 'unknown';
}
function withStatus(rows) {
  const t = Date.now();
  return rows.map((d) => ({ ...d, status: deviceStatus(d, t) }));
}

app.post('/api/friend/password', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a || !csrfOk(req, a)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  if (!validPassword(req.body?.password)) return reply.code(400).send({ ok: false, error: 'invalid_password' });
  cdb.setFriendPassword(a.user.id, bcrypt.hashSync(req.body.password, 12));
  cdb.securityEvent('friend', 'password_changed', String(a.user.id), req.ip);
  cdb.notify({ userId: a.user.id, role: 'friend', type: 'security',
    title: 'Mật khẩu tài khoản đã đổi', body: 'Nếu không phải bạn, hãy đổi mật khẩu ngay.' });
  return reply.send({ ok: true });
});

app.get('/api/friend/devices', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  const p = page(req.query, 20, 50);
  return reply.send({ ok: true, devices: withStatus(cdb.listDevices(a.user.id, p.limit, p.offset)), ...p });
});
app.patch('/api/friend/devices/:id', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a || !csrfOk(req, a)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const id = String(req.params.id);
  if (!cdb.validDeviceId(id) || !cdb.getDevice(a.user.id, id)) return reply.code(404).send({ ok: false, error: 'not_found' });
  cdb.setDeviceName(a.user.id, id, req.body?.name);
  cdb.audit('friend', 'device_renamed', id);
  return reply.send({ ok: true });
});
app.get('/api/admin/devices', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  const p = page(req.query, 20, 100);
  return reply.send({ ok: true, devices: withStatus(cdb.adminDevices(p.limit, p.offset)), ...p });
});

const downloadBlock = Buffer.alloc(64 * 1024, 0x5a);
app.get('/api/net/ping', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  if (rateLimited(req, 'ping', 120, 60000)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
  return reply.header('Cache-Control', 'no-store').send({ ok: true, t: Date.now(), ip: req.ip });
});
app.get('/api/net/download', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  if (rateLimited(req, 'download', 30, 60000)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
  let n = Number.parseInt(req.query.bytes, 10);
  if (!Number.isFinite(n) || n < 1024) n = 1024 * 1024;
  n = Math.min(n, 8 * 1024 * 1024);
  const buf = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i += downloadBlock.length) {
    downloadBlock.copy(buf, i, 0, Math.min(downloadBlock.length, n - i));
  }
  reply.header('Cache-Control', 'no-store');
  reply.header('Content-Length', String(n));
  return reply.type('application/octet-stream').send(buf);
});
app.post('/api/net/upload', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  if (rateLimited(req, 'upload', 30, 60000)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
  const received = Buffer.isBuffer(req.body) ? req.body.length : 0;
  return reply.send({ ok: true, received });
});
app.post('/api/friend/speedtest', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a || !csrfOk(req, a)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  if (rateLimited(req, 'speedtest', 20, 60000)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
  const b = req.body || {};
  const num = (v, max) => { const x = Number(v); return Number.isFinite(x) && x >= 0 && x <= max ? x : null; };
  const mode = b.mode === 'vpn' ? 'vpn' : b.mode === 'direct' ? 'direct' : null;
  const ping = num(b.ping_ms, 10000), jitter = num(b.jitter_ms, 10000);
  const loss = num(b.packet_loss_pct, 100), down = num(b.download_mbps, 10000), up = num(b.upload_mbps, 10000);
  const used = num(b.bytes_used, 100 * 1024 * 1024), dur = num(b.duration_s, 600);
  if (!mode || ping === null || jitter === null || loss === null || down === null || up === null || used === null || dur === null) {
    return reply.code(400).send({ ok: false, error: 'invalid_input' });
  }
  const id = cdb.addSpeedTest({ user_id: a.user.id, mode, verified: b.verified === true, ping_ms: ping,
    jitter_ms: jitter, packet_loss_pct: loss, download_mbps: down, upload_mbps: up,
    bytes_used: used, duration_s: dur, server: String(b.server || '').slice(0, 120) });
  cdb.purgeSpeedTests(100);
  cdb.audit('friend', 'speed_test_saved', String(a.user.id), `mode=${mode}`);
  return reply.code(201).send({ ok: true, id });
});
app.get('/api/friend/speedtests', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  const p = page(req.query, 20, 50);
  return reply.send({ ok: true, tests: cdb.speedTests(a.user.id, p.limit, p.offset), ...p });
});
app.get('/api/admin/speedtests', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  return reply.send({ ok: true, tests: cdb.adminSpeedTests(50) });
});
app.get('/api/monitor/latency', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  const [host, port] = (control.probe_endpoints[0] || '1.1.1.1:443').split(':');
  const results = await Promise.all(Array.from({ length: 6 }, () => probe(host, Number(port), 1500)));
  const samples = results.map((r) => (r.ok ? r.ms : null));
  const ok = samples.filter((x) => x !== null);
  const avg = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 0;
  const peak = ok.length ? Math.max(...ok) : 0;
  const jitter = ok.length > 1 ? ok.reduce((a, b) => a + Math.abs(b - avg), 0) / ok.length : 0;
  return reply.send({ ok: true, current: ok.at(-1) || 0, average: +avg.toFixed(1), peak: +peak.toFixed(1),
    jitter: +jitter.toFixed(1), packet_loss_pct: +((samples.length - ok.length) / samples.length * 100).toFixed(1),
    target: `${host}:${port}`, samples, note: 'TCP connect probes from this host; not client-side latency.' });
});

app.get('/api/sub/:token', async (req, reply) => {
  const u = cdb.getUserByToken(req.params.token);
  if (!u || !accountReady(u)) return reply.code(404).send({ ok: false, error: 'not_found' });
  const uri = vlessUri(u, req.query.device);
  if (!uri) return reply.code(404).send({ ok: false, error: 'not_found' });
  reply.header('Cache-Control', 'no-store');
  reply.type('text/plain; charset=utf-8');
  return reply.send(req.query.raw === '1' ? uri + '\n' : Buffer.from(uri + '\n').toString('base64'));
});

let cpuPrev = readCpu(), netPrev = readNet();
function readCpu() {
  const a = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
  return { idle: a[3], total: a.slice(0, 4).reduce((x, y) => x + y, 0) };
}
function cpuPct() {
  const c = readCpu();
  const d = c.total - cpuPrev.total;
  const v = d > 0 ? +(((d - (c.idle - cpuPrev.idle)) / d) * 100).toFixed(2) : 0;
  cpuPrev = c;
  return v;
}
function readNet() {
  const out = { rx: 0, tx: 0 };
  for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 10) continue;
    if (p[0].startsWith('lo:')) continue;
    out.rx += Number(p[1]); out.tx += Number(p[9]);
  }
  return out;
}
function netRates() {
  const n = readNet();
  const r = { rx_bps: Math.max(0, n.rx - netPrev.rx), tx_bps: Math.max(0, n.tx - netPrev.tx) };
  netPrev = n;
  return r;
}
function ram() {
  const s = fs.readFileSync('/proc/meminfo', 'utf8');
  const g = (k) => Number(s.match(new RegExp(k + ':\\s+(\\d+)'))[1]);
  return { total_kb: g('MemTotal'), available_kb: g('MemAvailable'), used_kb: g('MemTotal') - g('MemAvailable') };
}
function disk() {
  const s = fs.statfsSync(ROOT);
  return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function readPid(name) {
  try { return Number(fs.readFileSync(path.join(ROOT, 'logs', `${name}.pid`), 'utf8').trim()); } catch { return 0; }
}
function systemStats() {
  const r = ram();
  return {
    cpu_pct: cpuPct(), ram_used_kb: r.used_kb, ram_total_kb: r.total_kb,
    disk_total: disk().total, disk_free: disk().free,
    uptime_s: Math.floor(process.uptime()),
    api_latency_ms: apiTimes.length ? +(apiTimes.reduce((a, b) => a + b, 0) / apiTimes.length).toFixed(2) : 0
  };
}

function probe(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const t = Date.now();
    const s = net.connect(port, host);
    s.setTimeout(timeout);
    s.on('connect', () => { const ms = Date.now() - t; s.destroy(); resolve({ host, port, ok: true, ms }); });
    s.on('error', () => resolve({ host, port, ok: false, ms: null }));
    s.on('timeout', () => { s.destroy(); resolve({ host, port, ok: false, ms: null }); });
  });
}

app.get('/api/monitor/server', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  return reply.send({ ok: true, ...systemStats(), sing_box: processAlive(readPid('sing-box.pid')) });
});
app.get('/api/monitor/network', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  const probes = await Promise.all(control.probe_endpoints.map((e) => {
    const [h, p] = e.split(':');
    return probe(h, Number(p));
  }));
  const lost = probes.filter((p) => !p.ok).length;
  return reply.send({
    ok: true, rates: netRates(), probes,
    packet_loss_pct: +(lost / probes.length * 100).toFixed(1),
    note: 'TCP connect probes from this host; not a substitute for client-side ICMP or remote website latency.'
  });
});
app.get('/api/monitor/performance', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  return reply.send({ ok: true, metrics: cdb.metrics(120), note: 'Observed values from this host only.' });
});

const wss = new WebSocketServer({ noServer: true });
function closeUserConnections(userId) {
  const set = activeWs.get(userId);
  if (!set) return;
  for (const c of set) { try { c.client.close(); } catch {} try { c.upstream.close(); } catch {} }
  activeWs.delete(userId);
}
function bumpLiveTraffic(userId, up, down) {
  const cur = liveTraffic.get(userId) || { up: 0, down: 0 };
  cur.up += up;
  cur.down += down;
  liveTraffic.set(userId, cur);
}
function liveStats(user) {
  const live = liveTraffic.get(user.id) || { up: 0, down: 0 };
  const usedUpload = (user.used_upload || 0) + live.up;
  const usedDownload = (user.used_download || 0) + live.down;
  const now = Date.now();
  const prev = speedPrev.get(user.id);
  let upBps = 0, downBps = 0;
  if (prev) {
    const dt = (now - prev.t) / 1000;
    if (dt > 0) {
      upBps = Math.max(0, (live.up - prev.up) / dt);
      downBps = Math.max(0, (live.down - prev.down) / dt);
    }
  }
  speedPrev.set(user.id, { t: now, up: live.up, down: live.down });
  return {
    active: activeWs.has(user.id),
    up_bps: Math.round(upBps),
    down_bps: Math.round(downBps),
    total_bps: Math.round(upBps + downBps),
    used_upload: usedUpload,
    used_download: usedDownload,
    used_bytes: usedUpload + usedDownload,
    remaining_bytes: Math.max(0, (user.quota_bytes || 0) - usedUpload - usedDownload)
  };
}
app.server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url || '/', 'http://localhost');
  let token = u.pathname.startsWith('/vpn/') ? u.pathname.slice('/vpn/'.length) : null;
  if (!token || control.vpn_mode !== 'ws') { socket.destroy(); return; }
  let deviceId = null;
  const dot = token.lastIndexOf('.');
  if (dot > 0) {
    const candidate = token.slice(dot + 1);
    if (cdb.validDeviceId(candidate)) { token = token.slice(0, dot); deviceId = candidate; }
  }
  const user = cdb.getUserByToken(token);
  if (!user || !accountReady(user)) { socket.destroy(); return; }
  if (deviceId) {
    const known = cdb.getDevice(user.id, deviceId);
    cdb.upsertDevice(user.id, deviceId);
    if (!known) cdb.notify({ userId: user.id, role: 'friend', type: 'device',
      title: 'Thiết bị mới đã kết nối VPN', body: `Device ID: ${deviceId}` });
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    let up;
    try { up = new WebSocket(`ws://${control.singbox_ws_host}:${control.singbox_ws_port}${control.ws_path}`); }
    catch { ws.close(); return; }
    const pair = { client: ws, upstream: up, upBytes: 0, downBytes: 0, deviceId, lastTouch: 0, countedUp: 0, countedDown: 0 };
    if (!activeWs.has(user.id)) activeWs.set(user.id, new Set());
    activeWs.get(user.id).add(pair);
    const sid = cdb.db.prepare('INSERT INTO connection_sessions (user_id, ts_start, remote, device_id) VALUES (?, ?, ?, ?)')
      .run(user.id, cdb.now(), req.socket.remoteAddress || '', deviceId).lastInsertRowid;
    function touch() {
      const t = Date.now();
      if (t - pair.lastTouch < 5000) return;
      pair.lastTouch = t;
      const iso = cdb.now();
      cdb.db.prepare('UPDATE connection_sessions SET last_traffic_at=? WHERE id=?').run(iso, Number(sid));
      if (deviceId) {
        deviceLastTraffic.set(deviceId, t);
        cdb.addDeviceTraffic(deviceId, pair.upBytes - pair.countedUp, pair.downBytes - pair.countedDown, iso);
        pair.countedUp = pair.upBytes; pair.countedDown = pair.downBytes;
      }
    }
    function finish() {
      if (pair.done) return;
      pair.done = true;
      activeWs.get(user.id)?.delete(pair);
      if (activeWs.get(user.id)?.size === 0) activeWs.delete(user.id);
      cdb.db.prepare('UPDATE connection_sessions SET ts_end=?, upload_bytes=?, download_bytes=?, status=? WHERE id=?')
        .run(cdb.now(), pair.upBytes, pair.downBytes, 'closed', Number(sid));
      cdb.recordTraffic(user.id, pair.upBytes, pair.downBytes, 'ws-proxy');
      if (deviceId && (pair.upBytes > pair.countedUp || pair.downBytes > pair.countedDown)) {
        cdb.addDeviceTraffic(deviceId, pair.upBytes - pair.countedUp, pair.downBytes - pair.countedDown);
      }
      bumpLiveTraffic(user.id, -pair.upBytes, -pair.downBytes);
      try { ws.close(); } catch {}
      try { up.close(); } catch {}
    }
    const clientQueue = [];
    const upQueue = [];
    ws.on('message', (d) => {
      const n = Buffer.isBuffer(d) ? d.length : Buffer.byteLength(String(d));
      pair.upBytes += n;
      bumpLiveTraffic(user.id, n, 0);
      touch();
      if (up.readyState === WebSocket.OPEN) up.send(d); else clientQueue.push(d);
    });
    up.on('message', (d) => {
      const n = Buffer.isBuffer(d) ? d.length : Buffer.byteLength(String(d));
      pair.downBytes += n;
      bumpLiveTraffic(user.id, 0, n);
      touch();
      if (ws.readyState === WebSocket.OPEN) ws.send(d); else upQueue.push(d);
    });
    up.on('open', () => {
      for (const d of clientQueue.splice(0)) up.send(d);
    });
    ws.on('open', () => {
      for (const d of upQueue.splice(0)) ws.send(d);
    });
    ws.on('close', finish);
    up.on('close', finish);
    ws.on('error', finish);
    up.on('error', finish);
  });
});

function enforceQuota() {
  for (const u of cdb.listUsers()) {
    if (u.revoked_at) continue;
    const used = u.used_upload + u.used_download;
    const over = u.quota_bytes > 0 && used >= u.quota_bytes;
    if (over && (!u.exhausted || u.enabled)) {
      const fresh = !u.exhausted;
      cdb.setUserState(u.id, { exhausted: 1, enabled: 0 }, 'quota-worker');
      if (fresh) {
        cdb.db.prepare('INSERT INTO quota_history (user_id, ts, action, delta_bytes, quota_before, quota_after, actor, note) VALUES (?, ?, ?, 0, ?, ?, ?, ?)')
          .run(u.id, cdb.now(), 'exhausted', u.quota_bytes, u.quota_bytes, 'quota-worker', 'quota reached; VPN access revoked');
        cdb.audit('quota-worker', 'quota_exhausted', u.username, `used=${used} quota=${u.quota_bytes}`);
        cdb.notify({ userId: u.id, role: 'friend', type: 'quota',
          title: 'Đã hết dung lượng', body: 'VPN đã bị tạm ngưng vì đạt hạn mức. Liên hệ admin để cấp thêm.' });
        cdb.notify({ userId: 0, role: 'admin', type: 'quota',
          title: 'Account exhausted', body: `${u.username} reached its quota` });
      }
      closeUserConnections(u.id);
      applyConfig().catch(() => {});
    } else if (u.expires_at && Date.parse(u.expires_at) <= Date.now() && u.enabled) {
      cdb.setUserState(u.id, { enabled: 0 }, 'quota-worker');
      closeUserConnections(u.id);
      applyConfig().catch(() => {});
    }
  }
  cdb.purgeSessions();
  const t = Date.now();
  for (const [k, v] of loginFailures) if (v.until <= t) loginFailures.delete(k);
  for (const [k, v] of rateBuckets) if (v.reset <= t) rateBuckets.delete(k);
}

async function main() {
  const adminUser = String(envcfg.adminUsername || '').trim();
  const adminPass = String(envcfg.adminPassword || '');
  if (!adminUser || adminPass.length < 8 || /^CHANGE_ME/i.test(adminPass)) {
    process.stderr.write('control failed: set ADMIN_USERNAME and a real ADMIN_PASSWORD (>= 8 chars, not CHANGE_ME) in .env\n');
    process.exit(1);
  }
  try {
    cdb.seedAdminFromEnv(adminUser, bcrypt.hashSync(adminPass, 12));
  } catch (e) {
    process.stderr.write(`control failed: could not seed admin from .env: ${e.message}\n`);
    process.exit(1);
  }
  await app.listen({ host: control.appHost, port: control.internalPort });
  process.stdout.write(`tiktunnel-control listening on ${control.appHost}:${control.internalPort} public=${control.appPort} mode=${control.publicTransport}\n`);
  setInterval(enforceQuota, Number(control.quota_check_ms || 10000)).unref();
  setInterval(() => {
    const s = systemStats();
    const n = netRates();
    cdb.addMetric({ cpu_pct: s.cpu_pct, ram_used_kb: s.ram_used_kb, ram_total_kb: s.ram_total_kb,
      net_rx_bytes: n.rx_bps, net_tx_bytes: n.tx_bps, active_vpn: cdb.activeVpnUsers().length,
      api_latency_ms: s.api_latency_ms });
    cdb.purgeNotifications(200);
    cdb.purgeSpeedTests(100);
  }, 60000).unref();
  const shutdown = async () => { try { await app.close(); } finally { process.exit(0); } };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch((e) => { process.stderr.write(`control failed: ${e.message}\n`); process.exit(1); });
