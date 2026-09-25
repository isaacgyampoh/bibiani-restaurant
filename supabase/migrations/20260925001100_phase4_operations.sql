-- Phase 4: payment policy, device pairing, receipts, cancel/void, device status signals.

-- Payment policy is configuration per operational area (ADR 0002).
create type payment_policy as enum ('pay_before_fulfillment', 'pay_after_fulfillment');
alter table operational_areas add column payment_policy payment_policy not null default 'pay_after_fulfillment';

insert into permissions (code, description) values ('receipt.print', 'Print and reprint customer receipts');

alter table staff add column email text;
create unique index staff_restaurant_email_idx on staff (restaurant_id, lower(email)) where email is not null;

alter table branches add column address text;
alter table restaurants add column receipt_footer text;

-- Which printer a POS uses for customer receipts.
alter table devices add column receipt_printer_id uuid;
alter table devices add constraint devices_receipt_printer_fk
  foreign key (restaurant_id, receipt_printer_id) references printers (restaurant_id, device_id);

-- Cancellation and void bookkeeping.
alter table orders add column cancelled_by_staff_id uuid;
alter table orders add constraint orders_cancelled_by_fk
  foreign key (restaurant_id, cancelled_by_staff_id) references staff (restaurant_id, id);
alter table order_items add column voided_at timestamptz;
alter table order_items add column voided_by_staff_id uuid;
alter table order_items add constraint order_items_voided_by_fk
  foreign key (restaurant_id, voided_by_staff_id) references staff (restaurant_id, id);
alter table production_tickets add column cancel_reason text;

-- ---------------------------------------------------------------------------
-- Device pairing: a short-lived one-time code, stored only as a hash.
-- ---------------------------------------------------------------------------
create table device_pairing_codes (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null,
  device_id       uuid not null,
  code_hash       text not null unique,
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  created_by_staff_id uuid,
  created_at      timestamptz not null default now(),
  foreign key (restaurant_id, device_id) references devices (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, created_by_staff_id) references staff (restaurant_id, id)
);
select app.enable_tenant_rls('device_pairing_codes');
create index device_pairing_codes_device_idx on device_pairing_codes (device_id);

-- The device has no identity yet when it redeems a code, so redemption is the
-- one pairing step that must look across tenants. It consumes the code
-- atomically and returns only the device's own identity.
create function app.redeem_pairing_code(p_code_hash text, p_now timestamptz)
returns table (device_id uuid, restaurant_id uuid, branch_id uuid, kind public.device_kind, name text,
               station_id uuid, previous_auth_user_id uuid)
language plpgsql security definer set search_path = ''
as $$
declare
  v_code public.device_pairing_codes%rowtype;
begin
  select * into v_code from public.device_pairing_codes c
  where c.code_hash = p_code_hash for update;
  if not found or v_code.consumed_at is not null or v_code.expires_at < p_now then
    return;
  end if;
  update public.device_pairing_codes set consumed_at = p_now where id = v_code.id;
  -- Any other outstanding codes for this device die with this redemption.
  update public.device_pairing_codes set consumed_at = p_now
  where public.device_pairing_codes.device_id = v_code.device_id and consumed_at is null;
  return query
    select d.id, d.restaurant_id, d.branch_id, d.kind, d.name, d.station_id, d.auth_user_id
    from public.devices d where d.id = v_code.device_id and d.is_active;
end $$;

-- Binding the new auth identity to the device (also cross-tenant by nature of pairing).
create function app.bind_device_identity(p_device_id uuid, p_auth_user_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  update public.devices set auth_user_id = p_auth_user_id, status = 'unknown' where id = p_device_id
$$;

revoke all on function app.redeem_pairing_code(text, timestamptz) from public;
revoke all on function app.bind_device_identity(uuid, uuid) from public;
grant execute on function app.redeem_pairing_code(text, timestamptz) to rp_api;
grant execute on function app.bind_device_identity(uuid, uuid) to rp_api;

-- ---------------------------------------------------------------------------
-- Device and printer status signals for the operations view.
-- Topic: branch:<branch_id>:ops. Heartbeats themselves do not signal; only
-- changes of state do (online/offline, printer error appears/clears).
-- ---------------------------------------------------------------------------
create function app.on_device_status_changed() returns trigger
language plpgsql set search_path = ''
as $$
begin
  perform app.notify('branch:' || new.branch_id || ':ops', 'device_changed',
    jsonb_build_object('device_id', new.id, 'status', new.status));
  return null;
end $$;
create trigger devices_status_notify after update of status on devices
  for each row when (old.status is distinct from new.status)
  execute function app.on_device_status_changed();

create function app.on_printer_status_changed() returns trigger
language plpgsql set search_path = ''
as $$
declare v_branch uuid;
begin
  select branch_id into v_branch from public.devices where id = new.device_id;
  perform app.notify('branch:' || v_branch || ':ops', 'printer_changed',
    jsonb_build_object('printer_id', new.device_id, 'healthy', new.last_error is null));
  return null;
end $$;
create trigger printers_status_notify after update of last_error on printers
  for each row when (old.last_error is distinct from new.last_error)
  execute function app.on_printer_status_changed();

-- Marks devices offline when heartbeats stop. Runs every minute via pg_cron
-- where available; reads also derive liveness from last_heartbeat_at, so the
-- UI is correct even if the schedule is missing.
create function app.sweep_offline_devices() returns int
language plpgsql security definer set search_path = ''
as $$
declare v_count int;
begin
  with gone as (
    update public.devices set status = 'offline'
    where status = 'online' and last_heartbeat_at < now() - interval '90 seconds'
    returning id, restaurant_id, last_heartbeat_at
  ), logged as (
    insert into public.device_events (restaurant_id, device_id, event, detail)
    select restaurant_id, id, 'went_offline', jsonb_build_object('last_heartbeat_at', last_heartbeat_at) from gone
    returning 1
  )
  select count(*) into v_count from logged;
  return v_count;
end $$;
revoke all on function app.sweep_offline_devices() from public;

grant execute on function app.on_device_status_changed() to app_api;
grant execute on function app.on_printer_status_changed() to app_api;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('rp-sweep-offline-devices', '* * * * *', 'select app.sweep_offline_devices()');
  else
    raise notice 'pg_cron not available: device offline sweep not scheduled (liveness is still derived on read)';
  end if;
end $$;
