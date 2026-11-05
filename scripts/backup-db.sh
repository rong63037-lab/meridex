#!/bin/sh
# Daily local dump. Keeps the last 7 custom-format files and writes latest.json for the admin home.
set -u
DIR="${MERIDEX_BACKUP_DIR:-$HOME/meridex/backups}"
DBURL="${DATABASE_URL:-postgres://meridex:<redacted>@127.0.0.1:5432/meridex}"
mkdir -p "$DIR" || exit 1
STAMP=$(date +%Y%m%d-%H%M%S)
FILE="$DIR/meridex-$STAMP.dump"
LOG="$DIR/backup.log"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if pg_dump -Fc --no-owner --dbname="$DBURL" -f "$FILE"; then
  BYTES=$(wc -c < "$FILE" | tr -d ' ')
  printf '%s ok %s %s\n' "$NOW" "$FILE" "$BYTES" >> "$LOG"
  printf '{"ok":true,"at":"%s","file":"%s","bytes":%s}\n' "$NOW" "$FILE" "$BYTES" > "$DIR/latest.json"
else
  STATUS=$?
  printf '%s failed exit %s\n' "$NOW" "$STATUS" >> "$LOG"
  printf '{"ok":false,"at":"%s","file":"%s","error":"pg_dump exit %s"}\n' "$NOW" "$FILE" "$STATUS" > "$DIR/latest.json"
  exit "$STATUS"
fi

# Keep the newest 7 dumps. The log and latest.json stay.
OLD=$(ls -1t "$DIR"/meridex-*.dump 2>/dev/null | tail -n +8 || true)
if [ -n "$OLD" ]; then
  printf '%s\n' "$OLD" | while IFS= read -r path; do
    [ -n "$path" ] && rm -f "$path"
  done
fi
