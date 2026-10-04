#!/bin/sh
# Nightly SQLite backups. Each pass copies every /data/bees-*.sqlite to /data/backups/<name>-<date>.sqlite, then keeps
# only the newest BACKUP_KEEP_DAYS copies of each database. Old copies are trimmed only after a new one is written, so a
# failed backup never leaves fewer than KEEP good copies. Manual pre-deploy copies (pre-*.sqlite) age out on the same
# number of days. BACKUP_ONCE=1 runs a single pass (used by the test).
set -u
KEEP=${BACKUP_KEEP_DAYS:-3}
case "$KEEP" in '' | *[!0-9]* | 0) KEEP=3 ;; esac
DIR=${BACKUP_DIR:-/data/backups}
SRC=${BACKUP_SRC:-/data}
mkdir -p "$DIR"
while true; do
  for db in "$SRC"/bees-*.sqlite; do
    [ -f "$db" ] || continue
    n=$(basename "$db" .sqlite)
    out="$DIR/$n-$(date -u +%F).sqlite"
    # .backup is safe on a live WAL database. Write to a temp name so a half-written copy never counts as one.
    if sqlite3 "$db" ".backup '$out.part'" && mv -f "$out.part" "$out"; then
      ls -1t "$DIR/$n"-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].sqlite 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do rm -f "$old"; done
    else
      rm -f "$out.part"
      echo "backup of $db failed; keeping the older copies" >&2
    fi
  done
  find "$DIR" -name 'pre-*.sqlite' -mtime +$((KEEP - 1)) -delete
  [ "${BACKUP_ONCE:-0}" = 1 ] && exit 0
  sleep 86400
done
