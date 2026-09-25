#!/usr/bin/env bash
# DEV ONLY. Creates/rotates the database logins used by the API and by the
# hosted test suite, fetches the project's server-side auth key, and writes
# them to the gitignored .env. Never prints a secret.
#
# Requires: supabase CLI logged in, project linked (supabase link --project-ref <DEV ref>).
set -euo pipefail
cd "$(dirname "$0")/../.."

REF=$(cat supabase/.temp/project-ref)
if [[ "${REF}" != "${EXPECTED_DEV_REF:-nkijnjovztglmwxoemqg}" ]]; then
  echo "Linked project ${REF} is not the DEV project. Refusing." >&2; exit 1
fi
POOLER_HOST=$(sed -E 's#.*@([^:/]+):.*#\1#' supabase/.temp/pooler-url)
API_PW=$(openssl rand -hex 24)
ADMIN_PW=$(openssl rand -hex 24)

SQL_FILE=$(mktemp)
trap 'rm -f "$SQL_FILE"' EXIT
cat > "$SQL_FILE" <<SQL
alter role rp_api password '${API_PW}';
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'rp_dev_admin') then
    create role rp_dev_admin login bypassrls noinherit;
  end if;
end \$\$;
alter role rp_dev_admin password '${ADMIN_PW}';
grant app_api to rp_dev_admin;
grant usage on schema public, app, auth to rp_dev_admin;
grant all on all tables in schema public to rp_dev_admin;
grant all on all sequences in schema public to rp_dev_admin;
grant execute on all functions in schema app to rp_dev_admin;
alter default privileges in schema public grant all on tables to rp_dev_admin;
alter default privileges in schema public grant all on sequences to rp_dev_admin;
grant select, insert, delete on auth.users to rp_dev_admin;
SQL
supabase db query --linked -f "$SQL_FILE" > /dev/null 2>&1 || { echo "Failed to configure logins" >&2; exit 1; }

KEY=$(supabase projects api-keys --project-ref "$REF" --reveal -o json 2>/dev/null | python3 -c '
import sys, json
raw = sys.stdin.read(); keys = json.loads(raw[raw.index("["):])
secret = [k for k in keys if k.get("type") == "secret"]
legacy = [k for k in keys if k.get("name") == "service_role"]
pick = (secret or legacy)
assert not pick or "\u00b7" not in pick[0]["api_key"], "masked key"
print(pick[0]["api_key"] if pick else "")')
[[ -n "$KEY" ]] || { echo "Could not read the server-side API key" >&2; exit 1; }

python3 - "$REF" "$POOLER_HOST" "$API_PW" "$ADMIN_PW" "$KEY" <<'PY'
import sys, re, pathlib
ref, host, api_pw, admin_pw, key = sys.argv[1:]
env = pathlib.Path('.env'); text = env.read_text() if env.exists() else ''
values = {
  'DATABASE_URL': f'postgresql://rp_api.{ref}:{api_pw}@{host}:6543/postgres',
  'TEST_DATABASE_URL': f'postgresql://rp_dev_admin.{ref}:{admin_pw}@{host}:6543/postgres',
  'SUPABASE_SECRET_KEY': key,
}
for k, v in values.items():
  line = f'{k}={v}'
  text = re.sub(rf'^#?\s*{k}=.*$', line, text, flags=re.M) if re.search(rf'^#?\s*{k}=', text, flags=re.M) else text.rstrip('\n') + '\n' + line + '\n'
env.write_text(text)
print('Wrote to .env:', ', '.join(values))
PY
