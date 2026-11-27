'use strict';

/* Real, reproducible connectivity probe to tiktokv.com. No simulated results. */

const dns = require('node:dns');
const net = require('node:net');
const tls = require('node:tls');

const HOST = process.argv[2] || 'tiktokv.com';
const PORT = 443;
const TIMEOUT = 6000;
const SAMPLES = Number(process.env.TIKTOK_SAMPLES || 3);

function lookup(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true }, (err, rows) => err ? reject(err) : resolve(rows));
  });
}
function tcpConnect(host, port) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const s = net.connect(port, host);
    let done = false;
    const finish = (err, ms) => { if (done) return; done = true; s.destroy(); err ? reject(err) : resolve(ms); };
    s.setTimeout(TIMEOUT);
    s.once('connect', () => finish(null, performance.now() - t0));
    s.once('timeout', () => finish(new Error('tcp_timeout')));
    s.once('error', finish);
  });
}
function httpsGet(host) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const socket = net.connect(PORT, host);
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
    const timer = setTimeout(() => finish(new Error('request_timeout')), TIMEOUT);
    socket.setTimeout(TIMEOUT);
    socket.once('timeout', () => finish(new Error('tcp_timeout')));
    socket.once('error', finish);
    secure = tls.connect({ socket, servername: host, rejectUnauthorized: true }, () => {
      secure.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: tiktunnel-connectivity-test/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
    });
    secure.setTimeout(TIMEOUT);
    secure.once('timeout', () => finish(new Error('tls_timeout')));
    secure.once('error', finish);
    let buf = '';
    secure.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n') || buf.length > 8192) {
        const m = buf.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
        finish(null, { status: m ? Number(m[1]) : 0, ms: performance.now() - t0,
          protocol: secure.getProtocol(), authorized: secure.authorized,
          cn: secure.getPeerCertificate().subject?.CN || '' });
      }
    });
    secure.once('end', () => finish(null, { status: 0, ms: performance.now() - t0,
      protocol: secure.getProtocol(), authorized: secure.authorized }));
  });
}
function stats(nums) {
  if (!nums.length) return { min: 0, median: 0, max: 0 };
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return { min: +s[0].toFixed(1), median: +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(1),
    max: +s[s.length - 1].toFixed(1) };
}

(async () => {
  const report = { host: HOST, port: PORT, at: new Date().toISOString(), samples: SAMPLES };
  try {
    const ips = await lookup(HOST);
    report.dns = { ok: true, addresses: ips.map((x) => x.address) };
  } catch (e) {
    report.dns = { ok: false, error: e.message };
  }
  const tcp = [];
  const http = [];
  for (let i = 0; i < SAMPLES; i++) {
    try { tcp.push(await tcpConnect(HOST, PORT)); } catch (e) { tcp.push(null); }
    try { http.push(await httpsGet(HOST)); } catch (e) { http.push({ error: e.message }); }
  }
  report.tcp_ms = stats(tcp.filter((x) => x !== null));
  report.tcp_success = tcp.filter((x) => x !== null).length;
  report.http = {
    success: http.filter((x) => x.status > 0).length,
    status_codes: [...new Set(http.map((x) => x.status || x.error))],
    tls: http.find((x) => x.protocol)?.protocol || '',
    cert_valid: http.some((x) => x.authorized === true),
    cn: http.find((x) => x.cn)?.cn || '',
    rtt_ms: stats(http.filter((x) => x.status > 0).map((x) => x.ms))
  };
  report.verdict = report.http.success > 0
    ? 'REACHABLE — DNS/TCP/TLS/HTTP phản hồi thật; HTTP 404 trên / vẫn chứng tỏ CDN trả lời.'
    : 'UNREACHABLE — không có HTTP response thật từ CDN.';
  console.log(JSON.stringify(report, null, 2));
  if (!report.http.success) process.exitCode = 1;
})().catch((e) => { console.error(JSON.stringify({ host: HOST, error: e.message })); process.exitCode = 1; });
