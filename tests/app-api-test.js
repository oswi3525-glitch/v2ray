'use strict';

/* Tests the app-facing API: bearer tokens, refresh rotation, /api/vpn/* endpoints
   and server-observed metrics. All traffic numbers here come from real DB rows. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cdb = require('../control/db');
const cfg = require('../config/control.json');
const envcfg = require('../config/runtime');
const { ROOT } = cdb;

const BASE = `http://127.0.0.1:${cfg.app_port}`;
const markerSource = 'app-api-test';
const results = [];
function rec(name, status, detail = '') {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(6)} ${name}${detail ? ' — ' + detail : ''}`);
}
function check(name, cond, detail = '') { rec(name, cond ? 'PASS' : 'FAIL', detail); return !!cond; }

async function api(p, { method = 'GET', body, token, cookie, csrf, headers = {} } = {}) {
  const h = { ...headers };
  if (body) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  if (cookie) h.cookie = cookie;
  if (csrf) h['x-csrf-token'] = csrf;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data, headers: r.headers, cookie: sc ? sc.split(';')[0] : cookie };
}

async function main() {
  console.log('=== TikTunnel app API tests ===');
  const credFile = path.join(ROOT, 'tests', 'runtime', 'test-credentials.json');
  if (!fs.existsSync(credFile)) {
    check('friend credentials exist (run npm test first)', false, credFile);
    return finish();
  }
  const creds = JSON.parse(fs.readFileSync(credFile, 'utf8'));
  const user = cdb.listUsers().find((u) => u.username === 'friend1' && !u.revoked_at) || cdb.listUsers().find((u) => !u.revoked_at);
  if (!check('an active friend account exists', !!user)) return finish();

  const tokenIdsBefore = new Set(cdb.db.prepare('SELECT id FROM api_tokens').all().map((r) => r.id));
  const usedBefore = cdb.trafficTotals(user.id).total;
  const deviceId = crypto.randomBytes(8).toString('hex');

  const discovery = await api('/api');
  check('API discovery endpoint works without auth', discovery.status === 200 && discovery.data.api_version === 1);
  check('discovery advertises bearer auth', Array.isArray(discovery.data.auth) && discovery.data.auth.includes('bearer'));

  const login = await api('/api/tikfl/login', {
    method: 'POST', body: { username: user.username, password: creds.friend }
  });
  if (!check('token login succeeds', login.status === 200, `http=${login.status}`)) return finish();
  const token = login.data.token || login.data.access_token;
  const refresh = login.data.refresh_token;
  check('login returns snake_case token fields',
    typeof token === 'string' && token.length > 20 &&
    typeof refresh === 'string' && refresh.length > 20 &&
    typeof login.data.expires_in === 'number');
  check('login does not return raw password', !JSON.stringify(login.data).includes(creds.friend));
  check('token is stored as a hash, not plaintext',
    !!cdb.db.prepare('SELECT id FROM api_tokens WHERE token_hash=?').get(crypto.createHash('sha256').update(token).digest('hex')) &&
    !cdb.db.prepare('SELECT id FROM api_tokens WHERE token_hash=?').get(token));

  const me = await api('/api/auth/me', { token });
  check('bearer token authenticates /api/auth/me', me.status === 200 && me.data.role === 'friend');
  check('bearer session has no CSRF requirement', me.data.csrf === null);
  check('bearer session reports expiry', typeof me.data.expires_in === 'number' && me.data.expires_in > 0);
  const noAuth = await api('/api/auth/me');
  check('missing token is rejected', noAuth.status === 401);

  const post = await api('/api/friend/devices/register', {
    method: 'POST', token, body: { id: deviceId, name: 'App API Test', platform: 'ios', kind: 'mobile' }
  });
  check('bearer POST does not need a CSRF header', post.status === 200, `http=${post.status}`);

  const config = await api('/api/vpn/config', { token, headers: { 'accept-encoding': 'br' } });
  check('VPN config endpoint works with bearer', config.status === 200 && config.data.ok === true);
  check('config exposes a parseable VLESS URI', String(config.data.uri || '').startsWith('vless://'));
  check('config parsed fields match the account UUID',
    config.data.config?.uuid === cdb.getVpnClient(user.id).uuid);
  check('config network/security are honest for public TCP mode',
    config.data.config?.network === 'tcp' && config.data.config?.security === 'none');
  check('config includes full-tunnel profile and metadata',
    !!config.data.full_tunnel?.inbounds && config.data.profile_meta?.profile === 'tiktunnel-full-tunnel');
  check('config is marked no-store',
    String(config.headers.get('cache-control') || '').includes('no-store'));

  const status = await api('/api/vpn/status', { token });
  check('VPN status endpoint works with bearer', status.status === 200 && status.data.ok === true);
  check('status exposes real booleans, not a fake connected flag',
    typeof status.data.server_ready === 'boolean' &&
    typeof status.data.account_ready === 'boolean' &&
    typeof status.data.tunnel_active === 'boolean');
  check('status does not force tunnel_active true', status.data.tunnel_active === false || !!status.data.last_traffic_at);

  cdb.recordTraffic(user.id, 4096, 8192, markerSource, undefined, 96);
  const metrics = await api('/api/vpn/metrics', { token });
  if (!check('VPN metrics endpoint works with bearer', metrics.status === 200 && metrics.data.ok === true)) return finish();
  check('metrics are labelled server-observed', metrics.data.scope === 'server_observed');
  check('metrics used_bytes includes the injected real DB traffic',
    metrics.data.used_bytes >= usedBefore + 4096 + 8192,
    `${metrics.data.used_bytes} >= ${usedBefore + 12288}`);
  check('metrics overhead is tracked separately', metrics.data.overhead_bytes >= 96);
  check('metrics up/down bitrate is measured over a real window',
    metrics.data.up_bps > 0 && metrics.data.down_bps > 0 && metrics.data.rate_window_ms === 6000,
    `up=${metrics.data.up_bps} down=${metrics.data.down_bps}`);
  check('metrics rate source is recorded traffic', metrics.data.rate_source === 'traffic_usage');
  check('metrics report active only after real traffic', metrics.data.active === true && !!metrics.data.last_traffic_at);
  check('metrics include real session history array', Array.isArray(metrics.data.sessions));
  check('metrics disclose what the server cannot measure',
    /not observable|not simulated/i.test(metrics.data.note || ''));
  check('metrics do not expose admin-only host stats', metrics.data.cpu_pct === undefined && metrics.data.ram_used_kb === undefined);

  const rotated = await api('/api/auth/refresh', { method: 'POST', body: { refresh_token: refresh } });
  check('refresh rotates tokens', rotated.status === 200 && typeof rotated.data.token === 'string' && rotated.data.token !== token);
  const reused = await api('/api/auth/refresh', { method: 'POST', body: { refresh_token: refresh } });
  check('old refresh token cannot be reused', reused.status === 401);
  const rotatedMe = await api('/api/auth/me', { token: rotated.data.token });
  check('new access token works', rotatedMe.status === 200 && rotatedMe.data.role === 'friend');
  const originalMe = await api('/api/auth/me', { token });
  check('refresh rotation does not invalidate a live access token', originalMe.status === 200);

  const logout = await api('/api/auth/logout', { method: 'POST', token });
  check('bearer logout succeeds', logout.status === 200);
  const revoked = await api('/api/auth/me', { token });
  check('logged-out token is rejected', revoked.status === 401);

  cdb.db.prepare('DELETE FROM traffic_usage WHERE source=?').run(markerSource);
  cdb.db.prepare('DELETE FROM devices WHERE id=?').run(deviceId);
  for (const row of cdb.db.prepare('SELECT id FROM api_tokens').all()) {
    if (!tokenIdsBefore.has(row.id)) cdb.db.prepare('DELETE FROM api_tokens WHERE id=?').run(row.id);
  }
  finish();
}

function finish() {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  console.log(`SUMMARY PASS=${pass} FAIL=${fail}`);
  fs.mkdirSync(path.join(ROOT, 'reports', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'reports', 'runtime', 'app-api-tests.json'), JSON.stringify(results, null, 2) + '\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('app API test error:', e.stack); process.exit(2); });
