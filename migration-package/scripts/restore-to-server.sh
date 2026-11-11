#!/usr/bin/env bash
# ===========================================================================
# Loads a MY FOOD production backup into the server database that deploy.sh
# built from the committed migrations: DATA ONLY, into
#   public, app            business data (every row, RLS-protected included)
#   auth                   logins: users, identities, sessions, refresh tokens
#                          (password hashes are bcrypt, checked natively by the
#                          same Auth version the platform runs, v2.197.0)
#   storage                photo bucket + object records (the files themselves
#                          go to R2, see MANIFEST.yml media)
# Not loaded: auth.schema_migrations / storage.migrations (each service keeps
# its own), supabase_migrations (the server keeps its own applied history).
#
#   restore-to-server.sh <dump> <database>
#
# Refuses a backup whose schema version differs from the newest committed
# migration: a data-changing migration would otherwise be skipped. (Release
# rule: migrations reach production first, then the backup is taken.)
#
# Uses a postgres:18 client container (backups are written by pg_dump 18; the
# server's own tools are 17 and cannot read them), connecting as the database
# superuser over 127.0.0.1 (the only place the database listens).
# Then reconciles against <dump>.fingerprint.json (made by
# restore-and-reconcile.sh from the same backup). Exit 1 on any difference.
# ===========================================================================
set -euo pipefail
umask 077
DUMP="$1"; DB="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
PGPW="$(sed -n 's/^POSTGRES_PASSWORD=//p' /srv/central/.env | tail -1)"
[ -n "$PGPW" ] || { echo "no POSTGRES_PASSWORD in /srv/central/.env" >&2; exit 1; }
[ -f "$DUMP.fingerprint.json" ] || { echo "missing $DUMP.fingerprint.json (run restore-and-reconcile.sh on the backup first)" >&2; exit 1; }
DIR="$(dirname "$(readlink -f "$DUMP")")"; F="$(basename "$DUMP")"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
pg18 () { docker run --rm -i --network host -e PGPASSWORD="$PGPW" -v "$DIR:/dump:ro" -v "$WORK:/work" postgres:18-alpine "$@"; }

# Schema version of the backup vs the code.
dump_version="$(pg18 sh -c "pg_restore -a -n supabase_migrations -t schema_migrations -f - /dump/$F" \
  | awk '/^COPY .*schema_migrations/{c=1;next} /^\\\./{c=0} c{print $1}' | sort | tail -1)"
code_version="$(ls "$REPO"/supabase/migrations/*.sql | xargs -n1 basename | cut -c1-14 | sort | tail -1)"
echo "  backup schema $dump_version, code schema $code_version"
[ "$dump_version" = "$code_version" ] || { echo "REFUSED: apply migrations up to $code_version to production, take a new backup, then restore" >&2; exit 1; }

# The tables to load: every TABLE DATA entry of the four schemas, minus each service's own history.
pg18 pg_restore -l "/dump/$F" \
  | grep -E 'TABLE DATA (public|app|auth|storage) ' \
  | grep -vE 'TABLE DATA (auth schema_migrations|storage migrations) ' > "$WORK/restore.list"
tables="$(awk '{print $(NF-2)"."$(NF-1)}' "$WORK/restore.list" | sort -u)"
echo "  $(echo "$tables" | wc -l) tables to load"

# Empty them (migrations seed reference rows that production also has), then load.
list="$(echo "$tables" | sed -E 's/^([a-z_]+)\.([a-z0-9_]+)$/"\1"."\2"/' | paste -sd, -)"
docker exec -i central-postgres psql -v ON_ERROR_STOP=1 -U postgres -d "$DB" -q -c "truncate $list cascade"
pg18 pg_restore --data-only --disable-triggers --no-owner -h 127.0.0.1 -U postgres -d "$DB" -L /work/restore.list "/dump/$F" \
  > "$WORK/restore.log" 2>&1 || true
if grep -q 'ERROR:' "$WORK/restore.log"; then
  grep 'ERROR:' "$WORK/restore.log" | sort | uniq -c | head -20; echo "RESTORE HAD ERRORS" >&2; exit 1
fi
# Sequences follow the data (identity columns: audit_logs, events, ...).
docker exec -i central-postgres psql -v ON_ERROR_STOP=1 -U postgres -d "$DB" -q <<'SQL'
do $$ declare r record; begin
  for r in select s.relname seq, n.nspname sch, t.relname tbl, a.attname col
    from pg_class s join pg_depend d on d.objid = s.oid and d.deptype in ('a','i')
    join pg_class t on t.oid = d.refobjid join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
    join pg_namespace n on n.oid = t.relnamespace where s.relkind = 'S' and n.nspname in ('public','app','auth','storage') loop
    execute format('select setval(%L, coalesce((select max(%I) from %I.%I), 0) + 1, false)', r.sch||'.'||r.seq, r.col, r.sch, r.tbl);
  end loop; end $$;
SQL

# Reconcile the server copy against the backup's fingerprint (only what was loaded).
echo "  reconciling against $(basename "$DUMP").fingerprint.json"
docker run --rm --network host -e PGPASSWORD="$PGPW" -v "$REPO:/src:ro" -v "$DIR:/dump:ro" -w /src node:24-slim \
  node migration-package/scripts/reconcile.mjs "postgres://postgres@127.0.0.1:5432/$DB" > /tmp/myfood-server.json
docker run --rm -v "$REPO:/src:ro" -v "$DIR:/dump:ro" -v /tmp:/tmpx -w /src -e RECONCILE_SCOPE=restored node:24-slim \
  node migration-package/scripts/reconcile.mjs --compare "/dump/$F.fingerprint.json" /tmpx/myfood-server.json
