#!/usr/bin/env bash
# STAGING: creates/rotates the API login (rp_api) and the staging test login (rp_test_admin),
# fetches staging's own API keys, and writes everything to the gitignored .env.staging.
# Uses the staging postgres password from .env.staging (STAGING_DB_PASSWORD). Never prints secrets.
set -euo pipefail
cd "$(dirname "$0")/../.."
REF="${STAGING_PROJECT_REF:-impairlsvhkumjzhjhti}"
eval "$(grep -E '^STAGING_(DB_PASSWORD|POOLER_HOST)=' .env.staging)"
[[ -n "${STAGING_DB_PASSWORD:-}" && -n "${STAGING_POOLER_HOST:-}" ]] || { echo "Missing STAGING_DB_PASSWORD/STAGING_POOLER_HOST in .env.staging" >&2; exit 1; }
ADMIN_URL="postgresql://postgres.${REF}:${STAGING_DB_PASSWORD}@${STAGING_POOLER_HOST}:5432/postgres"
API_PW=$(openssl rand -hex 24); TEST_PW=$(openssl rand -hex 24)

# One statement per call: --db-url uses the extended protocol, which rejects multi-statement batches.
run_sql() { supabase db query --db-url "$ADMIN_URL" "$1" > /dev/null 2>&1 || { echo "Failed: ${1:0:60}" >&2; exit 1; }; }
run_sql "alter role rp_api password '${API_PW}'"
run_sql "do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'rp_test_admin') then create role rp_test_admin login bypassrls noinherit; end if; end \$\$"
run_sql "alter role rp_test_admin password '${TEST_PW}'"
run_sql "grant app_api to rp_test_admin"
run_sql "grant usage on schema public, app to rp_test_admin"
run_sql "grant all on all tables in schema public to rp_test_admin"
run_sql "grant all on all sequences in schema public to rp_test_admin"
run_sql "grant execute on all functions in schema app to rp_test_admin"
run_sql "alter default privileges in schema public grant all on tables to rp_test_admin"
run_sql "alter default privileges in schema public grant all on sequences to rp_test_admin"

KEYS=$(supabase projects api-keys --project-ref "$REF" --reveal -o json 2>/dev/null)
python3 - "$REF" "$STAGING_POOLER_HOST" "$API_PW" "$TEST_PW" "$KEYS" <<'PY'
import sys, re, json, pathlib
ref, host, api_pw, test_pw, raw = sys.argv[1:]
keys = json.loads(raw[raw.index('['):])
def pick(pred):
    for k in keys:
        if pred(k): return k['api_key']
    return ''
anon = pick(lambda k: k.get('name') == 'anon') or pick(lambda k: k.get('type') == 'publishable')
secret = pick(lambda k: k.get('type') == 'secret')
assert anon and secret and '·' not in secret, 'could not read staging keys'
env = pathlib.Path('.env.staging'); text = env.read_text()
values = {
  'APP_ENV': 'staging',
  'SUPABASE_URL': f'https://{ref}.supabase.co',
  'SUPABASE_ANON_KEY': anon,
  'SUPABASE_SECRET_KEY': secret,
  'DATABASE_URL': f'postgresql://rp_api.{ref}:{api_pw}@{host}:6543/postgres',
  'TEST_DATABASE_URL': f'postgresql://rp_test_admin.{ref}:{test_pw}@{host}:6543/postgres',
  'TEST_ALLOWED_PROJECT_REF': ref,
  'VITE_SUPABASE_URL': f'https://{ref}.supabase.co',
  'VITE_SUPABASE_ANON_KEY': anon,
}
for k, v in values.items():
    line = f'{k}={v}'
    if re.search(rf'^{k}=', text, flags=re.M): text = re.sub(rf'^{k}=.*$', line, text, flags=re.M)
    else: text = text.rstrip('\n') + '\n' + line + '\n'
env.write_text(text)
print('Wrote to .env.staging:', ', '.join(values))
PY
