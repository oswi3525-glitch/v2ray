'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'settings.json'), 'utf8'));

const fileEnv = {};
const envFile = path.join(ROOT, 'config', 'env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) fileEnv[m[1]] = m[2];
  }
}

const env = { ...fileEnv, ...process.env };

module.exports = {
  ROOT,
  settings,
  serverHost: env.SERVER_HOST || settings.public_host || '127.0.0.1',
  serverPort: Number(env.SERVER_PORT || settings.listen_port || 8443),
  protocol: env.PROTOCOL || 'vless',
  maxUsers: Number(env.MAX_USERS || settings.max_users || 3),
  listenHost: settings.listen_host || '0.0.0.0',
  apiHost: settings.api_host || '127.0.0.1',
  apiPort: Number(settings.api_port || 3000),
  security: settings.security || 'none',
  sni: settings.sni || '',
  transport: settings.transport || 'tcp',
  flow: settings.flow || '',
  mode: settings.mode || 'lab-local-only'
};
