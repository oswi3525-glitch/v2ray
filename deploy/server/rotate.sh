#!/usr/bin/env bash
set -euo pipefail
umask 077

SB_USER="${SB_USER:-sing-box}"
CFG=/etc/sing-box/config.json
REALITY_CFG=/etc/sing-box/reality.json
SECRETS=/root/tiktunnel-client-secrets.env
CLIENT_CFG=/root/tiktunnel-client.json
TEMPLATE=/etc/sing-box/templates/client.json.template

set -a
source "$SECRETS"
set +a

NEW_ST=$(openssl rand -hex 16)
NEW_SS=$(openssl rand -base64 16)
NEW_SID=$(openssl rand -hex 4)

jq --arg st "$NEW_ST" --arg ss "$NEW_SS" \
  '.inbounds[0].users[0].password=$st | .inbounds[1].password=$ss' \
  "$CFG" > "$CFG.tmp"
mv "$CFG.tmp" "$CFG"
chmod 600 "$CFG"
chown "$SB_USER":"$SB_USER" "$CFG"

if [[ -f "$REALITY_CFG" ]]; then
  jq --arg sid "$NEW_SID" '.inbounds[0].tls.reality.short_id[1]=$sid' \
    "$REALITY_CFG" > "$REALITY_CFG.tmp"
  mv "$REALITY_CFG.tmp" "$REALITY_CFG"
  chmod 600 "$REALITY_CFG"
  chown "$SB_USER":"$SB_USER" "$REALITY_CFG"
fi

CLIENT_TMP=$(mktemp)
sed -e "s|__SERVER_IP__|${SERVER_IP}|g" \
    -e "s|__HANDSHAKE_DOMAIN__|${HANDSHAKE_DOMAIN}|g" \
    -e "s|__UUID__|${UUID}|g" \
    -e "s|__SHADOWTLS_PASSWORD__|${NEW_ST}|g" \
    -e "s|__SS2022_PASSWORD__|${NEW_SS}|g" \
    -e "s|__REALITY_PUBLIC_KEY__|${REALITY_PUBLIC_KEY}|g" \
    -e "s|__REALITY_SHORT_ID__|${NEW_SID}|g" \
    -e "s|__REALITY_IP__|${REALITY_IP}|g" \
    "$TEMPLATE" > "$CLIENT_TMP"
if [[ -z "$REALITY_IP" ]]; then
  jq 'del(.outbounds[] | select(.tag == "reality-fallback")) | (.outbounds[] | select(has("outbounds")) | .outbounds) |= map(select(. != "reality-fallback"))' \
    "$CLIENT_TMP" > "${CLIENT_TMP}.json"
  mv "${CLIENT_TMP}.json" "$CLIENT_TMP"
fi
install -m 600 "$CLIENT_TMP" "$CLIENT_CFG"
rm -f "$CLIENT_TMP"

SECRETS_TMP=$(mktemp)
cat > "$SECRETS_TMP" <<EOF
SERVER_IP=${SERVER_IP}
HANDSHAKE_DOMAIN=${HANDSHAKE_DOMAIN}
UUID=${UUID}
SHADOWTLS_PASSWORD=${NEW_ST}
SS2022_PASSWORD=${NEW_SS}
REALITY_PUBLIC_KEY=${REALITY_PUBLIC_KEY}
REALITY_SHORT_ID=${NEW_SID}
REALITY_IP=${REALITY_IP}
SSH_PORT=${SSH_PORT}
EOF
install -m 600 "$SECRETS_TMP" "$SECRETS"
rm -f "$SECRETS_TMP"

systemctl restart sing-box
if [[ -f "$REALITY_CFG" ]] && systemctl is-enabled --quiet sing-box-reality; then
  systemctl restart sing-box-reality
fi

echo "SHADOWTLS_PASSWORD=${NEW_ST}"
echo "SS2022_PASSWORD=${NEW_SS}"
echo "SHORT_ID=${NEW_SID}"
echo "client config: ${CLIENT_CFG}"
