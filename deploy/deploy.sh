#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One-command production deploy for sync-music.
#
#   DNS first:  A  @   -> <this server's public IPv4>
#               (and AAAA if you have IPv6).  Ports 80 and 443 must be open.
#
#   Usage:      sudo ./deploy/deploy.sh suger.sh
#
# Installs Docker if missing, writes .env with freshly generated secrets,
# builds the images and brings up server + redis + Caddy (automatic HTTPS).
# ---------------------------------------------------------------------------
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "usage: $0 <domain>    e.g. $0 suger.sh" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "==> installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin missing" >&2; exit 1; }

if [[ ! -f .env ]]; then
  echo "==> generating .env for $DOMAIN"
  cp .env.example .env
  sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|"                          .env
  sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://${DOMAIN}|" .env
  sed -i "s|^TOKEN_SECRET=.*|TOKEN_SECRET=$(openssl rand -base64 48 | tr -d '\n')|"           .env
  sed -i "s|^AUDIO_URL_SECRET=.*|AUDIO_URL_SECRET=$(openssl rand -base64 48 | tr -d '\n')|"   .env
else
  echo "==> .env already exists, leaving it untouched"
fi

echo "==> checking DNS"
ip_here="$(curl -fsS https://api.ipify.org || true)"
ip_dns="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [[ -n "$ip_here" && -n "$ip_dns" && "$ip_here" != "$ip_dns" ]]; then
  echo "!! $DOMAIN resolves to $ip_dns but this host is $ip_here."
  echo "!! Let's Encrypt will fail until the A record points here. Continuing anyway."
fi

echo "==> building and starting"
docker compose up -d --build

echo "==> waiting for health"
for i in $(seq 1 60); do
  if curl -fsS "https://${DOMAIN}/healthz" >/dev/null 2>&1; then
    echo "==> live: https://${DOMAIN}/speaker"
    curl -s "https://${DOMAIN}/healthz"; echo
    exit 0
  fi
  sleep 3
done

echo "!! not healthy yet — inspect with: docker compose logs -f caddy server" >&2
exit 1
