'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const Fastify = require('fastify');

const db = require('./db');
const { ROOT } = db;
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'settings.json'), 'utf8'));

function loadSecrets() {
  const file = path.join(ROOT, 'config', 'secrets.env');
  if (!fs.existsSync(file)) throw new Error('config/secrets.env missing — run scripts/bootstrap.sh');
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  if (!out.TIKTUNNEL_ADMIN_TOKEN || out.TIKTUNNEL_ADMIN_TOKEN.includes('REPLACE')) {
    throw new Error('TIKTUNNEL_ADMIN_TOKEN is not configured');
  }
  return out;
}

const secrets = loadSecrets();
const adminToken = secrets.TIKTUNNEL_ADMIN_TOKEN;
const startedAt = Date.now();

const app = Fastify({
  logger: false,
  bodyLimit: 4096,
  trustProxy: false,
  connectionTimeout: 10000,
  keepAliveTimeout: 5000
});

app.setErrorHandler((err, _req, reply) => {
  reply.code(400).send({ ok: false, error: 'bad_request' });
});

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const buckets = new Map();
app.addHook('onRequest', async (req, reply) => {
  const isAdmin = req.url.startsWith('/api/') && !req.url.startsWith('/api/sub/');
  const limit = isAdmin ? 30 : 120;
  const windowMs = 60_000;
  const key = `${req.ip}|${isAdmin ? 'a' : 'p'}`;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.reset) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  reply.header('X-RateLimit-Limit', limit);
  reply.header('X-RateLimit-Remaining', Math.max(0, limit - b.count));
  if (b.count > limit) {
    reply.header('Retry-After', Math.ceil((b.reset - now) / 1000));
    return reply.code(429).send({ ok: false, error: 'rate_limited' });
  }
  if (buckets.size > 2000) {
    for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  }
});

function requireAdmin(req, reply, done) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!safeEqual(token, adminToken)) {
    reply.code(401).send({ ok: false, error: 'unauthorized' });
    return;
  }
  done();
}

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    expires_at: row.expires_at,
    created_at: row.created_at,
    revoked: row.revoked_at !== null,
    active: db.active(row),
    has_subscription: true
  };
}

function validateName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9 ._-]{1,32}$/.test(name);
}

function validateExpiry(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
  const t = Date.parse(value);
  if (!Number.isFinite(t) || t <= Date.now()) return false;
  return new Date(t).toISOString();
}

let applyChain = Promise.resolve();
function applyConfig() {
  applyChain = applyChain.then(
    () =>
      new Promise((resolve, reject) => {
        execFile(
          'bash',
          [path.join(ROOT, 'scripts', 'apply-config.sh')],
          { cwd: ROOT, timeout: 15_000 },
          (err, stdout) => {
            if (err) return reject(new Error('apply_config_failed'));
            resolve(stdout.trim());
          }
        );
      })
  );
  return applyChain;
}

function buildUri(row) {
  const host = settings.public_host;
  const port = Number(settings.listen_port);
  const q = new URLSearchParams();
  q.set('encryption', 'none');
  q.set('type', settings.transport || 'tcp');
  q.set('security', settings.security || 'none');
  if (settings.security === 'tls' && settings.sni) q.set('sni', settings.sni);
  if (settings.flow) q.set('flow', settings.flow);
  return `vless://${row.uuid}@${host}:${port}?${q.toString()}#${encodeURIComponent(row.name)}`;
}

function subscriptionFor(token) {
  const owner = db.findByToken(token);
  if (!owner || owner.revoked_at !== null) return null;
  const rows = db.listActiveUsers().filter((u) => u.sub_token === token);
  return rows.map(buildUri);
}

app.get('/health', async () => ({ ok: true, service: 'tiktunnel-api', uptime_s: Math.floor((Date.now() - startedAt) / 1000) }));

