#!/bin/sh
# Sandbox container entrypoint: engine, gateway, and the web server on $PORT.
set -eu
mkdir -p /data

meridex-engine serve &
engine_pid=$!

i=0
until node -e "fetch('http://127.0.0.1:7109/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
do
  i=$((i + 1))
  if [ "$i" -gt 50 ]; then echo "engine did not start" >&2; exit 1; fi
  sleep 0.4
done

cd /app/gateway
npx tsx src/index.ts &
gateway_pid=$!

i=0
until node -e "fetch('http://127.0.0.1:7108/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then echo "gateway did not start" >&2; exit 1; fi
  sleep 0.5
done

cd /app/web
trap 'kill "$engine_pid" "$gateway_pid" 2>/dev/null || true' EXIT INT TERM
HOST=0.0.0.0 exec node server.mjs
