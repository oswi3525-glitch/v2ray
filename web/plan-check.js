'use strict';
const resultEl = document.getElementById('result');

function pill(status) {
  const cls = status === 'OK' ? 'ok' : status === 'FAIL' ? 'bad' : 'warn';
  return `<span class="pill ${cls}">${status}</span>`;
}
function row(r) {
  return `<div class="diag-item"><div class="diag-head">${pill(r.status)}<b>${r.label}</b>
    <span class="sub">${r.ms ? Math.round(r.ms) + ' ms' : '—'}</span></div>
    <p>${r.detail}</p></div>`;
}
async function probe(label, url, timeoutMs = 7000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    return { label, status: 'OK', ms: performance.now() - t0, detail: `${url} phản hồi (không đọc được nội dung do no-cors, chỉ xác nhận kết nối)` };
  } catch (e) {
    return { label, status: 'FAIL', ms: performance.now() - t0,
      detail: `${url} — ${e.name === 'AbortError' ? 'timeout/' + timeoutMs + 'ms' : e.message}` };
  } finally { clearTimeout(timer); }
}
async function probeEndpoint(timeoutMs = 7000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  const url = `/health?cb=${Date.now()}`;
  try {
    const r = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    const j = await r.json();
    const ok = r.ok && j.ok === true && j.service === 'tiktunnel-control';
    return { label: 'Endpoint TikTunnel', status: ok ? 'OK' : 'FAIL', ms: performance.now() - t0,
      detail: `${location.origin}${url} → HTTP ${r.status}, service=${j.service || 'unknown'}` };
  } catch (e) {
    return { label: 'Endpoint TikTunnel', status: 'FAIL', ms: performance.now() - t0,
      detail: `${location.origin}/health — ${e.name === 'AbortError' ? 'timeout/' + timeoutMs + 'ms' : e.message}` };
  } finally { clearTimeout(timer); }
}
function conclusion(items) {
  const get = (label) => items.find((x) => x.label === label);
  const tiktok = get('TikTok').status === 'OK';
  const inet = get('Internet thường').status === 'OK';
  const ep = get('Endpoint TikTunnel').status === 'OK';
  let profile, verdict, fix, status;
  if (tiktok && !inet) {
    profile = 'Gói TikTok đơn lẻ (Internet thường không truy cập được)';
    fix = 'Dùng gói Internet thông thường. Không giả mạo lưu lượng hay SNI để vượt tính cước.';
    if (ep) { status = 'WARNING'; verdict = 'Endpoint TikTunnel vẫn truy cập được, nhưng phạm vi tính cước của lưu lượng VPN chưa được Viettel xác nhận — KHÔNG coi là miễn phí.'; }
    else { status = 'FAIL'; verdict = 'Endpoint TikTunnel không truy cập được trên gói TikTok đơn lẻ → VPN không thể dùng với gói này.'; }
  } else if (tiktok && inet) {
    profile = 'Có Internet thường'; status = ep ? 'OK' : 'FAIL';
    verdict = ep ? 'Endpoint truy cập được; có thể thử import và kết nối VPN.' : 'Internet thường OK nhưng endpoint TikTunnel FAIL — kiểm tra port/host hoặc firewall.';
    fix = ep ? 'Vào dashboard → Shadowrocket → Add to Shadowrocket, xác nhận trong app.' : 'Chạy Network Diagnostics trong dashboard để biết nguyên nhân cụ thể.';
  } else if (!tiktok && inet) {
    profile = 'TikTok bị chặn/không có trong gói, Internet thường OK'; status = ep ? 'OK' : 'FAIL';
    verdict = ep ? 'Endpoint truy cập được; việc TikTok bị chặn không ảnh hưởng đến VPN.' : 'Endpoint TikTunnel FAIL dù có Internet thường.';
    fix = ep ? 'Có thể dùng VPN bình thường.' : 'Chạy Network Diagnostics trong dashboard.';
  } else {
    profile = 'Không có kết nối Internet'; status = 'FAIL';
    verdict = 'Cả TikTok và Internet thường đều không phản hồi — không thể đánh giá gói cước lúc này.';
    fix = 'Kiểm tra SIM/sóng/mạng rồi chạy lại.';
  }
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
  return `<div class="diag-item"><div class="diag-head">${pill(status)}<b>Kết luận</b></div>
    <p><b>Hồ sơ mạng:</b> ${profile}</p><p>${verdict}</p><p class="sub">${fix}</p>
    <p class="sub">Thiết bị: ${isIos ? 'iOS' : 'không phải iOS/xác định từ User-Agent'}. VPN đang bật hay tắt do bạn kiểm soát — công cụ này giả định VPN đang TẮT.</p></div>`;
}
async function run() {
  resultEl.innerHTML = '<div class="skeleton-wrap"><div class="skeleton"></div><div class="skeleton"></div></div>';
  const items = [];
  items.push(await probe('TikTok', 'https://www.tiktok.com/'));
  items.push(await probe('Internet thường', 'https://example.com/'));
  items.push(await probeEndpoint());
  items.push({ label: 'DNS / TCP thô', status: 'UNKNOWN', ms: null,
    detail: 'Trình duyệt không cung cấp API để đo DNS riêng hay TCP handshake. Chỉ kết quả HTTP ở trên là dữ liệu thật.' });
  resultEl.innerHTML = items.map(row).join('') + conclusion(items) +
    `<p class="sub">Thời gian chạy: ${new Date().toLocaleString('vi-VN')} · nguồn: ${esc(location.origin)}</p>`;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
document.getElementById('run').onclick = run;
document.getElementById('clear').onclick = () => { resultEl.innerHTML = emptyState('Chưa có kết quả', 'Bấm “Chạy kiểm tra” trên SIM cần kiểm tra, VPN tắt'); };
function emptyState(msg, sub = '') { return `<div class="empty"><b>${esc(msg)}</b><p class="sub">${esc(sub)}</p></div>`; }
resultEl.innerHTML = emptyState('Chưa có kết quả', 'Bấm “Chạy kiểm tra” trên SIM cần kiểm tra, VPN tắt');
