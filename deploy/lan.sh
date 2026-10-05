#!/usr/bin/env bash
# Run Sync Music on your own Wi-Fi / hotspot with NO internet.
# Needs internet only once, for `npm ci`. Usage: ./deploy/lan.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8080}"
IP="$(node -e "const o=require('os').networkInterfaces();for(const k in o)for(const i of o[k])if(i.family==='IPv4'&&!i.internal){console.log(i.address);process.exit()}")"
[ -d node_modules ] || npm ci
npm run build
export NODE_ENV=development HOST=0.0.0.0 PORT="$PORT" PUBLIC_BASE_URL="http://$IP:$PORT" SERVE_WEB=true
echo; echo "Open on EVERY phone (same Wi-Fi):  http://$IP:$PORT"; echo "Host page: http://$IP:$PORT/#/host"; echo
cd server && node dist/index.js
