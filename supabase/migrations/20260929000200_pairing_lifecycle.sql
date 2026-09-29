-- Device pairing lifecycle fixes (production incident 2026-09-29). Additive only.
--
-- 1. A device that can only be one kind of device (MY FOOD Printing = print agent, MY FOOD Hub = hub)
--    says so when it asks for a code. Approving that code on a device record of another kind is
--    refused BEFORE anything changes: previously it was accepted, the other device (e.g. a till)
--    got a new login and its screen was signed out, and the program showed a new code at once.
-- 2. Asking for a new code can name the previous one (by its secret): the previous code stops
--    working then (one live code per device screen).
-- 3. Approval answers WHY a code cannot be used (not found, expired, already used, replaced, a
--    manager code typed in the wrong place, wrong kind of device), instead of one generic message.
--    The same code approved twice for the same device is a success, not an error.

alter table device_pairing_requests add column requested_kind public.device_kind;
alter table device_pairing_requests add column cancelled_at timestamptz;

create function app.create_pairing_request_v2(
  p_code_hash text, p_secret_hash text, p_expires timestamptz, p_now timestamptz,
  p_kind public.device_kind, p_replaces_secret_hash text)
returns void
language sql security definer set search_path = ''
as $$
  delete from public.device_pairing_requests where expires_at < p_now - interval '1 day';
  update public.device_pairing_requests
     set cancelled_at = p_now
   where p_replaces_secret_hash is not null and secret_hash = p_replaces_secret_hash
     and approved_at is null and cancelled_at is null;
  insert into public.device_pairing_requests (code_hash, secret_hash, expires_at, requested_kind)
  values (p_code_hash, p_secret_hash, p_expires, p_kind);
$$;

-- Returns 'approved' | 'already_approved' | 'not_found' | 'manager_code' | 'expired' | 'replaced'
--       | 'already_used' | 'device_unavailable' | 'wrong_kind:<kind>'.
create function app.approve_pairing_request_v2(
  p_code_hash text, p_manager_code_hash text, p_restaurant_id uuid, p_device_id uuid, p_staff_id uuid,
  p_now timestamptz)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_req public.device_pairing_requests%rowtype;
  v_kind public.device_kind;
begin
  select d.kind into v_kind from public.devices d
   where d.id = p_device_id and d.restaurant_id = p_restaurant_id and d.is_active;
  if not found then return 'device_unavailable'; end if;
  select * into v_req from public.device_pairing_requests r where r.code_hash = p_code_hash for update;
  if not found then
    if exists (select 1 from public.device_pairing_codes c where c.code_hash = p_manager_code_hash
                and c.restaurant_id = p_restaurant_id and c.consumed_at is null and c.expires_at > p_now) then
      return 'manager_code';
    end if;
    return 'not_found';
  end if;
  if v_req.approved_at is not null then
    return case when v_req.device_id = p_device_id and v_req.restaurant_id = p_restaurant_id
                then 'already_approved' else 'already_used' end;
  end if;
  if v_req.cancelled_at is not null then return 'replaced'; end if;
  if v_req.expires_at <= p_now then return 'expired'; end if;
  if v_req.requested_kind is not null and v_req.requested_kind <> v_kind then
    return 'wrong_kind:' || v_req.requested_kind::text;
  end if;
  update public.device_pairing_requests
     set restaurant_id = p_restaurant_id, device_id = p_device_id, approved_at = p_now, approved_by_staff_id = p_staff_id
   where id = v_req.id;
  return 'approved';
end $$;

-- A replaced (cancelled) code is over for the device that showed it, like an expired one.
create or replace function app.collect_pairing_request(p_secret_hash text, p_now timestamptz)
returns table (status text, device_id uuid, restaurant_id uuid, branch_id uuid, kind public.device_kind, name text,
               station_id uuid, previous_auth_user_id uuid)
language plpgsql security definer set search_path = ''
as $$
declare v_req public.device_pairing_requests%rowtype;
begin
  select * into v_req from public.device_pairing_requests r where r.secret_hash = p_secret_hash for update;
  if not found or v_req.collected_at is not null or v_req.cancelled_at is not null
     or (v_req.approved_at is null and v_req.expires_at < p_now) then
    return query select 'expired'::text, null::uuid, null::uuid, null::uuid, null::public.device_kind, null::text, null::uuid, null::uuid;
    return;
  end if;
  if v_req.approved_at is null then
    return query select 'waiting'::text, null::uuid, null::uuid, null::uuid, null::public.device_kind, null::text, null::uuid, null::uuid;
    return;
  end if;
  update public.device_pairing_requests set collected_at = p_now where id = v_req.id;
  update public.device_pairing_codes set consumed_at = p_now where device_pairing_codes.device_id = v_req.device_id and consumed_at is null;
  return query
    select 'approved'::text, d.id, d.restaurant_id, d.branch_id, d.kind, d.name, d.station_id, d.auth_user_id
    from public.devices d where d.id = v_req.device_id and d.is_active;
end $$;

revoke all on function app.create_pairing_request_v2(text, text, timestamptz, timestamptz, public.device_kind, text) from public;
revoke all on function app.approve_pairing_request_v2(text, text, uuid, uuid, uuid, timestamptz) from public;
grant execute on function app.create_pairing_request_v2(text, text, timestamptz, timestamptz, public.device_kind, text) to rp_api;
grant execute on function app.approve_pairing_request_v2(text, text, uuid, uuid, uuid, timestamptz) to rp_api;
