'use strict';

/* Download a prebuilt sing-box binary from the official GitHub release.
   No compiler, no root, no hardcoded asset filename. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'bin');
const BIN = path.join(BIN_DIR, 'sing-box');
const CONTROL = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'control.json'), 'utf8'));

const requested = process.env.SINGBOX_VERSION || CONTROL.singbox_version || '1.14.5';
const tag = String(requested).startsWith('v') ? String(requested) : `v${requested}`;
const version = tag.slice(1);
const ARCH = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'armv7' }[process.arch];
if (!ARCH) {
  console.error(`get-singbox: unsupported CPU architecture ${process.arch}`);
  process.exit(1);
}

function existingVersion() {
  if (!fs.existsSync(BIN)) return null;
  const r = spawnSync(BIN, ['version'], { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) return null;
  return (r.stdout || '').split('\n').find((l) => l.includes('sing-box version')) || null;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout || 'no output').trim().slice(0, 300)}`);
  }
  return r.stdout || '';
}

async function download(url, target) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'tiktunnel-get-singbox', Accept: 'application/octet-stream' }
  });
  if (!res.ok || !res.body) throw new Error(`download failed with HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(target));
}

function verifyChecksum(releaseBody, assetName, file) {
  const escaped = assetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = releaseBody.match(new RegExp(`([a-f0-9]{64})\\s+${escaped}|${escaped}\\s+([a-f0-9]{64})`, 'i'));
  if (!m) return false;
  const expected = (m[1] || m[2]).toLowerCase();
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (expected !== actual) throw new Error(`checksum mismatch for ${assetName}`);
  return true;
}

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  const current = existingVersion();
  if (current && current.includes(version)) {
    console.log(`sing-box already available: ${current.trim()}`);
    return;
  }
  if (current) console.log(`existing ${current.trim()} does not match requested ${version}; replacing`);

  const relRes = await fetch(`https://api.github.com/repos/SagerNet/sing-box/releases/tags/${encodeURIComponent(tag)}`, {
    headers: { 'User-Agent': 'tiktunnel-get-singbox', Accept: 'application/vnd.github+json' }
  });
  if (!relRes.ok) throw new Error(`GitHub release lookup for ${tag} failed with HTTP ${relRes.status}`);
  const release = await relRes.json();

  const assetRe = new RegExp(`^sing-box-${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-linux-${ARCH}(-musl)?\\.tar\\.gz$`);
  const matches = (release.assets || []).filter((a) => assetRe.test(a.name));
  if (matches.length === 0) {
    throw new Error(`no linux-${ARCH} prebuilt asset found in release ${tag} (regex: ${assetRe.source})`);
  }
  const asset = matches.find((a) => a.name.includes('musl')) || matches[0];
  console.log(`downloading ${asset.name} (${Math.round(asset.size / 1048576)} MiB) from ${tag}`);

  const tmp = path.join(BIN_DIR, `.sing-box-download-${process.pid}.tar.gz`);
  try {
    await download(asset.browser_download_url, tmp);
    const checked = verifyChecksum(release.body || '', asset.name, tmp);
    console.log(checked ? 'checksum verified against release notes' : 'no upstream checksum found; SHA-256 can be pinned locally');

    const listing = run('tar', ['-tzf', tmp]).split('\n').map((s) => s.trim()).filter(Boolean);
    const entry = listing.find((name) => /(^|\/)sing-box$/.test(name));
    if (!entry) throw new Error('archive does not contain a sing-box binary entry');
    const strip = entry.split('/').length - 1;
    run('tar', ['-xzf', tmp, '-C', BIN_DIR, `--strip-components=${strip}`, '--', entry]);
    fs.chmodSync(BIN, 0o755);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }

  const installed = existingVersion();
  if (!installed || !installed.includes(version)) {
    throw new Error(`installed binary did not report ${version}: ${installed || 'no output'}`);
  }
  console.log(`installed ${installed.trim()}`);
}

main().catch((err) => {
  console.error(`get-singbox: ${err.message}`);
  process.exit(1);
});
