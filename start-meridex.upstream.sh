#!/usr/bin/env bash
# Start Postgres when it is down, then the engine, gateway, and the three sites.
# A postmaster.pid is removed only when its pid is not a running postgres process.
# The gateway is not started until the database accepts connections.
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"

is_postgres_pid() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [[ -d "/proc/$pid" ]] || return 1
  if [[ ! -r "/proc/$pid/comm" ]]; then
    # The process exists but we cannot tell what it is. Leave the pid file.
    return 0
  fi
  local comm exe
  comm="$(tr -d '\0\n' < "/proc/$pid/comm" || true)"
  case "$comm" in
    postgres|postmaster) return 0 ;;
  esac
  if [[ -L "/proc/$pid/exe" ]]; then
    exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
    case "$exe" in
      */postgres|*/postmaster) return 0 ;;
    esac
  fi
  return 1
}

pidfile_present() {
  local pidfile="$1"
  [[ -f "$pidfile" ]] && return 0
  sudo -n test -f "$pidfile" >/dev/null 2>&1
}

read_pidfile() {
  local pidfile="$1"
  if [[ -r "$pidfile" ]]; then
    head -n 1 "$pidfile"
    return
  fi
  sudo -n head -n 1 "$pidfile"
}

remove_pidfile() {
  local pidfile="$1"
  if [[ -w "$pidfile" || -w "$(dirname "$pidfile")" ]]; then
    rm -f "$pidfile"
    return
  fi
  sudo -n rm -f "$pidfile"
}

# Print "absent", "kept pid N", or "removed pid N".
# Exit 1 only when the file is stale and cannot be deleted.
clear_stale_postmaster() {
  local pgdata="$1"
  local pidfile="$pgdata/postmaster.pid"
  if ! pidfile_present "$pidfile"; then
    echo "absent"
    return 0
  fi
  local pid
  pid="$(read_pidfile "$pidfile" | tr -d '[:space:]')"
  if is_postgres_pid "$pid"; then
    echo "kept pid $pid"
    return 0
  fi
  if remove_pidfile "$pidfile"; then
    echo "removed pid ${pid:-empty}"
    return 0
  fi
  echo "stale pid ${pid:-empty} but $pidfile could not be removed" >&2
  return 1
}

if [[ "${1:-}" == "--check-pid" ]]; then
  if msg="$(clear_stale_postmaster "${2:?pgdata}")"; then
    printf '%s\n' "$msg"
    exit 0
  fi
  printf '%s\n' "${msg:-failed}"
  exit 1
fi

cd "$root"
mkdir -p data

if [[ ! -d web-admin/node_modules ]]; then
  ln -sfn ../web/node_modules web-admin/node_modules
fi
if [[ ! -d web-pool/node_modules ]]; then
  ln -sfn ../web/node_modules web-pool/node_modules
fi

seen="|"
consider_pgdata() {
  local dir="$1"
  [[ -n "$dir" && -d "$dir" ]] || return 0
  [[ "$seen" == *"|$dir|"* ]] && return 0
  if [[ -f "$dir/PG_VERSION" || -f "$dir/postmaster.pid" ]] || sudo -n test -f "$dir/PG_VERSION" >/dev/null 2>&1 || sudo -n test -f "$dir/postmaster.pid" >/dev/null 2>&1; then
    seen="${seen}${dir}|"
    if msg="$(clear_stale_postmaster "$dir")"; then
      echo "postgres data $dir: $msg"
    else
      echo "postgres data $dir: stale postmaster.pid was left in place" >&2
    fi
  fi
}

if [[ -n "${PGDATA:-}" ]]; then
  consider_pgdata "$PGDATA"
fi
consider_pgdata /var/lib/postgresql/16/main
consider_pgdata /var/lib/postgresql/data
consider_pgdata /usr/local/var/postgres
consider_pgdata "$root/data/pg"

wait_for_db() {
  local i=0
  local started=0
  local host="${PGHOST:-127.0.0.1}"
  local port="${PGPORT:-5432}"
  local user="${PGUSER:-meridex}"
  local db="${PGDATABASE:-meridex}"
  echo "waiting for database ${user}@${host}:${port}/${db}"
  until pg_isready -h "$host" -p "$port" -U "$user" -d "$db" >/dev/null 2>&1; do
    if [[ "$started" -eq 0 ]]; then
      started=1
      if command -v pg_ctlcluster >/dev/null 2>&1; then
        pg_ctlcluster 16 main start >/dev/null 2>&1 || sudo -n pg_ctlcluster 16 main start >/dev/null 2>&1 || true
      fi
    fi
    i=$((i + 1))
    if [[ "$i" -gt 60 ]]; then
      echo "database did not become ready within 30s" >&2
      exit 1
    fi
    sleep 0.5
  done
  echo "database ready"
}

