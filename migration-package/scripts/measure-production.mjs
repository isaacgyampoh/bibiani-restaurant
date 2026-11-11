// Read-only inventory of the production database (default_transaction_read_only). Prints counts only, never values.
import postgres from 'postgres';

const e = process.env;
const sql = postgres(
  `postgresql://postgres.lgoirbfyspuflqekrcgp:${encodeURIComponent(e.PROD_DB_PASSWORD)}@${e.PROD_POOLER_HOST}:5432/postgres`,
  { max: 1, prepare: false, connection: { default_transaction_read_only: true } },
);
const out = {};
out.identity = (
  await sql`select current_database() db, version() v, inet_server_addr()::text addr, now() at time zone 'utc' as at`
)[0];
out.schemas =
  await sql`select n.nspname, count(c.*)::int tables from pg_namespace n left join pg_class c on c.relnamespace=n.oid and c.relkind in ('r','p') where n.nspname not like 'pg_%' and n.nspname <> 'information_schema' group by 1 order by 1`;
out.extensions = (await sql`select extname, extversion from pg_extension order by 1`).map(
  (r) => `${r.extname}@${r.extversion}`,
);
const tables =
  await sql`select table_schema s, table_name t from information_schema.tables where table_type='BASE TABLE' and table_schema in ('public','auth','storage','realtime','app','private','supabase_migrations') order by 1,2`;
out.rows = {};
for (const { s, t } of tables)
  out.rows[`${s}.${t}`] = Number((await sql.unsafe(`select count(*) n from "${s}"."${t}"`))[0].n);
out.functions =
  await sql`select n.nspname s, count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app','private') group by 1`;
out.policies = Number((await sql`select count(*) n from pg_policies where schemaname='public'`)[0].n);
out.triggers = Number(
  (
    await sql`select count(*) n from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname='public'`
  )[0].n,
);
out.rls_off = (
  await sql`select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity`
).map((r) => r.relname);
out.cron = await sql`select to_regclass('cron.job') is not null as present`;
if (out.cron[0].present) out.cronJobs = await sql`select jobname, schedule from cron.job`;
out.buckets =
  await sql`select b.id, b.public, count(o.*)::int objects, coalesce(sum((o.metadata->>'size')::bigint),0)::bigint bytes from storage.buckets b left join storage.objects o on o.bucket_id=b.id group by 1,2`;
out.authProviders = await sql`select provider, count(*)::int n from auth.identities group by 1`;
out.authUsers = (
  await sql`select count(*)::int n, count(*) filter (where encrypted_password is not null and encrypted_password<>'')::int with_password, count(*) filter (where email like '%devices.example.com')::int devices from auth.users`
)[0];
out.migrations = (
  await sql`select max(version) latest, count(*)::int n from supabase_migrations.schema_migrations`
)[0];
out.roles = (
  await sql`select rolname from pg_roles where rolname in ('rp_api','authenticated','anon','service_role','authenticator')`
).map((r) => r.rolname);
out.dbSize = (await sql`select pg_size_pretty(pg_database_size(current_database())) s`)[0].s;
console.log(JSON.stringify(out, null, 1));
await sql.end();
