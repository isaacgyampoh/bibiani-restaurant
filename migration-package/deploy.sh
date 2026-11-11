#!/usr/bin/env bash
# ===========================================================================
# Deploys MY FOOD onto the central server (the shared platform from
# everytinroom-pos/deploy: one PostgreSQL, one database per business).
# Restaurant-specific on purpose; the platform knows nothing about MY FOOD.
#
#   sudo migration-package/deploy.sh \
#     --supabase-host supabase.chefelisha.cc \
#     --web-host www.chefelisha.cc --web-host chefelisha.cc \
#     [--restore /root/myfood-production-YYYY.dump --pin-pepper-file /root/pin-pepper] \
#     [--realtime] [--staging] [--plain-http]
#
# Prerequisite: the platform is bootstrapped (bootstrap.sh) and its deploy
# directory is at --platform (default /srv/central).
#
# What it does, each step safe to run again:
#   1 provision the Supabase-compatible services the app uses, measured from the
#     code (MANIFEST.yml): Auth (logins), Storage (photos, R2 underneath),
#     optionally Realtime; under --supabase-host, like a Supabase project URL
#   2 generate MY FOOD's own secrets ONCE (mode 600, never printed)
#   3 apply the committed migrations not yet applied (tracked like Supabase does)
#   4 the API login role and the scheduled job (pg_cron runs in `postgres`)
#   5 optional: restore a production backup (data only) and reconcile it
#   6 build the API and web images from this checkout, start them
#   7 route --web-host to them (Caddy, automatic HTTPS), check health
#
# It never changes DNS. Nothing reaches this server until a record points here.
# ===========================================================================
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ROOT_DIR=/srv/central
NAME=myfood
SUPA_HOST=""; WEB_HOSTS=(); RESTORE=""; PEPPER_FILE=""; REALTIME=0; STAGING=0; PLAIN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --supabase-host) SUPA_HOST="$2"; shift 2 ;;
    --web-host) WEB_HOSTS+=("$2"); shift 2 ;;
    --restore) RESTORE="$2"; shift 2 ;;
    --pin-pepper-file) PEPPER_FILE="$2"; shift 2 ;;
    --realtime) REALTIME=1; shift ;;
    --staging) STAGING=1; shift ;;
    --plain-http) PLAIN=1; shift ;;
    --platform) ROOT_DIR="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say () { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die () { printf '\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root"
[ -n "$SUPA_HOST" ] && [ "${#WEB_HOSTS[@]}" -gt 0 ] || die "--supabase-host and at least one --web-host are required"
[ -x "$ROOT_DIR/provision-app.sh" ] || die "the platform is not installed at $ROOT_DIR (run bootstrap.sh first)"
docker inspect -f '{{.State.Health.Status}}' central-postgres 2>/dev/null | grep -q healthy || die "central-postgres is not healthy"
if [ -n "$RESTORE" ]; then
  [ -f "$RESTORE" ] && [ -f "$RESTORE.sha256" ] || die "backup or its .sha256 missing: $RESTORE"
  [ -f "$PEPPER_FILE" ] || die "--restore needs --pin-pepper-file: staff PINs are digested with production's PIN_PEPPER"
fi
psqlc () { docker exec -i central-postgres psql -v ON_ERROR_STOP=1 -U postgres "$@"; }
psqlq () { docker exec -i central-postgres psql -tAqX -U postgres "$@"; }
get () { sed -n "s/^$2=//p" "$1" | tail -1; }
put () { # KEY VALUE into the mode-600 file, never echoed
  local f="$1" k="$2" v="$3"; [ -e "$f" ] || ( umask 177; : > "$f" ); chmod 600 "$f"
  grep -v "^$k=" "$f" > "$f.tmp" || true; printf '%s=%s\n' "$k" "$v" >> "$f.tmp"; mv "$f.tmp" "$f"; chmod 600 "$f"
}

