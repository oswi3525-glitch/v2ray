'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const bcrypt = require('bcryptjs');
const Fastify = require('fastify');
const { WebSocketServer, WebSocket } = require('ws');

const zlib = require('node:zlib');
const cdb = require('./db');
const envcfg = require('../config/runtime');
const { runDiagnostics } = require('./diagnostics');
const research = require('./research');
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

const RESEARCH_TARGETS = [
  { id: 'tiktok', label: 'TikTok CDN (tiktokv.com)', host: 'tiktokv.com' },
  { id: 'youtube', label: 'YouTube (www.youtube.com)', host: 'www.youtube.com' },
  { id: 'apple', label: 'Safari/Apple (www.apple.com)', host: 'www.apple.com' },
  { id: 'github', label: 'GitHub (github.com)', host: 'github.com' },
  { id: 'cloudflare', label: 'Cloudflare (cloudflare.com)', host: 'cloudflare.com' }
];

const app = Fastify({ logger: false, bodyLimit: 16 * 1024, trustProxy: false });
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
const startedAt = Date.now();
const apiTimes = [];
const rateBuckets = new Map();
const activeWs = new Map();
const liveTraffic = new Map();
const lastTrafficSeen = new Map();
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
    experimental_vless_uri: u ? experimentalUri(u) : null,
    experimental_enabled: experimentalEnabled(),
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


function experimentalConfig() { return cdb.getExperimentalConfig(); }
function experimentalEnabled() { return experimentalConfig().enabled === true; }
function experimentalUri(u, deviceId = null) {
  const cfg = experimentalConfig();
  if (!cfg.enabled) return null;
  const v = cdb.getVpnClient(u.id);
  if (!v) return null;
  const uuid = cfg.uuid_mode === 'shared'
    ? (cfg.uuid || v.uuid)
    : cdb.getOrCreateExperimentalUuid(u.id);
  if (!uuid) return null;
  const name = encodeURIComponent((u.display_name || u.username) + ' Experimental');
  const address = cfg.server_address || control.publicTcpHost;
  const port = Number(cfg.server_port || control.publicTcpPort);
  const sni = cfg.sni || address;
  const host = cfg.host || address;
  const pathValue = (cfg.ws_path || '/vpn') + (cdb.validDeviceId(deviceId) ? `.${deviceId}` : '');
  if (cfg.protocol === 'vmess') {
    const obj = {
      v: '2', ps: (u.display_name || u.username) + ' Experimental', add: address, port: String(port),
      id: uuid, aid: '0', scy: 'auto', net: cfg.network || 'ws', type: 'none',
      host: host, path: pathValue, tls: cfg.tls_mode === 'tls' ? 'tls' : '',
      sni: sni
    };
    return 'vmess://' + Buffer.from(JSON.stringify(obj)).toString('base64');
  }
  if (cfg.network === 'ws') {
    const security = cfg.tls_mode === 'tls' ? 'tls' : 'none';
    const q = [
      'encryption=none', 'type=ws',
      `path=${encodeURIComponent(pathValue)}`,
      `host=${host}`, `security=${security}`, `sni=${sni}`
    ].join('&');
    return `vless://${uuid}@${address}:${port}?${q}#${name}`;
  }
  const security = cfg.tls_mode === 'tls' ? 'tls' : 'none';
  return `vless://${uuid}@${address}:${port}?encryption=none&type=tcp&security=${security}&sni=${sni}#${name}`;
}
function buildFullTunnelProfile(u, deviceId = null) {
  const v = cdb.getVpnClient(u.id);
  const s = cdb.getSubscription(u.id);
  if (!v || !s) return null;
  const tcp = control.publicTransport === 'tcp' || control.vpn_mode === 'tcp';
  const outbound = tcp
    ? {
        type: 'vless', tag: 'proxy',
        server: control.publicTcpHost, server_port: control.publicTcpPort,
        uuid: v.uuid, flow: '', packet_encoding: 'xudp'
      }
    : {
        type: 'vless', tag: 'proxy',
        server: control.public_https_host, server_port: 443,
        uuid: v.uuid, flow: '', packet_encoding: 'xudp',
        transport: {
          type: 'ws',
          path: s.path + (cdb.validDeviceId(deviceId) ? `.${deviceId}` : ''),
          headers: { Host: control.public_https_host }
        },
        tls: { enabled: true, server_name: control.public_https_host }
      };
  const config = {
    log: { level: 'warn', timestamp: true },
    dns: {
      servers: [
        { type: 'https', tag: 'remote-dns', server: '1.1.1.1', detour: 'proxy' },
        { type: 'local', tag: 'local-dns' }
      ],
      final: 'remote-dns'
    },
    inbounds: [
      {
        type: 'tun', tag: 'tun-in',
        address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
        mtu: 9000,
        auto_route: true,
        strict_route: true,
        stack: 'system'
      }
    ],
    outbounds: [
      outbound,
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' }
    ],
    route: {
      rules: [{ protocol: 'dns', action: 'hijack-dns' }],
      final: 'proxy',
      auto_detect_interface: true,
      default_domain_resolver: 'local-dns'
    }
  };
  return {
    config,
    meta: {
      profile: 'tiktunnel-full-tunnel',
      applies_to: 'sing-box client (desktop/Android/macOS). iOS system VPN still requires a NetworkExtension app or Shadowrocket.',
      ipv4: 'all IPv4 routed through the VPN outbound',
      ipv6: 'IPv6 is routed into the tunnel; no outside-tunnel IPv6 route is configured',
      dns: 'DNS resolved through the tunnel (remote-dns detoured to proxy)',
      udp: 'UDP forwarded via VLESS xudp; TCP via VLESS',
      routing_check: 'verify with a public IP echo after connecting; this file does not guarantee carrier-side behaviour'
    }
  };
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
// Compress JSON metadata/API responses when the client advertises support.
// This never touches VPN payloads (VLESS traffic does not pass through Fastify)
// and never re-compresses already-compressed or binary bodies.
app.addHook('onSend', async (req, reply, payload) => {
  try {
    if (req.method === 'HEAD' || reply.statusCode !== 200) return payload;
    if (!String(reply.getHeader('content-type') || '').includes('application/json')) return payload;
    if (reply.getHeader('content-encoding')) return payload;
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    if (body.length < 2048) return payload;
    const accept = String(req.headers['accept-encoding'] || '');
    if (/\bbr\b/.test(accept)) {
      const out = zlib.brotliCompressSync(body, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length }
      });
      reply.header('Content-Encoding', 'br');
      reply.header('Vary', 'Accept-Encoding');
      reply.header('Content-Length', out.length);
      return out;
    }
    if (/\bgzip\b/.test(accept)) {
      const out = zlib.gzipSync(body, { level: 6 });
      reply.header('Content-Encoding', 'gzip');
      reply.header('Vary', 'Accept-Encoding');
      reply.header('Content-Length', out.length);
      return out;
    }
  } catch {}
  return payload;
});
app.setErrorHandler((err, _req, reply) => reply.code(400).send({ ok: false, error: 'bad_request' }));

