-- Least-privilege database login for the API server.
--
-- rp_api can do exactly two things:
--   1. SET ROLE app_api (row-level security applies; one tenant per transaction)
--   2. call the identity functions below, which map a verified auth user to
--      its restaurant/staff/device. These are the only cross-tenant reads,
--      and they return identity rows only.
-- The password is NOT set here. It is set out of band per environment
-- (scripts/dev/configure-db-logins.ts for DEV; secret manager for prod).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'rp_api') then
    create role rp_api login noinherit nobypassrls connection limit 60;
  end if;
end $$;

grant app_api to rp_api;
grant usage on schema app to rp_api;

create function app.identity_for_auth_user(p_auth_user_id uuid)
returns table (kind text, restaurant_id uuid, staff_id uuid, device_id uuid, device_kind public.device_kind,
               branch_id uuid, station_id uuid, display_name text)
language sql stable security definer set search_path = ''
as $$
  select 'staff', s.restaurant_id, s.id, null::uuid, null::public.device_kind, null::uuid, null::uuid, s.display_name
  from public.staff s join public.restaurants r on r.id = s.restaurant_id
  where s.user_id = p_auth_user_id and s.is_active and r.is_active
  union all
  select 'device', d.restaurant_id, null, d.id, d.kind, d.branch_id, d.station_id, d.name
  from public.devices d join public.restaurants r on r.id = d.restaurant_id
  where d.auth_user_id = p_auth_user_id and d.is_active and r.is_active
$$;

create function app.staff_grants(p_staff_id uuid)
returns table (branch_id uuid, permissions text[])
language sql stable security definer set search_path = ''
as $$
  select sr.branch_id, array_agg(distinct rp.permission_code)
  from public.staff_roles sr join public.role_permissions rp on rp.role_id = sr.role_id
  where sr.staff_id = p_staff_id
  group by sr.branch_id
$$;

create function app.device_belongs_to(p_restaurant_id uuid, p_device_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.devices
    where id = p_device_id and restaurant_id = p_restaurant_id and is_active and kind in ('pos', 'kds')
  )
$$;

revoke all on function app.identity_for_auth_user(uuid) from public;
revoke all on function app.staff_grants(uuid) from public;
revoke all on function app.device_belongs_to(uuid, uuid) from public;
grant execute on function app.identity_for_auth_user(uuid) to rp_api;
grant execute on function app.staff_grants(uuid) to rp_api;
grant execute on function app.device_belongs_to(uuid, uuid) to rp_api;