port_open() {
  python3 - "$1" <<'PY'
import socket, sys
s = socket.socket()
s.settimeout(0.3)
try:
    sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
finally:
    s.close()
PY
}

wait_http() {
  local url="$1"
  local label="$2"
  local i=0
  until python3 - "$url" <<'PY'
import sys, urllib.request
try:
    urllib.request.urlopen(sys.argv[1], timeout=1)
    raise SystemExit(0)
except Exception:
    raise SystemExit(1)
PY
  do
    i=$((i + 1))
    if [[ "$i" -gt 60 ]]; then
      echo "$label did not become ready: $url" >&2
      exit 1
    fi
    sleep 0.5
  done
  echo "$label ready"
}

wait_for_db

if ! port_open 7109; then
  if [[ ! -x "$root/engine/target/debug/meridex-engine" ]]; then
    echo "engine binary missing; run: cargo build --manifest-path engine/Cargo.toml" >&2
    exit 1
  fi
  ENGINE_BIND="${ENGINE_BIND:-127.0.0.1:7109}" \
  ENGINE_JOURNAL="${ENGINE_JOURNAL:-$root/data/engine-journal.jsonl}" \
  ENGINE_REF_PRICE="${ENGINE_REF_PRICE:-13000}" \
  ENGINE_BAND_BPS="${ENGINE_BAND_BPS:-500}" \
  ENGINE_HALT_BPS="${ENGINE_HALT_BPS:-200}" \
  ENGINE_FSYNC_EVERY="${ENGINE_FSYNC_EVERY:-25}" \
    nohup "$root/engine/target/debug/meridex-engine" serve > "$root/data/engine.log" 2>&1 &
  echo "engine pid $!"
  wait_http "http://127.0.0.1:7109/health" "engine"
else
  echo "engine already listening"
fi

if ! port_open 7108; then
  (
    cd "$root/gateway"
    DATABASE_URL="${DATABASE_URL:-postgres://meridex:<redacted>@127.0.0.1:5432/meridex}" \
    ENGINE_URL="${ENGINE_URL:-http://127.0.0.1:7109}" \
    GATEWAY_PORT="${GATEWAY_PORT:-7108}" \
    GATEWAY_HOST="${GATEWAY_HOST:-127.0.0.1}" \
    JWT_SECRET="${JWT_SECRET:-<redacted>}" \
    SEED_DEMO="${SEED_DEMO:-1}" \
    BOTS="${BOTS:-1}" \
    SANDBOX_MOCK_GEO="${SANDBOX_MOCK_GEO:-1}" \
      nohup npx tsx src/index.ts > "$root/data/gateway.log" 2>&1 &
    echo "gateway pid $!"
  )
  wait_http "http://127.0.0.1:7108/healthz" "gateway"
else
  echo "gateway already listening"
fi

if ! port_open 4317; then
  (
    cd "$root/web"
    NODE_ENV=production API_INTERNAL_URL=http://127.0.0.1:7108 HOST="${HOST:-127.0.0.1}" PORT=4317 \
      nohup node server.mjs > "$root/data/web.log" 2>&1 &
    echo "customer pid $!"
  )
fi

if ! port_open 4318; then
  (
    cd "$root/web-admin"
    NODE_ENV=production API_INTERNAL_URL=http://127.0.0.1:7108 ADMIN_HOST="${ADMIN_HOST:-127.0.0.1}" PORT=4318 \
      nohup node server.mjs > "$root/data/admin.log" 2>&1 &
    echo "admin pid $!"
  )
fi

if ! port_open 4319; then
  (
    cd "$root/web-pool"
    NODE_ENV=production API_INTERNAL_URL=http://127.0.0.1:7108 POOL_HOST="${POOL_HOST:-127.0.0.1}" PORT=4319 \
      nohup node server.mjs > "$root/data/pool.log" 2>&1 &
    echo "pool pid $!"
  )
fi

echo "customer http://127.0.0.1:4317"
echo "admin    http://127.0.0.1:4318"
echo "pool     http://127.0.0.1:4319"
