#!/usr/bin/env bash
# ===========================================================================
# Restores a MY FOOD production backup TWICE into a disposable PostgreSQL
# cluster (its own data directory and port; nothing else on the machine is
# touched) and reconciles the two copies. Then proves the reconciliation can
# fail: it alters one payment in copy B and requires a non-zero exit.
#
#   bash migration-package/scripts/restore-and-reconcile.sh [dump] [--keep]
#
# Default dump: the newest in ~/restaurant-migration/backups. --keep leaves
# the cluster running (port 55432) for the application tests.
#
# What is loaded: schemas public, app, auth, storage, supabase_migrations, the
# extensions pgcrypto / uuid-ossp, and their data. Not loaded locally:
# Supabase-internal schemas (realtime, vault, graphql, pgbouncer, cron) and
# extensions a plain PostgreSQL does not ship (pg_cron, supabase_vault,
# pg_graphql, pg_net). On the VPS the supabase/postgres image provides them,
# and migration 20260925001100 re-creates the cron job.
# ===========================================================================
set -uo pipefail
umask 077
cd "$(dirname "$0")/../.."
KEEP=false; DUMP=""
for arg in "$@"; do case "$arg" in --keep) KEEP=true ;; *) DUMP="$arg" ;; esac; done
[ -n "$DUMP" ] || DUMP="$(ls -t "$HOME"/restaurant-migration/backups/*.dump | head -1)"
[ -f "$DUMP" ] && [ -f "$DUMP.sha256" ] || { echo "No such backup (or no .sha256): $DUMP" >&2; exit 1; }
PORT=55432
WORK="$HOME/restaurant-migration/restore-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$WORK"
EVID="$WORK/evidence"; mkdir -p "$EVID"
echo "Backup: $DUMP"
if [ "$(shasum -a 256 "$DUMP" | awk '{print $1}')" = "$(cat "$DUMP.sha256")" ]; then
  echo "  sha256 check: OK"
else
  echo "  sha256 check: MISMATCH (the backup file changed or is damaged)" >&2; exit 1
fi

# ── disposable cluster ─────────────────────────────────────────────────────
pg_ctl -D "$WORK/pgdata" stop -m fast >/dev/null 2>&1 || true
initdb -D "$WORK/pgdata" -U postgres --auth=trust >/dev/null
pg_ctl -D "$WORK/pgdata" -o "-p $PORT -k $WORK -c listen_addresses=127.0.0.1" -l "$WORK/postgres.log" start >/dev/null
trap '$KEEP || pg_ctl -D "$WORK/pgdata" stop -m fast >/dev/null 2>&1' EXIT
U="postgresql://postgres@127.0.0.1:$PORT"

SCHEMAS=(-n public -n app -n auth -n storage -n supabase_migrations)

restore_copy () {
  local db="$1"
  psql -q "$U/postgres" -c "create database $db" || return 1
  psql -q -v ON_ERROR_STOP=1 "$U/$db" -f migration-package/sql/00-prelude.sql > /dev/null || return 1
  # pg_restore exits non-zero on ANY error; the outcome is judged by reconciliation, and every
  # error line is kept as evidence and classified below.
  pg_restore --no-owner --no-acl "${SCHEMAS[@]}" -d "$U/$db" "$DUMP" > "$EVID/$db.restore.log" 2>&1
  local unexpected
  # Expected on a plain PostgreSQL: objects the prelude already created.
  unexpected=$(grep -E 'ERROR:' "$EVID/$db.restore.log" | grep -vE 'already exists' | wc -l | tr -d ' ')
  echo "  $db: $(grep -c 'ERROR:' "$EVID/$db.restore.log") restore error(s), $unexpected unexpected"
  # An empty restore also has zero errors: require the business tables and their rows.
  local tables orders
  tables=$(psql -At "$U/$db" -c "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")
  orders=$(psql -At "$U/$db" -c "select count(*) from public.orders" 2>/dev/null || echo 0)
  echo "  $db: $tables public tables, $orders orders"
  [ "$tables" -ge 50 ] && [ "$orders" -gt 0 ] || { echo "  $db: restore is empty or incomplete"; return 1; }
  [ "$unexpected" = 0 ] || { grep -E 'ERROR:' "$EVID/$db.restore.log" | grep -vE 'already exists' | sort | uniq -c | sort -rn | head -20; return 1; }
}

echo "Restoring copy A and copy B"
restore_copy myfood_a || { echo "RESTORE A FAILED"; exit 1; }
restore_copy myfood_b || { echo "RESTORE B FAILED"; exit 1; }

echo "Fingerprinting both copies"
node migration-package/scripts/reconcile.mjs "$U/myfood_a" > "$EVID/a.json" || exit 1
node migration-package/scripts/reconcile.mjs "$U/myfood_b" > "$EVID/b.json" || exit 1
node migration-package/scripts/reconcile.mjs --compare "$EVID/a.json" "$EVID/b.json" | tee "$EVID/reconcile.txt"
status=${PIPESTATUS[0]}
[ "$status" = 0 ] || { echo "RECONCILIATION FAILED"; exit 1; }

echo "Proving the reconciliation can fail: one payment in copy B changes by 1 pesewa"
psql -q "$U/myfood_b" -c "update public.payments set amount = amount - 1 where id = (select id from public.payments where amount > 1 order by id limit 1)"
node migration-package/scripts/reconcile.mjs "$U/myfood_b" > "$EVID/b-tampered.json"
if node migration-package/scripts/reconcile.mjs --compare "$EVID/a.json" "$EVID/b-tampered.json" > "$EVID/negative-control.txt" 2>&1; then
  echo "NEGATIVE CONTROL FAILED: a changed payment was not detected"; exit 1
fi
echo "  detected as expected:"; sed 's/^/    /' "$EVID/negative-control.txt" | head -6
psql -q "$U/myfood_b" -c "update public.payments set amount = amount + 1 where id = (select id from public.payments where amount > 1 order by id limit 1)"

python3 - "$EVID/a.json" > "$EVID/summary.txt" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print("tables", len(d["tables"]), "rows", sum(int(t["rows"]) for t in d["tables"].values()))
for k,v in d["totals"].items(): print(k, v)
print("invariants", d["invariants"])
PY
cat "$EVID/summary.txt"
cp "$DUMP.sha256" "$EVID/backup.sha256"; basename "$DUMP" > "$EVID/backup.name"
echo "Evidence: $EVID"
$KEEP && echo "Cluster kept running: $U/myfood_a (stop: pg_ctl -D $WORK/pgdata stop)"
exit 0