# ── 1. platform services ───────────────────────────────────────────────────
say "1. Provisioning Auth and Storage$([ $REALTIME = 1 ] && echo ' and Realtime') for $NAME at $SUPA_HOST"
PROV=(--name "$NAME" --domain "$SUPA_HOST" --auth --storage)
[ "$REALTIME" = 1 ] && PROV+=(--realtime)
"$ROOT_DIR/provision-app.sh" "${PROV[@]}"
APP_ENV="$ROOT_DIR/apps/$NAME/.env"
APP_DB="$(get "$APP_ENV" APP_DB)"; APP_DNS="$(get "$APP_ENV" APP_DNS)"
[ -n "$APP_DB" ] || die "provisioning wrote no APP_DB"
# Photo storage backend (Cloudflare R2, or an S3 stand-in on a staging runner), from the environment
# when given: MYFOOD_R2_BUCKET / _ENDPOINT / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY. Otherwise whatever
# the app's .env already holds (provision-app.sh writes SET-ME placeholders).
if [ -n "${MYFOOD_R2_BUCKET:-}" ]; then
  for k in BUCKET ENDPOINT ACCESS_KEY_ID SECRET_ACCESS_KEY; do
    v="MYFOOD_R2_$k"; [ -n "${!v:-}" ] || die "$v is not set"; put "$APP_ENV" "R2_$k" "${!v}"
  done
  put "$APP_ENV" R2_REGION "${MYFOOD_R2_REGION:-auto}"
  ( cd "$ROOT_DIR/apps/$NAME" && ./compose.sh up -d >/dev/null )
  echo "  storage backend set from MYFOOD_R2_* and Storage restarted"
fi
grep -q '^R2_BUCKET=SET-ME' "$APP_ENV" && echo "  WARNING: R2 is not configured: photo uploads will fail until R2_* are set in $APP_ENV"
for svc in auth storage; do
  for _ in $(seq 1 40); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$APP_DNS-$svc" 2>/dev/null)" = healthy ] && break; sleep 3
  done
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$APP_DNS-$svc" 2>/dev/null)" = healthy ] || die "$APP_DNS-$svc did not become healthy"
  echo "  $APP_DNS-$svc healthy"
done

# ── 2. MY FOOD's own secrets ───────────────────────────────────────────────
say "2. Secrets (generated once, mode 600, never printed)"
ENVF="$ROOT_DIR/apps/$NAME/myfood.env"
[ -n "$(get "$ENVF" RP_API_PASSWORD 2>/dev/null)" ] || put "$ENVF" RP_API_PASSWORD "$(openssl rand -hex 24)"
[ -n "$(get "$ENVF" MONITOR_TOKEN 2>/dev/null)" ] || put "$ENVF" MONITOR_TOKEN "$(openssl rand -hex 24)"
if [ -n "$PEPPER_FILE" ]; then
  put "$ENVF" PIN_PEPPER "$(tr -d '\r\n' < "$PEPPER_FILE")"
elif [ -z "$(get "$ENVF" PIN_PEPPER 2>/dev/null)" ]; then
  put "$ENVF" PIN_PEPPER "$(openssl rand -hex 32)"
fi
SCHEME=https; [ "$PLAIN" = 1 ] && SCHEME=http
RELEASE="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M)"
put "$ENVF" MYFOOD_SUPABASE_URL "$SCHEME://$SUPA_HOST"
put "$ENVF" MYFOOD_APP_URL "$SCHEME://${WEB_HOSTS[0]}"
put "$ENVF" MYFOOD_RELEASE "$RELEASE"
put "$ENVF" MYFOOD_APP_ENV "$([ $STAGING = 1 ] && echo staging || echo production)"
echo "  $ENVF ready (keys: $(cut -d= -f1 "$ENVF" | tr '\n' ' '))"

# ── 3. migrations ──────────────────────────────────────────────────────────
say "3. Database migrations (committed history only)"
# On the platform the Auth service owns auth.users and `postgres` is not a superuser (supabase_admin
# is). MY FOOD's tables reference logins (staff.user_id, devices.auth_user_id), as on Supabase, where
# postgres holds these rights by default.
sa () { docker exec -i central-postgres psql -v ON_ERROR_STOP=1 -q -U supabase_admin "$@"; }
sa -d "$APP_DB" -c "grant usage on schema auth, storage to postgres; grant references, select on auth.users to postgres;"
# Same extension layout as Supabase (and production): extensions live in `extensions`, not `public`.
# The migrations lock `public` down function by function and cannot touch an extension's functions.
sa -d "$APP_DB" <<'SQL'
create schema if not exists extensions;
do $$ declare e text; begin
  for e in select x.extname from pg_extension x join pg_namespace n on n.oid = x.extnamespace
            where n.nspname = 'public' and x.extname <> 'plpgsql' and x.extrelocatable loop
    execute format('alter extension %I set schema extensions', e);
    raise notice 'moved extension % to schema extensions', e;
  end loop; end $$;
