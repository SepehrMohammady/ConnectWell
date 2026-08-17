#!/bin/bash
# One-time TURN relay setup for ConnectWell calls. TURN relays audio/video when a
# direct peer-to-peer path is impossible (CGNAT, mobile carriers, strict NAT),
# which is the case STUN alone cannot solve.
#
# Run once, with sudo, from the machine that will host the relay:
#   sudo bash ~/apps/connectwell/deploy/setup-turn.sudo.sh
#
# Everything it needs comes from the app's own .env, so nothing about your server
# lives in this script or in git:
#   TURN_SECRET   required — the shared secret the app signs credentials with
#   TURN_HOST     the relay's public hostname; also used as the coturn realm
#
# Override the detected values if needed:
#   PUBLIC_IP=203.0.113.10 REALM=chat.example.com sudo -E bash deploy/setup-turn.sudo.sh
#
# Safe to re-run: it rewrites the config and restarts the service.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "This needs root. Re-run: sudo bash $0" >&2
    exit 1
fi

# Resolved from where this script actually sits, so the app may live anywhere.
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_ENV="$APP_DIR/.env"
MIN_PORT="${MIN_PORT:-49160}"
MAX_PORT="${MAX_PORT:-49260}"

envval() { grep -E "^$1=" "$APP_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'' || true; }

SECRET="$(envval TURN_SECRET)"
if [ -z "$SECRET" ]; then
    echo "TURN_SECRET not found in $APP_ENV. Set it there first, then re-run." >&2
    echo "  printf 'TURN_SECRET=%s\\n' \"\$(openssl rand -hex 32)\" >> $APP_ENV" >&2
    exit 1
fi

# The realm should match the hostname clients are handed, which is TURN_HOST.
REALM="${REALM:-$(envval TURN_HOST)}"
if [ -z "$REALM" ]; then
    echo "TURN_HOST not found in $APP_ENV and REALM not set. Add TURN_HOST=<your relay hostname>." >&2
    exit 1
fi

# coturn needs the address to advertise. Detected from the default route, then
# from the outside if that gives a private address (a NATted cloud instance).
if [ -z "${PUBLIC_IP:-}" ]; then
    PUBLIC_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')"
    case "$PUBLIC_IP" in
        10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*|"")
            DETECTED="$(getent hosts "$REALM" 2>/dev/null | awk '{print $1; exit}')"
            [ -n "$DETECTED" ] && PUBLIC_IP="$DETECTED"
            ;;
    esac
fi
if [ -z "$PUBLIC_IP" ]; then
    echo "Could not determine this host's public IP. Re-run with: PUBLIC_IP=<addr> sudo -E bash $0" >&2
    exit 1
fi
echo "==> relay address ${PUBLIC_IP}, realm ${REALM}"

echo "==> installing coturn"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y coturn

echo "==> enabling the service (the package ships it disabled)"
if grep -q '^#TURNSERVER_ENABLED' /etc/default/coturn 2>/dev/null; then
    sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
elif ! grep -q '^TURNSERVER_ENABLED=1' /etc/default/coturn 2>/dev/null; then
    echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn
fi

# Preserve the package's original config once, in case anyone wants it back.
if [ -f /etc/turnserver.conf ] && [ ! -f /etc/turnserver.conf.orig ]; then
    cp /etc/turnserver.conf /etc/turnserver.conf.orig
fi

echo "==> writing /etc/turnserver.conf"
cat > /etc/turnserver.conf <<CONF
# ConnectWell TURN relay — managed by deploy/setup-turn.sudo.sh
listening-port=3478
listening-ip=${PUBLIC_IP}
relay-ip=${PUBLIC_IP}
external-ip=${PUBLIC_IP}
min-port=${MIN_PORT}
max-port=${MAX_PORT}
realm=${REALM}
server-name=${REALM}

# Ephemeral credentials: the app signs "<expiry>:<userId>" with the shared
# secret (coturn REST / use-auth-secret scheme). No user database.
use-auth-secret
static-auth-secret=${SECRET}
fingerprint
stale-nonce=600

# Hardening: no admin CLI, no TCP-relay allocations (WebRTC never asks for one),
# and refuse to relay toward loopback/link-local/private ranges so the relay
# cannot be turned into a probe of internal services.
no-cli
no-tcp-relay
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
CONF
chmod 640 /etc/turnserver.conf
chown root:turnserver /etc/turnserver.conf 2>/dev/null || true

echo "==> opening the firewall (signaling port + relay range)"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow 3478/udp
    ufw allow 3478/tcp
    ufw allow ${MIN_PORT}:${MAX_PORT}/udp
else
    echo "    ufw not active — open 3478/udp, 3478/tcp and ${MIN_PORT}:${MAX_PORT}/udp by whatever means you use."
fi

echo "==> starting coturn"
systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn
sleep 1

echo ""
echo "==> result"
systemctl is-active coturn >/dev/null 2>&1 && echo "coturn: active" || { echo "coturn FAILED to start — check: journalctl -u coturn -n 40"; exit 1; }
echo "listening on 3478:"; ss -lun 2>/dev/null | grep ":3478" || echo "  (nothing on 3478/udp — check the log)"
echo ""
echo "Done. Many hosting providers put a second firewall in front of the machine,"
echo "configured in their control panel rather than on the box. If yours does,"
echo "open 3478 udp+tcp and ${MIN_PORT}-${MAX_PORT} udp there too, or calls will"
echo "still fail from outside even though coturn is running locally."