function readStatic(name, type) {
  return (req, reply) => {
    reply.header('Cache-Control', 'no-store, max-age=0');
    let body = fs.readFileSync(path.join(ROOT, 'web', name));
    if (name.endsWith('.html')) {
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
app.get('/plan-check', readStatic('plan-check.html', 'text/html; charset=utf-8'));
app.get('/plan-check.js', readStatic('plan-check.js', 'application/javascript; charset=utf-8'));
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

// ---- Research Lab (real measurements only) ----
app.get('/api/admin/research/hypotheses', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  return reply.send({ ok: true, hypotheses: research.listHypotheses(),
    targets: RESEARCH_TARGETS,
    policy: 'Server-observed probes only. No application-identity spoofing, traffic faking or carrier billing evasion.' });
});
app.post('/api/admin/research/run', async (req, reply) => {
  const a = guard(req, reply, 'admin'); if (!a || !csrfOk(req, a)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  if (rateLimited(req, 'research_run', 5, 60000)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
  const requested = Array.isArray(req.body?.targets) ? req.body.targets : RESEARCH_TARGETS.map((t) => t.id);
  const picked = RESEARCH_TARGETS.filter((t) => requested.includes(t.id));
  if (!picked.length) return reply.code(400).send({ ok: false, error: 'no_valid_targets' });
  const samples = Math.min(8, Math.max(3, Number.parseInt(req.body?.samples, 10) || 4));
  const results = [];
  for (const t of picked) {
    const r = await research.probeTarget(t.host, 443, { samples, tlsCheck: true, path: '/' });
    const id = cdb.addResearchRun({
      branch: 't15kn', target: t.host, kind: 'reachability', status: r.verdict,
      hypothesis: '', verdict: 'observed',
      detail: JSON.stringify({ tcp: r.tcp, tls: r.tls, http: r.http, dns: r.dns }),
      actor: 'admin'
    });
    results.push({ id, label: t.label, ...r });
  }
  cdb.securityEvent('admin', 'research_run', picked.map((t) => t.id).join(','), req.ip, `targets=${picked.length}`);
  return reply.header('Cache-Control', 'no-store').send({
    ok: true, branch: 't15kn', samples,
    results,
    note: 'Reachability is measured from the server. It does not prove how Viettel classifies or bills T15KN traffic.'
  });
});
app.get('/api/admin/research/runs', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  return reply.send({ ok: true, runs: cdb.listResearchRuns(limit), hypotheses: research.listHypotheses() });
});
app.post('/api/admin/research/carrier', async (req, reply) => {
  const a = guard(req, reply, 'admin'); if (!a || !csrfOk(req, a)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const b = req.body || {};
  const u = cdb.getUser(Number(b.user_id));
  if (!u) return reply.code(404).send({ ok: false, error: 'not_found' });
  const start = Date.parse(b.period_start);
  const end = Date.parse(b.period_end);
  const carrier = Number(b.carrier_used_bytes);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return reply.code(400).send({ ok: false, error: 'invalid_period' });
  if (!Number.isFinite(carrier) || carrier < 0) return reply.code(400).send({ ok: false, error: 'invalid_carrier_bytes' });
  const startIso = new Date(start).toISOString();
  const endIso = new Date(end).toISOString();
  const row = cdb.db.prepare('SELECT COALESCE(SUM(upload_bytes),0) AS up, COALESCE(SUM(download_bytes),0) AS down FROM traffic_usage WHERE user_id=? AND ts>=? AND ts<=?')
    .get(u.id, startIso, endIso);
  const serverUsed = Number(row.up) + Number(row.down);
  const delta = carrier - serverUsed;
  const denominator = Math.max(carrier, serverUsed, 1);
  const mismatchPct = +((Math.abs(delta) / denominator) * 100).toFixed(2);
  const id = cdb.addCarrierReport({
    user_id: u.id, period_start: startIso, period_end: endIso,
    carrier_used_bytes: Math.round(carrier), server_used_bytes: serverUsed,
    delta_bytes: Math.round(delta), note: String(b.note || '').slice(0, 300), actor: 'admin'
  });
  cdb.addResearchRun({
    branch: 't15kn', target: u.username, kind: 'carrier_reconciliation', status: mismatchPct > 10 ? 'MISMATCH' : 'CONSISTENT',
    hypothesis: 't15kn_non_tiktok_billed', verdict: mismatchPct > 10 ? 'testing' : 'unverified',
    detail: JSON.stringify({ carrier_used_bytes: Math.round(carrier), server_used_bytes: serverUsed, delta: Math.round(delta), mismatch_pct: mismatchPct }),
    actor: 'admin'
  });
  cdb.securityEvent('admin', 'carrier_report_added', String(u.id), req.ip, `delta=${Math.round(delta)}`);
  return reply.code(201).send({
    ok: true,
    id,
    user_id: u.id,
    carrier_used_bytes: Math.round(carrier),
    server_used_bytes: serverUsed,
    delta_bytes: Math.round(delta),
    mismatch_pct: mismatchPct,
    mismatch: mismatchPct > 10,
    note: 'The carrier figure is authoritative. Differences can come from free-rated traffic, tunnel overhead, clock skew or different billing windows.'
  });
});
app.get('/api/admin/research/carrier', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  return reply.send({ ok: true, reports: cdb.listCarrierReports(null, 100),
    note: 'Carrier figures are manually entered from Viettel usage screens; they are not fetched from Viettel APIs.' });
});
app.get('/api/friend/research', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  return reply.send({
    ok: true,
    branch: 't15kn',
    hypotheses: research.listHypotheses(),
    recent_runs: cdb.listResearchRuns(20).map((r) => ({ ts: r.ts, branch: r.branch, target: r.target, kind: r.kind, status: r.status, verdict: r.verdict })),
    carrier_reports: cdb.listCarrierReports(a.user.id, 20),
    note: 'Read-only research view. Run probes from the admin Research Lab.'
  });
});

app.get('/api/friend/me', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  return reply.send({ ok: true, user: publicSelf(cdb.getUser(a.user.id) || a.user) });
});
app.get('/api/friend/usage', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  return reply.send({ ok: true, usage: publicSelf(cdb.getUser(a.user.id) || a.user), history: cdb.trafficHistory(a.user.id, 100) });
});
app.get('/api/friend/usage/summary', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  const days = Math.min(365, Math.max(1, Number.parseInt(req.query.days, 10) || 30));
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const u = cdb.getUser(a.user.id) || a.user;
  return reply.header('Cache-Control', 'no-store').send({
    ok: true,
    scope: 'server-observed VPN interface bytes; not a carrier bill',
    quota_bytes: u.quota_bytes,
    used_upload: u.used_upload,
    used_download: u.used_download,
    ...cdb.trafficSummary(u.id, { buckets: days, sinceIso: since }),
    sessions: cdb.sessionHistory(u.id, 20)
  });
});
app.get('/api/friend/sessions', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  return reply.send({ ok: true, sessions: cdb.sessionHistory(a.user.id, 50) });
});
app.get('/api/admin/users/:id/usage/summary', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  const u = cdb.getUser(Number(req.params.id));
  if (!u) return reply.code(404).send({ ok: false, error: 'not_found' });
  const days = Math.min(365, Math.max(1, Number.parseInt(req.query.days, 10) || 30));
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  return reply.header('Cache-Control', 'no-store').send({
    ok: true,
    scope: 'server-observed VPN interface bytes; not a carrier bill',
    user: publicUser(u),
    ...cdb.trafficSummary(u.id, { buckets: days, sinceIso: since }),
    sessions: cdb.sessionHistory(u.id, 50)
  });
});
app.get('/api/friend/profile', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  const u = cdb.getUser(a.user.id) || a.user;
  if (!accountReady(u)) return reply.code(403).send({ ok: false, error: 'account_not_ready' });
  const profile = buildFullTunnelProfile(u, req.query.device);
  if (!profile) return reply.code(409).send({ ok: false, error: 'config_not_ready' });
  return reply.header('Cache-Control', 'no-store').send({ ok: true, ...profile });
});
app.get('/api/sub/:token/profile', async (req, reply) => {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(req.params.token)) return reply.code(400).send({ ok: false, error: 'invalid_token' });
  const u = cdb.getUserByToken(req.params.token);
  if (!u || !accountReady(u)) return reply.code(404).send({ ok: false, error: 'not_found' });
  const profile = buildFullTunnelProfile(u, req.query.device);
  if (!profile) return reply.code(404).send({ ok: false, error: 'not_found' });
  reply.header('Cache-Control', 'no-store');
  reply.header('Content-Disposition', `attachment; filename="tiktunnel-fulltunnel-${String(u.username).replace(/[^A-Za-z0-9_.-]/g, '_')}.json"`);
  return reply.send(profile.config);
});
app.get('/api/friend/vpn', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  return reply.send({     ok: true, uri: vlessUri(a.user, req.query.device), experimental_uri: experimentalUri(a.user, req.query.device), experimental_enabled: experimentalEnabled(), mode: control.publicTransport, active: cdb.activeVpnUsers().some((u) => u.id === a.user.id) });
});
app.get('/api/friend/import', async (req, reply) => {
  if (req.query && req.query.branch === 'experimental') return experimentalImportHandler(req, reply);
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
app.get('/api/friend/experimental', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  const u = cdb.getUser(a.user.id) || a.user;
  return reply.send({ ok: true, uri: experimentalUri(u, req.query.device), enabled: experimentalEnabled(),
    config: experimentalConfig(), mode: experimentalConfig().network || 'ws' });
});
app.get('/api/experimental/status', async (req, reply) => {
  const s = sessionFor(req);
  if (!s) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  return reply.send({ ok: true, enabled: experimentalEnabled(), config: experimentalConfig() });
});
function experimentalImportHandler(req, reply) {
  const a = guard(req, reply, 'friend'); if (!a) return;
  const u = cdb.getUser(a.user.id) || a.user;
  const deviceId = cdb.validDeviceId(req.query.device) ? req.query.device : null;
  if (!accountReady(u)) {
    cdb.securityEvent('friend', 'experimental_import_denied', String(u.id), req.ip, 'account_not_ready');
    return reply.code(403).send({ ok: false, error: 'account_not_ready' });
  }
  const cfg = experimentalConfig();
  if (!cfg.enabled) return reply.code(409).send({ ok: false, error: 'experimental_disabled' });
  const uri = experimentalUri(u, deviceId);
  if (!uri) return reply.code(409).send({ ok: false, error: 'experimental_config_not_ready' });
  // validate URI
  if (!/^vless:\/\/|^vmess:\/\//.test(uri)) return reply.code(400).send({ ok: false, error: 'invalid_uri' });
  const s = cdb.getSubscription(u.id);
  const origin = cfg.server_address ? `http://${cfg.server_address}:${cfg.server_port}` : (control.public_https_host ? `https://${control.public_https_host}` : `${req.protocol}://${req.headers.host}`);
  const subUrl = `${origin}/api/experimental/sub/${s.token}${deviceId ? `?device=${deviceId}` : ''}`;
  const remark = ((u.display_name || u.username) + ' Experimental').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40);
  const serverReady = true;
  cdb.securityEvent('friend', 'experimental_import_link_issued', String(u.id), req.ip, `branch=experimental`);
  return reply.header('Cache-Control', 'no-store').send({
    ok: true, branch: 'experimental',
    server_ready: serverReady, account_ready: true, ready: true,
    remaining_bytes: Math.max(0, (u.quota_bytes || 0) - (u.used_upload || 0) - (u.used_download || 0)),
    uri, subscription_url: subUrl,
    links: { node: `shadowrocket://add/${uri}`, subscription: `sub://${Buffer.from(subUrl, 'utf8').toString('base64')}#${encodeURIComponent(remark)}` },
    fallback: { copy_uri: true, open_url: subUrl, file_url: `/api/friend/export?branch=experimental${deviceId ? `&device=${deviceId}` : ''}` },
    note: 'Experimental branch. Main config unchanged.'
  });
}
app.get('/api/friend/import/experimental', experimentalImportHandler);
app.get('/api/experimental/import', experimentalImportHandler);
app.get('/api/friend/experimental/import', experimentalImportHandler);
app.get('/api/experimental/import/friend', experimentalImportHandler);
// alias with query
app.get('/api/experimental/import/:unused', experimentalImportHandler);

app.get('/api/experimental/sub/:token', async (req, reply) => {
  const u = cdb.getUserByToken(req.params.token);
  if (!u || !accountReady(u)) return reply.code(404).send({ ok: false, error: 'not_found' });
  const uri = experimentalUri(u, req.query.device);
  if (!uri) return reply.code(404).send({ ok: false, error: 'not_found' });
  reply.header('Cache-Control', 'no-store');
  reply.type('text/plain; charset=utf-8');
  return reply.send(req.query.raw === '1' ? uri + '\n' : Buffer.from(uri + '\n').toString('base64'));
});
app.get('/api/experimental/export', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a) return;
  const u = cdb.getUser(a.user.id) || a.user;
  const uri = experimentalUri(u, req.query.device);
  if (!uri) return reply.code(404).send({ ok: false, error: 'not_found' });
  const name = String(u.username || 'tiktunnel').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
  reply.header('Content-Disposition', `attachment; filename="tiktunnel-experimental-${name}.txt"`);
  reply.header('Cache-Control', 'no-store');
  reply.type('text/plain; charset=utf-8');
  return reply.send(uri + '\n');
});

