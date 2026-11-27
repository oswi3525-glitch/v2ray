'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'settings.json'), 'utf8'));

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const legacyEnv = parseEnvFile(path.join(ROOT, 'config', 'env'));
const dotEnv = parseEnvFile(path.join(ROOT, '.env'));
const env = { ...legacyEnv, ...dotEnv, ...process.env };

module.exports = {
  ROOT,
  settings,
  serverHost: env.SERVER_HOST || settings.public_host || '127.0.0.1',
  serverPort: Number(env.SERVER_PORT || settings.listen_port || 8443),
  protocol: env.PROTOCOL || 'vless',
  maxUsers: Number(env.MAX_USERS || settings.max_users || 3),
  adminUsername: env.ADMIN_USERNAME || '',
  adminPassword: env.ADMIN_PASSWORD || '',
  listenHost: settings.listen_host || '0.0.0.0',
  apiHost: settings.api_host || '127.0.0.1',
  apiPort: Number(settings.api_port || 3000),
  security: settings.security || 'none',
  sni: settings.sni || '',
  transport: settings.transport || 'tcp',
  flow: settings.flow || '',
  mode: settings.mode || 'lab-local-only'
};
