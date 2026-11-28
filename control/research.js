'use strict';

/*
 * TikTunnel Research Lab — real, reproducible network measurements.
 *
 * This module never fabricates results and never fakes an application identity,
 * spoofs TikTok traffic, or bypasses carrier billing. It only records what can be
 * observed on the wire from the server side and keeps hypotheses explicitly
 * marked by evidence level.
 */

const net = require('node:net');
const dns = require('node:dns');
const tls = require('node:tls');

const HYPOTHESES = [
  {
    id: 't15kn_tiktok_scope',
    statement: 'T15KN zero-rates only TikTok application traffic, not other applications.',
    status: 'unverified',
    evidence: 'No carrier usage statement or packet capture from a Viettel device has been recorded yet.'
  },
  {
    id: 't15kn_non_tiktok_billed',
    statement: 'Traffic from Safari/YouTube on T15KN is billed or throttled separately from TikTok.',
    status: 'unverified',
    evidence: 'Requires paired device captures plus a Viettel usage statement for the same window.'
  },
  {
    id: 't15kn_vpn_blocked',
    statement: 'A generic VPN tunnel cannot be established while only a T15KN data pack is active.',
    status: 'unverified',
    evidence: 'No capture of a failed tunnel setup on a real T15KN SIM has been recorded.'
  },
  {
    id: 't15kn_dns_classification',
    statement: 'Carrier classification depends on DNS names rather than destination IP alone.',
    status: 'unverified',
    evidence: 'Needs controlled DNS/SNI experiments from the carrier network.'
  },
  {
    id: 't15kn_sni_classification',
    statement: 'Carrier classification depends on TLS SNI and not only on packet destination.',
    status: 'unverified',
    evidence: 'Needs controlled SNI experiments from the carrier network.'
  }
];

const STATUSES = new Set(['unverified', 'testing', 'evidence', 'refuted']);

function lookupAll(host, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dns_timeout')), timeoutMs);
    dns.lookup(host, { all: true }, (err, rows) => {
      clearTimeout(timer);
      err ? reject(err) : resolve(rows || []);
    });
  });
}

function tcpConnect(host, port, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const s = net.connect(port, host);
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      s.destroy();
      err ? reject(err) : resolve(Date.now() - t0);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(null));
    s.once('timeout', () => finish(new Error('tcp_timeout')));
    s.once('error', finish);
  });
}

function httpOverTls(host, port = 443, requestPath = '/', timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const socket = net.connect(port, host);
    let secure = null;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { secure?.destroy(); } catch {}
      try { socket.destroy(); } catch {}
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('http_timeout')), timeoutMs);
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => finish(new Error('tcp_timeout')));
    socket.once('error', finish);
    secure = tls.connect({ socket, servername: host, rejectUnauthorized: true }, () => {
      secure.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: tiktunnel-research/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
    });
    secure.setTimeout(timeoutMs);
    secure.once('timeout', () => finish(new Error('tls_timeout')));
    secure.once('error', finish);
    let buf = '';
    secure.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n') || buf.length > 8192) {
        const m = buf.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
        const cert = secure.getPeerCertificate() || {};
        finish(null, {
          ms: Date.now() - t0,
          status: m ? Number(m[1]) : 0,
          protocol: secure.getProtocol(),
          authorized: secure.authorized === true,
          cn: cert.subject?.CN || '',
          issuer: cert.issuer?.CN || cert.issuer?.O || '',
          valid_to: cert.valid_to || ''
        });
      }
    });
    secure.once('end', () => {
      const cert = secure.getPeerCertificate() || {};
      finish(null, {
        ms: Date.now() - t0,
        status: 0,
        protocol: secure.getProtocol(),
        authorized: secure.authorized === true,
        cn: cert.subject?.CN || '',
        issuer: cert.issuer?.CN || cert.issuer?.O || '',
        valid_to: cert.valid_to || ''
      });
    });
  });
}

function stats(values) {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return { min: null, avg: null, median: null, max: null };
  const sum = clean.reduce((a, b) => a + b, 0);
  const mid = Math.floor(clean.length / 2);
  return {
    min: clean[0],
    avg: +(sum / clean.length).toFixed(1),
    median: +(clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2).toFixed(1),
    max: clean[clean.length - 1]
  };
}

async function probeTarget(host, port = 443, { samples = 5, tlsCheck = true, path = '/' } = {}) {
  const started = Date.now();
  const out = {
    target: `${host}:${port}`,
    host,
    port,
    checked_at: new Date().toISOString(),
    dns: { status: 'UNKNOWN', addresses: [] },
    tcp: { status: 'UNKNOWN', samples_ms: [], loss_pct: null, stats: stats([]) },
    tls: { status: 'UNKNOWN' },
    http: { status: 'UNKNOWN' },
    verdict: 'UNKNOWN'
  };

  try {
    const rows = await lookupAll(host);
    out.dns = { status: rows.length ? 'PASS' : 'FAIL', addresses: rows.map((r) => r.address), families: rows.map((r) => r.family) };
  } catch (e) {
    out.dns = { status: 'FAIL', addresses: [], error: e.message };
  }

  const times = [];
  let lost = 0;
  for (let i = 0; i < samples; i++) {
    try { times.push(await tcpConnect(host, port)); }
    catch { times.push(null); lost++; }
  }
  out.tcp = {
    status: times.some((v) => v !== null) ? 'PASS' : 'FAIL',
    samples_ms: times,
    loss_pct: +((lost / samples) * 100).toFixed(1),
    stats: stats(times.filter((v) => v !== null))
  };

  if (tlsCheck) {
    try {
      const r = await httpOverTls(host, port, path);
      out.tls = {
        status: r.protocol ? 'PASS' : 'FAIL',
        protocol: r.protocol,
        certificate_authorized: r.authorized,
        cn: r.cn,
        issuer: r.issuer,
        valid_to: r.valid_to
      };
      out.http = {
        status: r.status > 0 ? 'PASS' : 'WARNING',
        status_code: r.status,
        ms: r.ms,
        note: r.status > 0 ? 'HTTP response received from the destination.' : 'TLS completed but no HTTP status line was parsed.'
      };
    } catch (e) {
      out.tls = { status: 'FAIL', error: e.message };
      out.http = { status: 'UNKNOWN', error: e.message };
    }
  } else {
    out.tls = { status: 'SKIP', note: 'TLS check disabled for this target.' };
    out.http = { status: 'SKIP', note: 'HTTP check requires TLS.' };
  }

  const reachable = out.dns.status === 'PASS' && out.tcp.status === 'PASS';
  out.verdict = reachable ? 'REACHABLE' : 'UNREACHABLE';
  out.duration_ms = Date.now() - started;
  return out;
}

function listHypotheses() {
  return HYPOTHESES.map((h) => ({ ...h, status: STATUSES.has(h.status) ? h.status : 'unverified' }));
}

module.exports = { HYPOTHESES, STATUSES, probeTarget, listHypotheses, stats };
