-- PIN-first sign-in and the bill workflow. Additive only.

-- 1. Personal devices. An owner or manager can register their own phone/laptop (after proving their
--    email) as a device for PIN sign-in. On their OWN device a PIN session carries their full role;
--    on a shared till, management stays behind a password or a personal device.
alter table devices add column personal_staff_id uuid;
alter table devices
  add constraint devices_personal_staff_fk foreign key (restaurant_id, personal_staff_id) references staff (restaurant_id, id);
create index devices_personal_staff_idx on devices (personal_staff_id) where personal_staff_id is not null;

-- Every PIN sign-in is bound to the device it happened on (by the sign-in session's id). The API
-- uses this binding, not a client-supplied header, to know on which device a PIN session runs.
create table pin_sessions (
  session_id     uuid primary key,
  restaurant_id  uuid not null references restaurants(id),
  staff_id       uuid not null,
  device_id      uuid not null,
  created_at     timestamptz not null default now(),
  foreign key (restaurant_id, staff_id) references staff (restaurant_id, id),
  foreign key (restaurant_id, device_id) references devices (restaurant_id, id) on delete cascade
);
select app.enable_tenant_rls('pin_sessions');
create index pin_sessions_created_idx on pin_sessions (created_at);

create function app.pin_session_device(p_session_id uuid)
returns table (restaurant_id uuid, staff_id uuid, device_id uuid, personal_staff_id uuid)
language sql stable security definer set search_path = ''
as $$
  select p.restaurant_id, p.staff_id, p.device_id, d.personal_staff_id
    from public.pin_sessions p
    join public.devices d on d.id = p.device_id and d.is_active
   where p.session_id = p_session_id
$$;
revoke all on function app.pin_session_device(uuid) from public;
grant execute on function app.pin_session_device(uuid) to rp_api;

-- 2. Bills. A bill is another printout of an open order ("BILL - NOT PAID"); it never creates a
--    payment or a stock movement. The order remembers when the bill was first issued and how many
--    copies were printed.
alter type print_job_kind add value if not exists 'bill';
alter table orders add column bill_issued_at timestamptz;
alter table orders add column bill_prints int not null default 0 check (bill_prints >= 0);
