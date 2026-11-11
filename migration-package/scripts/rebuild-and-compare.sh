#!/usr/bin/env bash
# ===========================================================================
# Builds an EMPTY database from the committed migrations only and compares its
# structure (schemas public + app: tables, columns, constraints, indexes,
# triggers, functions, policies, grants) with production's, taken from a backup.
# Then loads production's rows into the rebuilt schema (data only) and
# reconciles them against a plain restore: any column production has and the
# migrations lack would fail here.
#
#   bash migration-package/scripts/rebuild-and-compare.sh [dump]
#
# Runs in its own disposable cluster (port 55433). Supabase-managed schemas
# (auth, storage) are taken from the backup, schema only, as the supabase/postgres
# image will provide them on the VPS. Exit 1 on any difference.
# ===========================================================================
set -uo pipefail
umask 077
cd "$(dirname "$0")/../.."
DUMP="${1:-$(ls -t "$HOME"/restaurant-migration/backups/*.dump | head -1)}"
[ -f "$DUMP" ] || { echo "No backup: $DUMP" >&2; exit 1; }
PORT=55433
WORK="$HOME/restaurant-migration/rebuild-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$WORK/evidence"
EVID="$WORK/evidence"
initdb -D "$WORK/pgdata" -U postgres --auth=trust >/dev/null
pg_ctl -D "$WORK/pgdata" -o "-p $PORT -k $WORK -c listen_addresses=127.0.0.1" -l "$WORK/postgres.log" start >/dev/null \
  || { echo "Could not start the disposable cluster (port $PORT in use? an earlier --keep run is still up)" >&2; exit 1; }
trap 'pg_ctl -D "$WORK/pgdata" stop -m fast >/dev/null 2>&1' EXIT
U="postgresql://postgres@127.0.0.1:$PORT"
fail=0

# 1. Production's structure, from the backup.
psql -q "$U/postgres" -c "create database prod"
psql -q -v ON_ERROR_STOP=1 "$U/prod" -f migration-package/sql/00-prelude.sql >/dev/null
pg_restore --no-owner --no-acl -n public -n app -n auth -n storage -n supabase_migrations -d "$U/prod" "$DUMP" > "$EVID/prod-restore.log" 2>&1

