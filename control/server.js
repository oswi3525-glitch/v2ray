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
const { ROOT } = cdb;
const control = (() => {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'control.json'), 'utf8'));
  return {
    ...c,
    appHost: c.app_host || envcfg.listenHost,
    appPort: Number(envcfg.serverPort || c.app_port || 23952),
    publicTcpHost: envcfg.serverHost,
    publicTcpPort: envcfg.serverPort,
    cookieSecure: c.cookie_secure === true
  };
})();

const app = Fastify({ logger: false, bodyLimit: 16 * 1024, trustProxy: false });
const startedAt = Date.now();
const apiTimes = [];
const rateBuckets = new Map();
const activeWs = new Map();

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
  reply.header('Set-Cookie', [
    'tiktunnel_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
    'tiktunnel_csrf=; Path=/; SameSite=Strict; Max-Age=0'
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
    password_set: !!u?.password_hash
  };
}

function vlessUri(u) {
  const v = cdb.getVpnClient(u.id);
  const s = cdb.getSubscription(u.id);
  if (!v || !s) return null;
  const name = encodeURIComponent(u.display_name);
  if (control.vpn_mode === 'tcp') {
    return `vless://${v.uuid}@${control.publicTcpHost}:${control.publicTcpPort}?encryption=none&type=tcp&security=none#${name}`;
  }
  const q = new URLSearchParams({
    encryption: 'none', type: 'ws', path: s.path,
    host: control.public_https_host, security: 'tls', sni: control.public_https_host
  });
  return `vless://${v.uuid}@${control.public_https_host}:443?${q.toString()}#${name}`;
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
  reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
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
app.get('/health', async () => ({ ok: true, service: 'tiktunnel-control', uptime_s: Math.floor((Date.now() - startedAt) / 1000) }));

app.post('/api/auth/login', async (req, reply) => {
  if (rateLimited(req, 'login', 10, 300000)) return reply.code(429).send({ ok: false, error: 'too_many_attempts' });
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password) {
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
    cdb.audit('anonymous', 'login_failed', username);
    return reply.code(401).send({ ok: false, error: 'invalid_credentials' });
  }
  const s = cdb.openSession(user.id, role);
  setSessionCookie(reply, s);
  cdb.audit(role, 'login', username);
  return reply.send({ ok: true, role, csrf: s.csrf });
});

app.post('/api/auth/logout', async (req, reply) => {
  const s = sessionFor(req);
  if (s) cdb.deleteSession(s.id);
  clearSessionCookie(reply);
  return reply.send({ ok: true });
});

app.get('/api/auth/me', async (req, reply) => {
  const s = sessionFor(req);
  if (!s) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const u = s.role === 'admin' ? cdb.getAdmin() : cdb.getUser(s.user_id);
  return reply.send({ ok: true, role: s.role, csrf: s.csrf, username: u?.username });
});

app.get('/api/admin/overview', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  const st = systemStats();
  return reply.send({
    ok: true,
    mode: control.vpn_mode,
    public_endpoint: control.vpn_mode === 'ws' ? `${control.public_https_host}:443` : `${control.publicTcpHost}:${control.publicTcpPort}`,
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

app.get('/api/friend/me', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  return reply.send({ ok: true, user: publicUser(a.user) });
});
app.get('/api/friend/usage', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  return reply.send({ ok: true, usage: publicUser(a.user), history: cdb.trafficHistory(a.user.id, 100) });
});
app.get('/api/friend/vpn', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  return reply.send({ ok: true, uri: vlessUri(a.user), mode: control.vpn_mode, active: cdb.activeVpnUsers().some((u) => u.id === a.user.id) });
});
app.get('/api/friend/subscription', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  const s = cdb.getSubscription(a.user.id);
  return reply.send({
    ok: true,
    url: `/api/sub/${s.token}`,
    token: s.token,
    uri: vlessUri(a.user)
  });
});

app.get('/api/sub/:token', async (req, reply) => {
  const u = cdb.getUserByToken(req.params.token);
  if (!u || u.revoked_at || u.enabled !== 1 || u.exhausted === 1) return reply.code(404).send({ ok: false, error: 'not_found' });
  const uri = vlessUri(u);
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

function probe(host, port) {
  return new Promise((resolve) => {
    const t = Date.now();
    const s = net.connect(port, host);
    s.setTimeout(3000);
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
app.server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url || '/', 'http://localhost');
  const token = u.pathname.startsWith('/vpn/') ? u.pathname.slice('/vpn/'.length) : null;
  if (!token || control.vpn_mode !== 'ws') { socket.destroy(); return; }
  const user = cdb.getUserByToken(token);
  if (!user || user.revoked_at || user.enabled !== 1 || user.exhausted === 1 ||
      (user.expires_at && Date.parse(user.expires_at) <= Date.now())) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    let up;
    try { up = new WebSocket(`ws://${control.singbox_ws_host}:${control.singbox_ws_port}${control.ws_path}`); }
    catch { ws.close(); return; }
    const pair = { client: ws, upstream: up, upBytes: 0, downBytes: 0 };
    if (!activeWs.has(user.id)) activeWs.set(user.id, new Set());
    activeWs.get(user.id).add(pair);
    const sid = cdb.db.prepare('INSERT INTO connection_sessions (user_id, ts_start, remote) VALUES (?, ?, ?)')
      .run(user.id, cdb.now(), req.socket.remoteAddress || '').lastInsertRowid;
    function finish() {
      if (pair.done) return;
      pair.done = true;
      activeWs.get(user.id)?.delete(pair);
      if (activeWs.get(user.id)?.size === 0) activeWs.delete(user.id);
      cdb.db.prepare('UPDATE connection_sessions SET ts_end=?, upload_bytes=?, download_bytes=?, status=? WHERE id=?')
        .run(cdb.now(), pair.upBytes, pair.downBytes, 'closed', Number(sid));
      cdb.recordTraffic(user.id, pair.upBytes, pair.downBytes, 'ws-proxy');
      try { ws.close(); } catch {}
      try { up.close(); } catch {}
    }
    const clientQueue = [];
    const upQueue = [];
    ws.on('message', (d) => {
      pair.upBytes += Buffer.isBuffer(d) ? d.length : Buffer.byteLength(String(d));
      if (up.readyState === WebSocket.OPEN) up.send(d); else clientQueue.push(d);
    });
    up.on('message', (d) => {
      pair.downBytes += Buffer.isBuffer(d) ? d.length : Buffer.byteLength(String(d));
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
  await app.listen({ host: control.appHost, port: control.appPort });
  process.stdout.write(`tiktunnel-control listening on ${control.appHost}:${control.appPort} mode=${control.vpn_mode}\n`);
  setInterval(enforceQuota, Number(control.quota_check_ms || 10000)).unref();
  setInterval(() => {
    const s = systemStats();
    const n = netRates();
    cdb.addMetric({ cpu_pct: s.cpu_pct, ram_used_kb: s.ram_used_kb, ram_total_kb: s.ram_total_kb,
      net_rx_bytes: n.rx_bps, net_tx_bytes: n.tx_bps, active_vpn: cdb.activeVpnUsers().length,
      api_latency_ms: s.api_latency_ms });
  }, 60000).unref();
  const shutdown = async () => { try { await app.close(); } finally { process.exit(0); } };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch((e) => { process.stderr.write(`control failed: ${e.message}\n`); process.exit(1); });
