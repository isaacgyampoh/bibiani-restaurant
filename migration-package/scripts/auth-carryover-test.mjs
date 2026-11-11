#!/usr/bin/env node
/**
 * Logins survive the move to the self-hosted Auth (staging runner only; synthetic users).
 *
 *   node --env-file=.env.vps auth-carryover-test.mjs            rows test (a)
 *   node --env-file=.env.vps auth-carryover-test.mjs --before   start a session, keep its refresh token
 *   node --env-file=.env.vps auth-carryover-test.mjs --after    after backup+restore: refresh it   (b)
 *
 * (a) A login arrives on the server as a database ROW, not through sign-up: an auth.users row with
 *     a bcrypt `$2a$10$` hash (the format of all 22 production logins) and its identity. It must sign
 *     in through the self-hosted Auth; a wrong password must be refused (control).
 * (b) Paired tills and kitchen screens hold refresh tokens. A session started before the backup
 *     must refresh after the restore; a made-up token must be refused (control).
 * Exits non-zero on any failure.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';

const { SUPABASE_URL, SUPABASE_ANON_KEY, PLATFORM_DATABASE_URL } = process.env;
const mode = process.argv[2] ?? '--rows';
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
const token = (grant, body) =>
  fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const STATE = '/tmp/auth-carryover-state.json';

if (mode === '--rows') {
  const sql = postgres(PLATFORM_DATABASE_URL, { max: 1, onnotice: () => {} });
  const id = randomUUID();
  const email = `carryover-${id.slice(0, 8)}@staging.test`;
  const password = `Pw-${randomUUID()}`;
  const [{ hash }] = await sql`select extensions.crypt(${password}, extensions.gen_salt('bf', 10)) as hash`;
  check(/^\$2a\$10\$.{53}$/.test(hash), 'the hash has the production format ($2a$10$, 60 characters)');
  await sql`insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
              raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
            values ('00000000-0000-0000-0000-000000000000', ${id}, 'authenticated', 'authenticated', ${email}, ${hash},
              now(), '{"provider":"email","providers":["email"]}', '{}', now(), now())`;
  await sql`insert into auth.identities (id, provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
            values (${randomUUID()}, ${id}, ${id}, ${sql.json({ sub: id, email })}, 'email', now(), now(), now())`;
  await sql.end();
  const ok = await token('password', { email, password });
  const body = await ok.json();
  check(
    ok.status === 200 && typeof body.access_token === 'string',
    `a login inserted as a row signs in (HTTP ${ok.status})`,
  );
  const bad = await token('password', { email, password: `${password}x` });
  check(bad.status === 400, `control: a wrong password is refused (HTTP ${bad.status})`);
} else if (mode === '--before') {
  const { accounts } = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? '.vps-accounts.json', 'utf8'));
  const res = await token('password', { email: accounts.manager.email, password: accounts.manager.password });
  const body = await res.json();
  check(res.status === 200 && body.refresh_token, `manager signs in before the backup (HTTP ${res.status})`);
  writeFileSync(STATE, JSON.stringify({ refresh: body.refresh_token }), { mode: 0o600 });
} else if (mode === '--after') {
  const { refresh } = JSON.parse(readFileSync(STATE, 'utf8'));
  const res = await token('refresh_token', { refresh_token: refresh });
  check(
    res.status === 200,
    `the session from before the backup refreshes after the restore (HTTP ${res.status})`,
  );
  const bad = await token('refresh_token', { refresh_token: 'made-up-token-xyz' });
  check(bad.status >= 400, `control: a made-up refresh token is refused (HTTP ${bad.status})`);
}
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
