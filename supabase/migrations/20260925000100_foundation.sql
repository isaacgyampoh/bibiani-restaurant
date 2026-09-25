-- Foundation: private schema, API role, tenant context helpers, shared enums.
--
-- Security model (see docs/adr/0001-application-layer-and-transactions.md):
--   * Browser clients (anon / authenticated) get NO table privileges in public.
--   * The API connects as the database owner and, for every tenant request,
--     runs `SET LOCAL ROLE app_api` plus a transaction-local restaurant id.
--     app_api is subject to RLS, so tenant isolation is enforced by Postgres
--     even if application code has a bug.

create schema if not exists app;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_api') then
    create role app_api nologin noinherit nobypassrls;
  end if;
end $$;

grant app_api to postgres;  -- the API connects as a member of postgres and switches to app_api per transaction
grant usage on schema public to app_api;
grant usage on schema app to app_api;

-- Tenant context. Set per transaction by the API (set_config(..., true)).
-- Fails closed: when unset, returns null and every tenant policy matches nothing.
create function app.current_restaurant_id() returns uuid
language sql stable
set search_path = ''
as $$
  select nullif(current_setting('app.restaurant_id', true), '')::uuid
$$;

-- Enables RLS on a tenant table and installs the standard isolation policy for app_api.
create function app.enable_tenant_rls(p_table regclass, p_append_only boolean default false) returns void
language plpgsql
set search_path = ''
as $$
begin
  execute format('alter table %s enable row level security', p_table);
  execute format(
    'create policy tenant_isolation on %s for all to app_api '
    'using (restaurant_id = app.current_restaurant_id()) '
    'with check (restaurant_id = app.current_restaurant_id())',
    p_table
  );
  if p_append_only then
    execute format('grant select, insert on %s to app_api', p_table);
  else
    execute format('grant select, insert, update, delete on %s to app_api', p_table);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Enums. Values must match packages/domain (checked by an automated test).
-- ---------------------------------------------------------------------------
create type order_channel as enum ('dine_in', 'takeaway');

create type order_status as enum (
  'draft', 'submitted', 'in_preparation', 'partially_ready', 'ready',
  'served', 'picked_up', 'completed', 'cancelled', 'voided'
);

create type payment_status as enum ('unpaid', 'partially_paid', 'paid', 'partially_refunded', 'refunded');

create type order_item_status as enum (
  'pending', 'sent', 'accepted', 'in_preparation', 'ready', 'served', 'cancelled', 'voided'
);

create type ticket_status as enum ('new', 'accepted', 'in_preparation', 'on_hold', 'ready', 'completed', 'cancelled');

create type print_job_kind as enum ('kitchen_ticket', 'receipt', 'void_slip', 'test');
create type print_job_status as enum ('pending', 'claimed', 'printed', 'failed', 'dead', 'cancelled');
create type printer_connection as enum ('network_escpos', 'usb_escpos');

create type payment_method as enum ('cash', 'momo', 'card');
create type payment_direction as enum ('charge', 'refund');
create type payment_record_status as enum ('recorded', 'voided');

create type device_kind as enum ('pos', 'kds', 'printer', 'print_agent', 'customer_display');
create type device_status as enum ('unknown', 'online', 'offline');

create type station_output_role as enum ('primary', 'copy', 'backup');
create type routing_match as enum ('product', 'category', 'default');

create type table_status as enum ('available', 'occupied', 'reserved', 'cleaning', 'payment_pending', 'out_of_service');
