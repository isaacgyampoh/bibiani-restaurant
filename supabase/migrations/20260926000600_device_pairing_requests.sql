-- Device-initiated pairing: the device shows a short code, a manager enters it in Devices.
--
-- 1. The device asks for a request: it receives a display code and a secret. Only their hashes are
--    stored here; the secret stays in the device's memory.
-- 2. A manager (device.manage, in their own restaurant) approves the code for one device record.
-- 3. The device collects with its secret; the API then pairs it exactly like a manager-issued code
--    (new identity, previous identity removed, audited). A request works once and expires after
--    10 minutes. The display code alone is useless without the device's secret.
--
-- Requests have no restaurant until approved, so the table is reachable only through the SECURITY
-- DEFINER functions below: row level security is on and no policy grants any direct access.
create table device_pairing_requests (
  id                    uuid primary key default gen_random_uuid(),
  code_hash             text not null unique,
  secret_hash           text not null unique,
  created_at            timestamptz not null default now(),
  expires_at            timestamptz not null,
  restaurant_id         uuid references restaurants(id),
  device_id             uuid,
  approved_at           timestamptz,
  approved_by_staff_id  uuid,
  collected_at          timestamptz,
  check ((approved_at is null) = (device_id is null))
);
alter table device_pairing_requests enable row level security;
create index device_pairing_requests_expiry_idx on device_pairing_requests (expires_at);

create function app.create_pairing_request(p_code_hash text, p_secret_hash text, p_expires timestamptz, p_now timestamptz)
returns void
language sql security definer set search_path = ''
as $$
  delete from public.device_pairing_requests where expires_at < p_now - interval '1 day';
  insert into public.device_pairing_requests (code_hash, secret_hash, expires_at) values (p_code_hash, p_secret_hash, p_expires);
$$;

create function app.approve_pairing_request(p_code_hash text, p_restaurant_id uuid, p_device_id uuid, p_staff_id uuid, p_now timestamptz)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_found boolean;
begin
  -- The device must belong to the approving restaurant and be active (checked again here).
  if not exists (select 1 from public.devices d where d.id = p_device_id and d.restaurant_id = p_restaurant_id and d.is_active) then
    return false;
  end if;
  update public.device_pairing_requests
     set restaurant_id = p_restaurant_id, device_id = p_device_id, approved_at = p_now, approved_by_staff_id = p_staff_id
   where code_hash = p_code_hash and approved_at is null and expires_at > p_now;
  get diagnostics v_found = row_count;
  return v_found;
end $$;

create function app.collect_pairing_request(p_secret_hash text, p_now timestamptz)
returns table (status text, device_id uuid, restaurant_id uuid, branch_id uuid, kind public.device_kind, name text,
               station_id uuid, previous_auth_user_id uuid)
language plpgsql security definer set search_path = ''
as $$
declare v_req public.device_pairing_requests%rowtype;
begin
  select * into v_req from public.device_pairing_requests r where r.secret_hash = p_secret_hash for update;
  if not found or v_req.collected_at is not null or (v_req.approved_at is null and v_req.expires_at < p_now) then
    return query select 'expired'::text, null::uuid, null::uuid, null::uuid, null::public.device_kind, null::text, null::uuid, null::uuid;
    return;
  end if;
  if v_req.approved_at is null then
    return query select 'waiting'::text, null::uuid, null::uuid, null::uuid, null::public.device_kind, null::text, null::uuid, null::uuid;
    return;
  end if;
  update public.device_pairing_requests set collected_at = p_now where id = v_req.id;
  -- Any outstanding manager-issued codes for this device end here too.
  update public.device_pairing_codes set consumed_at = p_now where device_pairing_codes.device_id = v_req.device_id and consumed_at is null;
  return query
    select 'approved'::text, d.id, d.restaurant_id, d.branch_id, d.kind, d.name, d.station_id, d.auth_user_id
    from public.devices d where d.id = v_req.device_id and d.is_active;
end $$;

revoke all on function app.create_pairing_request(text, text, timestamptz, timestamptz) from public;
revoke all on function app.approve_pairing_request(text, uuid, uuid, uuid, timestamptz) from public;
revoke all on function app.collect_pairing_request(text, timestamptz) from public;
grant execute on function app.create_pairing_request(text, text, timestamptz, timestamptz) to rp_api;
grant execute on function app.approve_pairing_request(text, uuid, uuid, uuid, timestamptz) to rp_api;
grant execute on function app.collect_pairing_request(text, timestamptz) to rp_api;
