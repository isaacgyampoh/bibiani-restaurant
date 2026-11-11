-- What a MY FOOD database expects from its PostgreSQL before the schema or a backup is loaded, on a
-- server that is not a Supabase project (a disposable test cluster here; on the VPS the
-- supabase/postgres image already provides all of it and every statement is a no-op).
-- Roles named by policies, grants and functions. NOLOGIN: nothing signs in as these here.
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','authenticator','supabase_auth_admin','supabase_storage_admin',
                           'supabase_admin','dashboard_user','supabase_realtime_admin','pgbouncer','app_api'] loop
    if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
  end loop;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  -- The API's own login role (migration 20260925001000). Its password is set per environment.
  if not exists (select 1 from pg_roles where rolname = 'rp_api') then create role rp_api nologin; end if;
end $$;
create schema if not exists extensions;
-- A schema-filtered restore (pg_restore -n) does not create the schemas themselves.
create schema if not exists app;
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists supabase_migrations;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
