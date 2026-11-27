'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../api/db');

const { ROOT } = db;
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'settings.json'), 'utf8'));
const outDir = path.join(ROOT, 'subscriptions');
fs.mkdirSync(outDir, { recursive: true });

function buildUri(row) {
  const q = new URLSearchParams();
  q.set('encryption', 'none');
  q.set('type', settings.transport || 'tcp');
  q.set('security', settings.security || 'none');
  if (settings.security === 'tls' && settings.sni) q.set('sni', settings.sni);
  if (settings.flow) q.set('flow', settings.flow);
  return `vless://${row.uuid}@${settings.public_host}:${settings.listen_port}?${q.toString()}#${encodeURIComponent(row.name)}`;
}

const byToken = new Map();
for (const row of db.listActiveUsers()) {
  if (!byToken.has(row.sub_token)) byToken.set(row.sub_token, []);
  byToken.get(row.sub_token).push(buildUri(row));
}

for (const [token, uris] of byToken) {
  const digest = crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
  const target = path.join(outDir, `${digest}.txt`);
  fs.writeFileSync(target, Buffer.from(uris.join('\n') + '\n').toString('base64'), { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  process.stdout.write(`subscription written: subscriptions/${digest}.txt (${uris.length} link)\n`);
}
