#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_PORT="${SSH_PORT:-2222}"
ADMIN_CIDR="${ADMIN_CIDR:-}"
HANDSHAKE_DOMAIN="${HANDSHAKE_DOMAIN:-www.tiktok.com}"
REALITY_IP="${REALITY_IP:-}"
SB_BIN=/usr/local/bin/sing-box
SB_USER=sing-box
NET_SUBNET="10.0.0.0/24"

if [[ -z "$ADMIN_CIDR" ]]; then
  echo "ADMIN_CIDR is required, e.g. ADMIN_CIDR=1.2.3.4/32" >&2
  exit 1
fi
PRIMARY_IP=$(ip -4 addr show scope global | awk '/inet / {print $2}' | cut -d/ -f1 | head -1)
SHADOWTLS_IP="$PRIMARY_IP"
if [[ -z "$REALITY_IP" ]]; then SHADOWTLS_IP="0.0.0.0"; fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl jq openssl unbound iptables netfilter-persistent ufw fail2ban ca-certificates logrotate

TAG=$(curl -fsSL https://api.github.com/repos/SagerNet/sing-box/releases/latest | jq -r .tag_name)
VER="${TAG#v}"
ARCH="linux-amd64"
ASSET="sing-box-${VER}-${ARCH}.tar.gz"
curl -fsSL "https://github.com/SagerNet/sing-box/releases/download/${TAG}/${ASSET}" -o /tmp/sing-box.tgz
WANT_SHA=$(curl -fsSL "https://api.github.com/repos/SagerNet/sing-box/releases/tags/${TAG}" 2>/dev/null \
  | jq -r --arg asset "$ASSET" '.assets[] | select(.name == $asset) | .digest' | cut -d: -f2)
if [[ -n "$WANT_SHA" ]]; then
  GOT_SHA=$(sha256sum /tmp/sing-box.tgz | awk '{print $1}')
  if [[ "$WANT_SHA" != "$GOT_SHA" ]]; then
    echo "sing-box checksum mismatch" >&2
    exit 1
  fi
else
  echo "warning: official checksum unavailable; downloaded sha256=$(sha256sum /tmp/sing-box.tgz | awk '{print $1}')" >&2
fi
tar -xzf /tmp/sing-box.tgz -C /tmp
install -m 0755 "/tmp/sing-box-${VER}-${ARCH}/sing-box" "$SB_BIN"
"$SB_BIN" version

ST_PASSWORD=$(openssl rand -hex 16)
SS_PASSWORD=$(openssl rand -base64 16)
UUID=$(cat /proc/sys/kernel/random/uuid)
SHORT_ID=$(openssl rand -hex 4)
KEYPAIR=$("$SB_BIN" generate reality-keypair)
REALITY_PRIVATE=$(echo "$KEYPAIR" | awk '/PrivateKey:/ {print $2}')
REALITY_PUBLIC=$(echo "$KEYPAIR" | awk '/PublicKey:/ {print $2}')

id -u "$SB_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin "$SB_USER"
install -d -o "$SB_USER" -g "$SB_USER" /etc/sing-box /var/log/sing-box

sed -e "s|__SHADOWTLS_IP__|${SHADOWTLS_IP}|g" \
    -e "s|__SHADOWTLS_PASSWORD__|${ST_PASSWORD}|g" \
    -e "s|__SS2022_PASSWORD__|${SS_PASSWORD}|g" \
    -e "s|__HANDSHAKE_DOMAIN__|${HANDSHAKE_DOMAIN}|g" \
    "$SCRIPT_DIR/config.json.template" > /etc/sing-box/config.json
chmod 600 /etc/sing-box/config.json
chown "$SB_USER":"$SB_USER" /etc/sing-box/config.json
"$SB_BIN" check -c /etc/sing-box/config.json

if [[ -n "$REALITY_IP" ]]; then
  sed -e "s|__REALITY_IP__|${REALITY_IP}|g" \
      -e "s|__UUID__|${UUID}|g" \
      -e "s|__SHORT_ID__|${SHORT_ID}|g" \
      -e "s|__REALITY_PRIVATE_KEY__|${REALITY_PRIVATE}|g" \
      -e "s|__HANDSHAKE_DOMAIN__|${HANDSHAKE_DOMAIN}|g" \
      "$SCRIPT_DIR/reality.json.template" > /etc/sing-box/reality.json
  chmod 600 /etc/sing-box/reality.json
  chown "$SB_USER":"$SB_USER" /etc/sing-box/reality.json
  "$SB_BIN" check -c /etc/sing-box/reality.json
fi

cat > /etc/systemd/system/sing-box.service <<EOF
[Unit]
Description=sing-box ShadowTLS to SS2022
After=network-online.target
Wants=network-online.target

[Service]
User=${SB_USER}
Group=${SB_USER}
ExecStart=${SB_BIN} run -c /etc/sing-box/config.json
Restart=on-failure
LimitNOFILE=65535
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/log/sing-box

[Install]
WantedBy=multi-user.target
EOF

if [[ -n "$REALITY_IP" ]]; then
  cat > /etc/systemd/system/sing-box-reality.service <<EOF
[Unit]
Description=sing-box VLESS Reality fallback
After=network-online.target
Wants=network-online.target

[Service]
User=${SB_USER}
Group=${SB_USER}
ExecStart=${SB_BIN} run -c /etc/sing-box/reality.json
Restart=on-failure
LimitNOFILE=65535
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/log/sing-box

[Install]
WantedBy=multi-user.target
EOF
fi

systemctl daemon-reload
systemctl enable --now sing-box
if [[ -n "$REALITY_IP" ]]; then
  systemctl enable --now sing-box-reality
fi

cat > /etc/sysctl.d/99-tiktunnel.conf <<EOF
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=0
net.ipv4.conf.all.rp_filter=0
EOF
sysctl --system >/dev/null

IFACE=$(ip route show default | awk '{print $5}' | head -1)
iptables -t nat -C POSTROUTING -s "$NET_SUBNET" -o "$IFACE" -j MASQUERADE 2>/dev/null || \
iptables -t nat -A POSTROUTING -s "$NET_SUBNET" -o "$IFACE" -j MASQUERADE
iptables -C FORWARD -s "$NET_SUBNET" -o "$IFACE" -j ACCEPT 2>/dev/null || \
iptables -A FORWARD -s "$NET_SUBNET" -o "$IFACE" -j ACCEPT
iptables -C FORWARD -i "$IFACE" -d "$NET_SUBNET" -j ACCEPT 2>/dev/null || \
iptables -A FORWARD -i "$IFACE" -d "$NET_SUBNET" -j ACCEPT
netfilter-persistent save

cat > /etc/unbound/unbound.conf.d/tiktunnel.conf <<'EOF'
server:
    interface: 127.0.0.1
    port: 53
    verbosity: 0
    use-syslog: no
    logfile: ""
    username: "unbound"
    do-ip4: yes
    do-ip6: no
    hide-identity: yes
    hide-version: yes
    qname-minimisation: yes
    harden-glue: yes
    rrset-roundrobin: yes
    prefetch: yes
EOF
systemctl enable --now unbound
printf 'nameserver 127.0.0.1\n' > /etc/resolv.conf

cat > /etc/logrotate.d/sing-box <<'EOF'
/var/log/sing-box/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    copytruncate
}
EOF

