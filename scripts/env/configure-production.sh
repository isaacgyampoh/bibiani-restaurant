#!/usr/bin/env bash
# PRODUCTION: sets the API login password (rp_api) and fetches production's API keys into the
# gitignored .env.production. Deliberately creates NO test/admin login. Never prints secrets.
set -euo pipefail
cd "$(dirname "$0")/../.."
REF="${PROD_PROJECT_REF:-lgoirbfyspuflqekrcgp}"
eval "$(grep -E '^PROD_(DB_PASSWORD|POOLER_HOST)=' .env.production)"
[[ -n "${PROD_DB_PASSWORD:-}" && -n "${PROD_POOLER_HOST:-}" ]] || { echo "Missing PROD_DB_PASSWORD/PROD_POOLER_HOST in .env.production" >&2; exit 1; }
ADMIN_URL="postgresql://postgres.${REF}:${PROD_DB_PASSWORD}@${PROD_POOLER_HOST}:5432/postgres"
API_PW=$(openssl rand -hex 24)
supabase db query --db-url "$ADMIN_URL" "alter role rp_api password '${API_PW}'" > /dev/null 2>&1 || { echo "Failed to set rp_api password" >&2; exit 1; }
KEYS=$(supabase projects api-keys --project-ref "$REF" --reveal -o json 2>/dev/null)
python3 - "$REF" "$PROD_POOLER_HOST" "$API_PW" "$KEYS" <<'PY'
import sys, re, json, pathlib
ref, host, api_pw, raw = sys.argv[1:]
keys = json.loads(raw[raw.index('['):])
def pick(pred):
    for k in keys:
        if pred(k): return k['api_key']
    return ''
anon = pick(lambda k: k.get('name') == 'anon') or pick(lambda k: k.get('type') == 'publishable')
secret = pick(lambda k: k.get('type') == 'secret')
assert anon and secret and '·' not in secret, 'could not read production keys'
env = pathlib.Path('.env.production'); text = env.read_text()
values = {
  'APP_ENV': 'production',
  'SUPABASE_URL': f'https://{ref}.supabase.co',
  'SUPABASE_ANON_KEY': anon,
  'SUPABASE_SECRET_KEY': secret,
  'DATABASE_URL': f'postgresql://rp_api.{ref}:{api_pw}@{host}:6543/postgres',
  'VITE_SUPABASE_URL': f'https://{ref}.supabase.co',
  'VITE_SUPABASE_ANON_KEY': anon,
}
for k, v in values.items():
    line = f'{k}={v}'
    text = re.sub(rf'^{k}=.*$', line, text, flags=re.M) if re.search(rf'^{k}=', text, flags=re.M) else text.rstrip('\n') + '\n' + line + '\n'
env.write_text(text)
print('Wrote to .env.production:', ', '.join(values))
PY