SQL
psqlc -d "$APP_DB" -q <<'SQL'
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
SQL
applied=0; skipped=0
for m in "$REPO"/supabase/migrations/*.sql; do
  v="$(basename "$m" | cut -d_ -f1)"
  if [ "$(psqlq -d "$APP_DB" -c "select 1 from supabase_migrations.schema_migrations where version='$v'")" = 1 ]; then
    skipped=$((skipped + 1)); continue
  fi
  { echo "begin;"; cat "$m"; echo; echo "insert into supabase_migrations.schema_migrations (version, name) values ('$v', '$(basename "$m" .sql | cut -d_ -f2-)');"; echo "commit;"; } \
    | psqlc -d "$APP_DB" -q > /tmp/myfood-migration.log 2>&1 || { tail -20 /tmp/myfood-migration.log; die "migration $(basename "$m")"; }
  applied=$((applied + 1))
done
echo "  applied $applied, already present $skipped"

# ── 4. API login and scheduled job ─────────────────────────────────────────
say "4. API login role and scheduled job"
psqlc -d "$APP_DB" -q -v pw="$(get "$ENVF" RP_API_PASSWORD)" <<SQL
alter role rp_api login password :'pw';
grant connect on database "$APP_DB" to rp_api;
SQL
psqlc -d postgres -q <<SQL
select cron.unschedule(jobid) from cron.job where jobname = 'myfood-sweep-offline-devices';
select cron.schedule_in_database('myfood-sweep-offline-devices', '* * * * *', 'select app.sweep_offline_devices()', '$APP_DB');
SQL
echo "  rp_api can log in to $APP_DB only; cron job registered"

# ── 5. production data ─────────────────────────────────────────────────────
if [ -n "$RESTORE" ]; then
  say "5. Restoring production data from $(basename "$RESTORE")"
  [ "$(sha256sum "$RESTORE" | awk '{print $1}')" = "$(cat "$RESTORE.sha256")" ] || die "backup checksum mismatch"
  # The reconciliation runs in a Node container; install the repository's modules once.
  [ -d "$REPO/node_modules/postgres" ] || docker run --rm -v "$REPO:/src" -w /src node:24-slim \
    sh -c "corepack enable >/dev/null && pnpm install --frozen-lockfile >/dev/null"
  "$HERE/scripts/restore-to-server.sh" "$RESTORE" "$APP_DB"
else
  say "5. No --restore: empty database (create the restaurant with scripts/platform/create-restaurant.ts)"
fi

# ── 6. images and containers ───────────────────────────────────────────────
say "6. Building MY FOOD $RELEASE and starting it"
ANON="$(get "$APP_ENV" ANON_KEY)"
docker build -q -f "$REPO/migration-package/docker/api.Dockerfile" -t "myfood-api:$RELEASE" "$REPO" >/dev/null
WS_ORIGIN="$([ $PLAIN = 1 ] && echo ws || echo wss)://$SUPA_HOST"
docker build -q -f "$REPO/migration-package/docker/web.Dockerfile" -t "myfood-web:$RELEASE" \
  --build-arg SUPABASE_URL="$SCHEME://$SUPA_HOST" --build-arg SUPABASE_ANON_KEY="$ANON" \
  --build-arg SUPABASE_WS_ORIGIN="$WS_ORIGIN" "$REPO" >/dev/null
docker compose -p myfood_app --env-file "$APP_ENV" --env-file "$ENVF" \
  -f "$REPO/migration-package/compose/myfood.compose.yml" up -d --remove-orphans

# ── 7. routing and health ──────────────────────────────────────────────────
say "7. Routing ${WEB_HOSTS[*]} and health"
SITE="$ROOT_DIR/compose/caddy-sites/myfood-web.caddy"
hosts="$(printf '%s, ' "${WEB_HOSTS[@]}" | sed 's/, $//')"
[ "$PLAIN" = 1 ] && hosts="$(printf 'http://%s, ' "${WEB_HOSTS[@]}" | sed 's/, $//')"
sed "s|__WEB_HOSTS__|$hosts|" "$REPO/migration-package/compose/myfood-web.caddy.tmpl" > "$SITE"
docker exec central-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || docker restart central-caddy >/dev/null
for _ in $(seq 1 40); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' myfood-api 2>/dev/null)" = healthy ] && break; sleep 3
done
[ "$(docker inspect -f '{{.State.Health.Status}}' myfood-api 2>/dev/null)" = healthy ] || { docker logs myfood-api --tail=30; die "myfood-api not healthy"; }
ready="$(curl -s --max-time 15 --resolve "${WEB_HOSTS[0]}:80:127.0.0.1" "http://${WEB_HOSTS[0]}/health/ready" || true)"
[ "$PLAIN" = 1 ] || ready="$(curl -sk --max-time 15 --resolve "${WEB_HOSTS[0]}:443:127.0.0.1" "https://${WEB_HOSTS[0]}/health/ready" || true)"
echo "  $ready"
echo "$ready" | grep -q '"status":"ready"' || die "MY FOOD is not ready"
say "MY FOOD $RELEASE is running. DNS was not changed."