// Admin experimental config endpoints
app.get('/api/admin/experimental', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  return reply.send({ ok: true, enabled: experimentalEnabled(), config: experimentalConfig() });
});
app.post('/api/admin/experimental', async (req, reply) => {
  const a = guard(req, reply, 'admin'); if (!a || !csrfOk(req, a)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const b = req.body || {};
  const patch = {};
  if (b.enabled !== undefined) patch.enabled = !!b.enabled;
  if (b.server_address !== undefined) patch.server_address = String(b.server_address).trim().slice(0, 255);
  if (b.server_port !== undefined) { const p=Number(b.server_port); if (Number.isFinite(p)&&p>0&&p<65536) patch.server_port=p; }
  if (b.protocol !== undefined && ['vless','vmess'].includes(b.protocol)) patch.protocol = b.protocol;
  if (b.network !== undefined && ['ws','tcp'].includes(b.network)) patch.network = b.network;
  if (b.tls_mode !== undefined && ['tls','none'].includes(b.tls_mode)) patch.tls_mode = b.tls_mode;
  if (b.sni !== undefined) patch.sni = String(b.sni).trim().slice(0, 255);
  if (b.host !== undefined) patch.host = String(b.host).trim().slice(0, 255);
  if (b.ws_path !== undefined) patch.ws_path = String(b.ws_path).trim().slice(0, 255) || '/vpn';
  if (b.uuid !== undefined && /^[0-9a-f-]{36}$/i.test(b.uuid)) patch.uuid = b.uuid;
  if (b.uuid_mode !== undefined && ['per_user','shared'].includes(b.uuid_mode)) patch.uuid_mode = b.uuid_mode;
  // rollback backup
  try {
    const fs = require('node:fs'); const path = require('node:path');
    const ROOT = cdb.ROOT;
    const backupDir = path.join(ROOT, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'experimental-config.last.json'), JSON.stringify(experimentalConfig(), null, 2));
  } catch {}
  const next = cdb.setExperimentalConfig(patch);
  return reply.send({ ok: true, enabled: next.enabled === true, config: next });
});
app.post('/api/admin/experimental/rollback', async (req, reply) => {
  const a = guard(req, reply, 'admin'); if (!a || !csrfOk(req, a)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  try {
    const fs = require('node:fs'); const path = require('node:path');
    const ROOT = cdb.ROOT;
    const f = path.join(ROOT, 'backups', 'experimental-config.last.json');
    if (fs.existsSync(f)) {
      const prev = JSON.parse(fs.readFileSync(f, 'utf8'));
      cdb.setSetting('experimental_config', JSON.stringify(prev));
    } else {
      cdb.setSetting('experimental_config', JSON.stringify(cdb.DEFAULT_EXPERIMENTAL_CONFIG || {}));
    }
  } catch (e) { return reply.code(500).send({ ok: false, error: 'rollback_failed' }); }
  return reply.send({ ok: true, enabled: experimentalEnabled(), config: experimentalConfig() });
});

// Experimental analyzer (server-side real probes)
app.get('/api/experimental/analyze', async (req, reply) => {
  const s = sessionFor(req);
  if (!s) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const cfg = experimentalConfig();
  if (!cfg.enabled) return reply.send({ ok: true, enabled: false, results: [] });
  const host = cfg.server_address || control.publicTcpHost;
  const port = Number(cfg.server_port || control.publicTcpPort);
  const out = [];
  // DNS
  try {
    const dns = require('node:dns');
    const r = await new Promise((res, rej) => dns.lookup(host, (e, a) => e ? rej(e) : res(a)));
    out.push({ id: 'dns', label: 'DNS resolution', status: 'PASS', detail: r });
  } catch (e) { out.push({ id: 'dns', label: 'DNS resolution', status: 'FAIL', detail: String(e.message) }); }
  // TCP
  let tcpOk = false, tcpMs = null;
  try {
    const t = Date.now();
    await new Promise((res, rej) => {
      const sock = require('node:net').connect(port, host);
      sock.setTimeout(3000);
      sock.on('connect', () => { tcpMs = Date.now()-t; sock.destroy(); res(); });
      sock.on('error', rej);
      sock.on('timeout', () => { sock.destroy(); rej(new Error('timeout')); });
    });
    tcpOk = true;
    out.push({ id: 'tcp', label: 'TCP connectivity', status: 'PASS', detail: `${tcpMs} ms` });
  } catch (e) { out.push({ id: 'tcp', label: 'TCP connectivity', status: 'FAIL', detail: String(e.message) }); }
  // TLS
  if (cfg.tls_mode === 'tls') {
    try {
      const tls = require('node:tls');
      const t = Date.now();
      await new Promise((res, rej) => {
        const sock = tls.connect({ host, port, servername: cfg.sni || host, rejectUnauthorized: true }, () => {
          const cert = sock.getPeerCertificate();
          out.push({ id: 'tls', label: 'TLS handshake', status: 'PASS', detail: `${Date.now()-t} ms` });
          out.push({ id: 'certificate', label: 'Certificate validation', status: cert && cert.subject ? 'PASS' : 'FAIL', detail: `CN=${cert?.subject?.CN || ''}, issuer=${cert?.issuer?.CN || ''}, valid_to=${cert?.valid_to || ''}` });
          sock.destroy(); res();
        });
        sock.setTimeout(5000);
        sock.on('error', (e) => { out.push({ id: 'tls', label: 'TLS handshake', status: 'FAIL', detail: String(e.message) }); rej(e); });
        sock.on('timeout', () => { sock.destroy(); out.push({ id: 'tls', label: 'TLS handshake', status: 'FAIL', detail: 'timeout' }); rej(new Error('timeout')); });
      });
    } catch {}
  } else {
    out.push({ id: 'tls', label: 'TLS handshake', status: 'WARNING', detail: 'TLS disabled (none mode)' });
  }
  // SNI/Host info
  out.push({ id: 'sni', label: 'SNI configured', status: cfg.sni ? 'PASS' : 'WARNING', detail: cfg.sni || '(none)' });
  out.push({ id: 'host', label: 'Host header configured', status: cfg.host ? 'PASS' : 'WARNING', detail: cfg.host || '(none)' });
  // WebSocket handshake (best-effort HTTP upgrade)
  if (cfg.network === 'ws' && tcpOk) {
    try {
      const http = require('node:http');
      const wsKey = require('node:crypto').randomBytes(16).toString('base64');
      const pathValue = cfg.ws_path || '/vpn';
      const res = await new Promise((resolve, reject) => {
        const req = http.request({ host, port, path: pathValue, method: 'GET',
          headers: { 'Connection': 'Upgrade', 'Upgrade': 'websocket', 'Sec-WebSocket-Key': wsKey, 'Sec-WebSocket-Version': '13', 'Host': cfg.host || host } }, (r) => resolve(r));
        if (cfg.tls_mode === 'tls') { /* skip for plain */ }
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
      const status = res.statusCode;
      out.push({ id: 'ws', label: 'WebSocket handshake', status: status === 101 ? 'PASS' : 'WARNING', detail: `HTTP ${status}` });
    } catch (e) { out.push({ id: 'ws', label: 'WebSocket handshake', status: 'FAIL', detail: String(e.message) }); }
  }
  // repeated TCP probes for packet loss / latency
  const probeMs = [];
  let lost = 0;
  for (let i = 0; i < 6; i++) {
    try {
      const t = Date.now();
      await new Promise((res, rej) => {
        const sock = require('node:net').connect(port, host);
        sock.setTimeout(2000);
        sock.on('connect', () => { probeMs.push(Date.now() - t); sock.destroy(); res(); });
        sock.on('error', rej);
        sock.on('timeout', () => { sock.destroy(); rej(new Error('timeout')); });
      });
    } catch (e) { lost++; }
  }
  const avgProbe = probeMs.length ? probeMs.reduce((a,b)=>a+b,0)/probeMs.length : 0;
  const lossPct = (lost / 6) * 100;
  out.push({ id: 'ping', label: 'Ping/TCP latency', status: tcpOk ? 'PASS' : 'FAIL', detail: tcpOk ? `avg ${avgProbe.toFixed(1)} ms` : 'unreachable' });
  out.push({ id: 'packet_loss', label: 'Packet loss', status: lossPct === 0 ? 'PASS' : (lossPct < 50 ? 'WARNING' : 'FAIL'), detail: `${lossPct.toFixed(1)} % (${lost}/6)` });
  // HTTP Host header probe
  try {
    const mod = cfg.tls_mode === 'tls' ? require('node:https') : require('node:http');
    const t = Date.now();
    const r = await new Promise((res, rej) => {
      const rq = mod.request({ host, port, path: '/', method: 'GET', servername: cfg.sni || host,
        headers: { Host: cfg.host || host }, rejectUnauthorized: cfg.tls_mode === 'tls' }, (resp) => {
        let bytes = 0;
        resp.on('data', (c) => { bytes += c.length; });
        resp.on('end', () => res({ status: resp.statusCode, bytes, ms: Date.now() - t }));
      });
      rq.on('error', rej);
      rq.setTimeout(5000, () => { rq.destroy(); rej(new Error('timeout')); });
      rq.end();
    });
    out.push({ id: 'http_host', label: 'HTTP Host Header', status: r.status < 500 ? 'PASS' : 'WARNING', detail: `HTTP ${r.status}, ${r.bytes} B, ${r.ms} ms` });
    out.push({ id: 'response_time', label: 'Thời gian phản hồi', status: 'PASS', detail: `${r.ms} ms` });
  } catch (e) {
    out.push({ id: 'http_host', label: 'HTTP Host Header', status: 'WARNING', detail: String(e.message) });
    out.push({ id: 'response_time', label: 'Thời gian phản hồi', status: 'WARNING', detail: String(e.message) });
  }
  // throughput estimate
  out.push({ id: 'throughput', label: 'Download/Upload throughput', status: 'WARNING', detail: 'Thử nghiệm throughput cần endpoint dữ liệu trên server Experimental; chưa có endpoint, không giả lập.' });
  return reply.header('Cache-Control', 'no-store').send({ ok: true, enabled: true, branch: 'experimental', host, port, results: out,
    summary: { pass: out.filter(c=>c.status==='PASS').length, fail: out.filter(c=>c.status==='FAIL').length,
      warning: out.filter(c=>c.status==='WARNING').length } });
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
  if (req.query && req.query.branch === 'experimental') {
    const u = cdb.getUser(a.user.id) || a.user;
    const uri = experimentalUri(u, req.query.device);
    if (!uri) return reply.code(404).send({ ok: false, error: 'not_found' });
    const name = String(u.username || 'tiktunnel').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
    reply.header('Content-Disposition', `attachment; filename="tiktunnel-experimental-${name}.txt"`);
    reply.header('Cache-Control', 'no-store');
    reply.type('text/plain; charset=utf-8');
    return reply.send(uri + '\n');
  }
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
app.post('/api/friend/devices/register', async (req, reply) => {
  const a = guard(req, reply, 'friend'); if (!a || !csrfOk(req, a)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  if (rateLimited(req, 'device_register', 30, 60000)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
  const id = String(req.body?.id || '');
  if (!cdb.validDeviceId(id)) return reply.code(400).send({ ok: false, error: 'invalid_device_id' });
  const b = req.body || {};
  const m = {
    name: typeof b.name === 'string' ? b.name : '',
    platform: typeof b.platform === 'string' ? b.platform : '',
    kind: ['mobile', 'tablet', 'desktop', 'unknown'].includes(b.kind) ? b.kind : 'unknown',
    agent_hash: typeof b.agent_hash === 'string' ? b.agent_hash : '',
    client_version: typeof b.client_version === 'string' ? b.client_version : ''
  };
  const known = cdb.getDevice(a.user.id, id);
  const device = cdb.registerDevice(a.user.id, id, m);
  if (!device) return reply.code(400).send({ ok: false, error: 'invalid_device_id' });
  if (!known) {
    cdb.audit('friend', 'device_registered', id, `${m.kind}/${m.platform}`);
    cdb.notify({ userId: a.user.id, role: 'friend', type: 'device',
      title: 'Thiết bị được đăng ký', body: `${m.platform || m.kind || 'Thiết bị mới'} đã đăng ký trong dashboard.` });
  }
  return reply.send({ ok: true, device });
});
app.get('/api/admin/devices', async (req, reply) => {
  if (!guard(req, reply, 'admin')) return;
  const p = page(req.query, 20, 100);
  return reply.send({ ok: true, devices: withStatus(cdb.adminDevices(p.limit, p.offset)), ...p });
});

const downloadBlock = Buffer.alloc(64 * 1024, 0x5a);
const downloadCache = new Map();
function downloadPayload(n) {
  let buf = downloadCache.get(n);
  if (!buf) {
    buf = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i += downloadBlock.length) {
      downloadBlock.copy(buf, i, 0, Math.min(downloadBlock.length, n - i));
    }
    if (downloadCache.size >= 12) downloadCache.clear();
    downloadCache.set(n, buf);
  }
  return buf;
}
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
  const buf = downloadPayload(n);
  reply.header('Cache-Control', 'no-store');
  reply.header('Content-Length', String(n));
  reply.header('X-Payload-Bytes', String(n));
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
const wsHeartbeat = setInterval(() => {
  for (const set of activeWs.values()) {
    for (const pair of set) {
      try {
        if (!pair.alive) {
          pair.client.terminate();
          pair.upstream.terminate();
          continue;
        }
        pair.alive = false;
        if (pair.client.readyState === WebSocket.OPEN) pair.client.ping();
      } catch {}
    }
  }
}, 30000);
wsHeartbeat.unref();
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
  if (up + down > 0) lastTrafficSeen.set(userId, Date.now());
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
  const wsLast = lastTrafficSeen.get(user.id) || 0;
  const dbLast = user.last_seen ? Date.parse(user.last_seen) : 0;
  const lastData = Math.max(wsLast, Number.isFinite(dbLast) ? dbLast : 0);
  const active = lastData > 0 && now - lastData <= 60000;
  return {
    active,
    tunnel_open: activeWs.has(user.id),
    last_traffic_at: lastData > 0 ? new Date(lastData).toISOString() : null,
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
    const pair = { client: ws, upstream: up, upBytes: 0, downBytes: 0, deviceId, lastTouch: 0,
      countedUp: 0, countedDown: 0, alive: true };
    ws.on('pong', () => { pair.alive = true; });
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
  for (const [k, v] of deviceLastTraffic) if (t - v > 10 * 60 * 1000) deviceLastTraffic.delete(k);
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
  const shutdown = async () => {
    clearInterval(wsHeartbeat);
    try { await app.close(); } finally { process.exit(0); }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch((e) => { process.stderr.write(`control failed: ${e.message}\n`); process.exit(1); });
