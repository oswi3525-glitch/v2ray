'use strict';
const root = document.getElementById('app');
const toastEl = document.getElementById('toast');
let me = null;

function toast(msg) {
  toastEl.textContent = msg; toastEl.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { toastEl.hidden = true; }, 3200);
}
async function api(path, opts = {}) {
  const o = { credentials: 'same-origin', headers: {}, ...opts };
  o.headers = { ...o.headers };
  if (opts.body) o.headers['Content-Type'] = 'application/json';
  const csrf = sessionStorage.getItem('csrf');
  if (csrf) o.headers['x-csrf-token'] = csrf;
  const r = await fetch(path, o);
  let d = {};
  try { d = await r.json(); } catch { d = {}; }
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmt(n) { return Number(n || 0).toLocaleString(); }
function gb(n) { return (Number(n || 0) / 1e9).toFixed(2) + ' GB'; }
function copy(text) { navigator.clipboard?.writeText(text).then(() => toast('Copied')).catch(() => toast('Copy failed')); }
function shell(title, body) {
  root.innerHTML = `<div class="wrap"><div class="row" style="justify-content:space-between">
    <h1>TikTunnel Control</h1><div class="row"><span class="sub">${esc(me?.username || '')}</span>
    <button class="ghost small" id="logout">Logout</button></div></div>${body}</div>`;
  document.getElementById('logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); sessionStorage.clear(); location.href = '/'; };
}

async function authScreen() {
  root.innerHTML = `<div class="center"><h1>TikTunnel Control</h1>
    <p class="sub">Sign in</p>
    <div class="card" style="width:100%;max-width:380px">
      <form id="f">
        <label>Username</label><input id="u" autocomplete="username" required>
        <label>Password</label><input id="p" type="password" autocomplete="current-password" required>
        <button style="width:100%;margin-top:16px" type="submit">Sign In</button>
      </form></div></div>`;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const u = document.getElementById('u').value, p = document.getElementById('p').value;
    try {
      const d = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
      sessionStorage.setItem('csrf', d.csrf);
      location.href = d.role === 'admin' ? '/admin' : '/friend';
    } catch (err) { toast(err.message); }
  };
}

async function adminPage() {
  const [ov, us, mon] = await Promise.all([
    api('/api/admin/overview'), api('/api/admin/users'), api('/api/monitor/network')
  ]);
  const rows = us.users.map(u => `<tr>
    <td><b>${esc(u.display_name)}</b><br><span class="mono">${esc(u.username)}</span></td>
    <td>${u.enabled ? '<span class="pill ok">enabled</span>' : '<span class="pill bad">disabled</span>'}
        ${u.exhausted ? '<span class="pill warn">exhausted</span>' : ''}</td>
    <td>${gb(u.quota_bytes)}<br><span class="sub">used ${gb(u.used_upload + u.used_download)}</span></td>
    <td class="mono">${u.uuid ? esc(u.uuid) : '—'}</td>
    <td><div class="actions">
      <button class="small ghost" data-copy="uuid" data-id="${u.id}">Copy UUID</button>
      <button class="small ghost" data-copy="uri" data-id="${u.id}">Copy VLESS</button>
      <button class="small ghost" data-copy="sub" data-id="${u.id}">Copy Sub</button>
      <button class="small ghost" data-act="disable" data-id="${u.id}">Disable</button>
      <button class="small ghost" data-act="enable" data-id="${u.id}">Enable</button>
      <button class="small danger" data-act="delete" data-id="${u.id}">Revoke</button>
    </div></td></tr>`).join('');
  shell('Admin', `<div class="grid">
    <div class="stat"><span>VPN</span><b>${ov.server.sing_box ? 'running' : 'stopped'}</b></div>
    <div class="stat"><span>CPU</span><b>${ov.server.cpu_pct}%</b></div>
    <div class="stat"><span>RAM used</span><b>${(ov.server.ram_used_kb / 1048576).toFixed(2)} GB</b></div>
    <div class="stat"><span>Friends</span><b>${ov.accounts.friends}/2</b></div>
    <div class="stat"><span>Active VPN</span><b>${ov.vpn_users}</b></div>
    <div class="stat"><span>Endpoint</span><b style="font-size:13px">${esc(ov.public_endpoint)}</b></div>
  </div>
  <div class="card"><h2>Accounts</h2><div class="scroll"><table><thead><tr><th>User</th><th>Status</th><th>Quota</th><th>UUID</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No accounts yet.</td></tr>'}</tbody></table></div></div>
  <div class="card"><h2>Create friend</h2><form id="create">
    <div class="row"><div style="flex:1;min-width:140px"><label>Username</label><input id="nu" required></div>
    <div style="flex:1;min-width:140px"><label>Display name</label><input id="nd" required></div>
    <div style="flex:1;min-width:100px"><label>Quota (GB)</label><input id="nq" type="number" min="0" value="5"></div></div>
    <label>Password</label><input id="np" type="password" required>
    <button style="margin-top:12px" type="submit">Create account</button></form></div>
  <div class="card"><h2>Quota</h2><form id="quota">
    <label>User ID</label><input id="qid" type="number" min="1" required>
    <div class="row"><div style="flex:1"><label>Action</label><select id="qact"><option value="set">Set</option><option value="add">Add</option><option value="reduce">Reduce</option><option value="reset">Reset</option></select></div>
    <div style="flex:1"><label>GB</label><input id="qgb" type="number" min="0" value="1"></div></div>
    <button style="margin-top:12px" type="submit">Apply quota</button></form></div>
  <div class="card"><h2>Network probes</h2><div id="probes">${mon.probes.map(p => `<div class="row"><span>${esc(p.host)}:${p.port}</span><span class="pill ${p.ok ? 'ok' : 'bad'}">${p.ok ? p.ms + ' ms' : 'unreachable'}</span></div>`).join('')}</div>
    <p class="sub">TCP connect probes from the server — not client-side latency to every website.</p></div>
  <div class="card"><h2>Metrics</h2><canvas id="chart" height="110"></canvas></div>`);

  document.getElementById('create').onsubmit = async e => {
    e.preventDefault();
    try {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify({
        username: document.getElementById('nu').value, display_name: document.getElementById('nd').value,
        password: document.getElementById('np').value, quota_gb: Number(document.getElementById('nq').value)
      }) });
      toast('Account created'); adminPage();
    } catch (err) { toast(err.message); }
  };
  document.getElementById('quota').onsubmit = async e => {
    e.preventDefault();
    try {
      await api(`/api/admin/users/${document.getElementById('qid').value}/quota`, { method: 'POST', body: JSON.stringify({
        action: document.getElementById('qact').value, gb: Number(document.getElementById('qgb').value)
      }) });
      toast('Quota updated'); adminPage();
    } catch (err) { toast(err.message); }
  };
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    const u = us.users.find(x => x.id === Number(b.dataset.id));
    let val = u?.uuid || '';
    if (b.dataset.copy === 'uri') val = (await api(`/api/sub/${u.subscription_token}?raw=1`)).text?.() || '';
    if (b.dataset.copy === 'sub') val = `${location.origin}/api/sub/${u.subscription_token}`;
    if (b.dataset.copy === 'uri') { const d = await fetch(`/api/sub/${u.subscription_token}?raw=1`); val = await d.text(); }
    copy(val);
  });
  document.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    if (b.dataset.act === 'delete' && !confirm('Revoke this account?')) return;
    try {
      await api(`/api/admin/users/${id}/${b.dataset.act}`, { method: 'POST' });
      toast('Updated'); adminPage();
    } catch (err) { toast(err.message); }
  });
  const m = await api('/api/monitor/performance');
  if (window.Chart && m.metrics.length) {
    const pts = [...m.metrics].reverse();
    new Chart(document.getElementById('chart'), {
      type: 'line', data: { labels: pts.map(p => p.ts.slice(11, 16)), datasets: [
        { label: 'CPU %', data: pts.map(p => p.cpu_pct), borderColor: '#2f81f7' },
        { label: 'RAM GB', data: pts.map(p => p.ram_used_kb / 1048576), borderColor: '#3fb950' }
      ] }, options: { responsive: true, plugins: { legend: { labels: { color: '#8ea1b5' } } }, scales: { x: { ticks: { color: '#8ea1b5' } }, y: { ticks: { color: '#8ea1b5' } } } }
    });
  }
}