ufw default deny incoming
ufw default allow outgoing
ufw allow 443/tcp comment 'ShadowTLS/Reality'
ufw allow from "$ADMIN_CIDR" to any port "$SSH_PORT" proto tcp comment 'SSH key-only'
ufw --force enable

mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/99-tiktunnel.conf <<EOF
Port ${SSH_PORT}
PasswordAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
EOF

cat > /etc/fail2ban/jail.d/tiktunnel.conf <<EOF
[sshd]
enabled = true
port = ${SSH_PORT}
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 1h
EOF

install -m 700 "$SCRIPT_DIR/rotate.sh" /usr/local/bin/tiktunnel-rotate
systemctl restart sshd
systemctl enable --now fail2ban

install -m 600 /dev/null /root/tiktunnel-client-secrets.env
cat > /root/tiktunnel-client-secrets.env <<EOF
SERVER_IP=$(ip -4 addr show scope global | awk '/inet / {print $2}' | cut -d/ -f1 | head -1)
HANDSHAKE_DOMAIN=${HANDSHAKE_DOMAIN}
UUID=${UUID}
SHADOWTLS_PASSWORD=${ST_PASSWORD}
SS2022_PASSWORD=${SS_PASSWORD}
REALITY_PUBLIC_KEY=${REALITY_PUBLIC}
REALITY_SHORT_ID=${SHORT_ID}
REALITY_IP=${REALITY_IP}
SSH_PORT=${SSH_PORT}
EOF
chmod 600 /root/tiktunnel-client-secrets.env

install -d -m 700 /etc/sing-box/templates
install -m 600 "$SCRIPT_DIR/rotate.sh" /etc/sing-box/templates/rotate.sh
install -m 600 "$SCRIPT_DIR/../client/client.json.template" /etc/sing-box/templates/client.json.template
CLIENT_TMP=$(mktemp)
sed -e "s|__SERVER_IP__|${PRIMARY_IP}|g" \
    -e "s|__HANDSHAKE_DOMAIN__|${HANDSHAKE_DOMAIN}|g" \
    -e "s|__UUID__|${UUID}|g" \
    -e "s|__SHADOWTLS_PASSWORD__|${ST_PASSWORD}|g" \
    -e "s|__SS2022_PASSWORD__|${SS_PASSWORD}|g" \
    -e "s|__REALITY_PUBLIC_KEY__|${REALITY_PUBLIC}|g" \
    -e "s|__REALITY_SHORT_ID__|${SHORT_ID}|g" \
    -e "s|__REALITY_IP__|${REALITY_IP}|g" \
    /etc/sing-box/templates/client.json.template > "$CLIENT_TMP"
if [[ -z "$REALITY_IP" ]]; then
  jq 'del(.outbounds[] | select(.tag == "reality-fallback")) | (.outbounds[] | select(has("outbounds")) | .outbounds) |= map(select(. != "reality-fallback"))' \
    "$CLIENT_TMP" > "${CLIENT_TMP}.json"
  mv "${CLIENT_TMP}.json" "$CLIENT_TMP"
fi
install -m 600 "$CLIENT_TMP" /root/tiktunnel-client.json
rm -f "$CLIENT_TMP"
chattr +i /etc/resolv.conf 2>/dev/null || true

systemctl status sing-box --no-pager -l || true
ss -lntp | grep ':443' || true