# 2. The rebuild: Supabase-managed schemas (schema only), then every committed migration in order.
psql -q "$U/postgres" -c "create database rebuilt"
psql -q -v ON_ERROR_STOP=1 "$U/rebuilt" -f migration-package/sql/00-prelude.sql >/dev/null
pg_restore --no-owner --no-acl --schema-only -n auth -n storage -n supabase_migrations -d "$U/rebuilt" "$DUMP" > "$EVID/rebuilt-supabase-schemas.log" 2>&1
applied=0
for m in supabase/migrations/*.sql; do
  if ! psql -q -v ON_ERROR_STOP=1 "$U/rebuilt" -f "$m" > "$EVID/migration.log" 2>&1; then
    echo "MIGRATION FAILED: $m"; sed 's/^/  /' "$EVID/migration.log" | head -10; exit 1
  fi
  applied=$((applied + 1))
done
echo "Rebuilt from $applied committed migrations (no manual SQL)."
# Negative control: INJECT_DRIFT=1 adds a column production does not have; the comparison must fail.
[ "${INJECT_DRIFT:-}" = 1 ] && psql -q "$U/rebuilt" -c "alter table public.orders add column drift_probe int" && echo "(drift injected)"

# 3. Structure comparison: schema-only dumps of public + app, normalised.
# Grants are compared separately (step 3b): the backup is taken without them.
norm () { pg_dump --schema-only --no-owner --no-acl --no-comments -n public -n app "$1" \
  | grep -vE '^(--|SET |SELECT pg_catalog|\\(un)?restrict )' | sed '/^$/d' | sort; }
norm "$U/prod" > "$EVID/prod.schema.sorted"
norm "$U/rebuilt" > "$EVID/rebuilt.schema.sorted"
if diff "$EVID/prod.schema.sorted" "$EVID/rebuilt.schema.sorted" > "$EVID/schema.diff"; then
  echo "STRUCTURE IDENTICAL: public + app ($(wc -l < "$EVID/prod.schema.sorted" | tr -d ' ') definition lines)."
else
  echo "STRUCTURE DIFFERS: $(grep -c '^[<>]' "$EVID/schema.diff") line(s) (< production, > rebuilt):"
  head -30 "$EVID/schema.diff"; fail=1
fi

# 3b. Grants (who may call/read what): production's live catalog (read-only) vs the rebuild.
grants_sql="select 'fn '||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||') '||coalesce(array_to_string(array(select x from unnest(p.proacl::text[]) x where x !~ '^(postgres|supabase_admin)=' order by 1),' '),'default')
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app')
  union all select 'tbl '||n.nspname||'.'||c.relname||' '||coalesce(array_to_string(array(select x from unnest(c.relacl::text[]) x where x !~ '^(postgres|supabase_admin)=' order by 1),' '),'default')
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app') and c.relkind in ('r','v','S') order by 1"
# Supabase grants its internal service_role on every new table by default privileges (the
# supabase/postgres image on the VPS does the same); the application never connects as service_role,
# so that one role is set aside. Every other grant, anon and authenticated included, must match.
strip_sr () { sed -E 's/ ?service_role=[a-zA-Z]+\/[a-z_]+//; s/ +$//'; }
psql -At "$U/rebuilt" -c "$grants_sql" | strip_sr > "$EVID/rebuilt.grants"
if [ -n "${PROD_GRANTS_FILE:-}" ] && [ -f "$PROD_GRANTS_FILE" ]; then
  strip_sr < "$PROD_GRANTS_FILE" > "$EVID/prod.grants"
  if diff "$EVID/prod.grants" "$EVID/rebuilt.grants" > "$EVID/grants.diff"; then
    echo "GRANTS IDENTICAL: $(wc -l < "$EVID/rebuilt.grants" | tr -d ' ') functions/tables/sequences."
  else
    echo "GRANTS DIFFER: $(grep -c '^[<>]' "$EVID/grants.diff") line(s)"; head -20 "$EVID/grants.diff"; fail=1
  fi
else
  echo "Grants not compared (set PROD_GRANTS_FILE, made by measure-grants.sh)"
fi

# 4. Production's rows into the rebuilt schema (data only, triggers off), then reconcile.
# Empty the rebuilt tables first: migrations seed reference rows (permissions, the photo bucket)
# that production's data also contains.
psql -q -v ON_ERROR_STOP=1 "$U/rebuilt" -c "do \$\$ declare t text; begin
  select string_agg(format('%I.%I', schemaname, tablename), ', ') into t from pg_tables
   where schemaname in ('public','app','auth','storage','supabase_migrations');
  execute 'truncate ' || t || ' cascade'; end \$\$;" >/dev/null
pg_restore --no-owner --no-acl --data-only --disable-triggers -n public -n app -n auth -n storage -n supabase_migrations \
  -d "$U/rebuilt" "$DUMP" > "$EVID/rebuilt-data.log" 2>&1
if grep -q 'ERROR:' "$EVID/rebuilt-data.log"; then
  echo "DATA DID NOT FIT THE REBUILT SCHEMA:"; grep 'ERROR:' "$EVID/rebuilt-data.log" | sort | uniq -c | head; fail=1
fi
node migration-package/scripts/reconcile.mjs "$U/prod" > "$EVID/prod.json"
node migration-package/scripts/reconcile.mjs "$U/rebuilt" > "$EVID/rebuilt.json"
node migration-package/scripts/reconcile.mjs --compare "$EVID/prod.json" "$EVID/rebuilt.json" || fail=1
echo "Evidence: $EVID"
exit $fail
