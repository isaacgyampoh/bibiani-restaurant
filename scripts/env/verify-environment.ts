/**
 * Verifies a deployed environment's database (read-only checks + least-privilege probes).
 *   ADMIN_DATABASE_URL=<postgres login> DATABASE_URL=<rp_api login> tsx scripts/env/verify-environment.ts
 * Prints a JSON report and exits non-zero if any check fails.
 */
import { readdirSync } from 'node:fs';
import postgres from 'postgres';

const admin = postgres(process.env.ADMIN_DATABASE_URL!, { prepare: false, max: 1, onnotice: () => {} });
const api = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1, onnotice: () => {} });
const expectedMigrations = readdirSync('supabase/migrations')
  .filter((f) => f.endsWith('.sql'))
  .map((f) => f.slice(0, 14))
  .sort();
const checks: { check: string; ok: boolean; detail: unknown }[] = [];
const check = (name: string, ok: boolean, detail: unknown) => checks.push({ check: name, ok, detail });

const applied = (await admin`select version from supabase_migrations.schema_migrations order by version`).map(
  (r) => r.version as string,
);
check('migrations applied match repository', JSON.stringify(applied) === JSON.stringify(expectedMigrations), {
  applied: applied.length,
  expected: expectedMigrations.length,
});
const tables = await admin`select tablename, rowsecurity from pg_tables where schemaname = 'public'`;
// Raise with each migration that adds tables (51 after 20260926000600_device_pairing_requests).
const EXPECTED_TABLES = 51;
check('public tables', tables.length === EXPECTED_TABLES, tables.length);
check(
  'RLS on every table',
  tables.every((t) => t.rowsecurity),
  tables.filter((t) => !t.rowsecurity).map((t) => t.tablename),
);
const [c] = await admin`select
  count(*) filter (where contype = 'f')::int as fks, count(*) filter (where contype = 'c')::int as checks,
  count(*) filter (where contype = 'u')::int as uniques, count(*) filter (where contype = 'p')::int as pks
  from pg_constraint k join pg_namespace n on n.oid = k.connamespace where n.nspname = 'public'`;
check('constraints present', c!.fks > 80 && c!.checks > 40 && c!.uniques > 30 && c!.pks === tables.length, c);
const [idx] = await admin`select count(*)::int as n from pg_indexes where schemaname = 'public'`;
check('indexes present', idx!.n > 80, idx!.n);
const grants =
  await admin`select count(*)::int as n from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated')`;
check('browser roles have no table privileges', grants[0]!.n === 0, grants[0]!.n);
const policy =
  await admin`select count(*)::int as n from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'branch_topic_read'`;
check('private realtime policy installed', policy[0]!.n === 1, policy[0]!.n);
const cron =
  await admin`select count(*)::int as n from cron.job where jobname = 'rp-sweep-offline-devices' and active`.catch(
    () => [{ n: -1 }],
  );
check('offline sweep scheduled (pg_cron)', cron[0]!.n === 1, cron[0]!.n);
const parts =
  await admin`select count(*)::int as n from pg_inherits i join pg_class p on p.oid = i.inhparent join pg_namespace ns on ns.oid = p.relnamespace
  where ns.nspname = 'realtime' and p.relname = 'messages'`;
check('realtime.messages partitions exist (new-project broadcast issue)', parts[0]!.n > 0, parts[0]!.n);

// Least privilege of the API login
const denied = async (q: () => Promise<unknown>) =>
  q().then(
    () => 'ALLOWED',
    (e) => e.code as string,
  );
check(
  'rp_api: direct table read denied',
  (await denied(() => api`select 1 from public.orders limit 1`)) === '42501',
  await denied(() => api`select 1 from public.orders limit 1`),
);
check(
  'rp_api: cannot run offline sweep',
  (await denied(() => api`select app.sweep_offline_devices()`)) === '42501',
  'sweep',
);
const viaRole = await api.begin(async (tx) => {
  await tx`select set_config('role', 'app_api', true)`;
  return (await tx`select count(*)::int as n from orders`)[0]!.n;
});
check('rp_api via app_api without tenant sees nothing', viaRole === 0, viaRole);
const appendOnly = await api
  .begin(async (tx) => {
    await tx`select set_config('role', 'app_api', true), set_config('app.restaurant_id', gen_random_uuid()::text, true)`;
    await tx`delete from audit_logs`;
    return 'ALLOWED';
  })
  .catch((e) => e.code as string);
check('audit_logs append-only for API role', appendOnly === '42501', appendOnly);
const [who] =
  await api`select current_user as u, (select rolbypassrls from pg_roles where rolname = current_user) as bypass`;
check('rp_api is not BYPASSRLS', who!.u === 'rp_api' && who!.bypass === false, who);

await admin.end();
await api.end();
console.log(JSON.stringify({ ok: checks.every((x) => x.ok), checks }, null, 1));
process.exit(checks.every((x) => x.ok) ? 0 : 1);
