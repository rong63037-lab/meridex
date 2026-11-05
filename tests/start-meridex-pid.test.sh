#!/usr/bin/env bash
# The pid guard must delete a dead or non-postgres pid and keep a live postgres pid.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
script="$root/start-meridex.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

check() {
  "$script" --check-pid "$1"
}

mkdir -p "$tmp/dead"
echo 999999 > "$tmp/dead/postmaster.pid"
out="$(check "$tmp/dead")"
[[ "$out" == removed* ]]
[[ ! -f "$tmp/dead/postmaster.pid" ]]

mkdir -p "$tmp/junk"
echo 'not-a-pid' > "$tmp/junk/postmaster.pid"
out="$(check "$tmp/junk")"
[[ "$out" == removed* ]]
[[ ! -f "$tmp/junk/postmaster.pid" ]]

mkdir -p "$tmp/self"
echo $$ > "$tmp/self/postmaster.pid"
out="$(check "$tmp/self")"
[[ "$out" == removed* ]]
[[ ! -f "$tmp/self/postmaster.pid" ]]

mkdir -p "$tmp/bin" "$tmp/live"
cp "$(command -v sleep)" "$tmp/bin/postgres"
"$tmp/bin/postgres" 30 &
pgpid=$!
echo "$pgpid" > "$tmp/live/postmaster.pid"
out="$(check "$tmp/live")"
kill "$pgpid" 2>/dev/null || true
wait "$pgpid" 2>/dev/null || true
[[ "$out" == kept* ]]
[[ -f "$tmp/live/postmaster.pid" ]]

live="/var/lib/postgresql/16/main/postmaster.pid"
if [[ -f "$live" ]] || sudo -n test -f "$live" >/dev/null 2>&1; then
  if [[ -r "$live" ]]; then
    before="$(head -n 1 "$live")"
  else
    before="$(sudo -n head -n 1 "$live")"
  fi
  out="$(check /var/lib/postgresql/16/main)"
  if [[ -r "$live" ]]; then
    after="$(head -n 1 "$live")"
  else
    after="$(sudo -n head -n 1 "$live")"
  fi
  [[ "$out" == kept* ]]
  [[ "$before" == "$after" ]]
  [[ "$before" =~ ^[0-9]+$ ]]
fi

echo "start-meridex pid guard ok"
