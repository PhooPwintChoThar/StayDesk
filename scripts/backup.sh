#!/bin/sh
# Backs up every service database (one file per database) into ./backups.
# Each microservice owns its data, so each database is dumped and can be
# restored on its own:
#   docker compose exec -T postgres psql -U postgres -d <db> < backups/<file>.sql
# Schedule it, for example daily at 02:00 with cron:
#   0 2 * * * cd /path/to/project && ./scripts/backup.sh
set -e
cd "$(dirname "$0")/.."
stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
for db in guest_db reservation_db room_rate_db payment_db notification_db; do
  docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-postgres}" --clean --if-exists "$db" > "backups/$db-$stamp.sql"
  echo "backups/$db-$stamp.sql"
done
# Keep the 14 most recent backups of each database.
for db in guest_db reservation_db room_rate_db payment_db notification_db; do
  ls -1t backups/$db-*.sql 2>/dev/null | tail -n +15 | xargs rm -f
done
