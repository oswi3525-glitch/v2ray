#!/usr/bin/env bash
set -uo pipefail

VPS="${VPS:-1.2.3.4}"
IFACE="${IFACE:-eth0}"
CAPTURE_SEC="${CAPTURE_SEC:-20}"
JA3_PY="${JA3_PY:-ja3.py}"

echo "== SNI =="
timeout "$CAPTURE_SEC" sudo tshark -i "$IFACE" -f "tcp port 443" -w /tmp/tunnel.pcap >/dev/null 2>&1 || true
sudo tshark -r /tmp/tunnel.pcap -Y "tls.handshake.type == 1" \
  -T fields -e frame.time_relative -e ip.dst \
           -e tls.handshake.extensions_server_name > /tmp/tiktunnel-sni.txt || true
if grep -q "www.tiktok.com\|www.tiktokcdn.com\|www.microsoft.com" /tmp/tiktunnel-sni.txt; then
  echo "SNI OK"
  cat /tmp/tiktunnel-sni.txt
else
  echo "SNI FAIL"
fi

echo "== JA3 =="
if command -v "$JA3_PY" >/dev/null 2>&1; then
  "$JA3_PY" /tmp/tunnel.pcap > /tmp/tunnel.ja3 2>/dev/null || true
  "$JA3_PY" /tmp/chrome.pcap > /tmp/chrome.ja3 2>/dev/null || true
  echo "tunnel: $(awk -F, '{print $2}' /tmp/tunnel.ja3 | head -1)"
  echo "chrome: $(awk -F, '{print $2}' /tmp/chrome.ja3 | head -1)"
  echo "capture a Chrome baseline to /tmp/chrome.pcap for comparison"
else
  echo "JA3 SKIP: set JA3_PY to ja3.py"
fi

echo "== Probe without key =="
openssl s_client -connect "$VPS:443" -servername www.tiktok.com -alpn h2 </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer || true
curl -sS --max-time 15 --resolve "www.tiktok.com:443:$VPS" -o /dev/null \
  -w "HTTP=%{http_code} URL=%{url_effective}\n" https://www.tiktok.com/ || true

echo "== IP and DNS =="
echo "IPv4 egress: $(curl -4 -sS --max-time 10 https://api.ipify.org || true)"
if curl -6 -sS --max-time 5 https://api64.ipify.org >/dev/null 2>&1; then
  echo "IPv6 LEAK: visible"
else
  echo "IPv6 blocked"
fi
echo "DNS resolver seen: $(dig +short @1.1.1.1 whoami.akamai.net A | head -1)"
echo "Open in WebView: https://dnsleaktest.com and https://test-ipv6.com"
echo "Kill switch: disconnect the tunnel, then curl --max-time 3 https://api.ipify.org must fail"
