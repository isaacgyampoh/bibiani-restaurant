#!/usr/bin/env bash
# ===========================================================================
# Complete, privileged, READ-ONLY backup of MY FOOD production (Supabase
# project lgoirbfyspuflqekrcgp). One pg_dump = one consistent snapshot of the
# WHOLE database: public (business data, RLS-protected included), app, auth
# (logins: users, identities, password hashes), storage (photo metadata),
# cron (scheduled job), supabase_migrations (applied migration history).
#
# Credential: PROD_DB_PASSWORD + PROD_POOLER_HOST from the git-ignored
# .env.production (or the environment). Handed to pg_dump through PGPASSWORD
# in its own environment: never in argv, never printed. db.<ref>.supabase.co
# is IPv6-only, so the dual-stack pooler (session mode, port 5432) is used,
# with user postgres.<ref>.
#
# Output: $RP_BACKUP_DIR (default ~/restaurant-migration/backups), mode 700,
# files mode 600, never in the repository. Each run writes a new timestamped
# dump plus .sha256 and its table of contents (.toc).
#   bash migration-package/scripts/backup-production.sh
# ===========================================================================
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
REF=lgoirbfyspuflqekrcgp
OUT_DIR="${RP_BACKUP_DIR:-$HOME/restaurant-migration/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR" && chmod 700 "$OUT_DIR"

if [ -z "${PROD_DB_PASSWORD:-}" ] || [ -z "${PROD_POOLER_HOST:-}" ]; then
  [ -f .env.production ] || { echo "No .env.production and no PROD_DB_PASSWORD/PROD_POOLER_HOST in the environment" >&2; exit 2; }
  PROD_DB_PASSWORD="$(grep -E '^PROD_DB_PASSWORD=' .env.production | cut -d= -f2-)"
  PROD_POOLER_HOST="$(grep -E '^PROD_POOLER_HOST=' .env.production | cut -d= -f2-)"
fi
[ -n "$PROD_DB_PASSWORD" ] && [ -n "$PROD_POOLER_HOST" ] || { echo "PROD_DB_PASSWORD / PROD_POOLER_HOST missing" >&2; exit 2; }

export PGPASSWORD="$PROD_DB_PASSWORD" PGHOST="$PROD_POOLER_HOST" PGPORT=5432 PGUSER="postgres.$REF" PGDATABASE=postgres PGSSLMODE=require
unset PROD_DB_PASSWORD

echo "Checking the database identity (read-only)"
ident="$(psql -At -v ON_ERROR_STOP=1 -c "set default_transaction_read_only=on; select current_database()||' | '||split_part(version(),' ',2)||' | '||(select count(*) from public.restaurants)||' restaurant(s) | schema '||(select max(version) from supabase_migrations.schema_migrations)")"
echo "  $ident"

DUMP="$OUT_DIR/myfood-production-$STAMP.dump"
echo "Dumping the whole database to $DUMP"
# -Fc: compressed, selectively restorable. --no-owner --no-acl: restorable as any role.
# Everything is included; the restore chooses what to load.
pg_dump -Fc --no-owner --no-acl --quote-all-identifiers --serializable-deferrable -f "$DUMP"
chmod 600 "$DUMP"

shasum -a 256 "$DUMP" | awk '{print $1}' > "$DUMP.sha256"
pg_restore -l "$DUMP" > "$DUMP.toc"
chmod 600 "$DUMP".*
ls -la "$DUMP"*
echo "Backup complete: $(basename "$DUMP")  sha256 $(cut -c1-16 "$DUMP.sha256")…"
