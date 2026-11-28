'use strict';

/* Tests for full-tunnel profile export, usage aggregation, response compression
   and the research/carrier reconciliation module. Uses real HTTP + real DB rows;
   no simulated connection state is asserted. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const cdb = require('../control/db');
const cfg = require('../config/control.json');
const envcfg = require('../config/runtime');
const { ROOT } = cdb;

const BASE = `http://127.0.0.1:${cfg.app_port}`;
const results = [];
function rec(name, status, detail = '') {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(6)} ${name}${detail ? ' — ' + detail : ''}`);
}
function check(name, cond, detail = '') { rec(name, cond ? 'PASS' : 'FAIL', detail); return !!cond; }

async function api(p, { method = 'GET', body, cookie, csrf, headers = {} } = {}) {
  const h = { ...headers };
  if (body) h['content-type'] = 'application/json';
  if (cookie) h.cookie = cookie;
  if (csrf) h['x-csrf-token'] = csrf;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data, headers: r.headers, cookie: sc ? sc.split(';')[0] : cookie };
}

async function main() {
  console.log('=== TikTunnel core upgrade tests ===');
  const adminUser = envcfg.adminUsername || 'admin';
  const adminPw = envcfg.adminPassword || '';
  const login = await api('/api/auth/login', { method: 'POST', body: { username: adminUser, password: adminPw } });
  if (!check('admin login', login.status === 200)) return finish();
  const admin = { cookie: login.cookie, csrf: login.data.csrf };

  const user = cdb.listUsers().find((u) => !u.revoked_at);
  if (!check('an active friend account exists (run npm test first)', !!user)) return finish();
  const token = cdb.getSubscription(user.id)?.token;

  // --- Full tunnel profile (validated by the real sing-box binary) ---
  const prof = await api(`/api/sub/${token}/profile`);
  const profile = prof.data;
  check('full-tunnel profile endpoint returns JSON', prof.status === 200 && !!profile.inbounds && !!profile.route);
  check('full-tunnel routes everything via proxy', profile.route?.final === 'proxy' && profile.route?.auto_detect_interface === true);
  check('full-tunnel handles IPv6 without an outside route',
    Array.isArray(profile.inbounds?.[0]?.address) && profile.inbounds[0].address.some((a) => a.includes(':')));
  check('full-tunnel sends DNS through the tunnel',
    profile.dns?.final === 'remote-dns' && profile.dns.servers.find((s) => s.tag === 'remote-dns')?.detour === 'proxy');
  check('full-tunnel outbound matches the account UUID and public endpoint',
    profile.outbounds?.[0]?.uuid === cdb.getVpnClient(user.id).uuid &&
    String(profile.outbounds[0].server) === String(cfg.public_tcp_host));

  const tmp = path.join(os.tmpdir(), `tiktunnel-profile-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(profile), { mode: 0o600 });
  const valid = spawnSync(path.join(ROOT, 'bin', 'sing-box'), ['check', '-c', tmp], { encoding: 'utf8' });
  check('sing-box accepts the generated full-tunnel profile', valid.status === 0, (valid.stderr || '').trim().slice(0, 160));
  fs.unlinkSync(tmp);

  // --- Compression of API metadata (not VPN payload) ---
  // Use node:http directly so the client does not transparently decompress.
  const rawHttp = await new Promise((resolve, reject) => {
    const http = require('node:http');
    const u = new URL(BASE + '/api/admin/users');
    const rq = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'GET',
      headers: { cookie: admin.cookie, 'accept-encoding': 'gzip' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    rq.on('error', reject);
    rq.end();
  });
  let decoded = null;
  try { decoded = zlib.gunzipSync(rawHttp.body).toString('utf8'); } catch {}
  check('large JSON API response is gzip-compressed and decodable',
    rawHttp.headers['content-encoding'] === 'gzip' && decoded && Array.isArray(JSON.parse(decoded).users),
    `encoding=${rawHttp.headers['content-encoding'] || '(none)'} bytes=${rawHttp.body.length}`);

  // --- Usage aggregation + overhead separation ---
  const stamp = new Date().toISOString();
  const markerSource = 'core-upgrade-test';
  cdb.recordTraffic(user.id, 1200, 8000, markerSource, stamp, 45);
  const sum = await api(`/api/admin/users/${user.id}/usage/summary?days=30`, { cookie: admin.cookie });
  const src = sum.data.by_source?.find((s) => s.source === markerSource);
  check('usage summary aggregates upload/download per source',
    sum.status === 200 && src && Number(src.up) >= 1200 && Number(src.down) >= 8000);
  check('usage summary reports tunnel overhead separately',
    src && Number(src.overhead) >= 45 && Number(sum.data.totals.overhead) >= 45);
  check('usage summary exposes daily/weekly/monthly buckets',
    Array.isArray(sum.data.daily) && Array.isArray(sum.data.weekly) && Array.isArray(sum.data.monthly));
  check('usage summary is labelled as server-observed, not carrier bill',
    /not a carrier bill/i.test(sum.data.scope || ''));

  // --- Carrier reconciliation ---
  const start = new Date(Date.now() - 3600e3).toISOString();
  const end = new Date(Date.now() + 3600e3).toISOString();
  const before = cdb.db.prepare('SELECT COALESCE(SUM(upload_bytes),0) AS up, COALESCE(SUM(download_bytes),0) AS down FROM traffic_usage WHERE user_id=? AND ts>=? AND ts<=?')
    .get(user.id, start, end);
  const serverUsed = Number(before.up) + Number(before.down);
  const match = await api('/api/admin/research/carrier', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { user_id: user.id, period_start: start, period_end: end, carrier_used_bytes: serverUsed, note: 'core test exact match' }
  });
  check('carrier report computes server-side bytes for the same window',
    match.status === 201 && match.data.server_used_bytes === serverUsed);
  check('carrier report flags no mismatch when figures agree', match.data.mismatch === false);
  const mismatch = await api('/api/admin/research/carrier', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { user_id: user.id, period_start: start, period_end: end, carrier_used_bytes: serverUsed + 50 * 1024 * 1024, note: 'core test mismatch' }
  });
  check('carrier report detects a large client/carrier mismatch', mismatch.status === 201 && mismatch.data.mismatch === true);
  const badPeriod = await api('/api/admin/research/carrier', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { user_id: user.id, period_start: end, period_end: start, carrier_used_bytes: 1 }
  });
  check('carrier report rejects inverted periods', badPeriod.status === 400);

  // --- Research hypotheses + real probe run ---
  const hyp = await api('/api/admin/research/hypotheses', { cookie: admin.cookie });
  check('research hypotheses are exposed with evidence states',
    hyp.status === 200 && hyp.data.hypotheses.length >= 4 &&
    hyp.data.hypotheses.every((h) => ['unverified', 'testing', 'evidence', 'refuted'].includes(h.status)));
  check('research policy forbids spoofing/billing evasion',
    /spoofing/i.test(hyp.data.policy || '') && /billing evasion/i.test(hyp.data.policy || ''));
  const run = await api('/api/admin/research/run', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { targets: ['github'], samples: 3 }
  });
  check('research run returns real probe structure',
    run.status === 200 && run.data.results.length === 1 &&
    run.data.results[0].tcp && Array.isArray(run.data.results[0].tcp.samples_ms) &&
    typeof run.data.results[0].verdict === 'string');
  check('research run states it does not prove carrier billing',
    /does not prove/i.test(run.data.note || ''));
  const runs = await api('/api/admin/research/runs?limit=10', { cookie: admin.cookie });
  check('research runs are persisted', runs.status === 200 && runs.data.runs.some((r) => r.kind === 'reachability'));

  // Cleanup test-only rows so production history is not polluted.
  cdb.db.prepare('DELETE FROM traffic_usage WHERE source=?').run(markerSource);
  cdb.db.prepare('DELETE FROM carrier_reports WHERE note LIKE ?').run('core test%');
  cdb.db.prepare("DELETE FROM research_runs WHERE kind='reachability' AND target='github' AND ts>=?").run(start);
  finish();
}

function finish() {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  console.log(`SUMMARY PASS=${pass} FAIL=${fail}`);
  fs.mkdirSync(path.join(ROOT, 'reports', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'reports', 'runtime', 'core-upgrade-tests.json'), JSON.stringify(results, null, 2) + '\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('core upgrade test error:', e.stack); process.exit(2); });
