#!/usr/bin/env bash
# ── Redis Backup Script ────────────────────────────────────────────────────────
# Dumps Redis data (BGSAVE → copy RDB) to /opt/autotrader/backups/redis/
# Keeps the last 7 daily backups, deletes older ones.
#
# Usage:
#   bash /opt/autotrader/scripts/redis-backup.sh
#
# Cron (daily at 03:00 server time):
#   0 3 * * * bash /opt/autotrader/scripts/redis-backup.sh >> /var/log/redis-backup.log 2>&1
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

BACKUP_DIR="/opt/autotrader/backups/redis"
REDIS_CLI="docker exec autotrader-redis-1 redis-cli"
RDB_PATH="/data/dump.rdb"          # path inside the Redis container
KEEP_DAYS=7
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
DEST="${BACKUP_DIR}/dump_${TIMESTAMP}.rdb"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting Redis backup"

# 1. Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# 2. Trigger a synchronous BGSAVE and wait for it to finish
echo "  → Triggering BGSAVE..."
$REDIS_CLI BGSAVE

# Wait for BGSAVE to complete (poll LASTSAVE timestamp)
BEFORE=$($REDIS_CLI LASTSAVE)
MAX_WAIT=60
WAITED=0
while true; do
  AFTER=$($REDIS_CLI LASTSAVE)
  if [ "$AFTER" -gt "$BEFORE" ]; then
    echo "  → BGSAVE complete (lastsave changed to $AFTER)"
    break
  fi
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    echo "  ⚠ Timeout waiting for BGSAVE — copying current RDB anyway"
    break
  fi
  sleep 2
  WAITED=$((WAITED + 2))
done

# 3. Copy RDB from container to backup directory on host
echo "  → Copying RDB to ${DEST}"
docker cp "autotrader-redis-1:${RDB_PATH}" "$DEST"

# 4. Compress the backup
gzip "$DEST"
DEST_GZ="${DEST}.gz"
SIZE=$(du -sh "$DEST_GZ" | cut -f1)
echo "  → Compressed backup: ${DEST_GZ} (${SIZE})"

# 5. Prune backups older than KEEP_DAYS
echo "  → Pruning backups older than ${KEEP_DAYS} days..."
find "$BACKUP_DIR" -name "dump_*.rdb.gz" -mtime "+${KEEP_DAYS}" -delete
REMAINING=$(ls "$BACKUP_DIR" | wc -l | tr -d ' ')
echo "  → ${REMAINING} backup(s) retained"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Redis backup complete: ${DEST_GZ}"
