-- Health probes for the API's readiness check. Read-only, narrow, callable by rp_api.

-- Latest applied migration, so a deployed API can refuse to report "ready" against an older schema.
create function app.schema_version() returns text
language plpgsql stable security definer set search_path = ''
as $$
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    return null; -- plain Postgres (tests): no migration ledger
  end if;
  return (select max(version) from supabase_migrations.schema_migrations);
end $$;

-- Realtime broadcasts are dropped until Supabase has created the daily partition of
-- realtime.messages that covers "now" (observed on new projects). Report it.
create function app.realtime_storage_ready() returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare v_name text := 'messages_' || to_char(now() at time zone 'utc', 'YYYY_MM_DD');
begin
  if to_regclass('realtime.messages') is null then
    return null; -- Realtime not installed (tests)
  end if;
  return exists (
    select 1 from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    join pg_namespace n on n.oid = p.relnamespace
    where n.nspname = 'realtime' and p.relname = 'messages' and c.relname = v_name
  );
end $$;

revoke all on function app.schema_version() from public;
revoke all on function app.realtime_storage_ready() from public;
grant execute on function app.schema_version() to rp_api;
grant execute on function app.realtime_storage_ready() to rp_api;
