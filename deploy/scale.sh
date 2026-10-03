#!/usr/bin/env bash
# Horizontal scale-out. Redis pub/sub keeps every instance in the same session,
# so this raises total speaker capacity without touching product logic.
#   ./deploy/scale.sh 4
set -euo pipefail
cd "$(dirname "$0")/.."
N="${1:-2}"
docker compose up -d --scale server="$N" --no-recreate
docker compose ps
echo "capacity ≈ $N × MAX_CONNECTIONS_PER_INSTANCE (see .env)"
