#!/usr/bin/env bash
# Production's grants on schemas public + app (read-only catalog query; names and roles only).
#   bash migration-package/scripts/measure-grants.sh > ~/restaurant-migration/prod.grants
set -euo pipefail
cd "$(dirname "$0")/../.."
export PGPASSWORD="$(grep -E '^PROD_DB_PASSWORD=' .env.production | cut -d= -f2-)" \
  PGHOST="$(grep -E '^PROD_POOLER_HOST=' .env.production | cut -d= -f2-)" PGPORT=5432 \
  PGUSER=postgres.lgoirbfyspuflqekrcgp PGDATABASE=postgres PGSSLMODE=require PGOPTIONS='-c default_transaction_read_only=on'
sql="$(sed -n '/^grants_sql="/,/order by 1"$/p' migration-package/scripts/rebuild-and-compare.sh | sed '1s/^grants_sql="//; $s/"$//')"
psql -At -c "$sql"