app.get('/api/status', { preHandler: requireAdmin }, async () => {
  let singBox = 'stopped';
  try {
    const pid = Number(fs.readFileSync(path.join(ROOT, 'logs', 'sing-box.pid'), 'utf8').trim());
    process.kill(pid, 0);
    singBox = 'running';
  } catch {
    singBox = 'stopped';
  }
  return {
    ok: true,
    mode: settings.mode,
    security: settings.security,
    listen_port: Number(settings.listen_port),
    sing_box: singBox,
    accounts: db.stats(),
    uptime_s: Math.floor((Date.now() - startedAt) / 1000)
  };
});

app.get('/api/users', { preHandler: requireAdmin }, async () => ({
  ok: true,
  max_users: Number(settings.max_users),
  users: db.listUsers().map(publicUser)
}));

app.post('/api/users', { preHandler: requireAdmin }, async (req, reply) => {
  const body = req.body || {};
  if (!validateName(body.name)) return reply.code(400).send({ ok: false, error: 'invalid_name' });
  const expiresAt = validateExpiry(body.expires_at);
  if (expiresAt === false) return reply.code(400).send({ ok: false, error: 'invalid_expires_at' });
  if (db.countActive() >= Number(settings.max_users)) {
    return reply.code(409).send({ ok: false, error: 'active_user_limit_reached' });
  }
  const row = db.createUser({ name: body.name.trim(), expiresAt });
  try {
    await applyConfig();
  } catch {
    db.revokeUser(row.id);
    await applyConfig().catch(() => {});
    return reply.code(500).send({ ok: false, error: 'config_apply_failed' });
  }
  const subToken = db.findById(row.id).sub_token;
  return reply.code(201).send({
    ok: true,
    user: publicUser(row),
    subscription_url: `/api/sub/${subToken}`
  });
});

app.patch('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'invalid_id' });
  const body = req.body || {};
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return reply.code(400).send({ ok: false, error: 'invalid_enabled' });
  }
  const expiresAt = validateExpiry(body.expires_at);
  if (expiresAt === false) return reply.code(400).send({ ok: false, error: 'invalid_expires_at' });
  const row = db.setUser(id, { enabled: body.enabled, expiresAt });
  if (!row) return reply.code(404).send({ ok: false, error: 'not_found' });
  try {
    await applyConfig();
  } catch {
    return reply.code(500).send({ ok: false, error: 'config_apply_failed' });
  }
  return reply.send({ ok: true, user: publicUser(row) });
});

app.delete('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'invalid_id' });
  const row = db.revokeUser(id);
  if (!row) return reply.code(404).send({ ok: false, error: 'not_found' });
  try {
    await applyConfig();
  } catch {
    return reply.code(500).send({ ok: false, error: 'config_apply_failed' });
  }
  return reply.send({ ok: true, user: publicUser(row) });
});

app.get('/api/sub/:token', async (req, reply) => {
  const token = req.params.token;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
    return reply.code(400).send({ ok: false, error: 'invalid_token' });
  }
  const uris = subscriptionFor(token);
  if (!uris) return reply.code(404).send({ ok: false, error: 'not_found' });
  reply.header('Cache-Control', 'no-store');
  reply.header('Content-Disposition', 'attachment; filename="tiktunnel.sub"');
  if (req.query.raw === '1') {
    reply.type('text/plain; charset=utf-8');
    return reply.send(uris.join('\n') + '\n');
  }
  reply.type('text/plain; charset=utf-8');
  return reply.send(Buffer.from(uris.join('\n') + '\n').toString('base64'));
});

app.get('/api/metrics', { preHandler: requireAdmin }, async () => {
  const mem = process.memoryUsage();
  return {
    ok: true,
    process: {
      rss_bytes: mem.rss,
      heap_used_bytes: mem.heapUsed,
      uptime_s: Math.floor(process.uptime())
    },
    accounts: db.stats(),
    events: db.recentEvents(10),
    rate_limit_buckets: buckets.size
  };
});

async function main() {
  await app.listen({ host: settings.api_host, port: Number(settings.api_port) });
  process.stdout.write(`tiktunnel-api listening on ${settings.api_host}:${settings.api_port}\n`);
  const shutdown = async () => {
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  process.stderr.write(`api_failed: ${err.message}\n`);
  process.exit(1);
});
