#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Publish the SPEAKER WEB CLIENT to surge.sh.
#
# surge.sh serves static files only. It cannot run the WebSocket gateway, the
# uploads or Redis — so the backend must live somewhere else, and this build is
# baked with its address.
#
#   ./deploy/surge.sh sync-music.surge.sh https://api.yourdomain.com
#
# Auth: run `npx surge login` once, or export SURGE_LOGIN + SURGE_TOKEN
# (get the token with `npx surge token`) for non-interactive deploys.
# ---------------------------------------------------------------------------
set -euo pipefail

DOMAIN="${1:-}"
BACKEND="${2:-${VITE_BACKEND_URL:-}}"

if [[ -z "$DOMAIN" || -z "$BACKEND" ]]; then
  echo "usage: $0 <subdomain.surge.sh> <https://backend-origin>" >&2
  exit 1
fi
if [[ "$BACKEND" != https://* ]]; then
  echo "backend must be HTTPS — browsers block wss:// and service workers otherwise" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

echo "==> checking backend $BACKEND"
curl -fsS "${BACKEND%/}/healthz" >/dev/null || {
  echo "!! $BACKEND/healthz unreachable. Deploy the backend first (deploy/deploy.sh)." >&2
  exit 1
}

echo "==> building speaker web against $BACKEND"
npm run build:packages
VITE_BACKEND_URL="${BACKEND%/}" npm run build -w @sync-music/speaker-web

DIST="apps/speaker-web/dist"
# surge SPA fallback: every unknown path (e.g. /speaker) serves the app
cp "$DIST/index.html" "$DIST/200.html"
echo "$DOMAIN" > "$DIST/CNAME"

echo "==> publishing to https://$DOMAIN"
if [[ -n "${SURGE_TOKEN:-}" && -n "${SURGE_LOGIN:-}" ]]; then
  npx --yes surge "$DIST" "$DOMAIN" --token "$SURGE_TOKEN"
else
  npx --yes surge "$DIST" "$DOMAIN"
fi

echo
echo "==> live:  https://$DOMAIN/speaker"
echo "    backend: $BACKEND  (CORS is already open on the server)"
