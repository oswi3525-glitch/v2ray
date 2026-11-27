'use strict';
const resultEl = document.getElementById('result');
const historyEl = document.getElementById('history');
const HISTORY_KEY = 'tiktunnel_plan_checks';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function pill(status) {
  const cls = status === 'OK' ? 'ok' : status === 'FAIL' ? 'bad' : 'warn';
  return `<span class="pill ${cls}">${status}</span>`;
}
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}
function saveHistory(runs) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(runs.slice(-20))); } catch {}
}
function row(r) {
  return `<div class="diag-item"><div class="diag-head">${pill(r.status)}<b>${esc(r.label)}</b>
    <span class="sub">${r.ms ? Math.round(r.ms) + ' ms' : '—'}${r.samples ? ' · ' + r.samples : ''}</span></div>
    <p>${esc(r.detail)}</p></div>`;
}
async function singleProbe(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    return { ok: true, ms: performance.now() - t0 };
  } catch (e) {
    return { ok: false, ms: performance.now() - t0,
      error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(timer); }
}
async function repeated(label, url, timeoutMs = 7000) {
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await singleProbe(`${url}${url.includes('?') ? '&' : '?'}cb=${Date.now()}-${i}`, timeoutMs));
  const okCount = runs.filter((r) => r.ok).length;
  const ms = runs.map((r) => Math.round(r.ms));
  return {
    label, status: okCount === 3 ? 'OK' : okCount === 0 ? 'FAIL' : 'WARNING', ms: Math.min(...ms),
    samples: `${okCount}/3 · [${ms.join(', ')}] ms`,
    detail: `${url} — ${okCount}/3 lần phản hồi${runs.some((r) => r.error) ? '; lỗi: ' + [...new Set(runs.map((r) => r.error).filter(Boolean))].join(', ') : ''} (no-cors: chỉ xác nhận kết nối)`
  };
}
async function endpointProbe() {
  const url = `${location.origin}/health`;
  const r = await repeated('Endpoint TikTunnel', url, 7000);
  try {
    const res = await fetch(`${url}?cb=${Date.now()}`, { cache: 'no-store' });
    const j = await res.json();
    const ok = res.ok && j.ok === true && j.service === 'tiktunnel-control';
    r.status = ok ? (r.status === 'OK' ? 'OK' : 'WARNING') : 'FAIL';
    r.detail = `${url} → HTTP ${res.status}, service=${j.service || 'unknown'} · ${r.detail}`;
  } catch (e) { r.status = 'FAIL'; r.detail += ` · health JSON: ${e.message}`; }
  return r;
}
function conclusion(items) {
  const get = (label) => items.find((x) => x.label === label);
  const ok = (label) => ['OK', 'WARNING'].includes(get(label).status);
  const tiktok = ok('TikTok'), inet = ok('Internet thường'), ep = ok('Endpoint TikTunnel');
  let profile, verdict, fix, status;
  if (tiktok && !inet) {
    profile = 'Gói TikTok đơn lẻ (Internet thường không truy cập được)';
    fix = 'Dùng gói Internet thông thường. Không giả mạo lưu lượng/SNI/Host/DNS để vượt tính cước.';
    if (ep) { status = 'WARNING'; verdict = 'Endpoint vẫn truy cập được, nhưng phạm vi tính cước của lưu lượng VPN chưa được Viettel xác nhận — KHÔNG coi là miễn phí.'; }
    else { status = 'FAIL'; verdict = 'Endpoint TikTunnel không truy cập được trên gói TikTok đơn lẻ → VPN không dùng được với gói này.'; }
  } else if (tiktok && inet) {
    profile = 'Có Internet thường'; status = ep ? 'OK' : 'FAIL';
    verdict = ep ? 'Endpoint truy cập được; có thể thử import và kết nối VPN (sẽ dùng data thường).' : 'Internet thường OK nhưng endpoint TikTunnel FAIL.';
    fix = ep ? 'Dashboard → Shadowrocket → Add to Shadowrocket, xác nhận trong app.' : 'Chạy Network Diagnostics trong dashboard.';
  } else if (!tiktok && inet) {
    profile = 'TikTok bị chặn/không có trong gói, Internet thường OK'; status = ep ? 'OK' : 'FAIL';
    verdict = ep ? 'Endpoint truy cập được; việc TikTok bị chặn không ảnh hưởng VPN.' : 'Endpoint FAIL dù có Internet thường.';
    fix = ep ? 'Dùng VPN bình thường với data thường.' : 'Chạy Network Diagnostics trong dashboard.';
  } else {
    profile = 'Không có kết nối Internet'; status = 'FAIL';
    verdict = 'Cả TikTok và Internet thường đều không phản hồi — chưa đủ dữ liệu để kết luận.';
    fix = 'Kiểm tra SIM/sóng rồi chạy lại.';
  }
  return `<div class="diag-item"><div class="diag-head">${pill(status)}<b>Kết luận</b></div>
    <p><b>Hồ sơ mạng:</b> ${profile}</p><p>${verdict}</p><p class="sub">${fix}</p>
    <p class="sub">Giới hạn: phép đo chạy bằng <b>trình duyệt</b>, trong khi ưu đãi gói TikTok áp dụng cho <b>app TikTok chính thức</b>. Kết quả chỉ là bằng chứng truy cập, không chứng minh phạm vi tính cước.</p></div>`;
}
function renderHistory() {
  const runs = loadHistory();
  if (!runs.length) { historyEl.innerHTML = '<p class="sub">Chưa có lần đo nào.</p>'; return; }
  historyEl.innerHTML = `<div class="scroll"><table><thead><tr><th>Thời gian</th><th>TikTok</th><th>CDN</th><th>Internet</th><th>Endpoint</th></tr></thead><tbody>
    ${runs.slice(-10).reverse().map((r) => `<tr><td class="mono">${esc(r.at)}</td><td>${pill(r.tiktok)}</td><td>${pill(r.cdn || 'UNKNOWN')}</td><td>${pill(r.inet)}</td><td>${pill(r.ep)}</td></tr>`).join('')}
    </tbody></table></div>`;
}
async function run() {
  if (!document.getElementById('vpn-off').checked) {
    resultEl.innerHTML = '<p class="sub warn-note">Hãy xác nhận bạn đang dùng SIM cần kiểm tra và VPN đang TẮT trước khi chạy.</p>';
    return;
  }
  resultEl.innerHTML = '<div class="skeleton-wrap"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
  const items = [];
  items.push(await repeated('TikTok', 'https://www.tiktok.com/'));
  items.push(await repeated('TikTok CDN (tiktokv.com)', 'https://tiktokv.com/'));
  items.push(await repeated('Internet thường', 'https://example.com/'));
  items.push(await endpointProbe());
  items.push({ label: 'DNS / TCP thô', status: 'UNKNOWN', ms: null, samples: '',
    detail: 'Trình duyệt không có API đo DNS riêng hay TCP handshake; không đánh dấu PASS khi chưa đo được.' });
  const at = new Date().toLocaleString('vi-VN');
  resultEl.innerHTML = items.map(row).join('') + conclusion(items) + `<p class="sub">Đo lúc: ${esc(at)}</p>`;
  const get = (l) => items.find((x) => x.label === l).status;
  const runs = loadHistory();
  runs.push({ at, tiktok: get('TikTok'), cdn: get('TikTok CDN (tiktokv.com)'),
    inet: get('Internet thường'), ep: get('Endpoint TikTunnel'), items });
  saveHistory(runs);
  renderHistory();
}
document.getElementById('run').onclick = run;
document.getElementById('clear').onclick = () => {
  resultEl.innerHTML = '<p class="sub">Đã xóa kết quả hiện tại. Lịch sử vẫn giữ trên thiết bị cho tới khi bấm “Xóa lịch sử”.</p>';
};
document.getElementById('clear-history').onclick = () => {
  try { localStorage.removeItem(HISTORY_KEY); } catch {}
  renderHistory();
};
document.getElementById('export').onclick = () => {
  const blob = new Blob([JSON.stringify(loadHistory(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tiktunnel-plan-check-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
renderHistory();