async function friendPage() {
  const [u, v, sub] = await Promise.all([api('/api/friend/me'), api('/api/friend/vpn'), api('/api/friend/subscription')]);
  const uu = u.user;
  shell('Account', `<div class="grid">
    <div class="stat"><span>Username</span><b>${esc(uu.display_name)}</b></div>
    <div class="stat"><span>Status</span><b>${uu.enabled && !uu.exhausted ? 'Active' : 'Inactive'}</b></div>
    <div class="stat"><span>Allocated</span><b>${gb(uu.quota_bytes)}</b></div>
    <div class="stat"><span>Used</span><b>${gb(uu.used_upload + uu.used_download)}</b></div>
    <div class="stat"><span>Remaining</span><b>${gb(uu.remaining_bytes)}</b></div>
    <div class="stat"><span>Upload</span><b>${gb(uu.used_upload)}</b></div>
    <div class="stat"><span>Download</span><b>${gb(uu.used_download)}</b></div>
    <div class="stat"><span>Expires</span><b style="font-size:13px">${esc(uu.expires_at || '—')}</b></div>
  </div>
  <div class="card"><h2>Connect</h2>
    <p class="sub">Mode: ${esc(v.mode)} — ${v.active ? 'configuration active' : 'configuration inactive'}</p>
    <p class="mono">${esc(v.uri || 'No configuration available')}</p>
    <div class="row" style="margin-top:12px">
      <button id="copyuri">Copy VLESS URI</button>
      <button class="ghost" id="copysub">Copy subscription URL</button>
      <a class="ghost" style="text-decoration:none" id="addios" href="#">Add to Shadowrocket</a>
    </div>
    <p class="sub">On iPhone: open the subscription URL in Safari, or copy the VLESS URI and paste it into Shadowrocket → + → Import from Clipboard.</p>
  </div>
  <div class="card"><h2>Usage</h2><canvas id="chart" height="120"></canvas></div>`);
  document.getElementById('copyuri').onclick = () => copy(v.uri || '');
  document.getElementById('copysub').onclick = () => copy(`${location.origin}${sub.url}`);
  document.getElementById('addios').onclick = (e) => {
    e.preventDefault();
    if (!v.uri) { toast('Configuration not ready'); return; }
    location.href = 'shadowrocket://add/' + btoa(unescape(encodeURIComponent(v.uri)));
  };
  const h = await api('/api/friend/usage');
  if (window.Chart && h.history.length) {
    const pts = [...h.history].reverse();
    new Chart(document.getElementById('chart'), {
      type: 'bar', data: { labels: pts.map(p => p.ts.slice(5, 16)), datasets: [
        { label: 'Download', data: pts.map(p => p.download_bytes / 1e6), backgroundColor: '#2f81f7' },
        { label: 'Upload', data: pts.map(p => p.upload_bytes / 1e6), backgroundColor: '#3fb950' }
      ] }, options: { responsive: true, plugins: { legend: { labels: { color: '#8ea1b5' } } }, scales: { x: { ticks: { color: '#8ea1b5' } }, y: { ticks: { color: '#8ea1b5' } } } }
    });
  }
}

(async () => {
  try {
    const r = await fetch('/api/auth/me');
    if (!r.ok && !location.pathname.startsWith('/')) { await authScreen(); return; }
    if (r.ok) {
      me = await r.json();
      if (me.role === 'admin') return adminPage();
      return friendPage();
    }
    return authScreen();
  } catch (e) {
    root.innerHTML = `<div class="center"><h1>TikTunnel Control</h1><p class="sub">Unable to reach API: ${esc(e.message)}</p></div>`;
  }
})();
